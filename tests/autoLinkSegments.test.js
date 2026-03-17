'use strict';

const { loadPureFunctions } = require('./appsScriptSandbox');
const { autoLinkSegments } = loadPureFunctions();

const BASE = 'https://example.atlassian.net';

function seg(text, extra) {
  return Object.assign({
    text, bold: false, italic: false, underline: false,
    strike: false, code: false, url: null, bgColor: null, fgColor: null
  }, extra || {});
}

describe('autoLinkSegments', () => {
  test('plain text with no URLs is returned unchanged', () => {
    const input = [seg('no links here')];
    expect(autoLinkSegments(input)).toEqual(input);
  });

  test('bare URL in text becomes a linked segment', () => {
    const result = autoLinkSegments([seg('see https://example.com for details')]);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('see ');
    expect(result[0].url).toBeNull();
    expect(result[1].text).toBe('https://example.com');
    expect(result[1].url).toBe('https://example.com');
    expect(result[2].text).toBe(' for details');
    expect(result[2].url).toBeNull();
  });

  test('URL at start of text', () => {
    const result = autoLinkSegments([seg('https://example.com is great')]);
    expect(result[0].url).toBe('https://example.com');
    expect(result[1].text).toBe(' is great');
  });

  test('URL at end of text', () => {
    const result = autoLinkSegments([seg('visit https://example.com')]);
    expect(result[1].url).toBe('https://example.com');
    expect(result[0].text).toBe('visit ');
  });

  test('text that is only a URL', () => {
    const result = autoLinkSegments([seg('https://example.com')]);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com');
  });

  test('multiple URLs in same segment', () => {
    const result = autoLinkSegments([seg('https://a.com and https://b.com')]);
    const urls = result.filter(s => s.url).map(s => s.url);
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
  });

  test('already-linked segment is not re-processed', () => {
    const input = [seg('https://example.com', { url: 'https://example.com' })];
    const result = autoLinkSegments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(input[0]);
  });

  test('preserves formatting on split segments', () => {
    const input = [seg('bold with https://example.com link', { bold: true })];
    const result = autoLinkSegments(input);
    result.forEach(s => expect(s.bold).toBe(true));
  });

  test('http:// URLs are also linked', () => {
    const result = autoLinkSegments([seg('http://insecure.example.com')]);
    expect(result[0].url).toBe('http://insecure.example.com');
  });

  test('empty segments array returns empty array', () => {
    expect(autoLinkSegments([])).toEqual([]);
  });

  test('segment with empty text is passed through', () => {
    const input = [seg('')];
    expect(autoLinkSegments(input)).toEqual(input);
  });
});

// ── Jira ticket key auto-linking ──────────────────────────────────────────────

describe('autoLinkSegments — Jira ticket keys', () => {
  test('bare ticket key becomes a Jira browse link', () => {
    const result = autoLinkSegments([seg('see PROJ-123 for details')], BASE);
    expect(result).toHaveLength(3);
    expect(result[1].text).toBe('PROJ-123');
    expect(result[1].url).toBe(BASE + '/browse/PROJ-123');
  });

  test('ticket key at start of text', () => {
    const result = autoLinkSegments([seg('PROJ-1 is the goal')], BASE);
    expect(result[0].text).toBe('PROJ-1');
    expect(result[0].url).toBe(BASE + '/browse/PROJ-1');
  });

  test('ticket key at end of text', () => {
    const result = autoLinkSegments([seg('tracked in PROJ-99')], BASE);
    const last = result[result.length - 1];
    expect(last.text).toBe('PROJ-99');
    expect(last.url).toBe(BASE + '/browse/PROJ-99');
  });

  test('multi-part project key (e.g. INFOKR-42)', () => {
    const result = autoLinkSegments([seg('see INFOKR-42')], BASE);
    const linked = result.find(s => s.url);
    expect(linked.text).toBe('INFOKR-42');
    expect(linked.url).toBe(BASE + '/browse/INFOKR-42');
  });

  test('multiple ticket keys in one segment', () => {
    const result = autoLinkSegments([seg('PROJ-1 and PROJ-2 are related')], BASE);
    const linked = result.filter(s => s.url);
    expect(linked).toHaveLength(2);
    expect(linked[0].url).toBe(BASE + '/browse/PROJ-1');
    expect(linked[1].url).toBe(BASE + '/browse/PROJ-2');
  });

  test('ticket key and URL in same segment', () => {
    const result = autoLinkSegments([seg('PROJ-1 see https://example.com')], BASE);
    const linked = result.filter(s => s.url);
    expect(linked).toHaveLength(2);
    expect(linked[0].url).toBe(BASE + '/browse/PROJ-1');
    expect(linked[1].url).toBe('https://example.com');
  });

  test('lowercase key is not matched', () => {
    const result = autoLinkSegments([seg('proj-123 is lowercase')], BASE);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBeNull();
  });

  test('key already inside a URL is not double-linked', () => {
    const input = [seg('https://example.atlassian.net/browse/PROJ-1')];
    const result = autoLinkSegments(input, BASE);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.atlassian.net/browse/PROJ-1');
  });

  test('preserves formatting on split segments', () => {
    const input = [seg('bold PROJ-1 text', { bold: true })];
    const result = autoLinkSegments(input, BASE);
    result.forEach(s => expect(s.bold).toBe(true));
  });
});
