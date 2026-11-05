import { Dialect as HarperDialect, SuggestionKind, type Lint, type Linter } from 'harper.js';
import { suggestionId } from './suggestions.ts';
import type { Category, CheckOptions, Dialect, DocumentSnapshot, Suggestion, SuggestionEngine } from './types.ts';

const KIND_TO_CATEGORY: Record<string, Category> = {
  Spelling: 'spelling',
  Typo: 'spelling',
  Punctuation: 'punctuation',
  Formatting: 'punctuation',
  Agreement: 'grammar',
  Grammar: 'grammar',
  BoundaryError: 'grammar',
  Capitalization: 'grammar',
  WordOrder: 'grammar',
  Malapropism: 'grammar',
  Eggcorn: 'grammar',
  Usage: 'grammar',
  Nonstandard: 'grammar',
  Miscellaneous: 'grammar',
  Readability: 'clarity',
  Redundancy: 'clarity',
  Repetition: 'clarity',
  WordChoice: 'clarity',
  Enhancement: 'style',
  Style: 'style',
  Regionalism: 'style',
};

export function categoryForLintKind(kind: string): Category {
  return KIND_TO_CATEGORY[kind] ?? 'grammar';
}

const DIALECTS: Record<Dialect, HarperDialect> = {
  american: HarperDialect.American,
  british: HarperDialect.British,
  canadian: HarperDialect.Canadian,
  australian: HarperDialect.Australian,
  indian: HarperDialect.Indian,
};

/**
 * Rules off by default, from tests/eval (docs/evaluation.md):
 * - LongSentences: flags a whole 40+ word sentence and hides every other error inside it.
 * - SplitWords: 3/3 suggestions wrong in the dataset ("adress" → "a dress", "wether" → "wet her").
 * - ExpandTimeShorthands: rewrites "ms" → "milliseconds" in technical text.
 */
export const DEFAULT_DISABLED_RULES = ['LongSentences', 'SplitWords', 'ExpandTimeShorthands'];

/**
 * Tokens that are almost certainly code, identifiers or acronyms, not misspelled English:
 * camelCase, snake_case, dotted/slashed paths, letters mixed with digits, ALL-CAPS.
 */
export function looksLikeCode(token: string): boolean {
  return (
    /\p{Ll}\p{Lu}/u.test(token) ||
    /[_./\\@#$<>{}()[\]=]/.test(token) ||
    (/\p{L}/u.test(token) && /\d/.test(token)) ||
    /^\p{Lu}{2,}s?$/u.test(token)
  );
}

/** Convert a code-point index into a UTF-16 index (only used if Harper ever reports code points). */
export function codePointToUtf16(text: string, cp: number): number {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen === cp) return units;
    units += ch.length;
    seen++;
  }
  return units;
}

/**
 * Find the UTF-16 range for a Harper span. harper.js 3.x reports UTF-16 indices (verified in
 * test/harper.test.ts with emoji input); we still verify and fall back to code-point conversion
 * so a future upstream change can't silently misplace corrections.
 */
export function resolveSpan(text: string, start: number, end: number, problemText: string): [number, number] | null {
  if (text.slice(start, end) === problemText) return [start, end];
  const s = codePointToUtf16(text, start);
  const e = codePointToUtf16(text, end);
  if (text.slice(s, e) === problemText) return [s, e];
  return null;
}

export function lintToSuggestion(text: string, lint: Lint, rule: string, version: number): Suggestion | null {
  const span = lint.span();
  const problem = lint.get_problem_text();
  const range = resolveSpan(text, span.start, span.end, problem);
  if (!range) return null;
  const [start, end] = range;
  const original = text.slice(start, end);
  const seen = new Set<string>();
  const replacements: string[] = [];
  for (const sug of lint.suggestions()) {
    const kind = sug.kind();
    const r =
      kind === SuggestionKind.Remove
        ? ''
        : kind === SuggestionKind.InsertAfter
          ? original + sug.get_replacement_text()
          : sug.get_replacement_text();
    if (r !== original && !seen.has(r)) {
      seen.add(r);
      replacements.push(r);
    }
  }
  const base = { source: 'harper' as const, rule, start, end, original };
  return {
    ...base,
    id: suggestionId(base),
    replacements: replacements.slice(0, 5),
    category: categoryForLintKind(lint.lint_kind()),
    message: lint.message(),
    documentVersion: version,
  };
}

/**
 * Local, offline grammar engine. Pass a harper.js `WorkerLinter` (web app, off main thread) or
 * `LocalLinter` (tests, extension offscreen document).
 */
export class HarperEngine implements SuggestionEngine {
  readonly source = 'harper' as const;
  private dialect: Dialect | undefined;
  private disabled = new Set<string>();
  private words: string[] = [];
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  private linter: Linter;

  constructor(linter: Linter) {
    this.linter = linter;
    this.ready = linter.setup();
  }

  check(doc: DocumentSnapshot, options: CheckOptions = {}): Promise<Suggestion[]> {
    // Serialize: configure() + lint must not interleave between concurrent callers
    // (different dialects in parallel crash the WASM linter).
    const run = this.queue.then(() => this.checkNow(doc, options));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async checkNow(doc: DocumentSnapshot, options: CheckOptions): Promise<Suggestion[]> {
    await this.ready;
    await this.configure(options);
    const grouped = await this.linter.organizedLints(doc.text, { language: 'plaintext' });
    const out: Suggestion[] = [];
    for (const [rule, lints] of Object.entries(grouped)) {
      for (const lint of lints) {
        const s = lintToSuggestion(doc.text, lint, rule, doc.version);
        if (s && !(s.category === 'spelling' && looksLikeCode(s.original))) out.push(s);
        lint.free();
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Add words to the personal dictionary so they stop being flagged. */
  async addWords(words: string[]): Promise<void> {
    await this.ready;
    this.words = [...new Set([...this.words, ...words])];
    await this.linter.importWords(words);
  }

  /** Replace the whole personal dictionary (so removed words get flagged again). */
  async setDictionary(words: string[]): Promise<void> {
    await this.ready;
    this.words = [...new Set(words)];
    await this.linter.clearWords();
    if (words.length) await this.linter.importWords(words);
  }

  async ruleDescriptions(): Promise<Record<string, string>> {
    await this.ready;
    return this.linter.getLintDescriptions();
  }

  dispose(): Promise<void> {
    return this.linter.dispose();
  }

  private async configure(options: CheckOptions): Promise<void> {
    let rebuilt = false;
    if (options.dialect && options.dialect !== this.dialect) {
      // harper.js 3.0.0 rebuilds the linter on setDialect, dropping imported words and rule config.
      await this.linter.setDialect(DIALECTS[options.dialect]);
      this.dialect = options.dialect;
      if (this.words.length) await this.linter.importWords(this.words);
      rebuilt = true;
    }
    const next = new Set([...DEFAULT_DISABLED_RULES, ...(options.disabledRules ?? [])]);
    if (rebuilt) this.disabled = new Set(); // config is back to defaults; re-apply everything
    if (!sameSet(next, this.disabled)) {
      const config = await this.linter.getLintConfig();
      for (const key of Object.keys(config)) {
        if (next.has(key)) config[key] = false;
        else if (this.disabled.has(key)) config[key] = null; // back to Harper's default
      }
      await this.linter.setLintConfig(config);
      this.disabled = next;
    }
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
