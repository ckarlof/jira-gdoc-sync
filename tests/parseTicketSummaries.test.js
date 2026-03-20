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

  test('parses section heading as bold para block', () => {
    const response = 'TICKET:PROJ-1\nSECTION:Accomplished\nITEM:Shipped the feature';
    const result = parseTicketSummaries(response);
    const blocks = result['PROJ-1'];

    expect(blocks[0].type).toBe('para');
    expect(blocks[0].segments[0].text).toBe('Accomplished');
    expect(blocks[0].segments[0].bold).toBe(true);
  });

  test('parses item as listItem block', () => {
    const response = 'TICKET:PROJ-1\nSECTION:Accomplished\nITEM:Shipped the feature';
    const blocks = parseTicketSummaries(response)['PROJ-1'];

    expect(blocks[1].type).toBe('listItem');
    expect(blocks[1].level).toBe(0);
    expect(blocks[1].ordered).toBe(false);
    expect(blocks[1].segments[0].text).toBe('Shipped the feature');
    expect(blocks[1].segments[0].bold).toBe(false);
  });

  test('parses two sections with items', () => {
    const response = `TICKET:PROJ-1
SECTION:Accomplished
ITEM:Deployed new auth service
ITEM:Completed API integration
SECTION:At Risk
ITEM:Database migration delayed`;

    const blocks = parseTicketSummaries(response)['PROJ-1'];

    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toMatchObject({ type: 'para',     segments: [{ text: 'Accomplished',              bold: true  }] });
    expect(blocks[1]).toMatchObject({ type: 'listItem', segments: [{ text: 'Deployed new auth service',  bold: false }] });
    expect(blocks[2]).toMatchObject({ type: 'listItem', segments: [{ text: 'Completed API integration',  bold: false }] });
    expect(blocks[3]).toMatchObject({ type: 'para',     segments: [{ text: 'At Risk',                    bold: true  }] });
    expect(blocks[4]).toMatchObject({ type: 'listItem', segments: [{ text: 'Database migration delayed', bold: false }] });
  });

  test('parses multiple tickets independently', () => {
    const response = `TICKET:PROJ-1
SECTION:Accomplished
ITEM:Done

TICKET:PROJ-2
SECTION:At Risk
ITEM:Blocked`;

    const result = parseTicketSummaries(response);

    expect(result['PROJ-1']).toHaveLength(2);
    expect(result['PROJ-1'][0].segments[0].text).toBe('Accomplished');
    expect(result['PROJ-2']).toHaveLength(2);
    expect(result['PROJ-2'][0].segments[0].text).toBe('At Risk');
  });

  test('ignores separator lines (---)', () => {
    const response = `--- Ticket: PROJ-1 ---
TICKET:PROJ-1
SECTION:Accomplished
ITEM:Progress is good.

--- Ticket: PROJ-2 ---
TICKET:PROJ-2
SECTION:At Risk
ITEM:Some delays.`;

    const result = parseTicketSummaries(response);

    expect(result['PROJ-1'][1].segments[0].text).toBe('Progress is good.');
    expect(result['PROJ-2'][1].segments[0].text).toBe('Some delays.');
  });

  test('handles missing TICKET marker gracefully', () => {
    const response = 'SECTION:Accomplished\nITEM:Some work done.';
    expect(parseTicketSummaries(response)).toEqual({});
  });

  test('trims whitespace from ticket keys and item text', () => {
    const response = 'TICKET:  PROJ-1  \nSECTION:  Accomplished  \nITEM:  Making progress.  ';
    const result = parseTicketSummaries(response);

    expect(result['PROJ-1']).toBeDefined();
    expect(result['PROJ-1'][0].segments[0].text).toBe('Accomplished');
    expect(result['PROJ-1'][1].segments[0].text).toBe('Making progress.');
  });

  test('handles empty response', () => {
    expect(parseTicketSummaries('')).toEqual({});
  });

  test('handles null response', () => {
    expect(parseTicketSummaries(null)).toEqual({});
  });

  test('preserves last ticket when no final newline', () => {
    const response = 'TICKET:PROJ-1\nSECTION:Accomplished\nITEM:First\nTICKET:PROJ-2\nSECTION:At Risk\nITEM:Last';
    const result = parseTicketSummaries(response);

    expect(result['PROJ-1'][1].segments[0].text).toBe('First');
    expect(result['PROJ-2'][1].segments[0].text).toBe('Last');
  });

  test('item text with colons is preserved intact', () => {
    const response = 'TICKET:PROJ-1\nSECTION:At Risk\nITEM:Status: blocked. Reason: awaiting PROJ-2.';
    const blocks = parseTicketSummaries(response)['PROJ-1'];

    expect(blocks[1].segments[0].text).toBe('Status: blocked. Reason: awaiting PROJ-2.');
  });
});
