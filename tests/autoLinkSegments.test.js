'use strict';

const { loadPureFunctions } = require('./appsScriptSandbox');
const { autoLinkSegments } = loadPureFunctions();

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
