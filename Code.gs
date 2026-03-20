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
 * Scans unlinked text segments for bare http(s) URLs and bare Jira ticket keys
 * (e.g. PROJ-123) and splits them into linked segments, leaving surrounding text
 * and already-linked segments alone.
 *
 * Accepts an optional baseUrl override (used in tests); falls back to CONFIG.
 */
function autoLinkSegments(segments, baseUrl) {
  var jiraBase = baseUrl || (CONFIG && CONFIG.jira && CONFIG.jira.baseUrl) || '';
  // Matches bare URLs first, then bare Jira keys (e.g. PROJ-123, INFOKR-42).
  // Lookbehind/ahead prevent matching keys that are already part of a longer word.
  var LINK_RE = /https?:\/\/[^\s<>'"]+|(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])/g;
  var result = [];
  segments.forEach(function(s) {
    if (s.url || !s.text) { result.push(s); return; }
    LINK_RE.lastIndex = 0;
    var text = s.text, lastIndex = 0, found = false, match;
    while ((match = LINK_RE.exec(text)) !== null) {
      found = true;
      if (match.index > lastIndex)
        result.push(Object.assign({}, s, { text: text.substring(lastIndex, match.index) }));
      var matchText = match[0];
      // match[1] is set for Jira key captures; otherwise it's a bare URL
      var url = match[1] ? (jiraBase + '/browse/' + match[1]) : matchText;
      result.push(Object.assign({}, s, { text: matchText, url: url }));
      lastIndex = match.index + matchText.length;
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
function getLatestCommentMeta(ticketId, index) {
  index = index || 0;
  var EMPTY = { bold: false, italic: false, underline: false,
                strike: false, code: false, url: null, bgColor: null, fgColor: null };
  var result = jiraGet('/rest/api/3/issue/' + ticketId + '/comment?orderBy=-created&maxResults=' + (index + 1));
  if (result.code !== 200)
    return { blocks: [{ type: 'para', segments: [Object.assign({ text: 'Error ' + result.code }, EMPTY)] }], date: null };
  var data = JSON.parse(result.body);
  if (!data.comments || data.comments.length <= index)
    return { blocks: [{ type: 'para', segments: [Object.assign({ text: '(no comments)' }, EMPTY)] }], date: null };
  var c      = data.comments[index];
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
 * 'summary' and 'assignee' are always included.
 */
function jiraFieldsForColumns() {
  var fields = { summary: true, assignee: true };
  var needsDepFields = false;
  (CONFIG.columns || []).forEach(function(col) {
    if (col.field && col.field !== 'latestComment' && col.field !== 'secondLatestComment' && col.field !== 'dependencySummary') {
      fields[col.field] = true;
    }
    if (col.field === 'dependencySummary') {
      needsDepFields = true;
    }
  });
  // Add fields required for dependency analysis
  if (needsDepFields) {
    fields.status = true;
    fields.updated = true;
  }
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
 * Maps a raw Jira issue object to the standard issue record used throughout the script.
 */
function mapIssue(issue) {
  var cfg = getConfig();
  var f   = issue.fields || {};
  return {
    key:          issue.key,
    summary:      f.summary || '(no summary)',
    url:          cfg.baseUrl + '/browse/' + issue.key,
    assigneeName: f.assignee ? f.assignee.displayName : 'Unassigned',
    fields:       f
  };
}

/**
 * Sorts an array of issue records according to CONFIG.sortOrder.
 * Mutates and returns the array.
 */
function sortIssues(issues) {
  if (CONFIG.sortOrder !== 'alpha') return issues;
  return issues.sort(function(a, b) {
    return a.summary.localeCompare(b.summary, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/**
 * Fetches child issues of a parent key. Tries multiple JQL strategies.
 * Returns a sorted array of issue records.
 */
function fetchChildIssues(parentKey) {
  var fields = jiraFieldsForColumns();

  var strategies = [
    'parent = ' + parentKey + ' ORDER BY created ASC',
    'issuekey in childIssuesOf("' + parentKey + '") ORDER BY created ASC',
  ];

  for (var i = 0; i < strategies.length; i++) {
    var result = jiraSearch(strategies[i], fields, 50);
    Logger.log('[' + strategies[i] + '] → HTTP ' + result.code +
               (result.code === 200 ? ', total=' + JSON.parse(result.body).total : ''));
    if (result.code !== 200) continue;
    var data = JSON.parse(result.body);
    if (!data.issues || data.issues.length === 0) continue;

    Logger.log(parentKey + ': found ' + data.issues.length + ' child issue(s) via [' + strategies[i] + ']');
    return sortIssues(data.issues.map(mapIssue));
  }

  Logger.log(parentKey + ': no child issues found with any strategy');
  return [];
}

/**
 * Fetches a parent ticket's summary and its child issues.
 * Returns { key, summary, issues }.
 */
function fetchParentData(parentKey) {
  var result  = jiraGet('/rest/api/3/issue/' + parentKey + '?fields=summary');
  var summary = parentKey;
  if (result.code === 200) {
    var data = JSON.parse(result.body);
    summary  = (data.fields && data.fields.summary) || parentKey;
  }
  return { key: parentKey, summary: summary, issues: fetchChildIssues(parentKey) };
}

/**
 * Fetches a specific list of issue keys directly (flat mode).
 * Returns an array of issue records in the order specified (then sorted if configured).
 */
function fetchFlatIssues(keys) {
  if (!keys || keys.length === 0) return [];
  var fields = jiraFieldsForColumns();
  var jql    = 'issuekey in (' + keys.join(',') + ')';
  var result = jiraSearch(jql, fields, keys.length + 10);
  if (result.code !== 200) {
    Logger.log('fetchFlatIssues failed: HTTP ' + result.code);
    return [];
  }
  var data = JSON.parse(result.body);
  return sortIssues((data.issues || []).map(mapIssue));
}

// ── Dependency Analysis ───────────────────────────────────────────────────────

/**
 * Fetches a single issue with expanded issuelinks.
 * Returns the issue with a normalized links array.
 */
function fetchIssueWithLinks(issueKey, fields) {
  if (!fields) fields = jiraFieldsForColumns();

  // Ensure issuelinks is included in the fields list (required for expand to work)
  var fieldsWithLinks = fields.slice(); // copy array
  if (fieldsWithLinks.indexOf('issuelinks') === -1) {
    fieldsWithLinks.push('issuelinks');
  }

  var cfg    = getConfig();
  var path   = '/rest/api/3/issue/' + issueKey + '?fields=' + fieldsWithLinks.join(',') +
               '&expand=issuelinks';
  var result = jiraGet(path);

  if (result.code !== 200) {
    Logger.log('fetchIssueWithLinks failed for ' + issueKey + ': HTTP ' + result.code);
    return null;
  }

  var raw = JSON.parse(result.body);
  var issue = mapIssue(raw);

  // Normalize issuelinks into { type, direction, linkedIssue } format
  var links = [];
  var rawLinks = raw.fields.issuelinks || [];

  rawLinks.forEach(function(link) {
    var type = link.type ? link.type.name : 'unknown';
    if (link.outwardIssue) {
      links.push({
        type: type,
        direction: 'outward',
        linkedIssue: link.outwardIssue
      });
    }
    if (link.inwardIssue) {
      links.push({
        type: type,
        direction: 'inward',
        linkedIssue: link.inwardIssue
      });
    }
  });

  issue.links = links;

  // Log what we found
  if (links.length > 0) {
    Logger.log('  → Found ' + links.length + ' link(s) for ' + issueKey + ':');
    links.forEach(function(link) {
      Logger.log('    - ' + link.direction + ' "' + link.type + '" → ' + link.linkedIssue.key);
    });
  } else {
    Logger.log('  → No links found for ' + issueKey);
  }

  return issue;
}

/**
 * Recursively fetches linked issues up to maxDepth levels.
 * Filters linked issues by cutoffDate (only include if updated >= cutoffDate).
 * Returns { nodes: [issueRecords], links: [{from, to, type, direction}] }.
 */
function fetchDependencyTree(rootKey, maxDepth, cutoffDate, visitedKeys) {
  if (visitedKeys[rootKey]) {
    return { nodes: [], links: [] };
  }

  visitedKeys[rootKey] = true;
  var rootIssue = fetchIssueWithLinks(rootKey);

  if (!rootIssue) {
    return { nodes: [], links: [] };
  }

  var allNodes = [rootIssue];
  var allLinks = [];

  // At depth 0, return the issue itself but don't recurse further.
  // Callers use the returned nodes to check the cutoff date.
  if (maxDepth === 0) {
    return { nodes: allNodes, links: allLinks };
  }

  var totalLinks = (rootIssue.links || []).length;
  var processedCount = 0;
  var skippedOldCount = 0;
  var skippedVisitedCount = 0;

  // Process each link - fetch full details first, then filter by date
  (rootIssue.links || []).forEach(function(link) {
    var linkedKey = link.linkedIssue.key;

    // Skip if already visited (cycle prevention)
    if (visitedKeys[linkedKey]) {
      skippedVisitedCount++;
      Logger.log('  ✗ Skipping ' + linkedKey + ' - already visited (cycle prevention)');
      return;
    }

    // Recursively fetch the linked issue (this gets full details including updated field)
    var childTree = fetchDependencyTree(linkedKey, maxDepth - 1, cutoffDate, visitedKeys);

    // Check if we got the linked issue and if it passes the date filter
    if (childTree.nodes && childTree.nodes.length > 0) {
      var linkedIssue = childTree.nodes[0]; // First node is the issue itself

      // Check updated date
      if (linkedIssue.fields && linkedIssue.fields.updated) {
        var updatedDate = new Date(linkedIssue.fields.updated);
        if (updatedDate < cutoffDate) {
          var daysAgo = Math.floor((Date.now() - updatedDate.getTime()) / (24 * 60 * 60 * 1000));
          Logger.log('  ✗ Skipping ' + linkedKey + ' - updated ' + daysAgo + ' days ago (cutoff: ' +
                     Math.floor((Date.now() - cutoffDate.getTime()) / (24 * 60 * 60 * 1000)) + ' days)');
          skippedOldCount++;
          return;
        }
      }

      // Include this link and its subtree
      allLinks.push({
        from: rootKey,
        to: linkedKey,
        type: link.type,
        direction: link.direction
      });
      allNodes = allNodes.concat(childTree.nodes);
      allLinks = allLinks.concat(childTree.links);
      processedCount++;
    }
  });

  if (totalLinks > 0) {
    Logger.log('  → Processed ' + processedCount + ' of ' + totalLinks + ' links ' +
               '(skipped: ' + skippedOldCount + ' old, ' + skippedVisitedCount + ' visited) ' +
               '(depth=' + maxDepth + ')');
  }

  // Also discover child issues (parent = rootKey)
  var childSearchResult = jiraSearch('parent = ' + rootKey, ['summary', 'updated'], 100);
  if (childSearchResult.code === 200) {
    var childData = JSON.parse(childSearchResult.body);
    var childIssues = childData.issues || [];
    if (childIssues.length > 0) {
      Logger.log('  → Found ' + childIssues.length + ' child issue(s) for ' + rootKey);
    }
    childIssues.forEach(function(rawChild) {
      var childKey = rawChild.key;
      if (visitedKeys[childKey]) {
        Logger.log('  ✗ Skipping child ' + childKey + ' - already visited (cycle prevention)');
        return;
      }

      var childTree = fetchDependencyTree(childKey, maxDepth - 1, cutoffDate, visitedKeys);

      if (childTree.nodes && childTree.nodes.length > 0) {
        var childIssue = childTree.nodes[0];

        // Check updated date
        if (childIssue.fields && childIssue.fields.updated) {
          var updatedDate = new Date(childIssue.fields.updated);
          if (updatedDate < cutoffDate) {
            var daysAgo = Math.floor((Date.now() - updatedDate.getTime()) / (24 * 60 * 60 * 1000));
            Logger.log('  ✗ Skipping child ' + childKey + ' - updated ' + daysAgo + ' days ago');
            return;
          }
        }

        allLinks.push({ from: rootKey, to: childKey, type: 'child', direction: 'outward' });
        allNodes = allNodes.concat(childTree.nodes);
        allLinks = allLinks.concat(childTree.links);
      }
    });
  }

  return { nodes: allNodes, links: allLinks };
}

/**
 * Builds dependency trees for all issues in the array.
 * Returns { [issueKey]: depTree }.
 */
function buildDependencyTreeForIssues(issues, config) {
  var cutoffDate = new Date(Date.now() - (config.cutoffDays * 24 * 60 * 60 * 1000));
  Logger.log('Dependency analysis: cutoff date = ' + cutoffDate.toISOString() +
             ' (last ' + config.cutoffDays + ' days, maxDepth=' + config.maxDepth + ')');

  var cache = {};

  issues.forEach(function(issue) {
    Logger.log('Building dependency tree for ' + issue.key + '...');
    var visitedKeys = {};
    var depTree = fetchDependencyTree(issue.key, config.maxDepth, cutoffDate, visitedKeys);
    cache[issue.key] = depTree;

    // Summary for this issue
    var nodeCount = depTree.nodes ? depTree.nodes.length : 0;
    var linkCount = depTree.links ? depTree.links.length : 0;
    Logger.log('  ✓ ' + issue.key + ': found ' + (nodeCount - 1) + ' linked issue(s), ' + linkCount + ' link(s)');
    if (nodeCount > 1) {
      depTree.nodes.forEach(function(node) {
        if (node.key !== issue.key) {
          Logger.log('    • ' + node.key + ' - ' + node.summary.substring(0, 60));
        }
      });
    }
  });

  return cache;
}

// ── OKR document builder ──────────────────────────────────────────────────────

/**
 * Sets text in a cell with automatic hyperlinking of Jira ticket keys.
 * Finds patterns like PROJ-123, ABC-456, etc. and converts them to clickable links.
 */
function setTextWithTicketLinks(cell, text) {
  if (!text) {
    cell.setText('');
    return;
  }

  var cfg = getConfig();
  var baseUrl = cfg.baseUrl;

  // Regex to match Jira ticket keys: 1+ uppercase letters, dash, 1+ digits
  // Matches: PROJ-123, ABC-456, INFOKR-27, etc.
  var ticketKeyRegex = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

  // Find all ticket keys and their positions
  var matches = [];
  var match;
  while ((match = ticketKeyRegex.exec(text)) !== null) {
    matches.push({
      key: match[1],
      start: match.index,
      end: match.index + match[1].length
    });
  }

  // Set the text first
  var t = cell.editAsText();
  t.setText(text);

  // Apply links to each ticket key
  matches.forEach(function(m) {
    var url = baseUrl + '/browse/' + m.key;
    t.setLinkUrl(m.start, m.end - 1, url);
  });
}

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

    case 'secondLatestComment':
      var meta2 = commentCache[kr.key + ':2'];
      writeBlocksToCell(cell, meta2 ? meta2.blocks : getLatestCommentMeta(kr.key, 1).blocks);
      break;

    case 'status':
      cell.setText(extractFieldText(kr.fields && kr.fields.status));
      break;

    case 'priority':
      cell.setText(extractFieldText(kr.fields && kr.fields.priority));
      break;

    case 'dependencySummary':
      var summaryCache = commentCache._depSummaries || {};
      var summaryText = summaryCache[kr.key] || '(dependency analysis not available)';
      // Auto-link ticket keys in the summary
      setTextWithTicketLinks(cell, summaryText);
      break;

    default:
      // Generic Jira field — render as plain text
      cell.setText(extractFieldText(kr.fields && kr.fields[col.field]));
      break;
  }
}

/**
 * Appends a styled table of issues to the document body.
 */
function appendIssueTable(body, issues, columns, style, commentCache) {
  var table     = body.appendTable();
  var headerRow = table.appendTableRow();

  columns.forEach(function(col) {
    var cell = headerRow.appendTableCell(col.heading);
    cell.setBackgroundColor(style.headerBgColor);
    var t = cell.editAsText();
    t.setBold(0, col.heading.length - 1, true);
    t.setForegroundColor(0, col.heading.length - 1, style.headerTextColor);
  });

  columns.forEach(function(col, idx) {
    if (col.width) try { table.setColumnWidth(idx, col.width); } catch(e) {}
  });

  issues.forEach(function(issue) {
    var row = table.appendTableRow();
    columns.forEach(function(col) {
      renderCell(row.appendTableCell(''), col, issue, commentCache);
    });
  });
}

/**
 * Clears the document and builds tables according to CONFIG.tables.
 *
 * Two table entry modes:
 *   { parentKeys: [...], title? } — one heading + table per parent; rows are child issues
 *   { keys: [...],       title  } — one heading + flat table; rows are the listed issues
 */
function buildTables() {
  var tableConfigs = CONFIG.tables;

  if (!tableConfigs || tableConfigs.length === 0) {
    DocumentApp.getUi().alert('No tables configured.\nEdit the tables array in Config.gs.');
    return;
  }

  var columns = CONFIG.columns || [
    { heading: 'Summary',      width: 175, field: 'summary'       },
    { heading: 'Assignee',     width: 75,  field: 'assignee'      },
    { heading: 'Last Comment', width: 600, field: 'latestComment' },
  ];

  var doc   = DocumentApp.getActiveDocument();
  var style = CONFIG.style;
  var body  = doc.getBody();

  body.clear();
  var tz      = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(new Date(), tz, "MMM d, yyyy h:mm a '(" + tz + ")'");
  body.appendParagraph(dateStr).setHeading(DocumentApp.ParagraphHeading.HEADING1);

  // ── Fetch all data up front ──────────────────────────────────────────────────
  // Normalise each table config into a list of { heading, issues } sections.
  var allSections = [];  // [{ heading: str|null, issues: [...] }]

  tableConfigs.forEach(function(tbl) {
    if (tbl.parentKeys && tbl.parentKeys.length > 0) {
      // Parent/child mode — one section per parent key
      tbl.parentKeys.forEach(function(parentKey) {
        Logger.log('Fetching children of ' + parentKey + '...');
        var parentData = fetchParentData(parentKey);
        var heading = parentData.key + ': ' + parentData.summary;
        allSections.push({ heading: heading, headingKey: parentKey, issues: parentData.issues });
      });
    } else if (tbl.keys && tbl.keys.length > 0) {
      // Flat list mode — one section for the whole entry
      Logger.log('Fetching flat list: ' + tbl.keys.join(', '));
      var issues = fetchFlatIssues(tbl.keys);
      allSections.push({ heading: tbl.title || null, headingKey: null, issues: issues });
    }
  });

  // ── Comment cache + AI/attention summary ─────────────────────────────────────
  // Build a unified issue list for the cache (mimics the old allObjectiveData shape)
  var allIssueGroups = allSections.map(function(s) {
    return { summary: s.heading || '', krs: s.issues };
  });

  var commentCache   = buildCommentCache(allIssueGroups);
  var attentionItems = buildAttentionItems(allIssueGroups, commentCache);

  // ── Dependency analysis (if enabled) ──────────────────────────────────────────
  var depSummaryCache = {};
  if (CONFIG.dependencyAnalysis && CONFIG.dependencyAnalysis.enabled) {
    // Check if any column uses dependencySummary
    var needsDepAnalysis = columns.some(function(col) {
      return col.field === 'dependencySummary';
    });

    if (needsDepAnalysis) {
      Logger.log('Building dependency trees...');

      // Collect all issues across all sections
      var allIssues = [];
      allSections.forEach(function(s) { allIssues = allIssues.concat(s.issues); });

      // Build dependency trees
      var depTreeCache = buildDependencyTreeForIssues(allIssues, {
        maxDepth: CONFIG.dependencyAnalysis.maxDepth,
        cutoffDays: CONFIG.dependencyAnalysis.cutoffDays
      });

      // Extend comment cache to include linked issues
      Logger.log('Fetching comments for linked dependencies...');
      var linkedIssueKeys = [];
      Object.keys(depTreeCache).forEach(function(rootKey) {
        var depTree = depTreeCache[rootKey];
        (depTree.nodes || []).forEach(function(node) {
          if (node.key !== rootKey && !commentCache[node.key]) {
            linkedIssueKeys.push(node.key);
          }
        });
      });

      // Fetch comments for linked issues
      if (linkedIssueKeys.length > 0) {
        Logger.log('  → Fetching comments for ' + linkedIssueKeys.length + ' linked issue(s)');
        linkedIssueKeys.forEach(function(key) {
          commentCache[key] = getLatestCommentMeta(key);
        });
      }

      // Build digests and separate issues with/without dependencies
      var depDigests = [];
      allIssues.forEach(function(issue) {
        var depTree = depTreeCache[issue.key] || { nodes: [], links: [] };

        // Check if there are actual linked issues (not just the root)
        if (depTree.nodes && depTree.nodes.length > 1) {
          depDigests.push({
            key: issue.key,
            digest: buildDependencyDigest(issue, depTree, commentCache)
          });
        } else {
          // No dependencies - set simple message without calling AI
          depSummaryCache[issue.key] = '(no linked dependencies)';
        }
      });

      // Generate AI summaries for issues with dependencies (batched)
      if (depDigests.length > 0) {
        var aiSummaries = generateBatchedTicketSummaries(depDigests);
        // Merge AI summaries into the cache
        Object.keys(aiSummaries).forEach(function(key) {
          depSummaryCache[key] = aiSummaries[key];
        });
      }

      Logger.log('Dependency analysis complete: ' + depDigests.length + ' AI summaries generated, ' +
                 (allIssues.length - depDigests.length) + ' tickets without dependencies');
    }
  }

  // Store in commentCache for renderCell access
  commentCache._depSummaries = depSummaryCache;

  if (CONFIG.aiSummary && CONFIG.aiSummary.enabled) {
    var digest      = buildCommentDigest(allIssueGroups, commentCache);
    var summaryText = generateAiSummary(digest);
    writeSummaryToDoc(body, summaryText || '', attentionItems);
  } else if (attentionItems.length > 0) {
    writeSummaryToDoc(body, '', attentionItems);
  }

  // ── Render sections ───────────────────────────────────────────────────────────
  var cfg        = getConfig();
  var tableCount = 0;

  allSections.forEach(function(section) {
    // Heading
    if (section.heading) {
      var headingPara = body.appendParagraph('');
      headingPara.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      var ht = headingPara.editAsText();
      ht.setText(section.heading);
      // Hyperlink just the key portion when we have one
      if (section.headingKey) {
        var url = cfg.baseUrl + '/browse/' + section.headingKey;
        ht.setLinkUrl(0, section.headingKey.length - 1, url);
      }
    }

    if (section.issues.length === 0) {
      body.appendParagraph('(no issues found)').setItalic(true);
      body.appendParagraph('');
      return;
    }

    appendIssueTable(body, section.issues, columns, style, commentCache);
    body.appendParagraph('');
    tableCount++;
  });

  DocumentApp.getUi().alert('Done. Built ' + tableCount + ' table(s).');
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
  var text = (data.content && data.content[0] && data.content[0].text) || null;
  if (!text) Logger.log('Claude API returned no text. Response: ' + response.getContentText());
  else Logger.log('Claude API success (' + text.length + ' chars)');
  return text;
}

/**
 * Generates AI summaries for multiple tickets in batched Claude API calls.
 * Takes array of { key, digest } objects and returns { [ticketKey]: summaryText }.
 */
function generateBatchedTicketSummaries(depDigests) {
  if (!depDigests || depDigests.length === 0) return {};

  var depAnalysis = CONFIG.dependencyAnalysis;
  if (!depAnalysis || !depAnalysis.enabled) return {};

  var props = PropertiesService.getUserProperties();
  var claudeKey = props.getProperty('CLAUDE_API_KEY');
  if (!claudeKey) {
    Logger.log('Dependency analysis skipped: CLAUDE_API_KEY not set.');
    return {};
  }

  // Determine which model to use
  var model;
  if (depAnalysis.model && depAnalysis.model !== 'default') {
    // Use model specified in dependencyAnalysis config
    model = depAnalysis.model;
  } else {
    // Use model from aiSummary config, or fallback to claude-opus-4-6
    model = (CONFIG.aiSummary && CONFIG.aiSummary.model) || 'claude-opus-4-6';
  }

  var prompt = depAnalysis.prompt || 'Analyze this ticket and its dependencies.';

  Logger.log('Using Claude model for dependency analysis: ' + model);

  var results = {};
  var batchSize = 10;

  // Process in batches
  for (var i = 0; i < depDigests.length; i += batchSize) {
    var batch = depDigests.slice(i, i + batchSize);
    Logger.log('Processing dependency summaries batch ' + (Math.floor(i / batchSize) + 1) +
               ' (' + batch.length + ' tickets)...');

    // Build batched prompt
    var batchPrompt = 'Analyze the following tickets. For each ticket, respond with:\n' +
                      'TICKET:[ticket-key]\n' +
                      'SUMMARY:[your 2-3 sentence summary]\n\n' +
                      'IMPORTANT: In your summary, reference specific ticket keys (like PROJ-123) when mentioning progress, blockers, or risks. ' +
                      'These will be automatically converted to clickable links.\n\n' +
                      prompt + '\n\n';

    batch.forEach(function(item) {
      batchPrompt += '--- Ticket: ' + item.key + ' ---\n';
      batchPrompt += item.digest + '\n\n';
    });

    // Log the full prompt for debugging
    Logger.log('Dependency analysis prompt for batch ' + (Math.floor(i / batchSize) + 1) + ':');
    Logger.log('--- PROMPT START ---');
    Logger.log(batchPrompt);
    Logger.log('--- PROMPT END ---');
    Logger.log('Prompt length: ' + batchPrompt.length + ' characters');

    var payload = JSON.stringify({
      model: model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: batchPrompt }]
    });

    try {
      var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        payload: payload,
        muteHttpExceptions: true
      });

      var code = response.getResponseCode();
      if (code !== 200) {
        Logger.log('Claude API error for batch: HTTP ' + code + '\n' + response.getContentText());
        // Mark all tickets in this batch as unavailable
        batch.forEach(function(item) {
          results[item.key] = '(AI summary unavailable)';
        });
        continue;
      }

      var data = JSON.parse(response.getContentText());
      var text = (data.content && data.content[0] && data.content[0].text) || '';

      // Log Claude's response
      Logger.log('Claude API response:');
      Logger.log('--- RESPONSE START ---');
      Logger.log(text);
      Logger.log('--- RESPONSE END ---');

      // Parse the batched response
      var batchResults = parseTicketSummaries(text);

      // Merge into results
      batch.forEach(function(item) {
        results[item.key] = batchResults[item.key] || '(summary not found in response)';
      });

      Logger.log('Batch processed successfully - extracted summaries for: ' + Object.keys(batchResults).join(', '));
    } catch (e) {
      Logger.log('Error calling Claude API for batch: ' + e.toString());
      batch.forEach(function(item) {
        results[item.key] = '(error generating summary)';
      });
    }
  }

  return results;
}

/**
 * Parses Claude's batched ticket summary response.
 * Expected format: TICKET:[KEY]\nSUMMARY:[text]
 */
function parseTicketSummaries(claudeResponse) {
  var results = {};
  if (!claudeResponse) return results;

  var lines = claudeResponse.split('\n');
  var currentTicket = null;
  var currentSummary = [];

  lines.forEach(function(line) {
    var ticketMatch = line.match(/^TICKET:\s*(.+)$/);
    var summaryMatch = line.match(/^SUMMARY:\s*(.+)$/);

    if (ticketMatch) {
      // Save previous ticket if exists
      if (currentTicket) {
        results[currentTicket] = currentSummary.join(' ').trim();
      }
      // Start new ticket
      currentTicket = ticketMatch[1].trim();
      currentSummary = [];
    } else if (summaryMatch && currentTicket) {
      currentSummary.push(summaryMatch[1].trim());
    } else if (currentTicket && line.trim() && !line.match(/^---/)) {
      // Continue multi-line summary
      currentSummary.push(line.trim());
    }
  });

  // Save last ticket
  if (currentTicket) {
    results[currentTicket] = currentSummary.join(' ').trim();
  }

  return results;
}

/**
 * Fetches comment metadata for every issue across all groups exactly once.
 * Returns a plain object keyed by ticket key: { blocks, date }
 */
function buildCommentCache(objectiveDataList) {
  var cache = {};
  var needsSecond = (CONFIG.columns || []).some(function(col) { return col.field === 'secondLatestComment'; });
  objectiveDataList.forEach(function(obj) {
    obj.krs.forEach(function(kr) {
      if (!cache[kr.key]) cache[kr.key] = getLatestCommentMeta(kr.key);
      if (needsSecond && !cache[kr.key + ':2']) cache[kr.key + ':2'] = getLatestCommentMeta(kr.key, 1);
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
 * Converts a dependency tree to text format for AI consumption.
 * Includes root ticket metadata and linked issues organized by level.
 */
function buildDependencyDigest(rootIssue, depTree, commentCache) {
  var lines = [];

  // Root ticket info
  lines.push('Root Ticket: ' + rootIssue.key + ' - ' + rootIssue.summary);
  if (rootIssue.fields.status) {
    lines.push('Status: ' + (rootIssue.fields.status.name || 'Unknown'));
  }
  lines.push('Assignee: ' + rootIssue.assigneeName);
  if (rootIssue.fields.updated) {
    lines.push('Updated: ' + rootIssue.fields.updated);
  }
  lines.push('');

  // If no linked issues, note that
  if (!depTree.nodes || depTree.nodes.length <= 1) {
    lines.push('No linked issues found with recent updates.');
    return lines.join('\n');
  }

  lines.push('Linked Issues (updated in last ' + (CONFIG.dependencyAnalysis.cutoffDays || 14) + ' days):');
  lines.push('');

  // Build a map of issue key to depth
  var depthMap = {};
  depthMap[rootIssue.key] = 0;

  // BFS to calculate depths
  var queue = [rootIssue.key];
  while (queue.length > 0) {
    var currentKey = queue.shift();
    var currentDepth = depthMap[currentKey];

    (depTree.links || []).forEach(function(link) {
      if (link.from === currentKey && !depthMap[link.to]) {
        depthMap[link.to] = currentDepth + 1;
        queue.push(link.to);
      }
    });
  }

  // Group nodes by depth
  var nodesByDepth = {};
  (depTree.nodes || []).forEach(function(node) {
    if (node.key === rootIssue.key) return; // Skip root
    var depth = depthMap[node.key] || 1;
    if (!nodesByDepth[depth]) nodesByDepth[depth] = [];
    nodesByDepth[depth].push(node);
  });

  // Output nodes by depth
  Object.keys(nodesByDepth).sort().forEach(function(depth) {
    nodesByDepth[depth].forEach(function(node) {
      // Find the link type for this node
      var linkType = 'linked';
      var parentKey = null;
      (depTree.links || []).forEach(function(link) {
        if (link.to === node.key) {
          linkType = link.type;
          parentKey = link.from;
        }
      });

      var prefix = 'Level ' + depth + ' - ' + linkType;
      if (depth > 1 && parentKey) {
        prefix += ' (via ' + parentKey + ')';
      }
      prefix += ' - ' + node.key + ': ' + node.summary;
      lines.push(prefix);

      // Add metadata
      var meta = [];
      if (node.fields.status) meta.push('Status: ' + node.fields.status.name);
      meta.push('Assignee: ' + node.assigneeName);
      if (node.fields.updated) meta.push('Updated: ' + node.fields.updated);
      lines.push('  ' + meta.join(' | '));

      // Add comment if available
      if (commentCache && commentCache[node.key]) {
        var commentMeta = commentCache[node.key];
        var commentText = commentMeta.blocks.map(function(block) {
          return block.segments.map(function(s) { return s.text; }).join('');
        }).join(' ').trim();
        if (commentText) {
          // Truncate long comments
          if (commentText.length > 200) commentText = commentText.substring(0, 200) + '...';
          lines.push('  Latest comment: ' + commentText);
        }
      }
      lines.push('');
    });
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
    .addItem('Build tables',                 'buildTables')
    .addSeparator()
    .addItem('Configure Jira credentials',   'configureCredentials')
    .addItem('Configure Claude API key',     'configureClaudeKey')
    .addToUi();
}
