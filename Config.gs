// ── Configuration ─────────────────────────────────────────────────────────────
// Edit this file to configure the script for your Jira instance.
// Credentials (email + API token) are NOT stored here — use Jira Sync > Configure credentials.

var CONFIG = {
  jira: {
    baseUrl: 'https://mycompany.atlassian.net'  // e.g. https://acme.atlassian.net
  },

  // Jira issue keys for the objectives you want to build tables for
  objectives: [
    // 'PROJ-1',
    // 'PROJ-5',
  ],

  style: {
    headerBgColor:   '#073763',  // dark blue
    headerTextColor: '#FFFFFF',  // white
    colWidths:       [175, 75, 600]  // points: Summary, Assignee, Last Comment
  }
};
