/**
 * Output sanitiser: the last line of defence between model output and the user's document.
 *
 * The model's JSON is treated as untrusted. Every edit must pass ALL guards below or it is dropped
 * (never "repaired" into something the model did not say). Guards, in order:
 *
 *  shape            — fields have the right types; category is a known Category.
 *  category         — category is allowed for the requested task (see TASK_CATEGORIES).
 *  field_too_long   — original > 300 chars or replacement > 400 chars (no paragraph rewrites).
 *  noop             — replacement === original.
 *  not_found        — `original` does not occur literally in the input (hallucinated quote).
 *  ambiguous        — short quote occurs more than once and no usable contextBefore (same rule as
 *                     the client's locateAiEdit, which we reuse so server and client always agree).
 *  newline          — replacement adds or removes line breaks.
 *  protected_span   — edit touches a URL, email, `inline code`, file path, file name, camelCase or
 *                     snake_case identifier in the input.
 *  protected_token  — numbers / URLs / emails / code-like tokens differ between original and
 *                     replacement (catches "5" -> "five", "1,000" -> "1000", "v2" -> "v3", new URLs).
 *  name_changed     — a name-like capitalised word (not sentence-initial, or sentence-initial but
 *                     never written in lowercase elsewhere in the text) is missing from the
 *                     replacement, or the replacement introduces a capitalised word found neither in
 *                     the original nor elsewhere in the document (possible invented name).
 *  negation_changed — count of negators (not, no, never, n't, without, …) differs (meaning flip).
 *  too_large        — word-level edit distance exceeds max(floor, ratio × sentence tokens), or the
 *                     replacement is > 3× (+20 chars) the original's length. Thresholds per task in
 *                     CHANGE_LIMITS: grammar is tight, clarity/tone allow more rewording.
 *  overlap          — overlaps an earlier kept edit.
 *  cap              — beyond maxEdits.
 *
 * These are heuristics tuned for English and deliberately conservative: a dropped good edit costs
 * little (Harper still runs locally), a kept bad edit can silently change what the user meant.
 */
import { locateAiEdit } from '../suggestions.ts';
import type { AiEdit, AiTask, Category } from '../types.ts';
import { TASK_CATEGORIES } from './prompts.ts';

export type DropReason =
  | 'shape'
  | 'category'
  | 'field_too_long'
  | 'noop'
  | 'not_found'
  | 'ambiguous'
  | 'newline'
  | 'protected_span'
  | 'protected_token'
  | 'name_changed'
  | 'negation_changed'
  | 'too_large'
  | 'overlap'
  | 'cap';

export interface SanitizeResult {
  edits: AiEdit[];
  dropped: Partial<Record<DropReason, number>>;
}

export const LIMITS = {
  maxOriginalChars: 300,
  maxReplacementChars: 400,
  maxMessageChars: 200,
  maxContextChars: 60,
  /** contextBefore the server attaches so the client places the edit exactly where we validated it. */
  attachedContextChars: 24,
} as const;

export const CHANGE_LIMITS: Record<AiTask, { ratio: number; floor: number }> = {
  grammar: { ratio: 0.34, floor: 2 },
  clarity: { ratio: 0.6, floor: 4 },
  tone: { ratio: 0.6, floor: 4 },
};

const ALL_CATEGORIES: readonly Category[] = ['spelling', 'grammar', 'punctuation', 'clarity', 'style', 'tone'];

/* ---------- token patterns ---------- */

const URL = String.raw`(?:https?:\/\/|www\.)[^\s<>"'\])]+`;
const EMAIL = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`;
const INLINE_CODE = String.raw`\x60[^\x60\n]+\x60`;
const PATH = String.raw`(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+`;
const FILE_NAME = String.raw`\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cs|php|json|ya?ml|toml|md|txt|csv|html|css|sql|sh|ipynb|pdf|docx?|xlsx?|png|jpe?g)\b`;
const CAMEL = String.raw`\b[a-z]+(?:[A-Z][a-z0-9]*)+\b`;
const SNAKE = String.raw`\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b`;
const CALL = String.raw`\b\w+\(\)`;
const NUMBER = String.raw`\d+(?:[.,:\/-]\d+)*%?`;

/** Spans in the INPUT that edits must not touch at all. */
const PROTECTED_SPAN_RE = new RegExp([URL, EMAIL, INLINE_CODE, PATH, FILE_NAME, CAMEL, SNAKE, CALL].join('|'), 'g');
/** Tokens that must be preserved (as a multiset) between original and replacement. */
const PROTECTED_TOKEN_RE = new RegExp([URL, EMAIL, INLINE_CODE, PATH, FILE_NAME, CAMEL, SNAKE, CALL, NUMBER].join('|'), 'g');

const NEGATION_RE =
  /\b(?:not|no|never|none|nobody|nothing|nowhere|neither|nor|without|cannot|dont|doesnt|didnt|cant|wont|isnt|arent|wasnt|werent|shouldnt|couldnt|wouldnt|hasnt|havent|hadnt|aint)\b|n['’]t\b/gi;

const CAP_WORD_RE = /\p{Lu}[\p{L}\p{M}\p{N}'’-]*/gu;
const PRONOUN_I_RE = /^I(?:['’](?:m|d|ll|ve))?$/;
const TOKEN_RE = /[\p{L}\p{M}\p{N}'’]+|[^\s\p{L}\p{M}\p{N}]/gu;

/* ---------- helpers ---------- */

function bump(dropped: SanitizeResult['dropped'], reason: DropReason): void {
  dropped[reason] = (dropped[reason] ?? 0) + 1;
}

function multiset(values: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function matches(re: RegExp, s: string): string[] {
  return Array.from(s.matchAll(new RegExp(re.source, re.flags)), (m) => m[0]);
}

function countMatches(re: RegExp, s: string): number {
  return matches(re, s).length;
}

/** True if position `index` in `text` starts a sentence (start of text/line or after . ! ? …). */
export function isSentenceInitial(text: string, index: number): boolean {
  const before = text.slice(0, index);
  if (/^[\s"'“‘(\[]*$/.test(before)) return true;
  return /(?:[.!?…]["'”’)\]]*\s+|\n\s*)["'“‘(\[]*$/.test(before.slice(-16));
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

const tokens = (s: string): string[] => s.match(TOKEN_RE) ?? [];

/** Token count of the sentence(s) that contain [start, end). */
function sentenceTokenCount(text: string, start: number, end: number): number {
  let s = start;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1] ?? '')) s--;
  let e = end;
  while (e < text.length && !/[.!?\n]/.test(text[e] ?? '')) e++;
  if (e < text.length) e++;
  return tokens(text.slice(s, e)).length;
}

function protectedSpans(text: string): [number, number][] {
  return Array.from(text.matchAll(new RegExp(PROTECTED_SPAN_RE.source, PROTECTED_SPAN_RE.flags)), (m) => [
    m.index,
    m.index + m[0].length,
  ]);
}

function overlapsAny(spans: readonly [number, number][], start: number, end: number): boolean {
  return spans.some(([s, e]) => start < e && s < end);
}

/** Frequent sentence-initial English words that are never treated as names. */
const COMMON_STARTERS = new Set(
  (
    'a an the this that these those there their they them then than it its it\'s we our you your he his she her ' +
    'my me us i if in on at to of for from by with without about after before during while when where why how ' +
    'what which who whom whose and but or so because since although though however also as all any each every ' +
    'some many most much more few both either neither no not nor yes please thanks thank hi hello hey dear ' +
    'is are was were be been being am do does did done have has had can could would should will shall may might ' +
    'must let just here now today tomorrow yesterday one two first second next finally overall well also only ' +
    'even still yet again once maybe perhaps actually basically'
  ).split(' '),
);

/** Common word, or a contraction of one ("They're" -> "they", "Don't" -> "do"). */
function isCommonStarter(word: string): boolean {
  const lower = word.toLowerCase().replace(/’/g, "'");
  if (COMMON_STARTERS.has(lower)) return true;
  const base = lower.split("'")[0] ?? '';
  return COMMON_STARTERS.has(base) || COMMON_STARTERS.has(base.replace(/n$/, ''));
}

/**
 * A capitalised word is "name-like" unless it starts a sentence AND it is a common word (listed above
 * or written in lowercase elsewhere in the document). So "The"/"Their" at a sentence start are normal
 * words, but "Maria" at a sentence start is treated as a name.
 */
function isNameLike(text: string, docLower: ReadonlySet<string>, word: string, absIndex: number): boolean {
  if (PRONOUN_I_RE.test(word)) return false;
  if (!isSentenceInitial(text, absIndex)) return true;
  return !isCommonStarter(word) && !docLower.has(word.toLowerCase());
}

function nameChanged(
  text: string,
  doc: { words: ReadonlySet<string>; lower: ReadonlySet<string> },
  start: number,
  original: string,
  replacement: string,
): boolean {
  // 1) Name-like capitalised words in the original must survive verbatim (case-sensitive).
  const repWords = multiset(tokens(replacement));
  for (const m of original.matchAll(CAP_WORD_RE)) {
    const word = m[0];
    if (!isNameLike(text, doc.lower, word, start + m.index)) continue;
    const n = repWords.get(word) ?? 0;
    if (n === 0) return true;
    repWords.set(word, n - 1);
  }
  // 2) The replacement must not introduce capitalised words that appear neither in the quoted original
  //    (case-insensitive, allows "monday" -> "Monday") nor anywhere in the document (allows resolving
  //    "she" -> "Maria" when Maria is mentioned). At a sentence start, a word that is a close spelling
  //    fix of the original's first word is also allowed ("teh" -> "The").
  const origTokens = tokens(original);
  const origLower = new Set(origTokens.map((w) => w.toLowerCase()));
  const firstOrig = (origTokens[0] ?? '').toLowerCase();
  for (const m of replacement.matchAll(CAP_WORD_RE)) {
    const word = m[0];
    if (PRONOUN_I_RE.test(word)) continue;
    if (origLower.has(word.toLowerCase()) || doc.words.has(word)) continue;
    const atStart = /^\s*$/.test(replacement.slice(0, m.index));
    const sentenceStart = atStart ? isSentenceInitial(text, start) : isSentenceInitial(replacement, m.index);
    if (sentenceStart && (doc.lower.has(word.toLowerCase()) || isCommonStarter(word) || levenshtein([...firstOrig], [...word.toLowerCase()]) <= 2)) {
      continue;
    }
    return true;
  }
  return false;
}

interface RawEdit {
  original: string;
  replacement: string;
  contextBefore: string;
  category: Category;
  message: string;
}

function parseRawEdit(value: unknown): RawEdit | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.original !== 'string' || typeof v.replacement !== 'string') return null;
  if (typeof v.category !== 'string' || !(ALL_CATEGORIES as readonly string[]).includes(v.category)) return null;
  if (v.contextBefore !== undefined && v.contextBefore !== null && typeof v.contextBefore !== 'string') return null;
  if (v.message !== undefined && v.message !== null && typeof v.message !== 'string') return null;
  return {
    original: v.original,
    replacement: v.replacement,
    contextBefore: typeof v.contextBefore === 'string' ? v.contextBefore : '',
    category: v.category as Category,
    message: typeof v.message === 'string' ? v.message : '',
  };
}

function cleanMessage(message: string, category: Category): string {
  // eslint-disable-next-line no-control-regex
  const flat = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return `Suggested ${category} improvement.`;
  return flat.length > LIMITS.maxMessageChars ? `${flat.slice(0, LIMITS.maxMessageChars - 1)}…` : flat;
}

/** Pull the edits array out of whatever JSON the model produced: {edits:[…]} or a bare array. */
export function extractEditList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { edits?: unknown }).edits)) {
    return (parsed as { edits: unknown[] }).edits;
  }
  return null;
}

/* ---------- main ---------- */

export function sanitizeEdits(rawList: readonly unknown[], text: string, task: AiTask, maxEdits: number): SanitizeResult {
  const dropped: SanitizeResult['dropped'] = {};
  const allowed = TASK_CATEGORIES[task];
  const limits = CHANGE_LIMITS[task];
  const located: { start: number; end: number; edit: AiEdit }[] = [];
  const spans = protectedSpans(text);
  const docTokens = tokens(text);
  const doc = { words: new Set(docTokens), lower: new Set(docTokens.filter((w) => w === w.toLowerCase())) };

  for (const value of rawList) {
    const raw = parseRawEdit(value);
    if (!raw) { bump(dropped, 'shape'); continue; }
    const { original, replacement, category } = raw;
    if (!allowed.includes(category)) { bump(dropped, 'category'); continue; }
    if (!original || original.length > LIMITS.maxOriginalChars || replacement.length > LIMITS.maxReplacementChars) {
      bump(dropped, 'field_too_long'); continue;
    }
    if (replacement === original) { bump(dropped, 'noop'); continue; }
    if (!text.includes(original)) { bump(dropped, 'not_found'); continue; }

    // Only trust contextBefore if it really precedes the quote; otherwise locate without it so the
    // ambiguity rule applies.
    let ctx = raw.contextBefore.slice(-LIMITS.maxContextChars);
    if (ctx && !text.includes(ctx + original)) ctx = '';
    const placed = locateAiEdit(
      { text, version: 0 },
      { original, replacement, category, message: '', ...(ctx ? { contextBefore: ctx } : {}) },
    );
    if (!placed) { bump(dropped, 'ambiguous'); continue; }
    const { start, end } = placed;

    if (countMatches(/\n/g, original) !== countMatches(/\n/g, replacement)) { bump(dropped, 'newline'); continue; }
    if (overlapsAny(spans, start, end)) { bump(dropped, 'protected_span'); continue; }
    if (!sameMultiset(multiset(matches(PROTECTED_TOKEN_RE, original)), multiset(matches(PROTECTED_TOKEN_RE, replacement)))) {
      bump(dropped, 'protected_token'); continue;
    }
    if (nameChanged(text, doc, start, original, replacement)) { bump(dropped, 'name_changed'); continue; }
    if (countMatches(NEGATION_RE, original) !== countMatches(NEGATION_RE, replacement)) {
      bump(dropped, 'negation_changed'); continue;
    }
    const distance = levenshtein(tokens(original), tokens(replacement));
    const budget = Math.max(limits.floor, Math.floor(limits.ratio * sentenceTokenCount(text, start, end)));
    if (distance > budget || replacement.length > original.length * 3 + 20) { bump(dropped, 'too_large'); continue; }

    // Attach a short real context so the client re-locates exactly the occurrence we validated.
    const attached = text.slice(Math.max(0, start - LIMITS.attachedContextChars), start);
    const contextBefore =
      attached && text.indexOf(attached + original) === start - attached.length ? attached : ctx;

    located.push({
      start,
      end,
      edit: {
        original,
        replacement,
        category,
        message: cleanMessage(raw.message, category),
        ...(contextBefore ? { contextBefore } : {}),
      },
    });
  }

  located.sort((a, b) => a.start - b.start || a.end - b.end);
  const edits: AiEdit[] = [];
  let lastEnd = -1;
  for (const item of located) {
    if (item.start < lastEnd) { bump(dropped, 'overlap'); continue; }
    if (edits.length >= maxEdits) { bump(dropped, 'cap'); continue; }
    edits.push(item.edit);
    lastEnd = item.end;
  }
  return { edits, dropped };
}
