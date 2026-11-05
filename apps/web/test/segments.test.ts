import { describe, expect, it } from 'vitest';
import type { Suggestion } from '@grammarme/core';
import { buildSegments, dismissKey, groupOf } from '../src/segments.ts';
import { aiWindow, AI_MAX_CHARS } from '../src/ai.ts';

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
    expect(groupOf(sug(0, 1, 'a', { source: 'ai', category: 'grammar' }))).toBe('ai');
    expect(groupOf(sug(0, 1, 'a', { category: 'clarity' }))).toBe('clarity');
  });
  it('dismiss key survives offset shifts', () => {
    const a = 'Hello teh world';
    const b = 'Oh. Hello teh world';
    expect(dismissKey(a, sug(6, 9, a))).toBe(dismissKey(b, sug(10, 13, b)));
  });
});

describe('aiWindow', () => {
  it('sends whole short documents', () => {
    expect(aiWindow('short text', 3)).toEqual({ text: 'short text', offset: 0 });
  });
  it('sends only the caret paragraph for long documents', () => {
    const p1 = 'a'.repeat(AI_MAX_CHARS);
    const text = `${p1}\n\nsecond para here\n\nthird`;
    const w = aiWindow(text, p1.length + 5);
    expect(w.text).toBe('second para here');
    expect(text.slice(w.offset, w.offset + w.text.length)).toBe(w.text);
  });
});
