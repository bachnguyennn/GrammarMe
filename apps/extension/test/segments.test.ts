import { describe, expect, it } from 'vitest';
import {
  badgeLabel,
  buildSegments,
  ignoreKey,
  replacementButtons,
  suggestionAt,
  visibleSuggestions,
} from '../src/segments.ts';
import { sug } from './helpers.ts';

const text = 'I has teh cat.';

describe('buildSegments', () => {
  it('covers the whole text with plain and underlined segments', () => {
    const s = [sug(text, 'has', { category: 'grammar' }), sug(text, 'teh')];
    const segs = buildSegments(text, s);
    expect(segs).toEqual([
      { start: 0, end: 2, index: -1 },
      { start: 2, end: 5, index: 0 },
      { start: 5, end: 6, index: -1 },
      { start: 6, end: 9, index: 1 },
      { start: 9, end: 14, index: -1 },
    ]);
    expect(segs.map((g) => text.slice(g.start, g.end)).join('')).toBe(text);
  });

  it('handles suggestions at the edges, zero-length insertions and empty text', () => {
    expect(buildSegments('teh', [sug('teh', 'teh')])).toEqual([{ start: 0, end: 3, index: 0 }]);
    const ins = { ...sug('ab', 'a'), start: 1, end: 1, original: '' };
    expect(buildSegments('ab', [ins])).toEqual([
      { start: 0, end: 1, index: -1 },
      { start: 1, end: 1, index: 0 },
      { start: 1, end: 2, index: -1 },
    ]);
    expect(buildSegments('', [])).toEqual([{ start: 0, end: 0, index: -1 }]);
  });

  it('skips overlapping or out-of-range suggestions instead of corrupting text', () => {
    const a = sug(text, 'has teh', { category: 'grammar' });
    const b = sug(text, 'teh');
    const bad = { ...sug(text, 'cat'), end: 99 };
    const segs = buildSegments(text, [a, b, bad]);
    expect(segs.filter((g) => g.index >= 0).map((g) => g.index)).toEqual([0]);
    expect(segs.map((g) => text.slice(g.start, g.end)).join('')).toBe(text);
  });

  it('keeps markup-looking text as plain text ranges (overlay uses textContent)', () => {
    const t = '<img src=x onerror=alert(1)> teh';
    const segs = buildSegments(t, [sug(t, 'teh')]);
    expect(t.slice(segs[0]!.start, segs[0]!.end)).toBe('<img src=x onerror=alert(1)> ');
  });

  it('uses UTF-16 offsets (emoji before the error)', () => {
    const t = '😀 teh';
    const s = sug(t, 'teh');
    expect(s.start).toBe(3);
    const segs = buildSegments(t, [s]);
    expect(t.slice(segs[1]!.start, segs[1]!.end)).toBe('teh');
  });
});

describe('suggestionAt', () => {
  const s = [sug(text, 'teh')]; // 6..9
  it('hit-tests clicks inclusively and keyboard carets exclusively at the end', () => {
    expect(suggestionAt(s, 6, true)).toBe(s[0]);
    expect(suggestionAt(s, 9, true)).toBe(s[0]);
    expect(suggestionAt(s, 9, false)).toBeUndefined();
    expect(suggestionAt(s, 5, true)).toBeUndefined();
  });
});

describe('visibleSuggestions', () => {
  it('drops ignored issues and dictionary words, and resolves overlaps', () => {
    const t = 'Bach wrote teh code';
    const name = sug(t, 'Bach');
    const typo = sug(t, 'teh');
    const style = sug(t, 'teh code', { category: 'style', rule: 'Style' });
    expect(visibleSuggestions([name, typo, style], new Set(), new Set(['bach'])).map((s) => s.original)).toEqual(['teh']);
    expect(visibleSuggestions([name, typo], new Set([ignoreKey(typo)]), new Set()).map((s) => s.original)).toEqual(['Bach']);
    // Dictionary only affects spelling.
    const grammar = sug(t, 'Bach', { category: 'grammar', rule: 'Cap' });
    expect(visibleSuggestions([grammar], new Set(), new Set(['bach']))).toHaveLength(1);
  });
});

describe('labels', () => {
  it('builds at most three accessible replacement buttons', () => {
    const b = replacementButtons({ original: 'teh', replacements: ['the', 'tea', 'ten', 'tech'] });
    expect(b.map((x) => x.label)).toEqual(['the', 'tea', 'ten']);
    expect(b[0]!.ariaLabel).toBe('Replace “teh” with “the”');
    const del = replacementButtons({ original: 'the the', replacements: ['', ' '] });
    expect(del[0]!.label).toBe('Remove “the the”');
    expect(del[1]!.label).toBe('␣');
  });

  it('describes the badge state', () => {
    expect(badgeLabel(0, 'idle').text).toBe('✓');
    expect(badgeLabel(0, 'checking').text).toBe('…');
    expect(badgeLabel(1, 'idle').aria).toBe('GrammarMe: 1 issue. Open the first one.');
    expect(badgeLabel(150, 'checking').text).toBe('99+');
    expect(badgeLabel(0, 'too-long').text).toBe('–');
  });
});
