// ── Configuration ─────────────────────────────────────────────────────────────
// Edit this file to configure the script for your Jira instance.
// Credentials (email + API token) are NOT stored here — use Jira Sync > Configure credentials.

var CONFIG = {
  jira: {
    baseUrl: 'https://mozilla-hub.atlassian.net'  // e.g. https://acme.atlassian.net
  },

  // Tables to build in the document. Each entry is one table (or group of tables).
  // Two modes:
  //
  // 1. Parent/child mode — one heading + table per parent ticket; rows are child issues:
  //      { parentKeys: ['PROJ-1', 'PROJ-2'] }
  //    The heading is always derived from the parent ticket's own summary (e.g. "PROJ-1: My Objective").
  //
  // 2. Flat list mode — one table for the whole entry; rows are the listed tickets directly:
  //      { title: 'My Table', keys: ['PROJ-10', 'PROJ-11', 'PROJ-12'] }
  //    'title' is required in flat mode (used as the heading above the table).
  //
  tables: [
    { parentKeys: ['INFOKR-1', 'INFOKR-3', 'INFOKR-5', 'INFOKR-6'] }
  ],

  // How issues are ordered within each table.
  // 'jira'  — keep the order Jira returns (default; typically creation order)
  // 'alpha' — sort alphabetically by summary, numeric-aware (e.g. KR2 before KR10)
  sortOrder: 'alpha',

  style: {
    headerBgColor:   '#15191d',  // dark blue
    headerTextColor: '#FFFFFF',  // white
  },

  // Table columns — defines heading label, width (points), and which Jira field to render.
  //
  // Built-in field values:
  //   'summary'        — KR summary text, hyperlinked to Jira
  //   'assignee'       — assignee display name (plain text)
  //   'latestComment'  — most recent comment with full rich-text formatting
  //   'status'         — issue status name (plain text)
  //   'priority'       — priority name (plain text)
  //
  // Any other value is treated as a raw Jira field name (e.g. 'customfield_10016')
  // and rendered as plain text.  The field must be a simple scalar or have a .name
  // or .value sub-property.
  columns: [
    { heading: 'Summary',      width: 175, field: 'summary'       },
    { heading: 'Assignee',     width: 75,  field: 'assignee'      },
    { heading: 'Last Comment', width: 600, field: 'latestComment' },
  ],

  // AI summary section — set enabled: true and configure your Claude API key via
  // Jira Sync > Configure credentials to use this feature.
  aiSummary: {
    enabled: true,

    // Claude model to use for summarization
    model: 'claude-opus-4-6',

    // Prompt sent to Claude. The full text of all KR comments is appended after this.
    // The format contract (SECTION:/ITEM:) must be preserved if you edit this prompt —
    // writeSummaryToDoc() parses it to produce native Google Docs formatting.
    prompt: 'You are summarizing OKR progress updates for a leadership audience. ' +
            'Given the latest Jira comments across all key results below, produce a structured ' +
            'summary with exactly two sections. Use this exact format:\n\n' +
            'SECTION: Progress & Wins\n' +
            'ITEM: <concise highlight>\n' +
            'ITEM: <concise highlight>\n\n' +
            'SECTION: Risks & Blockers\n' +
            'ITEM: <concise highlight>\n' +
            'ITEM: <concise highlight>\n\n' +
            'Rules:\n' +
            '- Every line must start with SECTION: or ITEM: — no other line types\n' +
            '- No markdown headings (#), bullet chars (-, •), or leading asterisks\n' +
            '- You may use **bold** within ITEM text to emphasize key terms\n' +
            '- Include 2-4 ITEMs per section. Be specific. Omit filler language.\n' +
            '- If a section has nothing to report, write one ITEM: Nothing to report.\n\n'
  }
};
