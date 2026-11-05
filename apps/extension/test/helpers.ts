import { suggestionId, type Category, type Suggestion } from '@grammarme/core';

/** Suggestion for `original` found at its first occurrence (or `at`) in `text`. */
export function sug(
  text: string,
  original: string,
  opts: { at?: number; category?: Category; replacements?: string[]; version?: number; rule?: string } = {},
): Suggestion {
  const start = opts.at ?? text.indexOf(original);
  if (start < 0) throw new Error(`"${original}" not in text`);
  const base = { source: 'harper' as const, rule: opts.rule ?? 'SpellCheck', start, end: start + original.length, original };
  return {
    ...base,
    id: suggestionId(base),
    replacements: opts.replacements ?? ['x'],
    category: opts.category ?? 'spelling',
    message: 'msg',
    documentVersion: opts.version ?? 0,
  };
}
