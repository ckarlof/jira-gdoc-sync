# jira-gdoc-sync

A Google Apps Script that syncs Jira OKR data into a Google Doc. Given a list of Jira objective ticket keys, it builds one table per objective, where each row represents a child KR (Key Result) ticket. Each run overwrites the document with a fresh timestamped snapshot.

## What it produces

For each configured objective, the script writes:

- A **heading** with the objective's short name linked to the Jira ticket, followed by the full summary text
- A **table** with one row per KR containing:
  - **Summary** — linked to the Jira ticket
  - **Assignee** — display name
  - **Last Comment** — most recent comment with full rich-text formatting: bold, italic, status lozenges, bullet/numbered lists with nesting, and auto-linked URLs

If AI summary is enabled, an executive summary of all KR comments appears between the timestamp and the tables.

The document is stamped with the run timestamp (e.g. `Mar 15, 2026 2:34 PM (America/Los_Angeles)`) at the top of each run.

## Setup

### 1. Create a Google Doc

Open or create the Google Doc where you want the OKR tables to appear.

### 2. Add the script files

1. In the doc, go to **Extensions → Apps Script**
2. Replace the contents of `Code.gs` with the contents of `Code.gs` from this repo
3. Create a second file called `Config.gs` and paste in the contents of `Config.gs` from this repo
4. Edit `Config.gs` to set your Jira base URL and objective keys (see [Configuration](#configuration))
5. Click **Save**

### 3. Configure credentials

1. Reload the Google Doc — a **Jira Sync** menu will appear
2. Go to **Jira Sync → Configure Jira credentials** and enter:
   - **Jira Email** — your Atlassian account email
   - **Jira API Token** — generate one at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

Credentials are stored in Google's **PropertiesService** (per-user, encrypted at rest). They are never stored in the script files.

### 4. Run

Go to **Jira Sync → Build OKR tables**. The document will be populated with the current OKR status.

## Configuration

All non-credential settings live in `Config.gs`:

```javascript
var CONFIG = {
  jira: {
    baseUrl: 'https://your-domain.atlassian.net'
  },

  // Jira issue keys for the objectives to sync
  objectives: [
    'PROJ-1',
    'PROJ-2'
  ],

  // KR sort order within each objective table
  // 'jira'  — keep the order Jira returns (default; typically creation order)
  // 'alpha' — sort alphabetically by summary, numeric-aware (KR2 before KR10)
  krSortOrder: 'jira',

  style: {
    headerBgColor:   '#073763',  // header background
    headerTextColor: '#FFFFFF',  // header text
    colWidths:       [175, 75, 600]  // points: Summary, Assignee, Last Comment
  },

  aiSummary: {
    enabled: false,
    model:   'claude-opus-4-6',
    prompt:  '...'
  }
};
```

## Menu reference

| Menu item | Description |
|---|---|
| Build OKR tables | Fetches data from Jira and rebuilds the document |
| Configure Jira credentials | Set Jira email and API token |
| Configure Claude API key | Set Anthropic API key for AI summaries |

## AI summary (optional)

The script can generate an executive summary of all KR comments using the Claude API, inserted at the top of the output before the tables.

To enable:

1. Set `aiSummary.enabled: true` in `Config.gs` and customize the `prompt` if desired
2. Go to **Jira Sync → Configure Claude API key** and paste your Anthropic API key
3. Run **Build OKR tables** — the summary will appear below the timestamp heading

The API key is stored in PropertiesService alongside Jira credentials. Review your organization's AI usage policies before enabling this feature with work data.

## Best practices

### Preserving a historical record

Each run overwrites the current tab. To build up a history of snapshots:

1. In Google Docs, create a new tab
2. Run **Jira Sync → Build OKR tables** in the new tab
3. Name the tab with the timestamp written at the top of the output (e.g. `Mar 15, 2026 2:34 PM (America/Los_Angeles)`)

Repeat for each sync cycle. Each tab becomes an archived, dated snapshot.

## Files

| File | Description |
|---|---|
| `Code.gs` | All script logic — paste into Apps Script |
| `Config.gs` | All non-credential configuration — paste into Apps Script and edit |

## Notes

- The script uses `POST /rest/api/3/search/jql` for Jira searches (the older `GET /rest/api/3/search` endpoint returns HTTP 410 on some Atlassian instances)
- KRs are fetched as child issues using `parent = OBJECTIVE-KEY` JQL
- Rich text in comments is parsed from Atlassian Document Format (ADF) and rendered with native Google Docs formatting
