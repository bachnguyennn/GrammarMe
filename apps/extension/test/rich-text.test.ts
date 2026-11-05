import { describe, expect, it } from 'vitest';
import { domPointAt, extractText, offsetAtDom } from '../src/rich-text.ts';

/* Minimal fake DOM: only the Node API subset rich-text.ts uses. */
interface Fake {
  nodeType: number;
  nodeName: string;
  childNodes: Fake[];
  data?: string;
  attrs?: Record<string, string>;
  getAttribute?(name: string): string | null;
}
const t = (data: string): Fake => ({ nodeType: 3, nodeName: '#text', childNodes: [], data });
const h = (tag: string, attrs: Record<string, string> | Fake[] = {}, ...kids: Fake[]): Fake => {
  const a = Array.isArray(attrs) ? {} : attrs;
  const children = Array.isArray(attrs) ? [...attrs, ...kids] : kids;
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    childNodes: children,
    attrs: a,
    getAttribute: (n) => (n in a ? a[n]! : null),
  };
};
const asNode = (f: Fake) => f as unknown as Node;
const extract = (f: Fake) => extractText(asNode(f));

describe('extractText', () => {
  it('reads plain inline text with offsets mapped 1:1', () => {
    const a = t('Hello ');
    const b = t('wrld');
    const root = h('div', [a, h('b', [b]), t('!')]);
    const m = extract(root);
    expect(m.text).toBe('Hello wrld!');
    expect(m.segments.map((s) => [s.start, s.end])).toEqual([[0, 6], [6, 10], [10, 11]]);
  });

  it('turns Gmail-style div lines and <br> into newlines, keeping blank lines', () => {
    // <div>Hi there</div><div><br></div><div>Thanks</div>
    const root = h('div', [h('div', [t('Hi there')]), h('div', [h('br')]), h('div', [t('Thanks')])]);
    expect(extract(root).text).toBe('Hi there\n\nThanks');
  });

  it('handles text directly in the editor followed by blocks', () => {
    const root = h('div', [t('First'), h('div', [t('Second')]), h('p', [t('Third')])]);
    expect(extract(root).text).toBe('First\nSecond\nThird');
  });

  it('maps no-break spaces and stray newlines to spaces without shifting offsets', () => {
    const root = h('div', [t('a b\nc\td')]);
    const m = extract(root);
    expect(m.text).toBe('a b c d');
    expect(m.text.length).toBe(7);
  });

  it('skips quoted replies, non-editable islands, hidden and opted-out parts', () => {
    const root = h(
      'div',
      [h('div', [t('My reply')]),
      h('div', { class: 'gmail_quote' }, h('div', [t('On Monday someone wrote: teh old text')])),
      h('span', { contenteditable: 'false' }, t('@Chip')),
      h('span', { hidden: '' }, t('secret')),
      h('div', { 'data-grammarme': 'off' }, t('skip me')),
      h('div', { id: 'divRplyFwdMsg' }, t('From: x')),
      h('div', [t('Bye')])],
    );
    expect(extract(root).text).toBe('My reply\nBye');
  });

  it('skips scripts, styles and form controls', () => {
    const root = h('div', [t('Text'), h('style', [t('.a{}')]), h('script', [t('x()')]), h('button', [t('Send')])]);
    expect(extract(root).text).toBe('Text');
  });
});

describe('domPointAt / offsetAtDom', () => {
  const a = t('I has ');
  const b = t('a apple');
  const c = t('Second line');
  const line2 = h('div', [c]);
  const root = h('div', [h('div', [a, h('i', [b])]), line2]);
  const m = extract(root);

  it('extracts the expected text', () => {
    expect(m.text).toBe('I has a apple\nSecond line');
  });

  it('maps offsets inside a node', () => {
    expect(domPointAt(m, 2, 'forward')).toEqual({ node: a, offset: 2 });
    expect(domPointAt(m, 5, 'backward')).toEqual({ node: a, offset: 5 });
  });

  it('puts a range start at a node boundary into the next node and an end into the previous one', () => {
    expect(domPointAt(m, 6, 'forward')).toEqual({ node: b, offset: 0 });
    expect(domPointAt(m, 6, 'backward')).toEqual({ node: a, offset: 6 });
  });

  it('snaps offsets on a virtual newline to real text', () => {
    // offset 13 is the "\n" between the lines
    expect(domPointAt(m, 13, 'backward')).toEqual({ node: b, offset: 7 });
    expect(domPointAt(m, 13, 'forward')).toEqual({ node: c, offset: 0 });
  });

  it('round-trips caret positions in text nodes and element containers', () => {
    expect(offsetAtDom(m, asNode(b), 2)).toBe(8);
    expect(offsetAtDom(m, asNode(c), 0)).toBe(14);
    expect(offsetAtDom(m, asNode(line2), 0)).toBe(14); // before the line's first child
    expect(offsetAtDom(m, asNode(root), 2)).toBe(m.text.length); // after the last child
  });

  it('returns null for positions outside the mapped text', () => {
    expect(offsetAtDom(m, asNode(t('elsewhere')), 0)).toBeNull();
    expect(domPointAt(extract(h('div')), 0, 'forward')).toBeNull();
  });
});
