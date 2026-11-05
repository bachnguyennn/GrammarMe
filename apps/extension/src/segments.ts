/**
 * Pure helpers for the underline overlay and popover: splitting text into plain/underlined
 * segments, hit-testing a caret offset, filtering ignored/dictionary words, and UI labels.
 * The overlay builds DOM nodes from segments with `textContent` only — page text is never
 * parsed as HTML, so no escaping is needed and markup in a textarea can't inject anything.
 */
import { resolveOverlaps, type Category, type Suggestion } from '@grammarme/core';

export interface Segment {
  /** Offsets into the full text (UTF-16, end-exclusive). */
  start: number;
  end: number;
  /** Index into the suggestions array passed to `buildSegments`, or -1 for plain text. */
  index: number;
}

/**
 * Cover `[0, text.length)` with consecutive segments. Suggestions must be sorted and
 * non-overlapping (use `visibleSuggestions`); any that are out of bounds or overlap an earlier
 * one are skipped defensively. Zero-length suggestions (pure insertions) produce an empty segment
 * so the overlay can draw a caret marker.
 */
export function buildSegments(text: string, suggestions: readonly Suggestion[]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  suggestions.forEach((s, index) => {
    if (s.start < pos || s.end < s.start || s.end > text.length) return;
    if (s.start > pos) out.push({ start: pos, end: s.start, index: -1 });
    out.push({ start: s.start, end: s.end, index });
    pos = s.end;
  });
  if (pos < text.length || out.length === 0) out.push({ start: pos, end: text.length, index: -1 });
  return out;
}

/**
 * The suggestion under a caret offset. With `inclusiveEnd` (mouse clicks) a caret right after the
 * last character still counts, because clicking the right half of a letter puts the caret there.
 */
export function suggestionAt(
  suggestions: readonly Suggestion[],
  offset: number,
  inclusiveEnd: boolean,
): Suggestion | undefined {
  return suggestions.find((s) =>
    s.start === s.end
      ? offset === s.start
      : offset >= s.start && (inclusiveEnd ? offset <= s.end : offset < s.end),
  );
}

/** Key used by "Ignore": the same rule on the same text stays ignored in this field. */
export function ignoreKey(s: Pick<Suggestion, 'rule' | 'original'>): string {
  return `${s.rule}\u0000${s.original}`;
}

/** Drop ignored issues and spelling hits for dictionary words, then remove overlaps. */
export function visibleSuggestions(
  all: readonly Suggestion[],
  ignored: ReadonlySet<string>,
  dictionaryLower: ReadonlySet<string>,
): Suggestion[] {
  return resolveOverlaps(
    all.filter(
      (s) =>
        !ignored.has(ignoreKey(s)) && !(s.category === 'spelling' && dictionaryLower.has(s.original.toLowerCase())),
    ),
  );
}

export const CATEGORY_LABEL: Record<Category, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  clarity: 'Clarity',
  style: 'Style',
  tone: 'Tone',
};

/** Visual group used for underline colour. */
export function categoryGroup(c: Category): 'correctness' | 'clarity' | 'style' {
  if (c === 'spelling' || c === 'grammar' || c === 'punctuation') return 'correctness';
  return c === 'clarity' ? 'clarity' : 'style';
}

/** Up to `max` replacement buttons with readable + accessible labels. */
export function replacementButtons(
  s: Pick<Suggestion, 'original' | 'replacements'>,
  max = 3,
): { index: number; label: string; ariaLabel: string }[] {
  return s.replacements.slice(0, max).map((r, index) => {
    if (r === '') return { index, label: `Remove “${clip(s.original)}”`, ariaLabel: `Remove “${s.original}”` };
    const label = r.trim() === '' ? visibleWhitespace(r) : clip(r);
    return { index, label, ariaLabel: `Replace “${s.original}” with “${r}”` };
  });
}

export type BadgeState = 'idle' | 'checking' | 'too-long' | 'error';

export function badgeLabel(count: number, state: BadgeState): { text: string; aria: string } {
  if (state === 'too-long') return { text: '–', aria: 'GrammarMe: text too long to check' };
  if (state === 'error') return { text: '!', aria: 'GrammarMe: checking failed' };
  if (count === 0) {
    return state === 'checking'
      ? { text: '…', aria: 'GrammarMe: checking' }
      : { text: '✓', aria: 'GrammarMe: no issues found' };
  }
  const text = count > 99 ? '99+' : String(count);
  return { text, aria: `GrammarMe: ${count} issue${count === 1 ? '' : 's'}. Open the first one.` };
}

function clip(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function visibleWhitespace(s: string): string {
  return s.replace(/ /g, '␣').replace(/\n/g, '↵').replace(/\t/g, '⇥') || '∅';
}
