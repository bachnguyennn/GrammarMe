/** Writing a chosen replacement into the page's field — only ever after an explicit click. */
import { applySuggestion, type DocumentSnapshot, type Suggestion } from '@grammarme/core';
import type { TextField } from './field-dom.ts';

/**
 * Replace `s` with `s.replacements[index]` in `el`.
 *
 * Goes through `applySuggestion` first, which throws `StaleSuggestionError` if `doc` (our view of
 * the field) no longer matches the suggestion. Uses `execCommand('insertText')` so the browser's
 * native undo stack works and frameworks (React/Vue controlled inputs) see a real `input` event;
 * falls back to `setRangeText` + a synthetic `input` event.
 *
 * Returns true when the field now holds exactly the expected text.
 */
export function applyToField(el: TextField, doc: DocumentSnapshot, s: Suggestion, index: number): boolean {
  const expected = applySuggestion(doc, s, index); // version + text check; throws if stale
  if (el.value !== doc.text) return false;
  const replacement = s.replacements[index] ?? '';
  el.focus({ preventScroll: true });
  el.setSelectionRange(s.start, s.end);
  let ok = false;
  try {
    ok =
      replacement === ''
        ? s.start === s.end || document.execCommand('delete', false)
        : document.execCommand('insertText', false, replacement);
  } catch {
    ok = false;
  }
  if (ok && el.value === expected.text) return true;
  if (el.value === doc.text) {
    // execCommand unavailable or refused (some pages intercept beforeinput): plain fallback.
    el.setRangeText(replacement, s.start, s.end, 'end');
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: replacement }),
    );
  }
  return el.value === expected.text;
}
