# CLAUDE.md — jira-gdoc-sync

## What this is

A two-file Google Apps Script that syncs Jira OKR data into a Google Doc:

- **`Code.gs`** — all logic
- **`Config.gs`** — all non-credential configuration (Jira base URL, objectives, style, AI settings)

The Apps Script files run inside the Apps Script runtime attached to a specific Google Doc. A Jest test suite covers the pure logic locally.

## How to test changes

### Unit tests (local — run these first)

```bash
npm test          # run all tests once
npm run test:watch  # re-run on file save
```

Tests live in `tests/`. They load `Code.gs` into a Node VM with all Apps Script globals stubbed out, so no Google account or internet connection is needed.

**What is tested:** `adfToBlocks`, `autoLinkSegments`, `buildCommentDigest`, `buildAttentionItems`

**What is not tested:** anything that calls `UrlFetchApp`, `DocumentApp`, `PropertiesService`, or `DriveApp` — those require the live Apps Script runtime.

### Manual testing (Apps Script runtime)

1. Open the bound Google Doc → **Extensions → Apps Script**
2. Paste updated file(s) into the editor
3. Run functions directly from the Apps Script editor or via the **Jira Sync** menu in the doc
4. Check output in **View → Logs** (or `Logger.log` output)

## Architecture

### `Config.gs`

Single `CONFIG` object with:
- `jira.baseUrl` — Atlassian instance URL
- `tables` — array of table configs; two modes:
  - `{ parentKeys: [...] }` — one heading + table per parent ticket; rows are child issues; heading always derived from parent ticket summary
  - `{ title: '...', keys: [...] }` — one flat table for a specific list of tickets; `title` is required
- `sortOrder` — `'jira'` (default, keeps Jira's order) or `'alpha'` (numeric-aware alphabetical)
- `style` — header colors (`headerBgColor`, `headerTextColor`)
- `columns` — array of `{ heading, width, field }` defining the table columns
- `aiSummary` — Claude API settings (enabled flag, model, prompt)

### `Code.gs` — key functions in order

| Function | Purpose |
|---|---|
| `getConfig` / `jiraGet` / `jiraSearch` | Jira API helpers; Jira base URL comes from `CONFIG`, credentials from PropertiesService |
| `adfToBlocks` | Parses Atlassian Document Format (ADF) JSON into a `[{type, segments}]` block array |
| `autoLinkSegments` | Post-processes segments to turn bare URLs into linked segments |
| `applySegmentsToText` | Applies rich-text formatting (bold, italic, links, colors) to a `Text` object |
| `writeBlocksToCell` | Writes a block array into a `TableCell`, using native `ListItem` for lists |
| `getLatestCommentMeta` | Fetches the most recent Jira comment; returns `{ blocks, date }` |
| `getLatestComment` | Thin wrapper over `getLatestCommentMeta` returning only blocks |
| `jiraFieldsForColumns` | Derives Jira field list from `CONFIG.columns` |
| `extractFieldText` | Handles nested Jira field shapes (`.name`, `.value`, `.displayName`) |
| `mapIssue` | Raw Jira issue → standard record `{ key, summary, url, assigneeName, fields }` |
| `sortIssues` | Sorts issues by `CONFIG.sortOrder` |
| `fetchChildIssues` / `fetchParentData` | Fetches parent summary + child issues |
| `fetchFlatIssues` | Fetches a specific list of issue keys directly |
| `renderCell` | Dispatches cell rendering by `col.field` |
| `appendIssueTable` | Builds one styled table in the document |
| `buildTables` | Main entry point — clears doc, writes timestamp, builds comment cache, runs AI summary, renders all sections |
| `buildCommentCache` / `buildCommentDigest` / `buildAttentionItems` | Comment cache and AI input preparation |
| `generateAiSummary` / `writeSummaryToDoc` | Claude API integration for executive summary |
| `parseBoldSegments` / `applyBoldSegments` | Handle `**bold**` spans in AI output |
| `configureCredentials` / `configureClaudeKey` | Menu-driven credential storage in PropertiesService |
| `onOpen` | Registers the Jira Sync menu |

## Known constraints and decisions

### Configuration split
Non-credential config (URLs, objectives, style, AI settings) lives in `Config.gs` so it can be version-controlled. Credentials (Jira email/token, Claude API key) are stored in `PropertiesService.getUserProperties()` and never in files.

### Jira search endpoint
Use `POST /rest/api/3/search/jql` — `GET /rest/api/3/search` returns HTTP 410
on this Atlassian instance. `jiraSearch()` already handles the fallback.

### Table cell borders
`DocumentApp.Attribute.BORDER_COLOR` does not work on table cells.
The Google Docs REST API `batchUpdate` approach was attempted and abandoned —
DocumentApp flushes overwrite REST API changes. Do not re-attempt border color features.

### Smart chips
`insertInlinePerson` (people smart chips) was tried for assignees and reverted —
the result looked poor. Arbitrary URL smart chips (e.g. for Jira links) are not
insertable via Apps Script or the Docs REST API; `RichLink` is read-only.

### Document tabs (`addTab`)
`Document.addTab()` is not available in this environment. Each run overwrites
the current document body and prepends a timestamped `HEADING1`. Users create
new tabs manually and run the script there to preserve history. Do not attempt `addTab`.

### Rich text / ADF
Comments are in Atlassian Document Format (ADF). The `adfToBlocks` function
walks the ADF tree and produces a flat block array. Inline content (text, status
lozenges, emoji, mentions, links) is handled by `inlineSegs`. Block content
(paragraphs, bullet/ordered lists with nesting, code blocks) is handled by
`walkBlocks` / `walkListItem`. Do not flatten lists back to prefixed text.

### Sort order
Controlled by `CONFIG.sortOrder`. Default `'jira'` preserves Jira's return order.
`'alpha'` uses `localeCompare` with `{ numeric: true }` so embedded numbers sort
correctly (KR2 before KR10). The sort is applied in `sortIssues` after mapping
the Jira response.

### Credentials
Jira email/token and Claude API key are stored in `PropertiesService.getUserProperties()`.
Never hardcode credentials. Never write them to a file.

## Style conventions

- ES5-compatible JavaScript (`var`, `function` declarations) — stay consistent with existing code
- No external dependencies in `Code.gs` or `Config.gs`
- Logic stays in `Code.gs`; configuration stays in `Config.gs`; tests in `tests/`
- `package.json` and `node_modules/` are for local testing only — they are not deployed to Apps Script
