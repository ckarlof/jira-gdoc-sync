'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

/**
 * Loads Code.gs with getLatestCommentMeta stubbed to return pre-built data.
 * commentMetaByKey: { [krKey]: { blocks: [...], date: Date|null } }
 * Returns { buildCommentDigest, buildAttentionItems, buildCommentCache }
 */
function loadWithMetaStub(commentMetaByKey) {
  const src = fs.readFileSync(path.join(__dirname, '../Code.gs'), 'utf8');

  const sandbox = {
    CONFIG: {
      jira: { baseUrl: 'https://example.atlassian.net' },
      objectives: [], krSortOrder: 'jira',
      style: { headerBgColor: '#073763', headerTextColor: '#FFF', colWidths: [] },
      aiSummary: { enabled: false }
    },
    PropertiesService: { getUserProperties: () => ({ getProperty: () => null }) },
    UrlFetchApp:       { fetch: () => { throw new Error('should not be called'); } },
    DocumentApp:       { GlyphType: {}, ParagraphHeading: {} },
    Logger:            { log: () => {} },
    Utilities:         { base64Encode: (s) => Buffer.from(s).toString('base64'), formatDate: () => '' },
    Session:           { getScriptTimeZone: () => 'UTC' },
    HtmlService:       {},
    DriveApp:          {},
    MimeType:          { PLAIN_TEXT: 'text/plain' },
  };

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const DEFAULT_META = { blocks: [{ segments: [{ text: '(no comments)' }] }], date: null };
  sandbox.getLatestCommentMeta = (key) => commentMetaByKey[key] || DEFAULT_META;

  return {
    buildCommentDigest:  sandbox.buildCommentDigest,
    buildAttentionItems: sandbox.buildAttentionItems,
    buildCommentCache:   sandbox.buildCommentCache,
  };
}

/** Convenience: build a cache object directly from the stub map for a given KR list. */
function makeCache(commentMetaByKey, objectiveDataList) {
  const cache = {};
  objectiveDataList.forEach(obj => {
    obj.krs.forEach(kr => { cache[kr.key] = commentMetaByKey[kr.key] || { blocks: [], date: null }; });
  });
  return cache;
}

// ── buildCommentDigest ────────────────────────────────────────────────────────

describe('buildCommentDigest', () => {
  test('includes objective summary line', () => {
    const { buildCommentDigest } = loadWithMetaStub({});
    const objectives = [{ key: 'OBJ-1', summary: 'Grow revenue', krs: [] }];
    const digest = buildCommentDigest(objectives, makeCache({}, objectives));
    expect(digest).toContain('Objective: Grow revenue');
  });

  test('includes KR summary and assignee', () => {
    const meta = { 'KR-1': { blocks: [{ segments: [{ text: 'On track' }] }], date: null } };
    const { buildCommentDigest } = loadWithMetaStub(meta);
    const objectives = [{ key: 'OBJ-1', summary: 'Grow revenue',
      krs: [{ key: 'KR-1', summary: 'Hit $1M ARR', assigneeName: 'Alice' }] }];
    const digest = buildCommentDigest(objectives, makeCache(meta, objectives));
    expect(digest).toContain('KR: Hit $1M ARR (assignee: Alice)');
  });

  test('includes comment text', () => {
    const meta = { 'KR-1': { blocks: [{ segments: [{ text: 'Great progress this week' }] }], date: new Date() } };
    const { buildCommentDigest } = loadWithMetaStub(meta);
    const objectives = [{ key: 'OBJ-1', summary: 'Grow revenue',
      krs: [{ key: 'KR-1', summary: 'Hit $1M ARR', assigneeName: 'Alice' }] }];
    const digest = buildCommentDigest(objectives, makeCache(meta, objectives));
    expect(digest).toContain('Latest comment: Great progress this week');
  });

  test('multiple objectives are all present', () => {
    const { buildCommentDigest } = loadWithMetaStub({});
    const objectives = [
      { key: 'OBJ-1', summary: 'Objective One', krs: [] },
      { key: 'OBJ-2', summary: 'Objective Two', krs: [] },
    ];
    const digest = buildCommentDigest(objectives, makeCache({}, objectives));
    expect(digest).toContain('Objective One');
    expect(digest).toContain('Objective Two');
  });

  test('KR with empty comment text omits the comment line', () => {
    const meta = { 'KR-1': { blocks: [{ segments: [{ text: '' }] }], date: null } };
    const { buildCommentDigest } = loadWithMetaStub(meta);
    const objectives = [{ key: 'OBJ-1', summary: 'Obj',
      krs: [{ key: 'KR-1', summary: 'KR', assigneeName: 'Bob' }] }];
    const digest = buildCommentDigest(objectives, makeCache(meta, objectives));
    expect(digest).not.toContain('Latest comment:');
  });

  test('empty objectives list returns only whitespace', () => {
    const { buildCommentDigest } = loadWithMetaStub({});
    expect(buildCommentDigest([], {}).trim()).toBe('');
  });
});

// ── buildAttentionItems ───────────────────────────────────────────────────────

describe('buildAttentionItems', () => {
  const KR_BASE = { key: 'KR-1', summary: 'Grow signups', url: 'https://example.com/KR-1' };

  test('unassigned KR is flagged', () => {
    const { buildAttentionItems } = loadWithMetaStub({});
    const kr = Object.assign({}, KR_BASE, { assigneeName: 'Unassigned' });
    const items = buildAttentionItems(
      [{ key: 'O1', summary: 'Obj', krs: [kr] }],
      { 'KR-1': { blocks: [], date: new Date() } }
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toContain('no owner assigned');
  });

  test('KR with no comments is flagged', () => {
    const { buildAttentionItems } = loadWithMetaStub({});
    const kr = Object.assign({}, KR_BASE, { assigneeName: 'Alice' });
    const items = buildAttentionItems(
      [{ key: 'O1', summary: 'Obj', krs: [kr] }],
      { 'KR-1': { blocks: [], date: null } }
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toContain('no updates');
  });

  test('KR with stale comment (>14 days) is flagged', () => {
    const { buildAttentionItems } = loadWithMetaStub({});
    const staleDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const kr = Object.assign({}, KR_BASE, { assigneeName: 'Alice' });
    const items = buildAttentionItems(
      [{ key: 'O1', summary: 'Obj', krs: [kr] }],
      { 'KR-1': { blocks: [], date: staleDate } }
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toMatch(/last update \d+ days ago/);
  });

  test('KR with recent comment and owner is not flagged', () => {
    const { buildAttentionItems } = loadWithMetaStub({});
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const kr = Object.assign({}, KR_BASE, { assigneeName: 'Alice' });
    const items = buildAttentionItems(
      [{ key: 'O1', summary: 'Obj', krs: [kr] }],
      { 'KR-1': { blocks: [], date: recentDate } }
    );
    expect(items).toHaveLength(0);
  });

  test('multiple issues on same KR are combined into one reason string', () => {
    const { buildAttentionItems } = loadWithMetaStub({});
    const kr = Object.assign({}, KR_BASE, { assigneeName: 'Unassigned' });
    const items = buildAttentionItems(
      [{ key: 'O1', summary: 'Obj', krs: [kr] }],
      { 'KR-1': { blocks: [], date: null } }
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toContain('no owner assigned');
    expect(items[0].reason).toContain('no updates');
  });

  test('empty objectives list returns empty array', () => {
    const { buildAttentionItems } = loadWithMetaStub({});
    expect(buildAttentionItems([], {})).toEqual([]);
  });
});
