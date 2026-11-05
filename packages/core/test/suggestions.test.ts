import { describe, expect, it } from 'vitest';
import {
  StaleSuggestionError,
  applySuggestion,
  countByCategory,
  diffRange,
  hash,
  isApplicable,
  locateAiEdit,
  rebaseSuggestions,
  resolveOverlaps,
  suggestionId,
} from '../src/suggestions.ts';
import type { AiEdit, DocumentSnapshot, Suggestion } from '../src/types.ts';
import { isWellFormed, pick, rng, splitsSurrogate, sug, sugAt } from './support/fixtures.ts';

const doc = (text: string, version = 1): DocumentSnapshot => ({ text, version });

// Unicode building blocks used throughout. Lengths are UTF-16 code units.
const GRIN = '😀'; // U+1F600, surrogate pair, length 2
const FAMILY = '👨‍👩‍👧‍👦'; // ZWJ sequence: 4 emoji + 3 ZWJ = 11 units
const FLAG = '🇻🇳'; // two regional indicators = 4 units
const E_ACUTE_NFD = 'é'; // "é" as e + combining acute = 2 units
const E_ACUTE_NFC = 'é'; // precomposed "é" = 1 unit

describe('unicode fixtures sanity', () => {
  it('has the code-unit lengths the tests assume', () => {
    expect(GRIN.length).toBe(2);
    expect(FAMILY.length).toBe(11);
    expect(FLAG.length).toBe(4);
    expect(E_ACUTE_NFD.length).toBe(2);
    expect(E_ACUTE_NFC.length).toBe(1);
  });
});

describe('hash / suggestionId', () => {
  it('is 32-bit FNV-1a over UTF-16 code units (standard ASCII vectors)', () => {
    expect(hash('')).toBe((0x811c9dc5).toString(36));
    expect(hash('a')).toBe((0xe40c292c).toString(36));
    expect(hash('foobar')).toBe((0xbf9cf968).toString(36));
  });

  it('is deterministic and distinguishes near-identical inputs', () => {
    expect(hash('teh')).toBe(hash('teh'));
    expect(hash('teh')).not.toBe(hash('the'));
    expect(hash(GRIN)).not.toBe(hash('😁'));
    expect(hash(E_ACUTE_NFC)).not.toBe(hash(E_ACUTE_NFD));
  });

  it('builds ids from source + rule + range + original', () => {
    const base = { source: 'harper' as const, rule: 'SpellCheck', start: 3, end: 6, original: 'teh' };
    const id = suggestionId(base);
    expect(id).toMatch(/^harper-[0-9a-z]+$/);
    expect(suggestionId({ ...base })).toBe(id);
    expect(suggestionId({ ...base, start: 4, end: 7 })).not.toBe(id);
    expect(suggestionId({ ...base, rule: 'Other' })).not.toBe(id);
    expect(suggestionId({ ...base, source: 'ai' })).toMatch(/^ai-/);
  });
});

describe('isApplicable', () => {
  const text = 'I recieve mail.';
  it('accepts an exact match', () => {
    expect(isApplicable(doc(text), sugAt(text, 'recieve', 'receive'))).toBe(true);
  });
  it('rejects text mismatch, negative, reversed and out-of-bounds ranges', () => {
    expect(isApplicable(doc(text), sug(2, 9, 'receive', 'x'))).toBe(false);
    expect(isApplicable(doc(text), sug(-1, 3, 'I r', 'x'))).toBe(false);
    expect(isApplicable(doc(text), sug(5, 3, '', 'x'))).toBe(false);
    expect(isApplicable(doc(text), sug(10, 99, 'mail.', 'x'))).toBe(false);
  });
  it('accepts a zero-width insertion point inside bounds, including at the very end', () => {
    expect(isApplicable(doc(text), sug(text.length, text.length, '', '!'))).toBe(true);
    expect(isApplicable(doc(text), sug(0, 0, '', '>'))).toBe(true);
  });
  it('uses UTF-16 offsets: a range landing inside an emoji does not match', () => {
    const t = `${GRIN} teh`;
    expect(isApplicable(doc(t), sug(3, 6, 'teh', 'the'))).toBe(true);
    // A code-point based producer would say 2..5 — that must be rejected, not silently misapplied.
    expect(isApplicable(doc(t), sug(2, 5, 'teh', 'the'))).toBe(false);
  });
  it('distinguishes NFC and NFD forms of the same visible text', () => {
    const t = `caf${E_ACUTE_NFD} crème`;
    expect(isApplicable(doc(t), sug(0, 5, `caf${E_ACUTE_NFD}`, 'x'))).toBe(true);
    expect(isApplicable(doc(t), sug(0, 4, `caf${E_ACUTE_NFC}`, 'x'))).toBe(false);
  });
});

describe('applySuggestion', () => {
  it('replaces the range and bumps the version by exactly one', () => {
    const d = doc('I recieve mail.', 7);
    const out = applySuggestion(d, sugAt(d.text, 'recieve', 'receive', { version: 7 }));
    expect(out).toEqual({ text: 'I receive mail.', version: 8 });
  });

  it('does not mutate the input snapshot', () => {
    const d = doc('teh end', 1);
    applySuggestion(d, sugAt(d.text, 'teh', 'the'));
    expect(d).toEqual({ text: 'teh end', version: 1 });
  });

  it('honours replacementIndex and throws RangeError when it does not exist', () => {
    const d = doc('teh end');
    const s = sugAt(d.text, 'teh', 'the', { replacements: ['the', 'tea'] });
    expect(applySuggestion(d, s, 1).text).toBe('tea end');
    expect(() => applySuggestion(d, s, 2)).toThrow(RangeError);
  });

  it('throws RangeError for explain-only suggestions (no replacements)', () => {
    const d = doc('teh end');
    expect(() => applySuggestion(d, sugAt(d.text, 'teh', '', { replacements: [] }))).toThrow(RangeError);
  });

  it('empty-string replacement deletes the range', () => {
    const d = doc('the the cat');
    expect(applySuggestion(d, sug(3, 7, ' the', '')).text).toBe('the cat');
  });

  it('applies zero-width insertions', () => {
    const d = doc('Hello world');
    expect(applySuggestion(d, sug(5, 5, '', ',')).text).toBe('Hello, world');
  });

  it('rejects a suggestion from an older version even when the text is identical (stale version)', () => {
    const d = doc('teh end', 2);
    const s = sugAt(d.text, 'teh', 'the', { version: 1 });
    expect(isApplicable(d, s)).toBe(true);
    expect(() => applySuggestion(d, s)).toThrow(StaleSuggestionError);
  });

  it('rejects a suggestion from a NEWER version (out-of-order bookkeeping must not slip through)', () => {
    const d = doc('teh end', 2);
    expect(() => applySuggestion(d, sugAt(d.text, 'teh', 'the', { version: 3 }))).toThrow(StaleSuggestionError);
  });

  it('rejects a same-version suggestion whose text no longer matches', () => {
    const d = doc('the end', 1);
    expect(() => applySuggestion(d, sug(0, 3, 'teh', 'the', { version: 1 }))).toThrow(StaleSuggestionError);
  });

  it('StaleSuggestionError is an Error with a stable name', () => {
    const e = new StaleSuggestionError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('StaleSuggestionError');
    expect(e.message).toMatch(/changed/);
  });

  it('applies correctly after emoji, ZWJ sequences, flags, CJK and RTL text', () => {
    const cases = [
      [`${GRIN}${GRIN} teh end`, 'teh', 'the'],
      [`${FAMILY} teh family`, 'teh', 'the'],
      [`${FLAG} I recieve`, 'recieve', 'receive'],
      ['日本語のテキスト teh end', 'teh', 'the'],
      ['שלום עולם and teh end', 'teh', 'the'],
      [`Caf${E_ACUTE_NFD} au lait is teh best`, 'teh', 'the'],
    ] as const;
    for (const [text, bad, good] of cases) {
      const out = applySuggestion(doc(text), sugAt(text, bad, good));
      expect(out.text).toBe(text.replace(bad, good));
      expect(isWellFormed(out.text)).toBe(true);
    }
  });

  it('can replace an emoji or a ZWJ sequence as a whole', () => {
    const t = `Nice ${FAMILY}!`;
    expect(applySuggestion(doc(t), sugAt(t, FAMILY, 'family')).text).toBe('Nice family!');
    const t2 = `ok ${GRIN} ok`;
    expect(applySuggestion(doc(t2), sugAt(t2, GRIN, '🙂')).text).toBe('ok 🙂 ok');
  });
});

describe('diffRange', () => {
  /** Reconstructs `next` from `prev` + change; asserts the structural invariants. */
  function checkInvariants(prev: string, next: string) {
    const c = diffRange(prev, next);
    if (prev === next) {
      expect(c).toBeNull();
      return;
    }
    expect(c).not.toBeNull();
    const { start, oldEnd, newEnd } = c!;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(oldEnd).toBeGreaterThanOrEqual(start);
    expect(newEnd).toBeGreaterThanOrEqual(start);
    expect(oldEnd).toBeLessThanOrEqual(prev.length);
    expect(newEnd).toBeLessThanOrEqual(next.length);
    expect(prev.slice(0, start)).toBe(next.slice(0, start));
    expect(prev.slice(oldEnd)).toBe(next.slice(newEnd));
    expect(prev.slice(0, start) + next.slice(start, newEnd) + prev.slice(oldEnd)).toBe(next);
    for (const [t, i] of [
      [prev, start],
      [prev, oldEnd],
      [next, start],
      [next, newEnd],
    ] as const) {
      expect(splitsSurrogate(t, i), `split at ${i} in ${JSON.stringify(t)}`).toBe(false);
    }
    return c!;
  }

  it('returns null for identical text', () => {
    expect(diffRange('abc', 'abc')).toBeNull();
    expect(diffRange('', '')).toBeNull();
  });

  it('describes insertions, deletions and replacements', () => {
    expect(diffRange('helo', 'hello')).toEqual({ start: 3, oldEnd: 3, newEnd: 4 });
    expect(diffRange('hello', 'helo')).toEqual({ start: 3, oldEnd: 4, newEnd: 3 });
    expect(diffRange('cat', 'cot')).toEqual({ start: 1, oldEnd: 2, newEnd: 2 });
    expect(diffRange('', 'abc')).toEqual({ start: 0, oldEnd: 0, newEnd: 3 });
    expect(diffRange('abc', '')).toEqual({ start: 0, oldEnd: 3, newEnd: 0 });
  });

  it('widens to whole code points when emoji share a high surrogate', () => {
    // 😀 = D83D DE00, 😁 = D83D DE01: naive prefix scan would stop between the halves.
    expect(diffRange('😀', '😁')).toEqual({ start: 0, oldEnd: 2, newEnd: 2 });
    expect(diffRange('a😀b', 'a😁b')).toEqual({ start: 1, oldEnd: 3, newEnd: 3 });
  });

  it('widens to whole code points when emoji share a low surrogate', () => {
    // U+1F600 (D83D DE00) vs U+1FA00 (D83E DE00): same low surrogate, suffix scan would split.
    const c = checkInvariants('x\u{1F600}y', 'x\u{1FA00}y');
    expect(c).toEqual({ start: 1, oldEnd: 3, newEnd: 3 });
  });

  it('handles inserting an emoji between emoji that share surrogate halves', () => {
    checkInvariants('😀😁', '😀😂😁');
    checkInvariants('😀😀', '😀😀😀');
    checkInvariants(`${FAMILY}`, `${FAMILY}${GRIN}`);
  });

  it('keeps invariants for combining accents, CJK, RTL and flags', () => {
    checkInvariants('cafe', `caf${E_ACUTE_NFD}`);
    checkInvariants(`caf${E_ACUTE_NFD}`, `caf${E_ACUTE_NFC}`);
    checkInvariants('日本語', '日本人語');
    checkInvariants('שלום', 'שלוםם');
    checkInvariants('🇻🇳', '🇺🇸');
  });

  it('fuzz: invariants hold and surrogate pairs are never split (seeded)', () => {
    const alphabet = ['a', 'b', ' ', 'é', E_ACUTE_NFD, '😀', '😁', '😂', '\u{1FA00}', '日', 'ש', '‍', '🇻', '🇳'];
    const r = rng(20261104);
    for (let iter = 0; iter < 3000; iter++) {
      const len = Math.floor(r() * 8);
      let prev = '';
      for (let i = 0; i < len; i++) prev += pick(r, alphabet);
      // Apply a random code-point aligned edit.
      const cps = [...prev];
      const at = Math.floor(r() * (cps.length + 1));
      const del = Math.floor(r() * Math.min(3, cps.length - at + 1));
      let ins = '';
      for (let i = Math.floor(r() * 3); i > 0; i--) ins += pick(r, alphabet);
      const next = [...cps.slice(0, at), ins, ...cps.slice(at + del)].join('');
      checkInvariants(prev, next);
    }
  });
});

describe('rebaseSuggestions', () => {
  const base = 'Teh cat will recieve teh mail.';
  const s0 = () => [
    sugAt(base, 'Teh', 'The'),
    sugAt(base, 'recieve', 'receive'),
    sugAt(base, 'teh', 'the'),
  ];

  it('keeps everything (with the new version) when the text is unchanged', () => {
    const out = rebaseSuggestions(base, doc(base, 2), s0());
    expect(out.map((s) => [s.start, s.end, s.documentVersion])).toEqual([
      [0, 3, 2],
      [13, 20, 2],
      [21, 24, 2],
    ]);
  });

  it('keeps suggestions before the edit and shifts the ones after it', () => {
    const next = base.replace('cat', 'big cat');
    const out = rebaseSuggestions(base, doc(next, 2), s0());
    expect(out.map((s) => next.slice(s.start, s.end))).toEqual(['Teh', 'recieve', 'teh']);
    expect(out.every((s) => s.documentVersion === 2 && isApplicable(doc(next, 2), s))).toBe(true);
  });

  it('shifts by the right amount when the inserted text is an emoji / ZWJ sequence', () => {
    for (const ins of [GRIN, FAMILY, FLAG, E_ACUTE_NFD, '日本']) {
      const next = base.replace('cat ', `cat ${ins} `);
      const out = rebaseSuggestions(base, doc(next, 2), s0());
      expect(out).toHaveLength(3);
      for (const s of out) expect(next.slice(s.start, s.end)).toBe(s.original);
    }
  });

  it('drops a suggestion whose range was edited', () => {
    const next = base.replace('recieve', 'receive');
    const out = rebaseSuggestions(base, doc(next, 2), s0());
    expect(out.map((s) => s.original)).toEqual(['Teh', 'teh']);
  });

  it('drops a word when a letter is typed directly after it', () => {
    const prev = 'teh';
    const out = rebaseSuggestions(prev, doc('tehx', 2), [sugAt(prev, 'teh', 'the')]);
    expect(out).toEqual([]);
  });

  it('keeps a word when a space or punctuation is typed directly after it', () => {
    const prev = 'teh';
    for (const next of ['teh ', 'teh.', 'teh,', `teh${GRIN}`]) {
      const out = rebaseSuggestions(prev, doc(next, 2), [sugAt(prev, 'teh', 'the')]);
      expect(out.map((s) => [s.start, s.end])).toEqual([[0, 3]]);
    }
  });

  it('drops a word when a letter is typed directly before it, keeps it for a space', () => {
    const prev = 'a teh';
    expect(rebaseSuggestions(prev, doc('a xteh', 2), [sugAt(prev, 'teh', 'the')])).toEqual([]);
    const kept = rebaseSuggestions(prev, doc('a  teh', 2), [sugAt(prev, 'teh', 'the')]);
    expect(kept.map((s) => [s.start, s.end])).toEqual([[3, 6]]);
  });

  it('drops a word that gets merged with its neighbour by deleting the separator', () => {
    const prev = 'teh cat';
    expect(rebaseSuggestions(prev, doc('tehcat', 2), [sugAt(prev, 'teh', 'the')])).toEqual([]);
    const prev2 = 'cat teh';
    expect(rebaseSuggestions(prev2, doc('catteh', 2), [sugAt(prev2, 'teh', 'the')])).toEqual([]);
  });

  it('treats apostrophes, hyphens and accented letters as part of a word', () => {
    const prev = 'teh';
    for (const next of ["teh'", 'teh-', 'tehé', 'teh_']) {
      expect(rebaseSuggestions(prev, doc(next, 2), [sugAt(prev, 'teh', 'the')]), next).toEqual([]);
    }
  });

  it('a rebased suggestion can be applied to the new version; the original cannot', () => {
    const v1 = doc(base, 1);
    const v2 = doc(`Well, ${base}`, 2);
    const original = s0()[1]!;
    expect(() => applySuggestion(v2, original)).toThrow(StaleSuggestionError);
    const [, rebased] = rebaseSuggestions(v1.text, v2, s0());
    expect(applySuggestion(v2, rebased!).text).toBe(`Well, ${base.replace('recieve', 'receive')}`);
  });

  it('never emits a suggestion that is not applicable to the new snapshot', () => {
    const prev = `${GRIN}teh${GRIN}`;
    const s = sugAt(prev, 'teh', 'the');
    // Replace the leading emoji with a different one that shares its high surrogate.
    const next = `😁teh${GRIN}`;
    for (const out of rebaseSuggestions(prev, doc(next, 2), [s])) {
      expect(isApplicable(doc(next, 2), out)).toBe(true);
    }
  });

  // BUG (packages/core/src/suggestions.ts, isWordChar): combining marks (\p{M}) are not treated as word
  // characters, so typing a combining accent directly after a flagged word keeps the old underline.
  // Applying it then produces a different word than the user sees ("teh" + U+0301 -> "the" + U+0301 = "thé").
  // Matters for input methods that emit combining marks separately (Vietnamese, Hindi/Devanagari, some dead keys).
  it('drops a word when a combining mark is typed directly after it', () => {
    const prev = 'teh';
    const out = rebaseSuggestions(prev, doc('teh́', 2), [sugAt(prev, 'teh', 'the')]);
    expect(out).toEqual([]);
  });
});

describe('resolveOverlaps', () => {
  const text = 'Their going too the store.';

  it('returns non-overlapping suggestions sorted by start', () => {
    const a = sug(10, 13, 'too', 'to', { category: 'grammar' });
    const b = sug(0, 5, 'Their', 'They’re', { category: 'grammar' });
    expect(resolveOverlaps([a, b])).toEqual([b, a]);
  });

  it('earlier start wins over a later overlapping range', () => {
    const a = sug(0, 11, 'Their going', 'They’re going', { category: 'style', source: 'ai' });
    const b = sug(6, 11, 'going', 'x', { category: 'spelling' });
    expect(resolveOverlaps([b, a])).toEqual([a]);
  });

  it('on equal start: correctness beats style, harper beats ai', () => {
    const style = sug(0, 5, 'Their', 'x', { category: 'style' });
    const aiGrammar = sug(0, 5, 'Their', 'y', { category: 'grammar', source: 'ai' });
    const harperGrammar = sug(0, 5, 'Their', 'z', { category: 'grammar' });
    const aiTone = sug(0, 5, 'Their', 'w', { category: 'tone', source: 'ai' });
    expect(resolveOverlaps([aiTone, style, aiGrammar, harperGrammar])).toEqual([harperGrammar]);
    expect(resolveOverlaps([aiTone, style, aiGrammar])).toEqual([aiGrammar]);
    expect(resolveOverlaps([aiTone, style])).toEqual([style]);
  });

  it('on equal start and rank, the longer range wins', () => {
    const short = sug(0, 5, 'Their', 'x', { category: 'grammar' });
    const long = sug(0, 11, 'Their going', 'y', { category: 'grammar' });
    expect(resolveOverlaps([short, long])).toEqual([long]);
  });

  it('keeps adjacent (touching) ranges — end is exclusive', () => {
    const a = sug(0, 5, 'Their', 'x');
    const b = sug(5, 6, ' ', 'y');
    expect(resolveOverlaps([b, a])).toEqual([a, b]);
  });

  it('drops a range nested inside an earlier long one, even past a short neighbour', () => {
    const long = sug(0, 20, text.slice(0, 20), 'x', { category: 'clarity', source: 'ai' });
    const inner1 = sug(6, 11, 'going', 'y');
    const inner2 = sug(14, 17, 'the', 'z');
    expect(resolveOverlaps([inner2, inner1, long])).toEqual([long]);
  });

  it('handles zero-width insertions: dedupes duplicates, drops ones strictly inside a range', () => {
    const ins1 = sug(5, 5, '', ',', { category: 'punctuation' });
    const ins2 = sug(5, 5, '', ';', { category: 'punctuation', source: 'ai' });
    expect(resolveOverlaps([ins2, ins1])).toEqual([ins1]);
    const range = sug(0, 11, 'Their going', 'x');
    const inside = sug(3, 3, '', '-');
    expect(resolveOverlaps([inside, range])).toEqual([range]);
    const atEnd = sug(11, 11, '', ',');
    expect(resolveOverlaps([atEnd, range])).toEqual([range, atEnd]);
  });

  it('does not mutate its input and handles empty input', () => {
    const input = [sug(5, 8, 'abc', 'x'), sug(0, 3, 'def', 'y')];
    const copy = [...input];
    resolveOverlaps(input);
    expect(input).toEqual(copy);
    expect(resolveOverlaps([])).toEqual([]);
  });

  it('result can always be applied right-to-left without conflicts (seeded fuzz)', () => {
    const r = rng(7);
    const t = 'The quick brown fox jumps over the lazy dog again and again.';
    const cats = ['spelling', 'grammar', 'style', 'clarity', 'tone', 'punctuation'] as const;
    for (let iter = 0; iter < 500; iter++) {
      const input: Suggestion[] = [];
      for (let i = 0; i < 8; i++) {
        const a = Math.floor(r() * t.length);
        const b = Math.min(t.length, a + Math.floor(r() * 6));
        input.push(sug(a, b, t.slice(a, b), 'X', { category: pick(r, cats), source: r() < 0.5 ? 'ai' : 'harper' }));
      }
      const out = resolveOverlaps(input);
      for (let i = 1; i < out.length; i++) {
        expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end);
      }
      let d = doc(t, 1);
      for (const s of [...out].reverse()) d = applySuggestion({ ...d, version: 1 }, s);
      expect(d.text.length).toBe(t.length + out.reduce((n, s) => n + 1 - (s.end - s.start), 0));
    }
  });
});

describe('locateAiEdit', () => {
  const edit = (original: string, replacement: string, contextBefore?: string): AiEdit => ({
    original,
    replacement,
    category: 'grammar',
    message: 'fix',
    ...(contextBefore !== undefined ? { contextBefore } : {}),
  });

  it('places a unique quote and stamps source/rule/version/id', () => {
    const d = doc('She dont like apples.', 4);
    const s = locateAiEdit(d, edit('dont', "doesn't"))!;
    expect(s).toMatchObject({
      start: 4,
      end: 8,
      original: 'dont',
      replacements: ["doesn't"],
      source: 'ai',
      rule: 'ai-grammar',
      category: 'grammar',
      documentVersion: 4,
    });
    expect(s.id).toBe(suggestionId(s));
    expect(applySuggestion(d, s).text).toBe("She doesn't like apples.");
  });

  it('rejects missing quotes (hallucinated text)', () => {
    expect(locateAiEdit(doc('Hello world.'), edit('Helo', 'Hello'))).toBeNull();
  });

  it('rejects quotes that differ only by case or Unicode normalization', () => {
    expect(locateAiEdit(doc('Hello world.'), edit('hello', 'Hi'))).toBeNull();
    expect(locateAiEdit(doc(`caf${E_ACUTE_NFD} time`), edit(`caf${E_ACUTE_NFC}`, 'coffee'))).toBeNull();
  });

  it('rejects no-ops and empty quotes', () => {
    expect(locateAiEdit(doc('Hello world.'), edit('world', 'world'))).toBeNull();
    expect(locateAiEdit(doc('Hello world.'), edit('', 'Hi '))).toBeNull();
  });

  it('rejects short ambiguous quotes without context', () => {
    expect(locateAiEdit(doc('I saw a dog and a cat.'), edit('a', 'an'))).toBeNull();
    expect(locateAiEdit(doc('the cat and the dog'), edit('the', 'a'))).toBeNull();
  });

  it('uses contextBefore to disambiguate a repeated short quote', () => {
    const d = doc('I saw a dog and a apple.');
    const s = locateAiEdit(d, edit('a', 'an', 'and '))!;
    expect(s.start).toBe(16);
    expect(applySuggestion(d, s).text).toBe('I saw a dog and an apple.');
  });

  it('places a long (>= 12 units) repeated quote at its first occurrence (documented behaviour)', () => {
    const phrase = 'in order to make';
    const d = doc(`We met ${phrase} plans, then left ${phrase} dinner.`);
    const s = locateAiEdit(d, edit(phrase, 'to make'))!;
    expect(s.start).toBe(7);
  });

  it('respects searchFrom', () => {
    const d = doc('teh cat saw teh dog');
    const s = locateAiEdit(d, edit('teh', 'the'), 5)!;
    expect(s.start).toBe(12);
  });

  it('returns UTF-16 offsets after emoji, ZWJ sequences, CJK and RTL', () => {
    for (const prefix of [GRIN, FAMILY, FLAG, '日本語 ', 'שלום ', `caf${E_ACUTE_NFD} `]) {
      const d = doc(`${prefix}She dont care.`);
      const s = locateAiEdit(d, edit('dont', "doesn't"))!;
      expect(d.text.slice(s.start, s.end)).toBe('dont');
      expect(applySuggestion(d, s).text).toBe(`${prefix}She doesn't care.`);
    }
  });

  it('a located edit is stale once the document moves on, until rebased', () => {
    const v1 = doc('She dont care.', 1);
    const s = locateAiEdit(v1, edit('dont', "doesn't"))!;
    const v2 = doc('Honestly, she dont care.', 2);
    expect(() => applySuggestion(v2, s)).toThrow(StaleSuggestionError);
    const [r] = rebaseSuggestions(v1.text, v2, [s]);
    expect(applySuggestion(v2, r!).text).toBe("Honestly, she doesn't care.");
  });

  // BUG (packages/core/src/suggestions.ts, locateAiEdit): the ambiguity guard is
  // `second !== -1 && original.length < 12 && !edit.contextBefore`. When the model supplies a
  // contextBefore that does NOT occur in the text (wrong/hallucinated context), the anchor search fails,
  // we fall back to a plain search, and the guard is skipped because contextBefore is truthy — so a short,
  // ambiguous quote is placed at its FIRST occurrence, i.e. probably the wrong word.
  // Input: text "I saw a dog and a apple.", edit {original:"a", replacement:"an", contextBefore:"with "}.
  // Expected: null. Actual: suggestion at 3..4 — the "a" INSIDE "saw" — which applies as "I sanw a dog ...".
  it('rejects an ambiguous short quote when contextBefore is given but not found', () => {
    const d = doc('I saw a dog and a apple.');
    expect(locateAiEdit(d, edit('a', 'an', 'with '))).toBeNull();
  });

  // Hardening idea (not a contract violation today): a quote that starts/ends inside a surrogate pair
  // (only possible from a malformed/hostile response, e.g. JSON "\udE00") is currently accepted and would
  // split an emoji when applied. Consider rejecting edits whose range splits a surrogate pair.
  it.todo('rejects an edit whose located range would split a surrogate pair');
});

describe('countByCategory', () => {
  it('buckets spelling/grammar/punctuation as correctness, clarity as clarity, style+tone as style', () => {
    const cats = ['spelling', 'grammar', 'punctuation', 'clarity', 'clarity', 'style', 'tone'] as const;
    const input = cats.map((c, i) => sug(i, i + 1, 'x', 'y', { category: c }));
    expect(countByCategory(input)).toEqual({ correctness: 3, clarity: 2, style: 2 });
    expect(countByCategory([])).toEqual({ correctness: 0, clarity: 0, style: 0 });
  });
});
