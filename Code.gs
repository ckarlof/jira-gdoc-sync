// Jira -> Google Doc table sync
// Credentials are loaded from Config.gs (gitignored).
// See Config.gs.example for the required variables.

// ── Helpers ──────────────────────────────────────────────────────────────────

function jiraAuthHeader() {
  return 'Basic ' + Utilities.base64Encode(JIRA_EMAIL + ':' + JIRA_API_TOKEN);
}

function jiraGet(path) {
  var response = UrlFetchApp.fetch(JIRA_BASE_URL + path, {
    method: 'GET',
    headers: { 'Authorization': jiraAuthHeader(), 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  return { code: response.getResponseCode(), body: response.getContentText() };
}

/**
 * Extracts plain text from a Jira Atlassian Document Format (ADF) body.
 * Falls back to raw string if the body is not ADF.
 */
function adfToText(body) {
  if (!body || body.version === undefined) return String(body || '');

  var parts = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'text') { parts.push(node.text || ''); return; }
    if (node.type === 'hardBreak') { parts.push('\n'); return; }
    (node.content || []).forEach(walk);
    // Add newline after block-level nodes so paragraphs are separated
    if (['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
         'blockquote', 'codeBlock', 'rule'].indexOf(node.type) !== -1) {
      parts.push('\n');
    }
  }
  walk(body);
  return parts.join('').trim();
}

// ── Core: fetch latest comment for one ticket ─────────────────────────────────

function getLatestComment(ticketId) {
  var result = jiraGet('/rest/api/3/issue/' + ticketId + '/comment?orderBy=-created&maxResults=1');

  if (result.code !== 200) {
    return 'Error ' + result.code + ': ' + result.body;
  }

  var data = JSON.parse(result.body);
  if (!data.comments || data.comments.length === 0) {
    return '(no comments)';
  }

  var comment = data.comments[0];
  var author  = comment.author ? comment.author.displayName : 'Unknown';
  var date    = comment.created ? comment.created.substring(0, 10) : '';
  var text    = adfToText(comment.body);

  return '[' + author + ', ' + date + ']\n' + text;
}

// ── Main: sync table in the active Google Doc ─────────────────────────────────

/**
 * Finds the first table in the document where column 1 contains Jira ticket IDs,
 * fetches the latest comment for each, and writes it to column 2.
 *
 * Ticket IDs are detected by the pattern: one or more uppercase letters,
 * a hyphen, and one or more digits (e.g. PROJ-123, BUG-4567).
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
  var table = tables[0]; // use the first table
  var numRows = table.getNumRows();
  var updated = 0;

  for (var i = 0; i < numRows; i++) {
    var row = table.getRow(i);
    if (row.getNumCells() < 2) continue;

    var ticketId = row.getCell(0).getText().trim();
    if (!TICKET_RE.test(ticketId)) continue; // skip header or non-ticket rows

    Logger.log('Fetching comment for ' + ticketId + '...');
    var comment = getLatestComment(ticketId);

    var cell = row.getCell(1);
    cell.clear();
    cell.setText(comment);
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

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Jira Sync')
    .addItem('Sync latest comments', 'syncJiraComments')
    .addItem('Verify API token', 'verifyJiraToken')
    .addToUi();
}
