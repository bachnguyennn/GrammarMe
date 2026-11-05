/** Pure unit tests for the Harper adapter — no WASM, Harper lints are faked. */
import { SuggestionKind, type Lint } from 'harper.js';
import { describe, expect, it } from 'vitest';
import { categoryForLintKind, codePointToUtf16, lintToSuggestion, looksLikeCode, resolveSpan } from '../src/harper.ts';
import { suggestionId } from '../src/suggestions.ts';

interface FakeSug {
  kind: SuggestionKind;
  text: string;
}

function fakeLint(start: number, end: number, problem: string, sugs: FakeSug[], kind = 'Spelling', message = 'msg'): Lint {
  return {
    span: () => ({ start, end }),
    get_problem_text: () => problem,
    lint_kind: () => kind,
    message: () => message,
    suggestions: () => sugs.map((s) => ({ kind: () => s.kind, get_replacement_text: () => s.text })),
  } as unknown as Lint;
}

const R = (text: string): FakeSug => ({ kind: SuggestionKind.Replace, text });

describe('codePointToUtf16', () => {
  it('is the identity for BMP-only text', () => {
    for (let i = 0; i <= 5; i++) expect(codePointToUtf16('hello', i)).toBe(i);
  });

  it('accounts for surrogate pairs and ZWJ sequences', () => {
    const t = '😀a👨‍👩‍👧‍👦b';
    // code points: 😀 | a | 👨 | ZWJ | 👩 | ZWJ | 👧 | ZWJ | 👦 | b
    expect(codePointToUtf16(t, 0)).toBe(0);
    expect(codePointToUtf16(t, 1)).toBe(2);
    expect(codePointToUtf16(t, 2)).toBe(3);
    expect(codePointToUtf16(t, 9)).toBe(14);
    expect(codePointToUtf16(t, 10)).toBe(15);
  });

  it('treats combining marks as their own code points (they are BMP)', () => {
    expect(codePointToUtf16('éx', 2)).toBe(2);
  });

  it('clamps past-the-end indices to the string length', () => {
    expect(codePointToUtf16('😀😀', 99)).toBe(4);
    expect(codePointToUtf16('', 3)).toBe(0);
  });
});

describe('resolveSpan', () => {
  it('accepts UTF-16 spans as-is', () => {
    expect(resolveSpan('😀 teh', 3, 6, 'teh')).toEqual([3, 6]);
  });

  it('falls back to code-point spans', () => {
    // A code-point producer would report "teh" at 2..5.
    expect(resolveSpan('😀 teh', 2, 5, 'teh')).toEqual([3, 6]);
    expect(resolveSpan('👨‍👩‍👧‍👦 teh', 8, 11, 'teh')).toEqual([12, 15]);
  });

  it('returns null when neither interpretation matches the problem text', () => {
    expect(resolveSpan('😀 teh', 0, 3, 'teh')).toBeNull();
    expect(resolveSpan('abc', 0, 3, 'xyz')).toBeNull();
  });
});

describe('categoryForLintKind', () => {
  it.each([
    ['Spelling', 'spelling'],
    ['Typo', 'spelling'],
    ['Punctuation', 'punctuation'],
    ['Formatting', 'punctuation'],
    ['Agreement', 'grammar'],
    ['Capitalization', 'grammar'],
    ['Malapropism', 'grammar'],
    ['Readability', 'clarity'],
    ['Redundancy', 'clarity'],
    ['WordChoice', 'clarity'],
    ['Style', 'style'],
    ['Enhancement', 'style'],
    ['Regionalism', 'style'],
    ['SomethingNewUpstream', 'grammar'],
  ] as const)('%s -> %s', (kind, cat) => {
    expect(categoryForLintKind(kind)).toBe(cat);
  });
});

describe('lintToSuggestion', () => {
  it('maps a simple spelling lint, with a deterministic id', () => {
    const text = 'I recieve mail.';
    const s = lintToSuggestion(text, fakeLint(2, 9, 'recieve', [R('receive'), R('relieve')]), 'SpellCheck', 3)!;
    expect(s).toMatchObject({
      start: 2,
      end: 9,
      original: 'recieve',
      replacements: ['receive', 'relieve'],
      category: 'spelling',
      source: 'harper',
      rule: 'SpellCheck',
      message: 'msg',
      documentVersion: 3,
    });
    expect(s.id).toBe(suggestionId(s));
  });

  it('turns Remove into "" and InsertAfter into original + inserted text', () => {
    const text = 'the the cat';
    const rm = lintToSuggestion(text, fakeLint(3, 7, ' the', [{ kind: SuggestionKind.Remove, text: '' }]), 'Repeated', 1)!;
    expect(rm.replacements).toEqual(['']);
    const ins = lintToSuggestion('Hello world', fakeLint(0, 5, 'Hello', [{ kind: SuggestionKind.InsertAfter, text: ',' }]), 'Comma', 1)!;
    expect(ins.replacements).toEqual(['Hello,']);
  });

  it('drops no-op and duplicate replacements and caps the list at 5', () => {
    const text = 'teh';
    const sugs = ['teh', 'the', 'the', 'tea', 'ten', 'tel', 'tee', 'tex'].map(R);
    const s = lintToSuggestion(text, fakeLint(0, 3, 'teh', sugs), 'SpellCheck', 1)!;
    expect(s.replacements).toEqual(['the', 'tea', 'ten', 'tel', 'tee']);
  });

  it('allows explain-only lints (no replacements)', () => {
    expect(lintToSuggestion('Long sentence.', fakeLint(0, 4, 'Long', [], 'Readability'), 'LongSentences', 1)!.replacements).toEqual([]);
  });

  it('converts code-point spans and keeps slice(start,end) === original', () => {
    const text = '😀😀 Their is a problm.';
    const s = lintToSuggestion(text, fakeLint(14, 20, 'problm', [R('problem')]), 'SpellCheck', 1)!;
    expect([s.start, s.end]).toEqual([16, 22]);
    expect(text.slice(s.start, s.end)).toBe(s.original);
  });

  it('returns null (never a misplaced suggestion) when the span cannot be resolved', () => {
    expect(lintToSuggestion('abc', fakeLint(0, 3, 'xyz', [R('q')]), 'X', 1)).toBeNull();
  });
});

describe('looksLikeCode', () => {
  it('matches identifiers, paths and acronyms', () => {
    for (const t of ['getUserById', 'S3', 'p95', 'ETL', 'ENV', 'APIs', 'user_id', 'index.ts', 'a/b']) expect(looksLikeCode(t)).toBe(true);
  });
  it('does not match ordinary or misspelled words', () => {
    for (const t of ['recieve', 'Teh', 'Paris', 'I', 'A', 'definately', 'Nguyễn']) expect(looksLikeCode(t)).toBe(false);
  });
});
