'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

/**
 * Loads Code.gs with stubs for Apps Script globals.
 * Returns { buildDependencyDigest }
 */
function loadCodeWithStubs() {
  const src = fs.readFileSync(path.join(__dirname, '../Code.gs'), 'utf8');

  const sandbox = {
    CONFIG: {
      jira: { baseUrl: 'https://example.atlassian.net' },
      dependencyAnalysis: {
        enabled: true,
        maxDepth: 2,
        cutoffDays: 14
      },
      style: { headerBgColor: '#073763', headerTextColor: '#FFF' },
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

  return {
    buildDependencyDigest: sandbox.buildDependencyDigest,
  };
}

describe('buildDependencyDigest', () => {
  const { buildDependencyDigest } = loadCodeWithStubs();

  const rootIssue = {
    key: 'PROJ-1',
    summary: 'Main Feature',
    assigneeName: 'Alice',
    fields: {
      status: { name: 'In Progress' },
      updated: '2024-03-15T10:30:00.000Z'
    }
  };

  test('formats root issue correctly', () => {
    const depTree = { nodes: [], links: [] };
    const digest = buildDependencyDigest(rootIssue, depTree, {});

    expect(digest).toContain('Root Ticket: PROJ-1 - Main Feature');
    expect(digest).toContain('Status: In Progress');
    expect(digest).toContain('Assignee: Alice');
    expect(digest).toContain('Updated: 2024-03-15T10:30:00.000Z');
  });

  test('includes message when no linked issues', () => {
    const depTree = { nodes: [], links: [] };
    const digest = buildDependencyDigest(rootIssue, depTree, {});

    expect(digest).toContain('No linked issues found with recent updates');
  });

  test('includes level 1 links with metadata', () => {
    const linkedIssue = {
      key: 'PROJ-2',
      summary: 'Sub-task A',
      assigneeName: 'Bob',
      fields: {
        status: { name: 'Done' },
        updated: '2024-03-14T15:00:00.000Z'
      }
    };

    const depTree = {
      nodes: [rootIssue, linkedIssue],
      links: [{ from: 'PROJ-1', to: 'PROJ-2', type: 'Blocks', direction: 'outward' }]
    };

    const digest = buildDependencyDigest(rootIssue, depTree, {});

    expect(digest).toContain('Level 1 - Blocks - PROJ-2: Sub-task A');
    expect(digest).toContain('Status: Done');
    expect(digest).toContain('Assignee: Bob');
  });

  test('includes level 2 links with parent reference', () => {
    const level1Issue = {
      key: 'PROJ-2',
      summary: 'Sub-task A',
      assigneeName: 'Bob',
      fields: { status: { name: 'In Progress' }, updated: '2024-03-14T15:00:00.000Z' }
    };

    const level2Issue = {
      key: 'PROJ-3',
      summary: 'Sub-sub-task',
      assigneeName: 'Charlie',
      fields: { status: { name: 'To Do' }, updated: '2024-03-13T09:00:00.000Z' }
    };

    const depTree = {
      nodes: [rootIssue, level1Issue, level2Issue],
      links: [
        { from: 'PROJ-1', to: 'PROJ-2', type: 'Blocks', direction: 'outward' },
        { from: 'PROJ-2', to: 'PROJ-3', type: 'Relates to', direction: 'outward' }
      ]
    };

    const digest = buildDependencyDigest(rootIssue, depTree, {});

    expect(digest).toContain('Level 1 - Blocks - PROJ-2: Sub-task A');
    expect(digest).toContain('Level 2 - Relates to (via PROJ-2) - PROJ-3: Sub-sub-task');
  });

  test('includes comment text when available in cache', () => {
    const linkedIssue = {
      key: 'PROJ-2',
      summary: 'Sub-task A',
      assigneeName: 'Bob',
      fields: { status: { name: 'In Progress' }, updated: '2024-03-14T15:00:00.000Z' }
    };

    const depTree = {
      nodes: [rootIssue, linkedIssue],
      links: [{ from: 'PROJ-1', to: 'PROJ-2', type: 'Blocks', direction: 'outward' }]
    };

    const commentCache = {
      'PROJ-2': {
        blocks: [{ segments: [{ text: 'Making good progress on this task' }] }],
        date: new Date()
      }
    };

    const digest = buildDependencyDigest(rootIssue, depTree, commentCache);

    expect(digest).toContain('Latest comment: Making good progress on this task');
  });

  test('truncates long comments to 200 chars', () => {
    const linkedIssue = {
      key: 'PROJ-2',
      summary: 'Sub-task A',
      assigneeName: 'Bob',
      fields: { status: { name: 'In Progress' }, updated: '2024-03-14T15:00:00.000Z' }
    };

    const depTree = {
      nodes: [rootIssue, linkedIssue],
      links: [{ from: 'PROJ-1', to: 'PROJ-2', type: 'Blocks', direction: 'outward' }]
    };

    const longComment = 'A'.repeat(250);
    const commentCache = {
      'PROJ-2': {
        blocks: [{ segments: [{ text: longComment }] }],
        date: new Date()
      }
    };

    const digest = buildDependencyDigest(rootIssue, depTree, commentCache);

    expect(digest).toContain('Latest comment: ' + 'A'.repeat(200) + '...');
    expect(digest).not.toContain('A'.repeat(250));
  });

  test('handles empty dependency tree gracefully', () => {
    const depTree = { nodes: [rootIssue], links: [] };
    const digest = buildDependencyDigest(rootIssue, depTree, {});

    expect(digest).toContain('Root Ticket: PROJ-1');
    expect(digest).toContain('No linked issues found');
  });
});
