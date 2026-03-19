'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

/**
 * Loads Code.gs with stubs for Apps Script globals.
 * Returns { parseTicketSummaries }
 */
function loadCodeWithStubs() {
  const src = fs.readFileSync(path.join(__dirname, '../Code.gs'), 'utf8');

  const sandbox = {
    CONFIG: {
      jira: { baseUrl: 'https://example.atlassian.net' },
      dependencyAnalysis: { enabled: true },
      style: {},
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
    parseTicketSummaries: sandbox.parseTicketSummaries,
  };
}

describe('parseTicketSummaries', () => {
  const { parseTicketSummaries } = loadCodeWithStubs();

  test('parses single ticket response', () => {
    const response = 'TICKET:PROJ-1\nSUMMARY:On track. All dependencies complete.';
    const result = parseTicketSummaries(response);

    expect(result).toEqual({
      'PROJ-1': 'On track. All dependencies complete.'
    });
  });

  test('parses multiple tickets', () => {
    const response = `TICKET:PROJ-1
SUMMARY:On track. Making good progress.

TICKET:PROJ-2
SUMMARY:Behind schedule. Blocked by infrastructure issues.`;

    const result = parseTicketSummaries(response);

    expect(result).toEqual({
      'PROJ-1': 'On track. Making good progress.',
      'PROJ-2': 'Behind schedule. Blocked by infrastructure issues.'
    });
  });

  test('handles multi-line summaries', () => {
    const response = `TICKET:PROJ-1
SUMMARY:On track. Making good progress.
Additional details on second line.`;

    const result = parseTicketSummaries(response);

    expect(result['PROJ-1']).toContain('On track. Making good progress.');
    expect(result['PROJ-1']).toContain('Additional details on second line.');
  });

  test('ignores separator lines (---)', () => {
    const response = `--- Ticket: PROJ-1 ---
TICKET:PROJ-1
SUMMARY:Progress is good.

--- Ticket: PROJ-2 ---
TICKET:PROJ-2
SUMMARY:Some delays.`;

    const result = parseTicketSummaries(response);

    expect(result).toEqual({
      'PROJ-1': 'Progress is good.',
      'PROJ-2': 'Some delays.'
    });
  });

  test('handles missing TICKET marker gracefully', () => {
    const response = 'SUMMARY:This summary has no ticket key.';
    const result = parseTicketSummaries(response);

    expect(result).toEqual({});
  });

  test('handles missing SUMMARY marker', () => {
    const response = 'TICKET:PROJ-1\nSome text but no SUMMARY: prefix';
    const result = parseTicketSummaries(response);

    // Should still capture text after TICKET marker
    expect(result['PROJ-1']).toBe('Some text but no SUMMARY: prefix');
  });

  test('trims whitespace from ticket keys and summaries', () => {
    const response = 'TICKET:  PROJ-1  \nSUMMARY:  Making progress.  ';
    const result = parseTicketSummaries(response);

    expect(result).toEqual({
      'PROJ-1': 'Making progress.'
    });
  });

  test('handles empty response', () => {
    const result = parseTicketSummaries('');
    expect(result).toEqual({});
  });

  test('handles null response', () => {
    const result = parseTicketSummaries(null);
    expect(result).toEqual({});
  });

  test('preserves last ticket when no final newline', () => {
    const response = 'TICKET:PROJ-1\nSUMMARY:First ticket\nTICKET:PROJ-2\nSUMMARY:Last ticket without newline';
    const result = parseTicketSummaries(response);

    expect(result).toEqual({
      'PROJ-1': 'First ticket',
      'PROJ-2': 'Last ticket without newline'
    });
  });

  test('handles tickets with colons in summary text', () => {
    const response = 'TICKET:PROJ-1\nSUMMARY:Status: On track. Risk: None.';
    const result = parseTicketSummaries(response);

    expect(result['PROJ-1']).toBe('Status: On track. Risk: None.');
  });

  test('multiple SUMMARY lines are concatenated', () => {
    const response = `TICKET:PROJ-1
SUMMARY:First part of summary.
SUMMARY:Second part of summary.`;

    const result = parseTicketSummaries(response);

    expect(result['PROJ-1']).toContain('First part of summary.');
    expect(result['PROJ-1']).toContain('Second part of summary.');
  });
});
