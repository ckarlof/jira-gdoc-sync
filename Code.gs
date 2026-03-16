// Jira -> Google Doc table sync
// Credentials are stored via Jira Sync > Configure credentials (never hardcoded).

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfig() {
  var props = PropertiesService.getUserProperties();
  var baseUrl = props.getProperty('JIRA_BASE_URL');
  var email   = props.getProperty('JIRA_EMAIL');
  var token   = props.getProperty('JIRA_API_TOKEN');
  if (!baseUrl || !email || !token) {
    throw new Error('Jira credentials not set. Use Jira Sync > Configure credentials.');
  }
  return { baseUrl: baseUrl, email: email, token: token };
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
 * Applies rich-text formatting from segments onto a Text object.
 */
function applySegmentsToText(t, segments) {
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

function getLatestComment(ticketId) {
  var EMPTY = { bold: false, italic: false, underline: false,
                strike: false, code: false, url: null, bgColor: null, fgColor: null };
  var result = jiraGet('/rest/api/3/issue/' + ticketId + '/comment?orderBy=-created&maxResults=1');
  if (result.code !== 200)
    return [{ type: 'para', segments: [Object.assign({ text: 'Error ' + result.code }, EMPTY)] }];
  var data = JSON.parse(result.body);
  if (!data.comments || data.comments.length === 0)
    return [{ type: 'para', segments: [Object.assign({ text: '(no comments)' }, EMPTY)] }];
  var c      = data.comments[0];
  var author = c.author ? c.author.displayName : 'Unknown';
  var date   = c.created ? c.created.substring(0, 10) : '';
  var header = { type: 'para',
                 segments: [Object.assign({ text: '[' + author + ', ' + date + ']' },
                                          EMPTY, { bold: true })] };
  return [header].concat(adfToBlocks(c.body));
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
 * Fetches child issues of an objective. Tries multiple JQL strategies,
 * including querying by numeric issue ID which works when key-based queries fail.
 */
function fetchChildren(objectiveKey) {
  var cfg = getConfig();

  var strategies = [
    'parent = ' + objectiveKey + ' ORDER BY created ASC',
    'issuekey in childIssuesOf("' + objectiveKey + '") ORDER BY created ASC',
  ];

  for (var i = 0; i < strategies.length; i++) {
    var result = jiraSearch(strategies[i], ['summary', 'assignee'], 50);
    Logger.log('[' + strategies[i] + '] → HTTP ' + result.code +
               (result.code === 200 ? ', total=' + JSON.parse(result.body).total : ''));
    if (result.code !== 200) continue;
    var data = JSON.parse(result.body);
    if (!data.issues || data.issues.length === 0) continue;

    Logger.log(objectiveKey + ': found ' + data.issues.length + ' KR(s) via [' + strategies[i] + ']');
    return data.issues.map(function(issue) {
      return {
        key:          issue.key,
        summary:      (issue.fields && issue.fields.summary) || '(no summary)',
        url:          cfg.baseUrl + '/browse/' + issue.key,
        assigneeName: (issue.fields && issue.fields.assignee)
                        ? issue.fields.assignee.displayName : 'Unassigned'
      };
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

// ── Table styling ─────────────────────────────────────────────────────────────

var DEFAULT_STYLE = {
  headerBgColor:   '#073763',  // dark blue
  headerTextColor: '#FFFFFF',  // white
  colWidths:       [175, 75, 600]  // points: Summary, Assignee, Last Comment
};

function getStyle() {
  var stored = PropertiesService.getUserProperties().getProperty('TABLE_STYLE');
  if (!stored) return DEFAULT_STYLE;
  try {
    var p = JSON.parse(stored);
    return {
      headerBgColor:   p.headerBgColor   || DEFAULT_STYLE.headerBgColor,
      headerTextColor: p.headerTextColor || DEFAULT_STYLE.headerTextColor,
      colWidths:       (p.colWidths && p.colWidths.length) ? p.colWidths : DEFAULT_STYLE.colWidths
    };
  } catch(e) { return DEFAULT_STYLE; }
}

function configureStyle() {
  var ui    = DocumentApp.getUi();
  var style = getStyle();

  var fields = [
    { key: 'headerBgColor',   label: 'Header background color', current: style.headerBgColor },
    { key: 'headerTextColor', label: 'Header text color',        current: style.headerTextColor },
  ];

  var newStyle = {};
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var r = ui.prompt(f.label, 'Current: ' + f.current + '\nEnter hex color e.g. #073763', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var val = r.getResponseText().trim();
    newStyle[f.key] = val !== '' ? val : f.current;
  }

  var widthPrompt = ui.prompt(
    'Column widths (points)',
    'Comma-separated: Summary, Assignee, Last Comment\nCurrent: ' + style.colWidths.join(', ') + '\n(72 pts = 1 inch)',
    ui.ButtonSet.OK_CANCEL
  );
  if (widthPrompt.getSelectedButton() !== ui.Button.OK) return;
  var widthInput = widthPrompt.getResponseText().trim();
  newStyle.colWidths = widthInput
    ? widthInput.split(',').map(function(w) { return parseInt(w.trim(), 10) || 150; })
    : style.colWidths;

  PropertiesService.getUserProperties().setProperty('TABLE_STYLE', JSON.stringify(newStyle));
  ui.alert('Style saved. Rebuild tables to apply.');
}


// ── OKR document builder ──────────────────────────────────────────────────────

var HEADER_COLS = ['Summary', 'Assignee', 'Last Comment'];

/**
 * Clears the document and builds one table per objective.
 * Each table row represents a KR (child ticket) of that objective.
 */
function buildOKRTables() {
  var props         = PropertiesService.getUserProperties();
  var keysRaw       = props.getProperty('OBJECTIVE_KEYS') || '';
  var objectiveKeys = keysRaw.split(',').map(function(k) { return k.trim(); })
                             .filter(function(k) { return k.length > 0; });

  if (objectiveKeys.length === 0) {
    DocumentApp.getUi().alert('No objective keys configured.\nUse Jira Sync > Configure objectives.');
    return;
  }

  var doc   = DocumentApp.getActiveDocument();
  var body  = doc.getBody();
  var style = getStyle();
  body.clear();

  objectiveKeys.forEach(function(objectiveKey) {
    Logger.log('Building table for ' + objectiveKey + '...');
    var data = fetchObjectiveData(objectiveKey);

    var headingText = objectiveKey + ': ' + data.summary;
    body.appendParagraph(headingText)
        .setHeading(DocumentApp.ParagraphHeading.HEADING2);

    if (data.krs.length === 0) {
      body.appendParagraph('(no KRs found)').setItalic(true);
      body.appendParagraph('');
      return;
    }

    var table = body.appendTable();

    // Header row
    var headerRow = table.appendTableRow();
    HEADER_COLS.forEach(function(label) {
      var cell = headerRow.appendTableCell(label);
      cell.setBackgroundColor(style.headerBgColor);
      var t = cell.editAsText();
      t.setBold(0, label.length - 1, true);
      t.setForegroundColor(0, label.length - 1, style.headerTextColor);
    });

    // Set column widths
    style.colWidths.forEach(function(width, idx) {
      if (idx < HEADER_COLS.length) {
        try { table.setColumnWidth(idx, width); } catch(e) {}
      }
    });

    // One row per KR
    data.krs.forEach(function(kr) {
      var row = table.appendTableRow();

      // Col 1: KR summary as hyperlink to Jira
      var summaryCell = row.appendTableCell('');
      var t = summaryCell.editAsText();
      t.setText(kr.summary);
      t.setLinkUrl(0, kr.summary.length - 1, kr.url);

      // Col 2: Assignee
      row.appendTableCell(kr.assigneeName);

      // Col 3: Latest comment with rich formatting
      var commentCell = row.appendTableCell('');
      writeBlocksToCell(commentCell, getLatestComment(kr.key));
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

// ── Credentials setup ─────────────────────────────────────────────────────────

function configureCredentials() {
  var ui    = DocumentApp.getUi();
  var props = PropertiesService.getUserProperties();

  var baseUrl = ui.prompt('Jira Base URL', 'e.g. https://mycompany.atlassian.net', ui.ButtonSet.OK_CANCEL);
  if (baseUrl.getSelectedButton() !== ui.Button.OK) return;

  var email = ui.prompt('Jira Email', 'Your Atlassian account email', ui.ButtonSet.OK_CANCEL);
  if (email.getSelectedButton() !== ui.Button.OK) return;

  var token = ui.prompt('Jira API Token', 'Paste your API token', ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK) return;

  props.setProperty('JIRA_BASE_URL',  baseUrl.getResponseText().trim());
  props.setProperty('JIRA_EMAIL',     email.getResponseText().trim());
  props.setProperty('JIRA_API_TOKEN', token.getResponseText().trim());

  ui.alert('Credentials saved. Run "Verify API token" to confirm they work.');
}

function configureObjectives() {
  var ui    = DocumentApp.getUi();
  var props = PropertiesService.getUserProperties();
  var current = props.getProperty('OBJECTIVE_KEYS') || '';

  var result = ui.prompt(
    'Configure Objective Keys',
    'Enter Jira objective keys separated by commas (current: ' + (current || 'none') + ')\n' +
    'e.g. INFOKR-1, INFOKR-5, INFOKR-12',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;

  props.setProperty('OBJECTIVE_KEYS', result.getResponseText().trim());
  ui.alert('Saved. Run "Build OKR tables" to regenerate the document.');
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Jira Sync')
    .addItem('Build OKR tables', 'buildOKRTables')
    .addItem('Verify API token', 'verifyJiraToken')
    .addSeparator()
    .addItem('Configure objectives', 'configureObjectives')
    .addItem('Configure credentials', 'configureCredentials')
    .addItem('Configure style', 'configureStyle')
    .addSeparator()
    .addItem('Debug objective (INFOKR-1)', 'debugObjective')
    .addItem('Debug KR (INFOKR-7)', 'debugKR')
    .addToUi();
}
