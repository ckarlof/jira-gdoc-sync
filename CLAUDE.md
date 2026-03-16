# CLAUDE.md — jira-gdoc-sync

## What this is

A single-file Google Apps Script (`Code.gs`) that syncs Jira OKR data into a
Google Doc. The entire project is one file; there is no build step, no package
manager, and no local execution. All code runs inside the Apps Script runtime
attached to a specific Google Doc.

## How to test changes

There is no local test runner. To test:

1. Open the bound Google Doc → **Extensions → Apps Script**
2. Paste the updated `Code.gs`
3. Run functions directly from the Apps Script editor or via the **Jira Sync**
   menu in the doc
4. Check output in **View → Logs** (or `Logger.log` output)

Never suggest running `node`, `npm`, or any local tooling — it will not work.

## Architecture

Everything lives in `Code.gs`. Key sections in order:

| Section | Purpose |
|---|---|
| `getConfig` / `jiraGet` / `jiraSearch` | Jira API helpers |
| `adfToBlocks` | Parses Atlassian Document Format (ADF) JSON into a `[{type, segments}]` block array |
| `autoLinkSegments` | Post-processes segments to turn bare URLs into linked segments |
| `applySegmentsToText` | Applies rich-text formatting (bold, italic, links, colors) to a `Text` object |
| `writeBlocksToCell` | Writes a block array into a `TableCell`, using native `ListItem` for lists |
| `getLatestComment` | Fetches the most recent Jira comment and returns it as blocks |
| `fetchChildren` / `fetchObjectiveData` | Fetches objective + KR data from Jira |
| `getStyle` / `configureStyle` | Reads/writes header color and column width settings from PropertiesService |
| `buildOKRTables` | Main entry point — clears the doc body and builds all tables |
| `onOpen` | Registers the Jira Sync menu |

## Known constraints and decisions

### Jira search endpoint
Use `POST /rest/api/3/search/jql` — `GET /rest/api/3/search` returns HTTP 410
on this Atlassian instance. `jiraSearch()` already handles the fallback.

### Table cell borders
`DocumentApp.Attribute.BORDER_COLOR` does not work on table cells.
The Google Docs REST API `batchUpdate` approach was attempted and abandoned —
DocumentApp flushes overwrite REST API changes. Do not re-attempt border color
features.

### Smart chips
`insertInlinePerson` (people smart chips) was tried for assignees and reverted —
the result looked poor. Arbitrary URL smart chips (e.g. for Jira links) are not
insertable via Apps Script or the Docs REST API; `RichLink` is read-only.

### Document tabs (`addTab`)
`Document.addTab()` is not available in this environment. The current approach
appends a timestamped `HEADING1` section to the document body on each run
instead of creating a new tab. Do not attempt `addTab`.

### Rich text / ADF
Comments are in Atlassian Document Format (ADF). The `adfToBlocks` function
walks the ADF tree and produces a flat block array. Inline content (text, status
lozenges, emoji, mentions, links) is handled by `inlineSegs`. Block content
(paragraphs, bullet/ordered lists with nesting, code blocks) is handled by
`walkBlocks` / `walkListItem`. Do not flatten lists back to prefixed text.

### Credentials
All credentials (Jira URL, email, API token) are stored in
`PropertiesService.getUserProperties()`. Never hardcode credentials. Never
write them to a file.

## Style conventions

- ES5-compatible JavaScript (Google Apps Script V8 supports modern JS, but the
  existing code uses `var` and `function` declarations — stay consistent)
- No external dependencies
- Keep all logic in `Code.gs` — do not split into multiple files
