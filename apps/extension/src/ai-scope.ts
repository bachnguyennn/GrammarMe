/**
 * Pure helpers for the optional ChatGPT check (no DOM, no chrome.*), so they are unit-tested:
 * - `aiScope`: exactly which part of a field is sent. An explicit selection wins; otherwise the
 *   whole field when it fits, otherwise the paragraph around the caret. Never more than the cap.
 * - `placeAiEdits`: turn the companion's quote-based edits into GrammarMe suggestions, confined to
 *   the range that was sent and tied to the document version it was sent from.
 */
import { AI_MAX_INPUT_CHARS } from '@grammarme/core/companion';
import { locateAiEdit, rebaseSuggestions, suggestionId, type AiEdit, type DocumentSnapshot, type Suggestion } from '@grammarme/core';

export type ScopeKind = 'selection' | 'all' | 'paragraph';

export interface AiScope {
  kind: ScopeKind;
  /** Offsets of the sent range in the field's text (UTF-16, end exclusive). */
  start: number;
  end: number;
  /** Exactly the text that will be sent. */
  text: string;
}

export type ScopeResult = { ok: true; scope: AiScope } | { ok: false; reason: 'empty' | 'too_long' };

export const SCOPE_LABEL: Record<ScopeKind, string> = {
  selection: 'your selected text',
  all: 'everything in this box',
  paragraph: 'the paragraph around your cursor',
};

/**
 * Pick the range to send. `selStart`/`selEnd` are the caret or selection in the field's text
 * (null when unknown). A selection longer than the cap is refused rather than silently cut,
 * because the user explicitly chose it.
 */
export function aiScope(text: string, selStart: number | null, selEnd: number | null, max = AI_MAX_INPUT_CHARS): ScopeResult {
  const clamp = (n: number) => Math.max(0, Math.min(text.length, n));
  if (selStart !== null && selEnd !== null && selStart !== selEnd) {
    const start = clamp(Math.min(selStart, selEnd));
    const end = clamp(Math.max(selStart, selEnd));
    const t = text.slice(start, end);
    if (!t.trim()) return { ok: false, reason: 'empty' };
    if (t.length > max) return { ok: false, reason: 'too_long' };
    return { ok: true, scope: trimScope({ kind: 'selection', start, end, text: t }) };
  }
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (text.length <= max) return { ok: true, scope: trimScope({ kind: 'all', start: 0, end: text.length, text }) };

  // Paragraph around the caret: blank-line separated, falling back to single newlines.
  const caret = clamp(selStart ?? 0);
  let start = text.lastIndexOf('\n\n', Math.max(0, caret - 1));
  start = start === -1 ? 0 : start + 2;
  let end = text.indexOf('\n\n', caret);
  end = end === -1 ? text.length : end;
  if (end - start > max) {
    const s1 = text.lastIndexOf('\n', Math.max(0, caret - 1));
    const e1 = text.indexOf('\n', caret);
    start = Math.max(start, s1 === -1 ? start : s1 + 1);
    end = Math.min(end, e1 === -1 ? end : e1);
  }
  if (end - start > max) return { ok: false, reason: 'too_long' };
  const t = text.slice(start, end);
  if (!t.trim()) return { ok: false, reason: 'empty' };
  return { ok: true, scope: trimScope({ kind: 'paragraph', start, end, text: t }) };
}

/** Drop surrounding whitespace from the range (it carries no meaning and costs allowance). */
function trimScope(s: AiScope): AiScope {
  const lead = s.text.length - s.text.trimStart().length;
  const trail = s.text.length - s.text.trimEnd().length;
  return { ...s, start: s.start + lead, end: s.end - trail, text: s.text.slice(lead, s.text.length - trail) };
}

export interface PlacedEdits {
  suggestions: Suggestion[];
  /** Edits that couldn't be placed safely (not found, ambiguous, outside the range, overlapping). */
  dropped: number;
}

/**
 * Place edits that were made for `scope.text` (sent from document version `sentVersion`) into the
 * current document. Each edit is located inside the sent range only, then shifted to document
 * offsets. If the user edited the field meanwhile, suggestions are rebased; any that touch an
 * edited region are dropped rather than guessed.
 */
export function placeAiEdits(
  edits: readonly AiEdit[],
  scope: AiScope,
  sent: DocumentSnapshot,
  current: DocumentSnapshot,
): PlacedEdits {
  if (sent.text.slice(scope.start, scope.end) !== scope.text) return { suggestions: [], dropped: edits.length };
  const local: DocumentSnapshot = { text: scope.text, version: sent.version };
  const placed: Suggestion[] = [];
  let dropped = 0;
  for (const edit of edits) {
    const s = locateAiEdit(local, edit);
    if (!s || s.end > scope.text.length) {
      dropped++;
      continue;
    }
    const start = s.start + scope.start;
    const end = s.end + scope.start;
    // Overlapping edits are ambiguous to apply one by one: keep the first.
    if (placed.some((p) => start < p.end && p.start < end)) {
      dropped++;
      continue;
    }
    placed.push({ ...s, start, end, id: suggestionId({ ...s, start, end }), documentVersion: sent.version });
  }
  if (current.version === sent.version && current.text === sent.text) return { suggestions: placed, dropped };
  const rebased = rebaseSuggestions(sent.text, current, placed);
  return { suggestions: rebased, dropped: dropped + (placed.length - rebased.length) };
}
