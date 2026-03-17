'use strict';

const { loadPureFunctions } = require('./appsScriptSandbox');
const { buildCommentDigest } = loadPureFunctions();

function makeObjective(summary, krs) {
  return {
    key:     summary.split(' ')[0],
    summary: summary,
    krs:     krs
  };
}

function makeKR(summary, assigneeName, commentText) {
  return {
    key:          'KR-1',
    summary:      summary,
    assigneeName: assigneeName,
    // Pre-built blocks so buildCommentDigest doesn't need to call getLatestComment
    _commentBlocks: [{ segments: [{ text: commentText }] }]
  };
}

// buildCommentDigest calls getLatestComment(kr.key) internally, which hits
// UrlFetchApp. We test the digest shape by monkey-patching via the sandbox
// so we can inject pre-built comment blocks.

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

function loadWithCommentStub(commentBlocksByKey) {
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

  // Override getLatestComment to return stubbed blocks
  sandbox.getLatestComment = function(key) {
    return commentBlocksByKey[key] || [{ segments: [{ text: '(no comments)' }] }];
  };

  return sandbox.buildCommentDigest;
}

describe('buildCommentDigest', () => {
  test('includes objective summary line', () => {
    const digest = loadWithCommentStub({})([
      { key: 'OBJ-1', summary: 'Grow revenue', krs: [] }
    ]);
    expect(digest).toContain('Objective: Grow revenue');
  });

  test('includes KR summary and assignee', () => {
    const fn = loadWithCommentStub({ 'KR-1': [{ segments: [{ text: 'On track' }] }] });
    const digest = fn([{
      key: 'OBJ-1', summary: 'Grow revenue',
      krs: [{ key: 'KR-1', summary: 'Hit $1M ARR', assigneeName: 'Alice' }]
    }]);
    expect(digest).toContain('KR: Hit $1M ARR (assignee: Alice)');
  });

  test('includes comment text', () => {
    const fn = loadWithCommentStub({ 'KR-1': [{ segments: [{ text: 'Great progress this week' }] }] });
    const digest = fn([{
      key: 'OBJ-1', summary: 'Grow revenue',
      krs: [{ key: 'KR-1', summary: 'Hit $1M ARR', assigneeName: 'Alice' }]
    }]);
    expect(digest).toContain('Latest comment: Great progress this week');
  });

  test('multiple objectives are all present', () => {
    const fn = loadWithCommentStub({});
    const digest = fn([
      { key: 'OBJ-1', summary: 'Objective One', krs: [] },
      { key: 'OBJ-2', summary: 'Objective Two', krs: [] },
    ]);
    expect(digest).toContain('Objective One');
    expect(digest).toContain('Objective Two');
  });

  test('KR with empty comment text omits the comment line', () => {
    const fn = loadWithCommentStub({ 'KR-1': [{ segments: [{ text: '' }] }] });
    const digest = fn([{
      key: 'OBJ-1', summary: 'Obj',
      krs: [{ key: 'KR-1', summary: 'KR', assigneeName: 'Bob' }]
    }]);
    expect(digest).not.toContain('Latest comment:');
  });

  test('empty objectives list returns only whitespace', () => {
    const fn = loadWithCommentStub({});
    expect(fn([]).trim()).toBe('');
  });
});
