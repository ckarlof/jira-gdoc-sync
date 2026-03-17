// Jira -> Google Doc table sync
// Credentials (email + API token) are stored via Jira Sync > Configure credentials (never hardcoded).
// All other configuration lives in Config.gs.

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConfig() {
  var props = PropertiesService.getUserProperties();
  var email = props.getProperty('JIRA_EMAIL');
  var token = props.getProperty('JIRA_API_TOKEN');
  if (!email || !token) {
    throw new Error('Jira credentials not set. Use Jira Sync > Configure credentials.');
  }
  if (!CONFIG.jira.baseUrl) {
    throw new Error('CONFIG.jira.baseUrl is not set. Edit Config.gs.');
  }
  return { baseUrl: CONFIG.jira.baseUrl, email: email, token: token };
}

function jiraAuthHeader() {
  var cfg = getConfig();
  return 'Basic ' + Utilities.base64Encode(cfg.email + ':' + cfg.token);
}

function jiraGet(path) {
  var cfg = getConfig();
  var response = UrlFetchApp.fetch(cfg.baseUrl + path, {
    method: 'GET',
    headers: { 'Authorization': jiraAuthHeader(), 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  return { code: response.getResponseCode(), body: response.getContentText() };
}

function jiraSearch(jql, fields, maxResults) {
  var cfg     = getConfig();
  var headers = {
    'Authorization': jiraAuthHeader(),
    'Accept':        'application/json',
    'Content-Type':  'application/json'
  };
  var body = JSON.stringify({
    jql:        jql,
    fields:     fields || ['summary', 'assignee'],
    maxResults: maxResults || 50
  });

  // Try the newer /search/jql endpoint first, fall back to /search
  var endpoints = [
    cfg.baseUrl + '/rest/api/3/search/jql',
    cfg.baseUrl + '/rest/api/3/search'
  ];

  for (var i = 0; i < endpoints.length; i++) {
    var response = UrlFetchApp.fetch(endpoints[i], {
      method: 'POST', headers: headers, payload: body, muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code !== 404 && code !== 410) {
      Logger.log('jiraSearch using endpoint: ' + endpoints[i] + ' (HTTP ' + code + ')');
      return { code: code, body: response.getContentText() };
    }
  }

  return { code: 410, body: 'All search endpoints returned 410/404' };
}

// ── Core ──────────────────────────────────────────────────────────────────────

// Jira status lozenge colors (matches Jira's subtle palette)
var STATUS_COLORS = {
  'neutral': { bg: '#DFE1E6', fg: '#172B4D' },
  'purple':  { bg: '#EAE6FF', fg: '#403294' },
  'blue':    { bg: '#DEEBFF', fg: '#0747A6' },
  'red':     { bg: '#FFEBE6', fg: '#BF2600' },
  'yellow':  { bg: '#FFFAE6', fg: '#7A5200' },
  'green':   { bg: '#E3FCEF', fg: '#006644' }
};

/**
 * Parses an ADF document into an array of blocks:
 *   { type: 'para', segments: [...] }
 *   { type: 'listItem', level: N, ordered: bool, segments: [...] }
 * Each segment: { text, bold, italic, underline, strike, code, url, bgColor, fgColor }
 */
function adfToBlocks(adfBody) {
  var EMPTY_SEG = { bold: false, italic: false, underline: false,
                    strike: false, code: false, url: null, bgColor: null, fgColor: null };

  if (!adfBody || adfBody.version === undefined) {
    return [{ type: 'para', segments: [Object.assign({ text: String(adfBody || '') }, EMPTY_SEG)] }];
  }

  var blocks = [];

  function seg(text, marks) {
    return { text: text, bold: !!marks.bold, italic: !!marks.italic,
             underline: !!marks.underline, strike: !!marks.strike, code: !!marks.code,
             url: marks.url || null, bgColor: marks.bgColor || null, fgColor: marks.fgColor || null };
  }

  function mergeMark(marks, mark) {
    var m = { bold: marks.bold, italic: marks.italic, underline: marks.underline,
              strike: marks.strike, code: marks.code, url: marks.url,
              bgColor: marks.bgColor, fgColor: marks.fgColor };
    switch (mark.type) {
      case 'strong':    m.bold      = true; break;
      case 'em':        m.italic    = true; break;
      case 'underline': m.underline = true; break;
      case 'strike':    m.strike    = true; break;
      case 'code':      m.code      = true; break;
      case 'link':      m.url = (mark.attrs && mark.attrs.href) || null; break;
    }
    return m;
  }

  // Walk inline nodes, return segments array
  function inlineSegs(node, marks) {
    if (!node) return [];
    var out = [];
    switch (node.type) {
      case 'text': {
        var m = marks;
        (node.marks || []).forEach(function(mk) { m = mergeMark(m, mk); });
        if (node.text) out.push(seg(node.text, m));
        return out;
      }
      case 'hardBreak':
        out.push(seg('\n', EMPTY_SEG));
        return out;
      case 'status': {
        if (!node.attrs || !node.attrs.text) return out;
        var color   = node.attrs.color || 'neutral';
        var palette = STATUS_COLORS[color] || STATUS_COLORS['neutral'];
        out.push({ text: ' ' + node.attrs.text.toUpperCase() + ' ',
                   bold: true, italic: false, underline: false, strike: false,
                   code: false, url: null, bgColor: palette.bg, fgColor: palette.fg });
        return out;
      }
      case 'emoji':
        if (node.attrs && node.attrs.text) out.push(seg(node.attrs.text, marks));
        else if (node.attrs && node.attrs.shortName) out.push(seg(node.attrs.shortName, marks));
        return out;
      case 'mention':
        if (node.attrs && node.attrs.text) out.push(seg(node.attrs.text, marks));
        return out;
      case 'inlineCard':
      case 'blockCard':
        if (node.attrs && node.attrs.url) out.push(seg(node.attrs.url, marks));
        return out;
    }
    // recurse for inline wrappers
    (node.content || []).forEach(function(child) {
      out = out.concat(inlineSegs(child, marks));
    });
    return out;
  }

  function collectSegs(nodes, marks) {
    var out = [];
    (nodes || []).forEach(function(n) { out = out.concat(inlineSegs(n, marks)); });
    return out;
  }

  function pushPara(segs) {
    if (segs.length) blocks.push({ type: 'para', segments: segs });
  }

  function walkListItem(node, level, ordered) {
    (node.content || []).forEach(function(child) {
      if (child.type === 'paragraph') {
        var segs = collectSegs(child.content, EMPTY_SEG);
        if (segs.length) blocks.push({ type: 'listItem', level: level, ordered: ordered, segments: segs });
      } else if (child.type === 'bulletList') {
        (child.content || []).forEach(function(item) { walkListItem(item, level + 1, false); });
      } else if (child.type === 'orderedList') {
        (child.content || []).forEach(function(item) { walkListItem(item, level + 1, true); });
      } else {
        walkBlocks([child]);
      }
    });
  }

  function walkBlocks(nodes) {
    (nodes || []).forEach(function(node) {
      switch (node.type) {
        case 'paragraph':
        case 'heading':
          pushPara(collectSegs(node.content, EMPTY_SEG));
          break;
        case 'codeBlock':
          pushPara(collectSegs(node.content,
            { bold: false, italic: false, underline: false, strike: false,
              code: true, url: null, bgColor: null, fgColor: null }));
          break;
        case 'bulletList':
          (node.content || []).forEach(function(item) { walkListItem(item, 0, false); });
          break;
        case 'orderedList':
          (node.content || []).forEach(function(item) { walkListItem(item, 0, true); });
          break;
        case 'rule':
          pushPara([seg('---', EMPTY_SEG)]);
          break;
        case 'blockquote':
        case 'panel':
        case 'doc':
          walkBlocks(node.content);
          break;
        case 'listItem':
          walkListItem(node, 0, false);
          break;
      }
    });
  }

  walkBlocks(adfBody.content);
  return blocks;
}

/**
 * Scans unlinked text segments for bare http(s) URLs and splits them into
 * linked segments, leaving surrounding text and already-linked segments alone.
 */
function autoLinkSegments(segments) {
  var URL_RE = /https?:\/\/[^\s<>'"]+/g;
  var result = [];
  segments.forEach(function(s) {
    if (s.url || !s.text) { result.push(s); return; }
    URL_RE.lastIndex = 0;
    var text = s.text, lastIndex = 0, found = false, match;
    while ((match = URL_RE.exec(text)) !== null) {
      found = true;
      if (match.index > lastIndex)
        result.push(Object.assign({}, s, { text: text.substring(lastIndex, match.index) }));
      result.push(Object.assign({}, s, { text: match[0], url: match[0] }));
      lastIndex = match.index + match[0].length;
    }
    if (!found) { result.push(s); return; }
    if (lastIndex < text.length)
      result.push(Object.assign({}, s, { text: text.substring(lastIndex) }));
  });
  return result;
}

/**
 * Applies rich-text formatting from segments onto a Text object.
 */
function applySegmentsToText(t, segments) {
  segments = autoLinkSegments(segments);
  var fullText = segments.map(function(s) { return s.text; }).join('');
  t.setText(fullText);
  var pos = 0;
  segments.forEach(function(s) {
    if (!s.text.length) return;
    var end = pos + s.text.length - 1;
    if (s.bold)      t.setBold(pos, end, true);
    if (s.italic)    t.setItalic(pos, end, true);
    if (s.underline) t.setUnderline(pos, end, true);
    if (s.strike)    t.setStrikethrough(pos, end, true);
    if (s.code)      t.setFontFamily(pos, end, 'Courier New');
    if (s.url)       t.setLinkUrl(pos, end, s.url);
    if (s.bgColor)   t.setBackgroundColor(pos, end, s.bgColor);
    if (s.fgColor)   t.setForegroundColor(pos, end, s.fgColor);
    pos += s.text.length;
  });
}

/**
 * Writes an array of blocks into a table cell.
 * Para blocks become paragraphs; listItem blocks become native Google Doc list items
 * with proper nesting levels.
 */
function writeBlocksToCell(cell, blocks) {
  cell.clear();
  if (!blocks || !blocks.length) return;

  var cellIsEmpty    = true;   // after clear(), one empty para remains
  var firstListItem  = null;   // anchor for setListId grouping
  var prevWasList    = false;

  blocks.forEach(function(block) {
    if (block.type === 'listItem') {
      var item = cell.appendListItem('');
      item.setNestingLevel(block.level || 0);
      item.setGlyphType(block.ordered
        ? DocumentApp.GlyphType.NUMBER
        : DocumentApp.GlyphType.BULLET);

      if (!firstListItem || !prevWasList) {
        // Start of a new list — this item becomes the anchor
        firstListItem = item;
        if (cellIsEmpty) {
          // Remove the leading empty paragraph that cell.clear() leaves behind
          try { cell.removeChild(cell.getChild(0)); } catch(e) {}
          cellIsEmpty = false;
        }
      } else {
        item.setListId(firstListItem);
      }
      applySegmentsToText(item.editAsText(), block.segments);
      prevWasList = true;
    } else {
      // para block
      var para;
      if (cellIsEmpty) {
        para = cell.getChild(0).asParagraph();
        cellIsEmpty = false;
      } else {
        para = cell.appendParagraph('');
      }
      applySegmentsToText(para.editAsText(), block.segments);
      prevWasList   = false;
      firstListItem = null;  // next list will start fresh
    }
  });
}

/**
 * Fetches the latest comment for a ticket and returns:
 *   { blocks: [...], date: Date|null }
 * date is null when there are no comments or the date cannot be parsed.
 * blocks is the rich-text block array ready for writeBlocksToCell.
 */
function getLatestCommentMeta(ticketId) {
  var EMPTY = { bold: false, italic: false, underline: false,
                strike: false, code: false, url: null, bgColor: null, fgColor: null };
  var result = jiraGet('/rest/api/3/issue/' + ticketId + '/comment?orderBy=-created&maxResults=1');
  if (result.code !== 200)
    return { blocks: [{ type: 'para', segments: [Object.assign({ text: 'Error ' + result.code }, EMPTY)] }], date: null };
  var data = JSON.parse(result.body);
  if (!data.comments || data.comments.length === 0)
    return { blocks: [{ type: 'para', segments: [Object.assign({ text: '(no comments)' }, EMPTY)] }], date: null };
  var c      = data.comments[0];
  var author = c.author ? c.author.displayName : 'Unknown';
  var dateStr = c.created ? c.created.substring(0, 10) : '';
  var date    = c.created ? new Date(c.created) : null;
  var header  = { type: 'para',
                  segments: [Object.assign({ text: '[' + author + ', ' + dateStr + ']' },
                                           EMPTY, { bold: true })] };
  return { blocks: [header].concat(adfToBlocks(c.body)), date: date };
}

function getLatestComment(ticketId) {
  return getLatestCommentMeta(ticketId).blocks;
}

// ── OKR data fetching ─────────────────────────────────────────────────────────

/**
 * Logs the raw structure of an objective ticket to help diagnose hierarchy issues.
 * Run this from the Apps Script editor when KRs aren't being found.
 */
function debugKR() {
  var krKey        = 'INFOKR-7';
  var objectiveKey = 'INFOKR-1';

  var result = jiraGet('/rest/api/3/issue/' + krKey + '?fields=*all');
  if (result.code !== 200) {
    Logger.log('Failed: HTTP ' + result.code + '\n' + result.body);
    return;
  }

  var fields = JSON.parse(result.body).fields;
  Logger.log('=== Fields on ' + krKey + ' that reference ' + objectiveKey + ' ===');
  Object.keys(fields).forEach(function(key) {
    var val = fields[key];
    var str = JSON.stringify(val);
    if (str && str.indexOf(objectiveKey) !== -1) {
      Logger.log(key + ': ' + str);
    }
  });

  Logger.log('=== All non-null fields on ' + krKey + ' ===');
  Object.keys(fields).forEach(function(key) {
    var val = fields[key];
    if (val !== null && val !== undefined && val !== '') {
      Logger.log(key + ': ' + JSON.stringify(val).substring(0, 120));
    }
  });
}

function debugObjective() {
  var key = 'INFOKR-1';

  var issueResult = jiraGet('/rest/api/3/issue/' + key + '?fields=summary,issuetype,subtasks,parent,issuelinks');
  if (issueResult.code !== 200) {
    Logger.log('Failed to fetch issue: HTTP ' + issueResult.code);
    Logger.log(issueResult.body);
    return;
  }

  var issue = JSON.parse(issueResult.body);
  var f = issue.fields;

  Logger.log('=== ' + key + ' ===');
  Logger.log('Issue type : ' + (f.issuetype ? f.issuetype.name : 'unknown'));
  Logger.log('Summary    : ' + f.summary);
  Logger.log('Parent     : ' + (f.parent ? f.parent.key : 'none'));

  var subtasks = f.subtasks || [];
  Logger.log('Subtasks (' + subtasks.length + '):');
  subtasks.forEach(function(s) { Logger.log('  ' + s.key + ': ' + s.fields.summary); });

  var links = f.issuelinks || [];
  Logger.log('Issue links (' + links.length + '):');
  links.forEach(function(l) {
    var related = l.outwardIssue || l.inwardIssue;
    var dir     = l.outwardIssue ? 'outward' : 'inward';
    var type    = l.type ? l.type.name + ' (' + dir + ')' : dir;
    Logger.log('  [' + type + '] ' + (related ? related.key + ': ' + related.fields.summary : '?'));
  });

  // List all custom fields with "parent" in the name
  Logger.log('--- Parent-related custom fields ---');
  var fieldsResult = jiraGet('/rest/api/3/field');
  if (fieldsResult.code === 200) {
    JSON.parse(fieldsResult.body).forEach(function(f) {
      if (f.name && f.name.toLowerCase().indexOf('parent') !== -1) {
        Logger.log('  ' + f.id + '  "' + f.name + '"  custom=' + f.custom);
      }
    });
  }

  // JQL probes
  Logger.log('--- JQL probes ---');
  var parentFieldId = getParentLinkFieldId();
  var strategies = [];
  if (parentFieldId) strategies.push(parentFieldId + ' = "' + key + '"');
  strategies = strategies.concat([
    '"Parent Link" = "' + key + '"',
    'parent = "'        + key + '"',
    '"Epic Link" = "'   + key + '"',
  ]);
  strategies.forEach(function(jql) {
    var r     = jiraSearch(jql, ['summary'], 1);
    var count = r.code === 200 ? JSON.parse(r.body).total : ('HTTP ' + r.code);
    Logger.log(jql + '  →  ' + count);
  });
}

/**
 * Fetches all Jira fields and returns the field ID of the Advanced Roadmaps
 * parent-link field (the custom field that stores hierarchy above Epic level).
 * Caches the result in UserProperties to avoid repeated API calls.
 */
function getParentLinkFieldId() {
  var props   = PropertiesService.getUserProperties();
  var cached  = props.getProperty('JIRA_PARENT_LINK_FIELD_ID');
  if (cached) return cached;

  var result = jiraGet('/rest/api/3/field');
  if (result.code !== 200) return null;

  var fields = JSON.parse(result.body);

  // Priority: exact name match first, then any custom field with "parent" in the name
  var CANDIDATE_NAMES = ['Parent Link', 'Parent link', 'ParentLink'];
  var found = null;

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (!f.custom) continue;
    if (CANDIDATE_NAMES.indexOf(f.name) !== -1) { found = f; break; }
    if (!found && f.name && f.name.toLowerCase().indexOf('parent') !== -1) {
      found = f;
    }
  }

  if (found) {
    Logger.log('Parent link field: ' + found.name + ' (' + found.id + ')');
    props.setProperty('JIRA_PARENT_LINK_FIELD_ID', found.id);
    return found.id;
  }

  Logger.log('Could not find a parent link custom field');
  return null;
}

/**
 * Returns the Jira field names to request for the configured columns.
 * 'latestComment' is fetched separately; all others map directly to Jira field names.
 * 'summary' is always included (needed for headings, sort, and attention items).
 */
function jiraFieldsForColumns() {
  var fields = { summary: true, assignee: true };  // always fetch these two
  (CONFIG.columns || []).forEach(function(col) {
    if (col.field && col.field !== 'latestComment') fields[col.field] = true;
  });
  return Object.keys(fields);
}

/**
 * Extracts a plain-text value from a Jira field, handling common nested shapes:
 *   { name: '...' }, { value: '...' }, { displayName: '...' }, or a bare scalar.
 */
function extractFieldText(fieldValue) {
  if (fieldValue === null || fieldValue === undefined) return '';
  if (typeof fieldValue === 'object') {
    return fieldValue.displayName || fieldValue.name || fieldValue.value || JSON.stringify(fieldValue);
  }
  return String(fieldValue);
}

/**
 * Fetches child issues of an objective. Tries multiple JQL strategies,
 * including querying by numeric issue ID which works when key-based queries fail.
 */
function fetchChildren(objectiveKey) {
  var cfg    = getConfig();
  var fields = jiraFieldsForColumns();

  var strategies = [
    'parent = ' + objectiveKey + ' ORDER BY created ASC',
    'issuekey in childIssuesOf("' + objectiveKey + '") ORDER BY created ASC',
  ];

  for (var i = 0; i < strategies.length; i++) {
    var result = jiraSearch(strategies[i], fields, 50);
    Logger.log('[' + strategies[i] + '] → HTTP ' + result.code +
               (result.code === 200 ? ', total=' + JSON.parse(result.body).total : ''));
    if (result.code !== 200) continue;
    var data = JSON.parse(result.body);
    if (!data.issues || data.issues.length === 0) continue;

    Logger.log(objectiveKey + ': found ' + data.issues.length + ' KR(s) via [' + strategies[i] + ']');
    return data.issues.map(function(issue) {
      var f = issue.fields || {};
      return {
        key:          issue.key,
        summary:      f.summary || '(no summary)',
        url:          cfg.baseUrl + '/browse/' + issue.key,
        assigneeName: f.assignee ? f.assignee.displayName : 'Unassigned',
        fields:       f   // full fields bag for generic column rendering
      };
    }).sort(function(a, b) {
      if (CONFIG.krSortOrder !== 'alpha') return 0;
      return a.summary.localeCompare(b.summary, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  Logger.log(objectiveKey + ': no KRs found with any strategy');
  return [];
}

/**
 * Fetches an objective's summary and its child KRs from Jira.
 */
function fetchObjectiveData(objectiveKey) {
  var objResult        = jiraGet('/rest/api/3/issue/' + objectiveKey + '?fields=summary');
  var objectiveSummary = objectiveKey;
  if (objResult.code === 200) {
    var objData      = JSON.parse(objResult.body);
    objectiveSummary = (objData.fields && objData.fields.summary) || objectiveKey;
  }

  return { key: objectiveKey, summary: objectiveSummary, krs: fetchChildren(objectiveKey) };
}

// ── OKR document builder ──────────────────────────────────────────────────────

/**
 * Renders a single table cell for a KR row based on the column's field value.
 * Mutates the cell in place.
 */
function renderCell(cell, col, kr, commentCache) {
  switch (col.field) {
    case 'summary':
      var t = cell.editAsText();
      t.setText(kr.summary);
      if (kr.summary.length > 0) t.setLinkUrl(0, kr.summary.length - 1, kr.url);
      break;

    case 'assignee':
      cell.setText(kr.assigneeName);
      break;

    case 'latestComment':
      var meta = commentCache[kr.key];
      writeBlocksToCell(cell, meta ? meta.blocks : getLatestComment(kr.key));
      break;

    case 'status':
      cell.setText(extractFieldText(kr.fields && kr.fields.status));
      break;

    case 'priority':
      cell.setText(extractFieldText(kr.fields && kr.fields.priority));
      break;

    default:
      // Generic Jira field — render as plain text
      cell.setText(extractFieldText(kr.fields && kr.fields[col.field]));
      break;
  }
}

/**
 * Clears the document and builds one table per objective.
 * Each table row represents a KR (child ticket) of that objective.
 */
function buildOKRTables() {
  var objectiveKeys = CONFIG.objectives;

  if (!objectiveKeys || objectiveKeys.length === 0) {
    DocumentApp.getUi().alert('No objectives configured.\nEdit the objectives array in Config.gs.');
    return;
  }

  var doc   = DocumentApp.getActiveDocument();
  var style = CONFIG.style;
  var body  = doc.getBody();

  body.clear();
  var tz      = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(new Date(), tz, "MMM d, yyyy h:mm a '(" + tz + ")'");
  body.appendParagraph(dateStr).setHeading(DocumentApp.ParagraphHeading.HEADING1);

  // Fetch all objective data up front so we can pass it to the AI summarizer
  var allObjectiveData = objectiveKeys.map(function(key) {
    Logger.log('Fetching data for ' + key + '...');
    return fetchObjectiveData(key);
  });

  // Build comment cache once — used by both the AI digest and attention items
  var commentCache   = buildCommentCache(allObjectiveData);
  var attentionItems = buildAttentionItems(allObjectiveData, commentCache);

  // AI summary — runs before the tables so it appears at the top
  if (CONFIG.aiSummary && CONFIG.aiSummary.enabled) {
    var digest      = buildCommentDigest(allObjectiveData, commentCache);
    var summaryText = generateAiSummary(digest);
    if (summaryText) writeSummaryToDoc(body, summaryText, attentionItems);
  } else if (attentionItems.length > 0) {
    // Still write the attention section even when AI summary is disabled
    writeSummaryToDoc(body, '', attentionItems);
  }

  allObjectiveData.forEach(function(data) {
    var objectiveKey = data.key;
    Logger.log('Building table for ' + objectiveKey + '...');

    // Heading: "KEY: Summary text" with only the Jira key hyperlinked.
    var cfg         = getConfig();
    var objUrl      = cfg.baseUrl + '/browse/' + objectiveKey;
    var headingText = objectiveKey + ': ' + data.summary;
    var headingPara = body.appendParagraph('');
    headingPara.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    var ht = headingPara.editAsText();
    ht.setText(headingText);
    ht.setLinkUrl(0, objectiveKey.length - 1, objUrl);

    if (data.krs.length === 0) {
      body.appendParagraph('(no KRs found)').setItalic(true);
      body.appendParagraph('');
      return;
    }

    var columns = CONFIG.columns || [
      { heading: 'Summary',      width: 175, field: 'summary'       },
      { heading: 'Assignee',     width: 75,  field: 'assignee'      },
      { heading: 'Last Comment', width: 600, field: 'latestComment' },
    ];

    var table = body.appendTable();

    // Header row
    var headerRow = table.appendTableRow();
    columns.forEach(function(col) {
      var cell = headerRow.appendTableCell(col.heading);
      cell.setBackgroundColor(style.headerBgColor);
      var t = cell.editAsText();
      t.setBold(0, col.heading.length - 1, true);
      t.setForegroundColor(0, col.heading.length - 1, style.headerTextColor);
    });

    // Set column widths
    columns.forEach(function(col, idx) {
      if (col.width) try { table.setColumnWidth(idx, col.width); } catch(e) {}
    });

    // One row per KR
    data.krs.forEach(function(kr) {
      var row = table.appendTableRow();
      columns.forEach(function(col) {
        renderCell(row.appendTableCell(''), col, kr, commentCache);
      });
    });

    body.appendParagraph('');
  });

  DocumentApp.getUi().alert('Done. Built tables for ' + objectiveKeys.length + ' objective(s).');
}

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Quick check that your credentials are valid. Run this first.
 */
function verifyJiraToken() {
  var result = jiraGet('/rest/api/3/myself');

  if (result.code === 200) {
    var user = JSON.parse(result.body);
    Logger.log('SUCCESS: Authenticated as ' + user.displayName + ' (' + user.emailAddress + ')');
  } else {
    Logger.log('FAILED: HTTP ' + result.code);
    Logger.log(result.body);
  }
}

// ── AI summary ────────────────────────────────────────────────────────────────

/**
 * Calls the Claude API with the collected KR comment text and returns a summary string.
 * Returns null (with a logged error) if the call fails or the feature is disabled.
 */
function generateAiSummary(commentText) {
  var ai = CONFIG.aiSummary;
  if (!ai || !ai.enabled) return null;

  var props     = PropertiesService.getUserProperties();
  var claudeKey = props.getProperty('CLAUDE_API_KEY');
  if (!claudeKey) {
    Logger.log('AI summary skipped: CLAUDE_API_KEY not set. Use Jira Sync > Configure credentials.');
    return null;
  }

  var model  = ai.model  || 'claude-opus-4-6';
  var prompt = ai.prompt || '';

  var payload = JSON.stringify({
    model:      model,
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt + commentText }]
  });

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         claudeKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json'
    },
    payload:            payload,
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    Logger.log('Claude API error: HTTP ' + code + '\n' + response.getContentText());
    return null;
  }

  var data = JSON.parse(response.getContentText());
  return (data.content && data.content[0] && data.content[0].text) || null;
}

/**
 * Fetches comment metadata for every KR across all objectives exactly once.
 * Returns a plain object keyed by ticket key: { blocks, date }
 */
function buildCommentCache(objectiveDataList) {
  var cache = {};
  objectiveDataList.forEach(function(obj) {
    obj.krs.forEach(function(kr) {
      if (!cache[kr.key]) cache[kr.key] = getLatestCommentMeta(kr.key);
    });
  });
  return cache;
}

/**
 * Collects plain-text comment content from all KRs for use as AI input.
 * Uses a pre-built comment cache to avoid redundant API calls.
 */
function buildCommentDigest(objectiveDataList, commentCache) {
  var lines = [];
  objectiveDataList.forEach(function(obj) {
    lines.push('Objective: ' + obj.summary);
    obj.krs.forEach(function(kr) {
      lines.push('  KR: ' + kr.summary + ' (assignee: ' + kr.assigneeName + ')');
      var meta = commentCache[kr.key];
      var commentText = meta ? meta.blocks.map(function(block) {
        return block.segments.map(function(s) { return s.text; }).join('');
      }).join(' ').trim() : '';
      if (commentText) lines.push('  Latest comment: ' + commentText);
    });
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * Returns an array of { summary, url, reason } objects for KRs that need attention:
 *   - unassigned owner
 *   - no comments at all
 *   - latest comment is more than STALE_DAYS old
 */
function buildAttentionItems(objectiveDataList, commentCache) {
  var STALE_DAYS = 14;
  var now        = new Date();
  var items      = [];

  objectiveDataList.forEach(function(obj) {
    obj.krs.forEach(function(kr) {
      var reasons = [];

      if (!kr.assigneeName || kr.assigneeName === 'Unassigned') {
        reasons.push('no owner assigned');
      }

      var meta = commentCache[kr.key];
      if (!meta || !meta.date) {
        reasons.push('no updates');
      } else {
        var ageDays = (now - meta.date) / (1000 * 60 * 60 * 24);
        if (ageDays > STALE_DAYS) {
          var daysAgo = Math.floor(ageDays);
          reasons.push('last update ' + daysAgo + ' days ago');
        }
      }

      if (reasons.length > 0) {
        items.push({ summary: kr.summary, url: kr.url, reason: reasons.join('; ') });
      }
    });
  });

  return items;
}

/**
 * Parses a string that may contain **bold** spans into a segments array:
 *   [{ text: string, bold: boolean }, ...]
 */
function parseBoldSegments(text) {
  var segments = [];
  var re = /\*\*(.+?)\*\*/g;
  var last = 0, match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) segments.push({ text: text.substring(last, match.index), bold: false });
    segments.push({ text: match[1], bold: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.substring(last), bold: false });
  return segments;
}

/**
 * Applies a segments array (with bold flags) to a Text object.
 */
function applyBoldSegments(t, segments) {
  var full = segments.map(function(s) { return s.text; }).join('');
  t.setText(full);
  var pos = 0;
  segments.forEach(function(s) {
    if (s.text.length && s.bold) t.setBold(pos, pos + s.text.length - 1, true);
    pos += s.text.length;
  });
}

/**
 * Writes the AI summary and attention items into the document body.
 *
 * summaryText uses SECTION:/ITEM: format from Claude.
 * attentionItems is an array of { summary, url, reason } from buildAttentionItems.
 *
 * SECTION lines → HEADING3. ITEM lines → native bullet list items with **bold** preserved.
 * The "Needs Attention" section is always appended after the AI sections.
 */
function writeSummaryToDoc(body, summaryText, attentionItems) {
  body.appendParagraph('AI Summary').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  var firstListItem = null;

  if (summaryText) {
    summaryText.split('\n').forEach(function(raw) {
      var line = raw.trim();
      if (!line) return;

      // Strip stray leading markdown chars that aren't part of SECTION/ITEM structure
      line = line.replace(/^#+\s*/, '').replace(/^[-•]\s*/, '');

      if (line.indexOf('SECTION:') === 0) {
        var title = line.substring('SECTION:'.length).trim();
        body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING3);
        firstListItem = null;  // each section starts a fresh list
      } else if (line.indexOf('ITEM:') === 0) {
        var itemText = line.substring('ITEM:'.length).trim();
        var item = body.appendListItem('').setGlyphType(DocumentApp.GlyphType.BULLET);
        if (firstListItem) {
          item.setListId(firstListItem);
        } else {
          firstListItem = item;
        }
        applyBoldSegments(item.editAsText(), parseBoldSegments(itemText));
      } else {
        // Unexpected line — render as plain paragraph and reset list anchor
        firstListItem = null;
        body.appendParagraph(line);
      }
    });
  }

  // Needs Attention section — always computed locally, no AI involved
  if (attentionItems && attentionItems.length > 0) {
    body.appendParagraph('Needs Attention').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    firstListItem = null;
    attentionItems.forEach(function(a) {
      var item = body.appendListItem('').setGlyphType(DocumentApp.GlyphType.BULLET);
      if (firstListItem) {
        item.setListId(firstListItem);
      } else {
        firstListItem = item;
      }
      // Render "KR summary (reason)" with the KR name as a hyperlink
      var t = item.editAsText();
      var label  = a.summary + ' (' + a.reason + ')';
      t.setText(label);
      t.setLinkUrl(0, a.summary.length - 1, a.url);
    });
  }

  body.appendParagraph('');
}

// ── Credentials setup ─────────────────────────────────────────────────────────

function configureCredentials() {
  var ui    = DocumentApp.getUi();
  var props = PropertiesService.getUserProperties();

  var email = ui.prompt('Jira Email', 'Your Atlassian account email', ui.ButtonSet.OK_CANCEL);
  if (email.getSelectedButton() !== ui.Button.OK) return;

  var token = ui.prompt('Jira API Token', 'Paste your API token', ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK) return;

  props.setProperty('JIRA_EMAIL',     email.getResponseText().trim());
  props.setProperty('JIRA_API_TOKEN', token.getResponseText().trim());

  ui.alert('Jira credentials saved. Run "Verify API token" to confirm they work.');
}

function configureClaudeKey() {
  var ui    = DocumentApp.getUi();
  var props = PropertiesService.getUserProperties();

  var r = ui.prompt('Claude API Key', 'Paste your Anthropic API key (starts with sk-ant-)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;

  props.setProperty('CLAUDE_API_KEY', r.getResponseText().trim());
  ui.alert('Claude API key saved.');
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Jira Sync')
    .addItem('Build OKR tables',        'buildOKRTables')
    .addSeparator()
    .addItem('Configure Jira credentials',   'configureCredentials')
    .addItem('Configure Claude API key',     'configureClaudeKey')
    .addToUi();
}
