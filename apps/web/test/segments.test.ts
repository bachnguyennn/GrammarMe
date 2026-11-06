import { describe, expect, it } from 'vitest';
import type { Suggestion } from '@grammarme/core';
import { buildSegments, dismissKey, groupOf } from '../src/segments.ts';

const sug = (start: number, end: number, text: string, extra: Partial<Suggestion> = {}): Suggestion => ({
  id: `s${start}`, start, end, original: text.slice(start, end), replacements: ['x'],
  category: 'spelling', source: 'harper', message: '', rule: 'R', documentVersion: 1, ...extra,
});

describe('buildSegments', () => {
  it('reassembles the exact text, including emoji', () => {
    const text = '😀 teh cat 👍🏽 sat';
    const segs = buildSegments(text, [sug(3, 6, text)]);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs[1]).toMatchObject({ text: 'teh' });
  });
  it('skips zero-length and overlapping ranges', () => {
    const text = 'abcdef';
    const segs = buildSegments(text, [sug(1, 4, text), sug(2, 3, text), sug(5, 5, text)]);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs.filter((s) => s.suggestion)).toHaveLength(1);
  });
});

describe('groupOf / dismissKey', () => {
  it('groups AI separately', () => {
    expect(groupOf(sug(0, 1, 'a', { category: 'clarity' }))).toBe('clarity');
  });
  it('dismiss key survives offset shifts', () => {
    const a = 'Hello teh world';
    const b = 'Oh. Hello teh world';
    expect(dismissKey(a, sug(6, 9, a))).toBe(dismissKey(b, sug(10, 13, b)));
  });
});
