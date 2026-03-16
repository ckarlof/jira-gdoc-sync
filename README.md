# jira-gdoc-sync

A Google Apps Script that syncs Jira OKR data into a Google Doc. Given a list of Jira objective ticket keys, it builds one table per objective, where each row represents a child KR (Key Result) ticket. Each run overwrites the document with a fresh timestamped snapshot.

## What it produces

For each configured objective, the script writes:

- A **heading** with the objective's short name linked to the Jira ticket, followed by the full summary text
- A **table** with one row per KR containing:
  - **Summary** — linked to the Jira ticket
  - **Assignee** — display name
  - **Last Comment** — most recent comment with full rich-text formatting: bold, italic, status lozenges, bullet/numbered lists with nesting, and auto-linked URLs

The document is stamped with the run timestamp (e.g. `Mar 15, 2026 2:34 PM (America/Los_Angeles)`) at the top.

## Setup

### 1. Create a Google Doc

Open or create the Google Doc where you want the OKR tables to appear.

### 2. Add the script

1. In the doc, go to **Extensions → Apps Script**
2. Delete any existing code in `Code.gs`
3. Paste the contents of `Code.gs` from this repo
4. Click **Save**

### 3. Enable the Google Docs API advanced service (optional)

Only needed if you plan to extend the script with Docs REST API features. In the Apps Script editor: **Services (+) → Google Docs API → Add**.

### 4. Configure credentials

1. Reload the Google Doc — a **Jira Sync** menu will appear
2. Go to **Jira Sync → Configure credentials** and enter:
   - **Jira Base URL** — e.g. `https://your-domain.atlassian.net`
   - **Jira Email** — your Atlassian account email
   - **Jira API Token** — generate one at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

Credentials are stored in Google's **PropertiesService** (per-user, encrypted).

### 5. Configure objectives

Go to **Jira Sync → Configure objectives** and enter a comma-separated list of objective Jira keys, e.g.:

```
INFOKR-1, INFOKR-5, INFOKR-12
```

### 6. Run

Go to **Jira Sync → Build OKR tables**. The document will be populated with the current OKR status.

## Menu reference

| Menu item | Description |
|---|---|
| Build OKR tables | Fetches data from Jira and rebuilds the document |
| Configure objectives | Set the Jira keys for the objectives to sync |
| Configure credentials | Set Jira URL, email, and API token |
| Configure style | Set header background/text colors and column widths |

## Styling

Go to **Jira Sync → Configure style** to adjust:

- **Header background color** — default `#073763` (dark blue)
- **Header text color** — default `#FFFFFF` (white)
- **Column widths** — in points (72 pt = 1 inch); default `175, 75, 600`

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
| `Code.gs` | The entire script — copy this into Apps Script |

## Notes

- The script uses `POST /rest/api/3/search/jql` for Jira searches (the older `GET /rest/api/3/search` endpoint returns HTTP 410 on some Atlassian instances)
- KRs are fetched as child issues using `parent = OBJECTIVE-KEY` JQL
- Rich text in comments is parsed from Atlassian Document Format (ADF) and rendered with native Google Docs formatting
