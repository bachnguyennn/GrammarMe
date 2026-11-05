/**
 * GrammarMe shared suggestion contract.
 *
 * OFFSET CONVENTION — read this before touching any range code:
 *   `start` and `end` are JavaScript string indices, i.e. UTF-16 code units,
 *   with `end` exclusive. `text.slice(start, end) === original` must always hold
 *   for the document version the suggestion was produced against.
 *   Every component (Harper adapter, AI worker, web editor, extension) uses this.
 */

/** Broad grouping shown in the UI. Correctness = spelling | grammar | punctuation. */
export type Category =
  | 'spelling'
  | 'grammar'
  | 'punctuation'
  | 'clarity'
  | 'style'
  | 'tone';

/** Where a suggestion came from. `harper` never leaves the device; `ai` was sent to a cloud model. */
export type Source = 'harper' | 'ai';

export interface Suggestion {
  /** Stable for the same (source, rule, range, original) — used for keys and ignore lists. */
  id: string;
  /** UTF-16 start offset, inclusive. */
  start: number;
  /** UTF-16 end offset, exclusive. Equal to `start` for pure insertions. */
  end: number;
  /** Exact text currently in the range. */
  original: string;
  /** Candidate replacements, best first. Empty string = delete the range. May be empty (explain-only). */
  replacements: string[];
  category: Category;
  source: Source;
  /** Short human explanation, plain text. */
  message: string;
  /** Machine rule id (e.g. Harper lint kind or AI check type). Used for "ignore this rule". */
  rule: string;
  /** Document version the offsets refer to. */
  documentVersion: number;
}

/** A versioned snapshot of the text being checked. Increment `version` on every edit. */
export interface DocumentSnapshot {
  text: string;
  version: number;
}

export type WritingMode = 'standard' | 'academic' | 'professional' | 'casual';

export type Dialect = 'american' | 'british' | 'canadian' | 'australian' | 'indian';

export interface CheckOptions {
  dialect?: Dialect;
  /** Rule ids the user turned off. */
  disabledRules?: string[];
}

/** Anything that can turn text into suggestions. Harper and the AI client both implement this. */
export interface SuggestionEngine {
  readonly source: Source;
  check(doc: DocumentSnapshot, options?: CheckOptions): Promise<Suggestion[]>;
}

/* ---------- AI API contract (workers/ai-api) ---------- */

export type AiTask = 'grammar' | 'clarity' | 'tone';

export interface AiCheckRequest {
  text: string;
  task: AiTask;
  mode: WritingMode;
  /** Echoed back so the client can discard stale responses. */
  documentVersion: number;
}

/** One edit the model proposes, located by quoting text rather than by offsets (models are bad at counting). */
export interface AiEdit {
  original: string;
  replacement: string;
  /** A few characters before `original`, used to disambiguate repeated phrases. */
  contextBefore?: string;
  category: Category;
  message: string;
}

export interface AiCheckResponse {
  documentVersion: number;
  edits: AiEdit[];
  model: string;
  /** Requests left today for this client, if the server tracks it. */
  remaining?: number;
}

export interface AiErrorResponse {
  error: 'rate_limited' | 'quota_exhausted' | 'bad_request' | 'unauthorized' | 'upstream_error' | 'too_long';
  message: string;
  retryAfterSeconds?: number;
}
