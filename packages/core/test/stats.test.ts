import { describe, expect, it } from 'vitest';
import { countSyllables, readabilityLabel, textStats } from '../src/stats.ts';

describe('countSyllables', () => {
  it.each([
    ['', 0],
    ['123', 0],
    ['a', 1],
    ['the', 1],
    ['cat', 1],
    ['make', 1], // silent final e
    ['table', 2], // consonant + "le" keeps its syllable
    ['hello', 2],
    ['running', 2],
    ['yellow', 2], // leading y is a consonant
    ['readable', 3],
    ["Don't", 1],
    ['HELLO', 2], // case-insensitive
  ])('countSyllables(%j) = %i', (word, n) => {
    expect(countSyllables(word)).toBe(n);
  });

  it('never returns less than 1 for a word with letters', () => {
    for (const w of ['rhythm', 'nth', 'shh', 'tsk', 'crwth', 'bye', 'ye']) expect(countSyllables(w)).toBeGreaterThanOrEqual(1);
  });

  it('documents the ASCII-only heuristic: accented letters are stripped before counting', () => {
    // "café" is 2 syllables in English; the heuristic sees "caf". Acceptable for an English readability
    // estimate, but means Flesch scores for accent-heavy text are slightly inflated.
    expect(countSyllables('café')).toBe(1);
    expect(countSyllables('日本語')).toBe(0);
  });
});

describe('textStats', () => {
  it('handles empty and whitespace-only text', () => {
    for (const t of ['', '   ', '\n\n']) {
      expect(textStats(t)).toEqual({ words: 0, characters: t.length, sentences: 0, readingMinutes: 0, readability: null });
    }
  });

  it('counts a fragment without terminal punctuation as one sentence', () => {
    expect(textStats('Hello world')).toMatchObject({ words: 2, sentences: 1 });
  });

  it('keeps contractions, curly apostrophes and hyphenated compounds as single words', () => {
    expect(textStats("Don't stop. Well-known facts! Really?")).toMatchObject({ words: 5, sentences: 3 });
    expect(textStats('It’s a state-of-the-art build.').words).toBe(4);
  });

  it('counts runs of terminal punctuation once', () => {
    expect(textStats('Wait... what?! No!!').sentences).toBe(3);
  });

  it('does not end a sentence on a period inside a number, URL or identifier', () => {
    expect(textStats('Version 3.14 shipped on example.com today').sentences).toBe(1);
    expect(textStats('Call obj.method() now').sentences).toBe(1);
  });

  it('counts numbers as words and ignores emoji and punctuation', () => {
    expect(textStats('I ate 3 pizzas 😀 !!').words).toBe(4);
  });

  it('counts characters in UTF-16 code units (documented current behaviour)', () => {
    expect(textStats('😀').characters).toBe(2);
    expect(textStats('👨‍👩‍👧‍👦').characters).toBe(11);
    expect(textStats('é').characters).toBe(2);
    expect(textStats('日本語').characters).toBe(3);
  });

  it('handles CJK and RTL text without throwing', () => {
    const cjk = textStats('日本語のテキスト。');
    expect(cjk.words).toBeGreaterThanOrEqual(1);
    const rtl = textStats('שלום עולם. מה שלומך?');
    expect(rtl.words).toBe(4);
    expect(rtl.sentences).toBe(2);
  });

  it('reading time is words / 238 minutes', () => {
    const t = Array.from({ length: 238 }, () => 'word').join(' ');
    expect(textStats(t).readingMinutes).toBe(1);
    expect(textStats('one two').readingMinutes).toBeCloseTo(2 / 238, 10);
  });

  it('returns null readability below 30 words and a Flesch score from 30 words up', () => {
    const sentence = 'The cat sat on the mat.';
    expect(textStats(Array(4).fill(sentence).join(' ')).readability).toBeNull(); // 24 words
    const thirty = textStats(Array(5).fill(sentence).join(' ')); // 30 words, 5 sentences, 30 syllables
    expect(thirty.words).toBe(30);
    expect(thirty.sentences).toBe(5);
    // 206.835 - 1.015 * (30/5) - 84.6 * (30/30) = 116.145 -> 116
    expect(thirty.readability).toBe(116);
  });

  it('scores dense academic prose as harder than simple prose', () => {
    const easy = Array(6).fill('We went to the park. It was fun.').join(' ');
    const hard = Array(3)
      .fill(
        'Notwithstanding considerable methodological heterogeneity, the investigators characterised institutional accountability mechanisms as fundamentally insufficient.',
      )
      .join(' ');
    const e = textStats(easy).readability!;
    const h = textStats(hard).readability!;
    expect(e).toBeGreaterThan(80);
    expect(h).toBeLessThan(30);
  });

  // BUG (packages/core/src/stats.ts, WORD regex): combining marks (\p{M}) are not allowed inside a word, so
  // decomposed (NFD) text — common when pasting from macOS file names/PDFs, and the norm for Vietnamese and
  // Devanagari input — splits words at every accent. Input: "résumé writers" ("résumé writers").
  // Expected words: 2. Actual: 3 ("re", "sume", "writers"). Fix: add \p{M} to the WORD character class.
  it.fails('counts a word with combining accents (NFD) as one word', () => {
    expect(textStats('résumé writers').words).toBe(2);
  });

  // BUG (packages/core/src/stats.ts, sentence regex /[.!?]+(?=\s|$)/): a terminator followed by a closing
  // quote or bracket is not counted. Input: 'He said "Stop." Then he left.'  Expected sentences: 2. Actual: 1.
  // Dialogue-heavy text therefore gets longer average sentences and a lower (harder) readability score.
  // Fix: allow closing punctuation in the lookahead, e.g. /[.!?]+["'”’)\]]*(?=\s|$)/.
  it.fails('ends a sentence on a terminator followed by a closing quote or bracket', () => {
    expect(textStats('He said "Stop." Then he left.').sentences).toBe(2);
    expect(textStats('(This is an aside.) It ends here.').sentences).toBe(2);
  });

  // Product question, not a contract violation: `characters` is UTF-16 length, so one emoji counts as 2 and a
  // family emoji as 11. Users comparing with other editors expect grapheme counts (Intl.Segmenter).
  it.todo('decide whether `characters` should count graphemes instead of UTF-16 code units');
});

describe('readabilityLabel', () => {
  it.each([
    [null, 'Write a little more'],
    [120, 'Very easy to read'],
    [80, 'Very easy to read'],
    [79, 'Easy to read'],
    [60, 'Easy to read'],
    [59, 'Fairly difficult'],
    [50, 'Fairly difficult'],
    [49, 'Difficult'],
    [30, 'Difficult'],
    [29, 'Very difficult'],
    [-20, 'Very difficult'],
  ] as const)('readabilityLabel(%j) = %j', (score, label) => {
    expect(readabilityLabel(score)).toBe(label);
  });
});
