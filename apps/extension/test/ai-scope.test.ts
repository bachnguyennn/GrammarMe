import { describe, expect, it } from 'vitest';
import type { AiEdit } from '@grammarme/core';
import { aiScope, placeAiEdits } from '../src/ai-scope.ts';

const edit = (original: string, replacement: string, extra: Partial<AiEdit> = {}): AiEdit => ({
  original,
  replacement,
  category: 'grammar',
  message: 'why',
  ...extra,
});

describe('aiScope: what gets sent', () => {
  it('prefers an explicit selection, trimmed', () => {
    const text = 'One. Two  sentence here. Three.';
    const r = aiScope(text, 4, 24);
    expect(r).toMatchObject({ ok: true, scope: { kind: 'selection', text: 'Two  sentence here.' } });
    if (r.ok) expect(text.slice(r.scope.start, r.scope.end)).toBe(r.scope.text);
  });

  it('handles a backwards selection', () => {
    const r = aiScope('abc def', 7, 4);
    expect(r).toMatchObject({ ok: true, scope: { kind: 'selection', text: 'def', start: 4, end: 7 } });
  });

  it('refuses a selection longer than the cap instead of cutting it', () => {
    expect(aiScope('x'.repeat(50), 0, 50, 40)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('sends the whole field when it fits and nothing is selected', () => {
    expect(aiScope('  Hello there.  ', 3, 3)).toMatchObject({ ok: true, scope: { kind: 'all', text: 'Hello there.', start: 2, end: 14 } });
  });

  it('sends only the paragraph around the caret when the field is too long', () => {
    const p1 = 'a'.repeat(30);
    const p2 = 'The middle paragraph.';
    const p3 = 'c'.repeat(30);
    const text = `${p1}\n\n${p2}\n\n${p3}`;
    const caret = text.indexOf('middle');
    const r = aiScope(text, caret, caret, 40);
    expect(r).toMatchObject({ ok: true, scope: { kind: 'paragraph', text: p2 } });
  });

  it('reports empty text', () => {
    expect(aiScope('   ', null, null)).toEqual({ ok: false, reason: 'empty' });
    expect(aiScope('abc   def', 3, 6)).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('placeAiEdits: confined, versioned, never guessed', () => {
  const text = 'Intro line.\n\nI has a apple and the the cat.\n\nOutro has a apple too.';
  const start = text.indexOf('I has');
  const end = text.indexOf('cat.') + 4;
  const scope = { kind: 'paragraph' as const, start, end, text: text.slice(start, end) };
  const sent = { text, version: 3 };

  it('shifts offsets into the field and recomputes ids', () => {
    const r = placeAiEdits([edit('I has', 'I have')], scope, sent, sent);
    expect(r.dropped).toBe(0);
    const [s] = r.suggestions;
    expect(text.slice(s!.start, s!.end)).toBe('I has');
    expect(s!.source).toBe('ai');
    expect(s!.documentVersion).toBe(3);
    const again = placeAiEdits([edit('I has', 'I have')], { ...scope }, sent, sent).suggestions[0]!;
    expect(again.id).toBe(s!.id);
    expect(s!.id).toContain('ai-');
  });

  it('only searches inside the sent range ("has a apple" also appears outside it)', () => {
    const r = placeAiEdits([edit('has a apple', 'has an apple')], scope, sent, sent);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.start).toBe(text.indexOf('has a apple'));
    expect(r.suggestions[0]!.end).toBeLessThanOrEqual(end);
  });

  it('drops quotes that are not in the range, ambiguous short quotes, and overlaps', () => {
    const r = placeAiEdits(
      [edit('Outro', 'Ending'), edit('the', 'a'), edit('I has a', 'I have an'), edit('has a apple', 'has an apple')],
      scope,
      sent,
      sent,
    );
    expect(r.suggestions.map((s) => s.original)).toEqual(['I has a']);
    expect(r.dropped).toBe(3);
  });

  it('uses contextBefore to disambiguate a repeated short quote', () => {
    const r = placeAiEdits([edit('the', '', { contextBefore: 'and the ' })], scope, sent, sent);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.start).toBe(text.indexOf('the the') + 4);
  });

  it('rebases onto newer text and drops edits the user has since touched', () => {
    const edits = [edit('I has', 'I have'), edit('cat', 'dog', { category: 'clarity' })];
    const typedAtStart = { text: `Hello. ${text}`, version: 4 };
    const moved = placeAiEdits(edits, scope, sent, typedAtStart);
    expect(moved.suggestions.map((s) => typedAtStart.text.slice(s.start, s.end))).toEqual(['I has', 'cat']);
    expect(moved.suggestions.every((s) => s.documentVersion === 4)).toBe(true);

    const editedWord = { text: text.replace('I has', 'I had'), version: 4 };
    const r = placeAiEdits(edits, scope, sent, editedWord);
    expect(r.suggestions.map((s) => s.original)).toEqual(['cat']);
    expect(r.dropped).toBe(1);
  });

  it('drops everything if the sent range no longer matches the sent text', () => {
    const r = placeAiEdits([edit('I has', 'I have')], { ...scope, text: 'something else' }, sent, sent);
    expect(r).toEqual({ suggestions: [], dropped: 1 });
  });
});
