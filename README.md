# jira-gdoc-sync

A Google Apps Script that syncs Jira ticket data into a Google Doc. Given a list of Jira ticket keys (or parent tickets whose children you want to display), it builds one or more tables in the document. Each run overwrites the document with a fresh timestamped snapshot.

## What it produces

The script writes:

- A **timestamp heading** at the top of each run (e.g. `Mar 15, 2026 2:34 PM (America/Los_Angeles)`)
- An optional **AI summary** block with two sections — *Progress & Wins* and *Risks & Blockers* — and a *Needs Attention* list for tickets that are unassigned, have no comments, or have stale comments (>14 days)
- One or more **tables**, each with a heading and configurable columns

Columns are fully configurable (heading label, width, Jira field). Built-in fields include `summary` (linked to Jira), `assignee`, `latestComment` (full rich-text formatting), `secondLatestComment` (second most recent comment), `dependencySummary` (AI-powered analysis of linked issues), `status`, and `priority`. Any raw Jira field name also works.

## Setup

### 1. Create a Google Doc

Open or create the Google Doc where you want the tables to appear.

### 2. Add the script files

1. In the doc, go to **Extensions → Apps Script**
2. Replace the contents of `Code.gs` with the contents of `Code.gs` from this repo
3. Create a second file called `Config.gs` and paste in the contents of `Config.gs` from this repo
4. Edit `Config.gs` to set your Jira base URL and tables (see [Configuration](#configuration))
5. Click **Save**

### 3. Configure credentials

1. Reload the Google Doc — a **Jira Sync** menu will appear
2. Go to **Jira Sync → Configure Jira credentials** and enter:
   - **Jira Email** — your Atlassian account email
   - **Jira API Token** — generate one at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

Credentials are stored in Google's **PropertiesService** (per-user, encrypted at rest). They are never stored in the script files.

### 4. Run

Go to **Jira Sync → Build tables**. The document will be populated with the current data.

## Configuration

All non-credential settings live in `Config.gs`:

```javascript
var CONFIG = {
  jira: {
    baseUrl: 'https://your-domain.atlassian.net'
  },

  // Tables to build. Two modes:
  //
  // Parent/child mode — one heading + table per parent; rows are child issues:
  //   { parentKeys: ['PROJ-1', 'PROJ-2'] }
  //   The heading is derived from each parent ticket's own summary.
  //
  // Flat list mode — one heading + table for a specific list of tickets:
  //   { title: 'My Table', keys: ['PROJ-10', 'PROJ-11'] }
  //   'title' is required in flat mode.
  tables: [
    { parentKeys: ['PROJ-1', 'PROJ-2'] }
  ],

  // Sort order within each table.
  // 'jira'  — keep the order Jira returns (default; typically creation order)
  // 'alpha' — sort alphabetically by summary, numeric-aware (KR2 before KR10)
  sortOrder: 'jira',

  style: {
    headerBgColor:   '#073763',  // header background
    headerTextColor: '#FFFFFF',  // header text
  },

  // Table columns — heading label, width (points), and Jira field to render.
  // Built-in fields: 'summary', 'assignee', 'latestComment', 'secondLatestComment',
  //                  'dependencySummary', 'status', 'priority'
  // Any other value is treated as a raw Jira field name (e.g. 'customfield_10016').
  columns: [
    { heading: 'Summary',      width: 175, field: 'summary'       },
    { heading: 'Assignee',     width: 75,  field: 'assignee'      },
    { heading: 'Last Comment', width: 600, field: 'latestComment' },
  ],

  aiSummary: {
    enabled: false,
    model:   'claude-opus-4-6',
    prompt:  '...'
  },

  dependencyAnalysis: {
    enabled: true,
    maxDepth: 2,
    cutoffDays: 14,
    linkTypes: 'all',
    model: 'default',  // 'default' uses aiSummary.model, or specify a model
    prompt: '...'
  }
};
```

## Menu reference

| Menu item | Description |
|---|---|
| Build tables | Fetches data from Jira and rebuilds the document |
| Configure Jira credentials | Set Jira email and API token |
| Configure Claude API key | Set Anthropic API key for AI summaries |

## AI summary (optional)

The script can generate an executive summary of all comments using the Claude API, inserted at the top of the output before the tables. It also always computes a **Needs Attention** list (locally, no AI required) for tickets that are unassigned, have no comments, or whose last comment is more than 14 days old.

To enable the AI summary:

1. Set `aiSummary.enabled: true` in `Config.gs` and customize the `prompt` if desired
2. Go to **Jira Sync → Configure Claude API key** and paste your Anthropic API key
3. Run **Build tables** — the summary will appear below the timestamp heading

If the Claude API call fails, the Needs Attention section is still written. Check **View → Logs** in the Apps Script editor for diagnostic output.

The API key is stored in PropertiesService alongside Jira credentials. Review your organization's AI usage policies before enabling this feature with work data.

## Dependency analysis (optional)

The script can analyze linked Jira issues for each ticket and generate per-ticket AI summaries showing progress, risks, and blockers across the dependency tree. This is enabled by adding a column with `field: 'dependencySummary'`.

**How it works:**

1. **Fetches linked issues and children** — For each ticket in the table, recursively fetches all linked issues (e.g., "fulfilled by", "blocks", "relates to") and direct child issues up to a configurable depth (default: 2 levels)
2. **Filters by activity** — Only includes issues updated within a configurable time window (default: 14 days)
3. **Gathers comments** — Fetches the latest comment from each linked issue to provide context
4. **Generates AI summary** — Uses Claude to analyze the full dependency tree and summarize progress/risks in 3-4 sentences
5. **Auto-links ticket keys** — Ticket references (like PROJ-123) in the summary automatically become clickable links to Jira

**Configuration:**

```javascript
dependencyAnalysis: {
  enabled: true,       // Master switch
  maxDepth: 2,         // Levels of links to traverse (1-3 recommended)
  cutoffDays: 14,      // Only include recently updated issues
  linkTypes: 'all',    // 'all' or array like ['fulfills', 'blocks']
  model: 'default',    // 'default' uses aiSummary.model, or specify a model
  prompt: '...'        // Customize the AI analysis prompt
}
```

**Example column:**

```javascript
columns: [
  { heading: 'Summary',      width: 175, field: 'summary'            },
  { heading: 'Dependencies', width: 400, field: 'dependencySummary'  },
  { heading: 'Assignee',     width: 75,  field: 'assignee'           }
]
```

**Performance:** For a table with 10 tickets each having 5 linked issues, expect ~50-60 Jira API calls and 1-2 Claude API calls. Runtime adds ~5-10 seconds. Cost is approximately $0.50-$1.00 per run depending on model choice.

**Tip:** Set `model: 'claude-haiku-4-5'` in `dependencyAnalysis` to use a faster, cheaper model for dependency summaries while keeping a more capable model for the main document summary.

## Best practices

### Preserving a historical record

Each run overwrites the current tab. To build up a history of snapshots:

1. In Google Docs, create a new tab
2. Run **Jira Sync → Build tables** in the new tab
3. Name the tab with the timestamp written at the top of the output

Repeat for each sync cycle. Each tab becomes an archived, dated snapshot.

## Files

| File | Description |
|---|---|
| `Code.gs` | All script logic — paste into Apps Script |
| `Config.gs` | All non-credential configuration — paste into Apps Script and edit |

## Notes

- The script uses `POST /rest/api/3/search/jql` for Jira searches (the older `GET /rest/api/3/search` endpoint returns HTTP 410 on some Atlassian instances)
- Child issues are fetched using `parent = PARENT-KEY` JQL
- Linked issues (for dependency analysis) are fetched using the `issuelinks` field with `expand=issuelinks`
- Rich text in comments is parsed from Atlassian Document Format (ADF) and rendered with native Google Docs formatting
- Ticket keys (PROJ-123, ABC-456, etc.) in dependency summaries are automatically converted to clickable Jira links
