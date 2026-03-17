'use strict';

const { loadPureFunctions } = require('./appsScriptSandbox');
const { adfToBlocks, STATUS_COLORS } = loadPureFunctions();

// ── Helpers ───────────────────────────────────────────────────────────────────

function doc(content) {
  return { version: 1, type: 'doc', content };
}

function para(content) {
  return { type: 'paragraph', content };
}

function text(t, marks) {
  const node = { type: 'text', text: t };
  if (marks && marks.length) node.marks = marks;
  return node;
}

function mark(type, attrs) {
  return attrs ? { type, attrs } : { type };
}

// ── Non-ADF fallback ──────────────────────────────────────────────────────────

describe('adfToBlocks — non-ADF input', () => {
  test('null input returns single empty-text para', () => {
    const blocks = adfToBlocks(null);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('para');
    expect(blocks[0].segments[0].text).toBe('');
  });

  test('plain string (no version) is wrapped in a para', () => {
    const blocks = adfToBlocks('hello');
    expect(blocks[0].segments[0].text).toBe('hello');
  });
});

// ── Plain paragraphs ──────────────────────────────────────────────────────────

describe('adfToBlocks — paragraphs', () => {
  test('single paragraph with plain text', () => {
    const blocks = adfToBlocks(doc([para([text('Hello world')])]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('para');
    expect(blocks[0].segments[0].text).toBe('Hello world');
    expect(blocks[0].segments[0].bold).toBe(false);
  });

  test('empty paragraph produces no blocks', () => {
    const blocks = adfToBlocks(doc([para([])]));
    expect(blocks).toHaveLength(0);
  });

  test('multiple paragraphs', () => {
    const blocks = adfToBlocks(doc([
      para([text('First')]),
      para([text('Second')]),
    ]));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].segments[0].text).toBe('First');
    expect(blocks[1].segments[0].text).toBe('Second');
  });
});

// ── Inline marks ─────────────────────────────────────────────────────────────

describe('adfToBlocks — inline marks', () => {
  test('bold text', () => {
    const blocks = adfToBlocks(doc([para([text('Bold', [mark('strong')])])]));
    expect(blocks[0].segments[0].bold).toBe(true);
    expect(blocks[0].segments[0].italic).toBe(false);
  });

  test('italic text', () => {
    const blocks = adfToBlocks(doc([para([text('Italic', [mark('em')])])]));
    expect(blocks[0].segments[0].italic).toBe(true);
  });

  test('underline text', () => {
    const blocks = adfToBlocks(doc([para([text('Under', [mark('underline')])])]));
    expect(blocks[0].segments[0].underline).toBe(true);
  });

  test('strikethrough text', () => {
    const blocks = adfToBlocks(doc([para([text('Strike', [mark('strike')])])]));
    expect(blocks[0].segments[0].strike).toBe(true);
  });

  test('inline code', () => {
    const blocks = adfToBlocks(doc([para([text('code()', [mark('code')])])]));
    expect(blocks[0].segments[0].code).toBe(true);
  });

  test('link', () => {
    const blocks = adfToBlocks(doc([
      para([text('click', [mark('link', { href: 'https://example.com' })])])
    ]));
    expect(blocks[0].segments[0].url).toBe('https://example.com');
  });

  test('combined bold + italic', () => {
    const blocks = adfToBlocks(doc([
      para([text('Both', [mark('strong'), mark('em')])])
    ]));
    const seg = blocks[0].segments[0];
    expect(seg.bold).toBe(true);
    expect(seg.italic).toBe(true);
  });

  test('mixed plain and bold segments in same paragraph', () => {
    const blocks = adfToBlocks(doc([
      para([text('Hello '), text('world', [mark('strong')])])
    ]));
    expect(blocks[0].segments).toHaveLength(2);
    expect(blocks[0].segments[0].bold).toBe(false);
    expect(blocks[0].segments[1].bold).toBe(true);
  });
});

// ── Hard break ────────────────────────────────────────────────────────────────

describe('adfToBlocks — hardBreak', () => {
  test('hardBreak emits a newline segment', () => {
    const blocks = adfToBlocks(doc([
      para([text('line1'), { type: 'hardBreak' }, text('line2')])
    ]));
    const texts = blocks[0].segments.map(s => s.text);
    expect(texts).toEqual(['line1', '\n', 'line2']);
  });
});

// ── Status lozenge ────────────────────────────────────────────────────────────

describe('adfToBlocks — status nodes', () => {
  test('status node produces uppercase bold text with lozenge colors', () => {
    const statusNode = {
      type: 'status',
      attrs: { text: 'In Progress', color: 'blue' }
    };
    const blocks = adfToBlocks(doc([para([statusNode])]));
    const seg = blocks[0].segments[0];
    expect(seg.text).toBe(' IN PROGRESS ');
    expect(seg.bold).toBe(true);
    expect(seg.bgColor).toBe(STATUS_COLORS.blue.bg);
    expect(seg.fgColor).toBe(STATUS_COLORS.blue.fg);
  });

  test('unknown color falls back to neutral palette', () => {
    const statusNode = { type: 'status', attrs: { text: 'Custom', color: 'magenta' } };
    const blocks = adfToBlocks(doc([para([statusNode])]));
    expect(blocks[0].segments[0].bgColor).toBe(STATUS_COLORS.neutral.bg);
  });

  test('status node with no attrs produces no blocks (empty para is dropped)', () => {
    const blocks = adfToBlocks(doc([para([{ type: 'status' }])]));
    expect(blocks).toHaveLength(0);
  });
});

// ── Emoji & mention ───────────────────────────────────────────────────────────

describe('adfToBlocks — emoji and mention', () => {
  test('emoji with text attr', () => {
    const blocks = adfToBlocks(doc([para([{ type: 'emoji', attrs: { text: '😀' } }])]));
    expect(blocks[0].segments[0].text).toBe('😀');
  });

  test('emoji falls back to shortName', () => {
    const blocks = adfToBlocks(doc([para([{ type: 'emoji', attrs: { shortName: ':tada:' } }])]));
    expect(blocks[0].segments[0].text).toBe(':tada:');
  });

  test('mention with text attr', () => {
    const blocks = adfToBlocks(doc([para([{ type: 'mention', attrs: { text: '@alice' } }])]));
    expect(blocks[0].segments[0].text).toBe('@alice');
  });
});

// ── Code block ────────────────────────────────────────────────────────────────

describe('adfToBlocks — codeBlock', () => {
  test('code block marks all segments as code', () => {
    const blocks = adfToBlocks(doc([{
      type: 'codeBlock',
      content: [text('const x = 1;')]
    }]));
    expect(blocks[0].segments[0].code).toBe(true);
    expect(blocks[0].segments[0].text).toBe('const x = 1;');
  });
});

// ── Bullet list ───────────────────────────────────────────────────────────────

describe('adfToBlocks — bulletList', () => {
  function bulletList(items) {
    return {
      type: 'bulletList',
      content: items.map(t => ({
        type: 'listItem',
        content: [para([text(t)])]
      }))
    };
  }

  test('flat bullet list produces listItem blocks at level 0', () => {
    const blocks = adfToBlocks(doc([bulletList(['Alpha', 'Beta', 'Gamma'])]));
    expect(blocks).toHaveLength(3);
    blocks.forEach(b => {
      expect(b.type).toBe('listItem');
      expect(b.level).toBe(0);
      expect(b.ordered).toBe(false);
    });
    expect(blocks[0].segments[0].text).toBe('Alpha');
    expect(blocks[2].segments[0].text).toBe('Gamma');
  });

  test('nested bullet list increments nesting level', () => {
    const nested = {
      type: 'bulletList',
      content: [{
        type: 'listItem',
        content: [
          para([text('Parent')]),
          bulletList(['Child'])
        ]
      }]
    };
    const blocks = adfToBlocks(doc([nested]));
    expect(blocks[0].level).toBe(0);
    expect(blocks[0].segments[0].text).toBe('Parent');
    expect(blocks[1].level).toBe(1);
    expect(blocks[1].segments[0].text).toBe('Child');
  });
});

// ── Ordered list ──────────────────────────────────────────────────────────────

describe('adfToBlocks — orderedList', () => {
  test('ordered list items have ordered=true', () => {
    const blocks = adfToBlocks(doc([{
      type: 'orderedList',
      content: [
        { type: 'listItem', content: [para([text('First')])] },
        { type: 'listItem', content: [para([text('Second')])] },
      ]
    }]));
    expect(blocks[0].ordered).toBe(true);
    expect(blocks[1].ordered).toBe(true);
  });
});

// ── Blockquote / panel ────────────────────────────────────────────────────────

describe('adfToBlocks — blockquote and panel', () => {
  test('blockquote recurses into children', () => {
    const blocks = adfToBlocks(doc([{
      type: 'blockquote',
      content: [para([text('Quoted text')])]
    }]));
    expect(blocks[0].segments[0].text).toBe('Quoted text');
  });

  test('panel recurses into children', () => {
    const blocks = adfToBlocks(doc([{
      type: 'panel',
      content: [para([text('Panel text')])]
    }]));
    expect(blocks[0].segments[0].text).toBe('Panel text');
  });
});

// ── Horizontal rule ───────────────────────────────────────────────────────────

describe('adfToBlocks — rule', () => {
  test('rule node emits a --- para', () => {
    const blocks = adfToBlocks(doc([{ type: 'rule' }]));
    expect(blocks[0].segments[0].text).toBe('---');
  });
});

// ── inlineCard / blockCard ────────────────────────────────────────────────────

describe('adfToBlocks — card nodes', () => {
  test('inlineCard emits the url as text', () => {
    const blocks = adfToBlocks(doc([
      para([{ type: 'inlineCard', attrs: { url: 'https://jira.example.com/browse/PROJ-1' } }])
    ]));
    expect(blocks[0].segments[0].text).toBe('https://jira.example.com/browse/PROJ-1');
  });
});
