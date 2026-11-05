import { suggestionId } from '../../src/suggestions.ts';
import type { Category, DocumentSnapshot, Source, Suggestion, SuggestionEngine } from '../../src/types.ts';

/** Build a Suggestion for `original` found in `text` (nth occurrence, default first). */
export function sugAt(
  text: string,
  original: string,
  replacement: string,
  opts: {
    nth?: number;
    version?: number;
    category?: Category;
    source?: Source;
    rule?: string;
    replacements?: string[];
  } = {},
): Suggestion {
  let start = -1;
  for (let i = 0; i <= (opts.nth ?? 0); i++) {
    start = text.indexOf(original, start + 1);
    if (start === -1) throw new Error(`fixture: "${original}" #${opts.nth ?? 0} not in "${text}"`);
  }
  return sug(start, start + original.length, original, replacement, opts);
}

export function sug(
  start: number,
  end: number,
  original: string,
  replacement: string,
  opts: {
    version?: number;
    category?: Category;
    source?: Source;
    rule?: string;
    replacements?: string[];
  } = {},
): Suggestion {
  const base = {
    source: opts.source ?? ('harper' as const),
    rule: opts.rule ?? 'SpellCheck',
    start,
    end,
    original,
  };
  return {
    ...base,
    id: suggestionId(base),
    replacements: opts.replacements ?? [replacement],
    category: opts.category ?? 'spelling',
    message: `Replace "${original}"`,
    documentVersion: opts.version ?? 1,
  };
}

/** Deterministic PRNG (mulberry32) so fuzz failures are reproducible from the seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

/** True if index `i` sits between the two halves of a surrogate pair. */
export function splitsSurrogate(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const hi = text.charCodeAt(i - 1);
  const lo = text.charCodeAt(i);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/**
 * A deterministic fake engine: flags whole-word typos from a fixed list. Word boundaries match
 * the characters `rebaseSuggestions` treats as word characters, so a fresh check and a rebased
 * result are directly comparable. `delayMs` lets tests make results arrive out of order.
 */
export const TYPOS: Record<string, string> = { teh: 'the', recieve: 'receive', wrold: 'world', adress: 'address' };

export class FakeSpellEngine implements SuggestionEngine {
  readonly source = 'harper' as const;
  calls = 0;
  delayFor: (doc: DocumentSnapshot) => number = () => 0;

  async check(doc: DocumentSnapshot): Promise<Suggestion[]> {
    this.calls++;
    const delay = this.delayFor(doc);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return fakeCheckSync(doc);
  }
}

export function fakeCheckSync(doc: DocumentSnapshot): Suggestion[] {
  const out: Suggestion[] = [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}'’_-])(${Object.keys(TYPOS).join('|')})(?![\\p{L}\\p{N}'’_-])`, 'gu');
  for (const m of doc.text.matchAll(re)) {
    const word = m[1] as string;
    out.push(sug(m.index, m.index + word.length, word, TYPOS[word] as string, { version: doc.version }));
  }
  return out;
}

/** Position-and-text key for comparing suggestion sets regardless of id/version. */
export const key = (s: Suggestion) => `${s.start}:${s.end}:${s.original}`;

/** No lone surrogates (String.prototype.isWellFormed is ES2024; tsconfig targets ES2022 libs). */
export function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}
