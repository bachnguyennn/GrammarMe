import type { AiEdit, DocumentSnapshot, Suggestion } from './types.ts';

export class StaleSuggestionError extends Error {
  constructor(message = 'The text changed since this suggestion was made.') {
    super(message);
    this.name = 'StaleSuggestionError';
  }
}

/** FNV-1a — tiny, deterministic, good enough for UI keys. */
export function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function suggestionId(s: Pick<Suggestion, 'source' | 'rule' | 'start' | 'end' | 'original'>): string {
  return `${s.source}-${hash(`${s.rule}|${s.start}|${s.end}|${s.original}`)}`;
}

/** True when the suggestion still points at exactly the text it was made for. */
export function isApplicable(doc: DocumentSnapshot, s: Suggestion): boolean {
  if (s.start < 0 || s.end > doc.text.length || s.start > s.end) return false;
  return doc.text.slice(s.start, s.end) === s.original;
}

/**
 * Apply one replacement. Refuses (throws StaleSuggestionError) unless the suggestion was made for
 * this exact version, or it was rebased to it and the original text is still in place.
 */
export function applySuggestion(doc: DocumentSnapshot, s: Suggestion, replacementIndex = 0): DocumentSnapshot {
  if (s.documentVersion !== doc.version || !isApplicable(doc, s)) throw new StaleSuggestionError();
  const replacement = s.replacements[replacementIndex];
  if (replacement === undefined) throw new RangeError(`No replacement at index ${replacementIndex}`);
  return {
    text: doc.text.slice(0, s.start) + replacement + doc.text.slice(s.end),
    version: doc.version + 1,
  };
}

/** The single contiguous region that differs between two strings. */
export interface TextChange {
  start: number;
  /** End of the replaced region in the OLD text. */
  oldEnd: number;
  /** End of the inserted region in the NEW text. */
  newEnd: number;
}

export function diffRange(prev: string, next: string): TextChange | null {
  if (prev === next) return null;
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let oldEnd = prev.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && prev.charCodeAt(oldEnd - 1) === next.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  // Never split a surrogate pair: widen the change to whole code points.
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start--;
  if (oldEnd < prev.length && isLowSurrogate(prev.charCodeAt(oldEnd))) {
    oldEnd++;
    newEnd++;
  }
  return { start, oldEnd, newEnd };
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Keep underlines stable while the user types, before the next check finishes:
 * suggestions before the edit are kept, after it are shifted, touching it are dropped.
 */
export function rebaseSuggestions(
  prevText: string,
  next: DocumentSnapshot,
  suggestions: Suggestion[],
): Suggestion[] {
  const change = diffRange(prevText, next.text);
  const delta = change ? change.newEnd - change.oldEnd : 0;
  const out: Suggestion[] = [];
  for (const s of suggestions) {
    let moved: Suggestion;
    if (!change) {
      moved = { ...s, documentVersion: next.version };
    } else if (s.end < change.start || (s.end === change.start && !isWordChar(next.text, change.start))) {
      // Entirely before the edit. (Typing a letter directly after a word changes that word, so it drops.)
      moved = { ...s, documentVersion: next.version };
    } else if (s.start > change.oldEnd || (s.start === change.oldEnd && !isWordChar(next.text, change.newEnd - 1))) {
      moved = { ...s, start: s.start + delta, end: s.end + delta, documentVersion: next.version };
    } else {
      continue; // The edit touched this range — wait for a fresh check.
    }
    if (isApplicable(next, moved)) out.push(moved);
  }
  return out;
}

/** Is the code point covering UTF-16 `index` part of a word? (letters, digits, combining marks, apostrophes) */
function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  let i = index;
  const c = text.charCodeAt(i);
  if (isLowSurrogate(c) && i > 0 && isHighSurrogate(text.charCodeAt(i - 1))) i--;
  const cp = text.codePointAt(i);
  return cp !== undefined && /[\p{L}\p{N}\p{M}'’_-]/u.test(String.fromCodePoint(cp));
}

/**
 * Remove overlapping suggestions. Earlier start wins; on ties, correctness beats style
 * and local (Harper) beats AI, so the cheaper, deterministic result is preferred.
 */
export function resolveOverlaps(suggestions: Suggestion[]): Suggestion[] {
  const rank = (s: Suggestion) =>
    (['spelling', 'grammar', 'punctuation'].includes(s.category) ? 0 : 2) + (s.source === 'harper' ? 0 : 1);
  const sorted = [...suggestions].sort((a, b) => a.start - b.start || rank(a) - rank(b) || b.end - a.end);
  const out: Suggestion[] = [];
  let lastEnd = -1;
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.start < lastEnd) continue;
    if (prev && s.start === s.end && s.start === prev.start && prev.start === prev.end) continue;
    out.push(s);
    lastEnd = Math.max(lastEnd, s.end);
  }
  return out;
}

/**
 * Turn an AI edit (located by quoted text) into a Suggestion with real offsets.
 * Returns null if the quote can't be found, is ambiguous, or the "edit" is a no-op — this is the
 * validation step that stops hallucinated or meaning-free AI output from reaching the UI.
 */
export function locateAiEdit(doc: DocumentSnapshot, edit: AiEdit, searchFrom = 0): Suggestion | null {
  if (!edit.original || edit.original === edit.replacement) return null;
  let start = -1;
  if (edit.contextBefore) {
    const anchor = doc.text.indexOf(edit.contextBefore + edit.original, searchFrom);
    if (anchor !== -1) start = anchor + edit.contextBefore.length;
  }
  if (start === -1) {
    const first = doc.text.indexOf(edit.original, searchFrom);
    if (first === -1) return null;
    const second = doc.text.indexOf(edit.original, first + 1);
    // Ambiguous short quotes ("a", "the") are unsafe to place unless context matched above.
    if (second !== -1 && edit.original.length < 12) return null;
    start = first;
  }
  const end = start + edit.original.length;
  const base = {
    start,
    end,
    original: edit.original,
    rule: `ai-${edit.category}`,
    source: 'ai' as const,
  };
  return {
    ...base,
    id: suggestionId(base),
    replacements: [edit.replacement],
    category: edit.category,
    message: edit.message,
    documentVersion: doc.version,
  };
}

export function countByCategory(suggestions: Suggestion[]): Record<'correctness' | 'clarity' | 'style', number> {
  const out = { correctness: 0, clarity: 0, style: 0 };
  for (const s of suggestions) {
    if (s.category === 'spelling' || s.category === 'grammar' || s.category === 'punctuation') out.correctness++;
    else if (s.category === 'clarity') out.clarity++;
    else out.style++;
  }
  return out;
}
