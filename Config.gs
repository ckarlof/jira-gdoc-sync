// ── Configuration ─────────────────────────────────────────────────────────────
// Edit this file to configure the script for your Jira instance.
// Credentials (email + API token) are NOT stored here — use Jira Sync > Configure credentials.

var CONFIG = {
  jira: {
    baseUrl: 'https://mozilla-hub.atlassian.net'  // e.g. https://acme.atlassian.net
  },

  // Jira issue keys for the objectives you want to build tables for
  objectives: [
    'INFOKR-1',
    'INFOKR-3',
    'INFOKR-5',
    'INFOKR-6'
  ],

  // How child KRs are ordered within each objective table.
  // 'jira'  — keep the order Jira returns (default; typically creation order)
  // 'alpha' — sort alphabetically by summary, numeric-aware (e.g. KR2 before KR10)
  krSortOrder: 'alpha',

  style: {
    headerBgColor:   '#15191d',  // dark blue
    headerTextColor: '#FFFFFF',  // white
    colWidths:       [175, 75, 600]  // points: Summary, Assignee, Last Comment
  },

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
