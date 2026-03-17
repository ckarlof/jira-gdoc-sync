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

  style: {
    headerBgColor:   '#073763',  // dark blue
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
    prompt: 'You are summarizing OKR progress updates for a leadership audience. ' +
            'Given the latest Jira comments across all key results below, write a concise ' +
            'executive summary (3-5 bullet points) highlighting the most important progress, ' +
            'blockers, and risks. Be specific and avoid filler language.\n\n'
  }
};
