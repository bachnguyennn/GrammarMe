/**
 * Message protocol between the extension's contexts. Pure and DOM-free so it can be unit-tested.
 *
 *   content script ──check──▶ service worker ──lint──▶ offscreen document (the ONE Harper instance)
 *   popup ──getSiteInfo──▶ content script (so the popup needs no `tabs`/`activeTab` permission)
 *   offscreen ──offscreenIdle──▶ service worker (which then closes the document to free memory)
 *
 * `chrome.runtime.sendMessage` from a content script reaches *every* extension page (service
 * worker AND offscreen document), so every message carries an explicit `target` and receivers
 * ignore anything not addressed to them.
 */
import type { CheckOptions, Suggestion } from '@grammarme/core';

/** Texts longer than this are not checked (keeps a single lint well under ~100 ms). */
export const MAX_CHECK_CHARS = 20_000;
/** Wait this long after the last keystroke before checking. */
export const CHECK_DEBOUNCE_MS = 400;
/** Close the offscreen document (and free Harper's memory) after this much inactivity. */
export const OFFSCREEN_IDLE_MS = 5 * 60_000;
/** Longest word accepted into the personal dictionary. */
export const MAX_WORD_LENGTH = 64;

export interface CheckRequest {
  target: 'background';
  type: 'check';
  text: string;
  version: number;
}

export interface AddWordRequest {
  target: 'background';
  type: 'addWord';
  word: string;
}

export interface OffscreenIdleNotice {
  target: 'background';
  type: 'offscreenIdle';
}

export type BackgroundRequest = CheckRequest | AddWordRequest | OffscreenIdleNotice;

export type CheckResponse =
  | { ok: true; version: number; suggestions: Suggestion[] }
  | { ok: false; version: number; error: CheckErrorCode; message?: string };

export type CheckErrorCode = 'disabled' | 'too_long' | 'bad_request' | 'engine_error';

export interface LintRequest {
  target: 'offscreen';
  type: 'lint';
  text: string;
  version: number;
  options: CheckOptions;
  /** Personal-dictionary words to import before linting (idempotent). */
  addWords?: string[];
}

export interface AddWordsRequest {
  target: 'offscreen';
  type: 'addWords';
  words: string[];
}

export type OffscreenRequest = LintRequest | AddWordsRequest;

export interface GetSiteInfoRequest {
  target: 'content';
  type: 'getSiteInfo';
}

export type ContentRequest = GetSiteInfoRequest;

export interface SiteInfo {
  host: string;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isVersion = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((w) => typeof w === 'string');

export function isBackgroundRequest(x: unknown): x is BackgroundRequest {
  if (!isObject(x) || x.target !== 'background') return false;
  switch (x.type) {
    case 'check':
      return typeof x.text === 'string' && isVersion(x.version);
    case 'addWord':
      return typeof x.word === 'string';
    case 'offscreenIdle':
      return true;
    default:
      return false;
  }
}

export function isOffscreenRequest(x: unknown): x is OffscreenRequest {
  if (!isObject(x) || x.target !== 'offscreen') return false;
  switch (x.type) {
    case 'lint':
      return (
        typeof x.text === 'string' &&
        isVersion(x.version) &&
        isObject(x.options) &&
        (x.addWords === undefined || isStringArray(x.addWords))
      );
    case 'addWords':
      return isStringArray(x.words);
    default:
      return false;
  }
}

export function isContentRequest(x: unknown): x is ContentRequest {
  return isObject(x) && x.target === 'content' && x.type === 'getSiteInfo';
}

export function isCheckResponse(x: unknown): x is CheckResponse {
  if (!isObject(x) || !isVersion(x.version)) return false;
  if (x.ok === true) return Array.isArray(x.suggestions);
  return x.ok === false && typeof x.error === 'string';
}

/** Validate a check request before it costs any CPU. Returns an error code or null if fine. */
export function validateCheck(req: CheckRequest): CheckErrorCode | null {
  if (req.text.length > MAX_CHECK_CHARS) return 'too_long';
  return null;
}

/** Normalise a word for the personal dictionary; null if it isn't a plausible single word. */
export function normalizeWord(word: string): string | null {
  const w = word.normalize('NFC').trim();
  if (w.length === 0 || w.length > MAX_WORD_LENGTH) return null;
  if (/\s/u.test(w)) return null;
  if (!/\p{L}/u.test(w)) return null;
  return w;
}
