import type { Category, Suggestion } from '@grammarme/core';

export interface Segment {
  text: string;
  suggestion?: Suggestion;
}

/**
 * Split text into plain and underlined runs. Assumes `suggestions` are already non-overlapping
 * (see resolveOverlaps). Zero-length suggestions are skipped here — they still show in the sidebar.
 */
export function buildSegments(text: string, suggestions: Suggestion[]): Segment[] {
  const sorted = suggestions.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start < cursor || s.end > text.length) continue;
    if (s.start > cursor) out.push({ text: text.slice(cursor, s.start) });
    out.push({ text: text.slice(s.start, s.end), suggestion: s });
    cursor = s.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

export type Group = 'correctness' | 'clarity' | 'style';

export function groupOf(s: Suggestion): Group {
  return groupOfCategory(s.category);
}

export function groupOfCategory(c: Category): Group {
  if (c === 'spelling' || c === 'grammar' || c === 'punctuation') return 'correctness';
  if (c === 'clarity') return 'clarity';
  return 'style';
}

export const CATEGORY_LABEL: Record<Category, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  clarity: 'Clarity',
  style: 'Style',
  tone: 'Tone',
};

/** Key used to remember a dismissed issue across re-checks (offsets move, context mostly doesn't). */
export function dismissKey(text: string, s: Suggestion): string {
  // Context = the preceding word only, so edits elsewhere in the sentence don't resurrect it.
  const before = text.slice(Math.max(0, s.start - 40), s.start).trimEnd().split(/\s+/).pop() ?? '';
  return `${s.rule}|${s.original}|${before}`;
}
