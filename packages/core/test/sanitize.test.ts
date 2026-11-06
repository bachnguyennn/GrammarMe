import { describe, expect, it } from 'vitest';
import { locateAiEdit } from '../src/suggestions.ts';
import { sanitizeEdits, isSentenceInitial } from '../src/ai/sanitize.ts';

const TEXT =
  'Their going to the park on 5 May. I has a apple. Visit https://exampel.com for more. ' +
  'The function getUserName() returns teh name. Maria said she did not like it.';

const edit = (original: string, replacement: string, extra: Record<string, unknown> = {}) => ({
  original,
  replacement,
  contextBefore: '',
  category: 'grammar',
  message: 'Fix.',
  ...extra,
});

function run(edits: unknown[], task: 'grammar' | 'clarity' | 'tone' = 'grammar', text = TEXT, max = 25) {
  return sanitizeEdits(edits, text, task, max);
}

describe('sanitizeEdits — keeps good edits', () => {
  it('keeps minimal grammar/spelling fixes and they locate on the client', () => {
    const { edits, dropped } = run([
      edit("Their going", "They're going"),
      edit('I has', 'I have'),
      edit('a apple', 'an apple'),
      edit('teh', 'the', { category: 'spelling' }),
    ]);
    expect(dropped).toEqual({});
    expect(edits.map((e) => e.replacement)).toEqual(["They're going", 'I have', 'an apple', 'the']);
    for (const e of edits) {
      const s = locateAiEdit({ text: TEXT, version: 1 }, e);
      expect(s).not.toBeNull();
      expect(TEXT.slice(s!.start, s!.end)).toBe(e.original);
    }
  });

  it('allows reordering that preserves numbers and names', () => {
    const { edits } = run([edit('on 5 May', 'on May 5')]);
    expect(edits).toHaveLength(1);
  });

  it('returns edits sorted by position and attaches a real contextBefore', () => {
    const { edits } = run([edit('a apple', 'an apple'), edit("Their going", "They're going")]);
    expect(edits[0]!.original).toBe("Their going");
    expect(edits[0]!.contextBefore).toBeUndefined(); // at start of text
    expect(TEXT.includes(edits[1]!.contextBefore! + 'a apple')).toBe(true);
  });

  it('allows resolving a pronoun to a name already in the document (clarity)', () => {
    const { edits } = run([edit('she did', 'Maria did', { category: 'clarity' })], 'clarity');
    expect(edits).toHaveLength(1);
  });
});

describe('sanitizeEdits — meaning-preservation guards', () => {
  const cases: [string, unknown, string, ('grammar' | 'clarity' | 'tone')?][] = [
    ['hallucinated quote', edit('We was', 'We were'), 'not_found'],
    ['no-op', edit('I has', 'I has'), 'noop'],
    ['number spelled out', edit('on 5 May', 'on five May'), 'protected_token'],
    ['number changed', edit('on 5 May', 'on 6 May'), 'protected_token'],
    ['URL typo "fixed"', edit('exampel.com', 'example.com'), 'protected_span'],
    ['code identifier changed', edit('getUserName()', 'getUsername()'), 'protected_span'],
    ['name changed', edit('Maria said', 'Mario said'), 'name_changed'],
    ['invented name', edit('she did', 'Anna did', { category: 'clarity' }), 'name_changed', 'clarity'],
    ['negation removed', edit('did not like', 'disliked'), 'negation_changed'],
    ['negation added', edit('I has', "I hasn't"), 'negation_changed'],
    ['category not allowed for task', edit('I has', 'I have', { category: 'tone' }), 'category'],
    ['unknown category', edit('I has', 'I have', { category: 'vibes' }), 'shape'],
    ['missing replacement', { original: 'I has', category: 'grammar' }, 'shape'],
    ['not an object', 'I has -> I have', 'shape'],
    ['newline injected', edit('I has', 'I\nhave'), 'newline'],
    [
      'whole-sentence rewrite in grammar mode',
      edit('Their going to the park on 5 May.', 'We will all go together to the big green park on 5 May.'),
      'too_large',
    ],
  ];
  for (const [name, e, reason, task] of cases) {
    it(`drops: ${name} (${reason})`, () => {
      const { edits, dropped } = run([e], task ?? 'grammar');
      expect(edits).toEqual([]);
      expect(dropped).toEqual({ [reason]: 1 });
    });
  }

  it('drops over-long quotes (field_too_long)', () => {
    const text = 'word '.repeat(80);
    expect(run([edit(text.slice(0, 301), 'x')], 'grammar', text).dropped).toEqual({ field_too_long: 1 });
  });

  it('drops a sentence-initial name change and an invented sentence-initial name', () => {
    const text = 'Maria said she was late. She said it twice.';
    expect(run([edit('Maria said', 'Mario said')], 'grammar', text).dropped).toEqual({ name_changed: 1 });
    expect(run([edit('She said', 'Anna said', { category: 'clarity' })], 'clarity', text).dropped).toEqual({ name_changed: 1 });
    expect(run([edit('teh cat', 'The cat', { category: 'spelling' })], 'grammar', 'teh cat sat.').edits).toHaveLength(1);
  });

  it('drops ambiguous short quotes without context but keeps them with a correct contextBefore', () => {
    const text = 'I saw the the cat and the dog.';
    expect(run([edit('the the', 'the')], 'grammar', text).edits).toHaveLength(1); // unique
    expect(run([edit('the', 'a')], 'grammar', text).dropped).toEqual({ ambiguous: 1 });
    const ok = run([edit('the', 'a', { contextBefore: 'and ' })], 'grammar', text);
    expect(ok.edits).toHaveLength(1);
    const placed = locateAiEdit({ text, version: 1 }, ok.edits[0]!);
    expect(placed!.start).toBe(text.indexOf('and the') + 4);
  });

  it('ignores a contextBefore that does not precede the quote', () => {
    const text = 'I saw the the cat and the dog.';
    expect(run([edit('the', 'a', { contextBefore: 'zebra ' })], 'grammar', text).dropped).toEqual({ ambiguous: 1 });
  });

  it('allows larger rewording for clarity than for grammar', () => {
    const text = 'In order to finish the report, we need to start working on it right now.';
    const e = edit('In order to finish', 'To finish', { category: 'clarity' });
    expect(run([e], 'clarity', text).edits).toHaveLength(1);
  });

  it('drops overlapping edits and enforces the cap', () => {
    const overlap = run([edit('I has', 'I have'), edit('has a apple', 'have an apple')]);
    expect(overlap.edits).toHaveLength(1);
    expect(overlap.dropped).toEqual({ overlap: 1 });
    const capped = run([edit('I has', 'I have'), edit('a apple', 'an apple'), edit('teh', 'the', { category: 'spelling' })], 'grammar', TEXT, 2);
    expect(capped.edits).toHaveLength(2);
    expect(capped.dropped).toEqual({ cap: 1 });
  });

  it('cleans and truncates messages', () => {
    const { edits } = run([edit('I has', 'I have', { message: `  line\nbreak ${'x'.repeat(300)}` })]);
    expect(edits[0]!.message.length).toBeLessThanOrEqual(200);
    expect(edits[0]!.message.startsWith('line break')).toBe(true);
  });
});

describe('isSentenceInitial', () => {
  it('detects sentence starts', () => {
    const t = 'Hello there. Bob went\nHome. "Yes," said Ann.';
    expect(isSentenceInitial(t, 0)).toBe(true);
    expect(isSentenceInitial(t, t.indexOf('Bob'))).toBe(true);
    expect(isSentenceInitial(t, t.indexOf('Home'))).toBe(true);
    expect(isSentenceInitial(t, t.indexOf('Ann'))).toBe(false);
    expect(isSentenceInitial(t, t.indexOf('went'))).toBe(false);
  });
});
