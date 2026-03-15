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

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Walks an ADF document and returns an array of segments:
 *   [{ text, bold, italic, underline, strike, code, url }, ...]
 * Marks are inherited from parent nodes down to text leaves.
 */
function adfToSegments(adfBody) {
  if (!adfBody || adfBody.version === undefined) {
    return [{ text: String(adfBody || ''), bold: false, italic: false,
              underline: false, strike: false, code: false, url: null }];
  }

  var segments = [];

  function pushText(text, marks) {
    if (!text) return;
    segments.push({
      text:      text,
      bold:      !!marks.bold,
      italic:    !!marks.italic,
      underline: !!marks.underline,
      strike:    !!marks.strike,
      code:      !!marks.code,
      url:       marks.url || null
    });
  }

  function mergeMark(marks, mark) {
    var m = { bold: marks.bold, italic: marks.italic, underline: marks.underline,
              strike: marks.strike, code: marks.code, url: marks.url };
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

  var BASE_MARKS = { bold: false, italic: false, underline: false,
                     strike: false, code: false, url: null };

  function walk(node, marks) {
    if (!node) return;
    switch (node.type) {
      case 'text': {
        var m = marks;
        (node.marks || []).forEach(function(mark) { m = mergeMark(m, mark); });
        pushText(node.text || '', m);
        return;
      }
      case 'hardBreak':
        pushText('\n', marks);
        return;
      case 'status':
        if (node.attrs && node.attrs.text) pushText(node.attrs.text, marks);
        return;
      case 'emoji':
        if (node.attrs && node.attrs.text) pushText(node.attrs.text, marks);
        else if (node.attrs && node.attrs.shortName) pushText(node.attrs.shortName, marks);
        return;
      case 'mention':
        if (node.attrs && node.attrs.text) pushText(node.attrs.text, marks);
        return;
      case 'inlineCard':
      case 'blockCard':
        if (node.attrs && node.attrs.url) pushText(node.attrs.url, marks);
        return;
      case 'rule':
        pushText('\n---\n', marks);
        return;
    }
    (node.content || []).forEach(function(child) { walk(child, marks); });
    if (['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
         'blockquote', 'codeBlock', 'panel'].indexOf(node.type) !== -1) {
      pushText('\n', BASE_MARKS);
    }
  }

  walk(adfBody, BASE_MARKS);

  // Trim leading/trailing newline segments
  while (segments.length && segments[0].text.trim() === '') segments.shift();
  while (segments.length && segments[segments.length - 1].text.trim() === '') segments.pop();
  return segments;
}

/**
 * Writes an array of styled segments into a table cell, preserving formatting.
 */
function writeSegmentsToCell(cell, segments) {
  cell.clear();
  var fullText = segments.map(function(s) { return s.text; }).join('');
  var t = cell.editAsText();
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
    pos += s.text.length;
  });
}

function getLatestComment(ticketId) {
  var result = jiraGet('/rest/api/3/issue/' + ticketId + '/comment?orderBy=-created&maxResults=1');
  if (result.code !== 200) return [{ text: 'Error ' + result.code, bold: false, italic: false,
                                     underline: false, strike: false, code: false, url: null }];
  var data = JSON.parse(result.body);
  if (!data.comments || data.comments.length === 0) {
    return [{ text: '(no comments)', bold: false, italic: false,
              underline: false, strike: false, code: false, url: null }];
  }
  var c      = data.comments[0];
  var author = c.author ? c.author.displayName : 'Unknown';
  var date   = c.created ? c.created.substring(0, 10) : '';
  var header = [{ text: '[' + author + ', ' + date + ']\n', bold: true, italic: false,
                  underline: false, strike: false, code: false, url: null }];
  return header.concat(adfToSegments(c.body));
}

// ── Core: fetch ticket summary ────────────────────────────────────────────────

function getTicketSummary(ticketId) {
  var result = jiraGet('/rest/api/3/issue/' + ticketId + '?fields=summary,assignee');

  if (result.code !== 200) {
    return { summary: 'Error ' + result.code, url: null, assignee: '' };
  }

  var data     = JSON.parse(result.body);
  var summary  = data.fields && data.fields.summary ? data.fields.summary : '(no summary)';
  var assignee = data.fields && data.fields.assignee ? data.fields.assignee.displayName : 'Unassigned';
  var cfg      = getConfig();
  var url      = cfg.baseUrl + '/browse/' + ticketId;

  return { summary: summary, url: url, assignee: assignee };
}

// ── Main: sync table in the active Google Doc ─────────────────────────────────

/**
 * Finds the first table in the document where column 1 contains Jira ticket IDs
 * (skipping the header row automatically), fetches each ticket's summary, and
 * writes it as a hyperlink back to the Jira ticket in column 2.
 */
function syncJiraComments() {
  var doc    = DocumentApp.getActiveDocument();
  var body   = doc.getBody();
  var tables = body.getTables();

  if (tables.length === 0) {
    DocumentApp.getUi().alert('No tables found in this document.');
    return;
  }

  var TICKET_RE = /^[A-Z]+-\d+$/;
  var table   = tables[0];
  var numRows = table.getNumRows();
  var updated = 0;

  for (var i = 0; i < numRows; i++) {
    var row = table.getRow(i);
    if (row.getNumCells() < 2) continue;

    var ticketId = row.getCell(0).getText().trim();
    if (!TICKET_RE.test(ticketId)) continue; // skips header and non-ticket rows

    Logger.log('Fetching summary for ' + ticketId + '...');
    var ticket = getTicketSummary(ticketId);

    var cell = row.getCell(1);
    cell.clear();
    var text = cell.editAsText();
    text.setText(ticket.summary);
    if (ticket.url) {
      text.setLinkUrl(0, ticket.summary.length - 1, ticket.url);
    }

    if (row.getNumCells() >= 3) {
      row.getCell(2).clear().editAsText().setText(ticket.assignee);
    }

    if (row.getNumCells() >= 4) {
      writeSegmentsToCell(row.getCell(3), getLatestComment(ticketId));
    }

    updated++;
  }

  DocumentApp.getUi().alert('Done. Updated ' + updated + ' row(s).');
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

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Jira Sync')
    .addItem('Sync ticket summaries', 'syncJiraComments')
    .addItem('Verify API token', 'verifyJiraToken')
    .addSeparator()
    .addItem('Configure credentials', 'configureCredentials')
    .addToUi();
}
