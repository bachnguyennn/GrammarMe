/**
 * Messages for the optional ChatGPT connection, between the extension's own contexts:
 *
 *   popup ───────── aiStatus / aiConnect / aiDisconnect / aiModels / aiSetModel / aiTest ──▶ service worker
 *   content script ─ aiCheck / aiCancel ─────────────────────────────────────────────────────▶ service worker
 *   service worker ─ native messaging (one port per operation) ──▶ local companion ──▶ OpenAI
 *
 * Credentials live only in the companion (apps/companion). The service worker never sees a token,
 * and content scripts get only what they need to show a result: no account details at all.
 * Pure and DOM-free so it is unit-tested.
 */
import type { AiEdit, AiTask, WritingMode } from '@grammarme/core';
import { AI_MAX_INPUT_CHARS, type CompanionErrorCode, type ModelInfo, type StatusPayload } from '@grammarme/core/companion';

/** chrome.storage.local key holding only a non-secret flag the content scripts read. */
export const AI_READY_KEY = 'aiReady';
/** chrome.storage.local key: the user has seen the "You're using your ChatGPT plan" notice. */
export const AI_CONSENT_KEY = 'aiConsentShown';
/** chrome.storage.session key for an in-progress sign-in (the popup closes when a tab opens). */
export const AI_SIGNIN_KEY = 'aiSignIn';

/** Errors that come from the extension side rather than the companion. */
export type ExtensionAiError =
  /** The optional nativeMessaging permission hasn't been granted. */
  | 'permission_missing'
  /** Chrome found no native messaging host: the companion isn't installed. */
  | 'companion_missing'
  /** The host exists but doesn't allow this extension ID. */
  | 'companion_forbidden'
  /** The companion exited or the connection dropped before answering. */
  | 'interrupted'
  /** GrammarMe is turned off for this site. */
  | 'disabled';

export type AiErrorCode = CompanionErrorCode | ExtensionAiError;

export interface AiFailure {
  ok: false;
  error: AiErrorCode;
  message: string;
}

/** What the popup shows. */
export interface AiStatusResponse {
  ok: true;
  /** nativeMessaging permission granted. */
  permission: boolean;
  /** Companion reachable and answering. */
  companion: boolean;
  status?: StatusPayload;
  /** Sign-in currently waiting in a browser tab. */
  signingIn: boolean;
  /** Why the companion couldn't be reached or the last sign-in failed, if it did. */
  error?: AiErrorCode;
  message?: string;
}

/** Stored in chrome.storage.session while/after a sign-in runs in the service worker. */
export interface SignInState {
  state: 'waiting' | 'done' | 'error';
  error?: AiErrorCode;
  message?: string;
  at: number;
}

export type PopupAiRequest =
  | { target: 'background'; type: 'aiStatus' }
  | { target: 'background'; type: 'aiConnect' }
  | { target: 'background'; type: 'aiCancelConnect' }
  | { target: 'background'; type: 'aiDisconnect' }
  | { target: 'background'; type: 'aiModels' }
  | { target: 'background'; type: 'aiSetModel'; model: string }
  | { target: 'background'; type: 'aiTest' };

export interface AiCheckRequest {
  target: 'background';
  type: 'aiCheck';
  /** Chosen by the content script so it can cancel this exact request. */
  requestId: string;
  task: AiTask;
  mode: WritingMode;
  text: string;
}

export interface AiCancelRequest {
  target: 'background';
  type: 'aiCancel';
  requestId: string;
}

export type ContentAiRequest = AiCheckRequest | AiCancelRequest;
export type AiRequest = PopupAiRequest | ContentAiRequest;

export type AiCheckResponse = { ok: true; edits: AiEdit[]; dropped: number; model: string } | AiFailure;
export type AiModelsResponse = { ok: true; models: ModelInfo[]; selected?: string } | AiFailure;
export type AiSimpleResponse = { ok: true; latencyMs?: number; revoked?: boolean } | AiFailure;

/** The non-secret flag content scripts read to decide whether to offer the AI button. */
export interface AiReadyFlag {
  ready: boolean;
}

const TASKS: readonly AiTask[] = ['grammar', 'clarity', 'tone'];
const MODES: readonly WritingMode[] = ['standard', 'academic', 'professional', 'casual'];
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

export function isAiRequest(x: unknown): x is AiRequest {
  if (!isObject(x) || x.target !== 'background') return false;
  switch (x.type) {
    case 'aiStatus':
    case 'aiConnect':
    case 'aiCancelConnect':
    case 'aiDisconnect':
    case 'aiModels':
    case 'aiTest':
      return true;
    case 'aiSetModel':
      return typeof x.model === 'string' && x.model.length > 0 && x.model.length <= 100;
    case 'aiCheck':
      return (
        typeof x.requestId === 'string' &&
        REQUEST_ID.test(x.requestId) &&
        TASKS.includes(x.task as AiTask) &&
        MODES.includes(x.mode as WritingMode) &&
        typeof x.text === 'string' &&
        x.text.trim().length > 0 &&
        x.text.length <= AI_MAX_INPUT_CHARS
      );
    case 'aiCancel':
      return typeof x.requestId === 'string' && REQUEST_ID.test(x.requestId);
    default:
      return false;
  }
}

/** Requests a content script (a web page's context) may send. Everything else is popup-only. */
export function isContentAiRequest(x: AiRequest): x is ContentAiRequest {
  return x.type === 'aiCheck' || x.type === 'aiCancel';
}

export const EXTENSION_ERROR_TEXT: Record<ExtensionAiError, string> = {
  permission_missing: 'GrammarMe needs permission to talk to its companion app. Choose Continue with ChatGPT to allow it.',
  companion_missing: 'The GrammarMe companion isn’t installed on this computer. Follow the setup guide, then try again.',
  companion_forbidden: 'The GrammarMe companion is installed for a different extension ID. Re-run its installer (see the setup guide).',
  interrupted: 'The connection to the GrammarMe companion was interrupted. Try again.',
  disabled: 'GrammarMe is turned off for this site.',
};

/** Classify a native-messaging disconnect from chrome.runtime.lastError's message. */
export function classifyNativeError(message: string | undefined): ExtensionAiError {
  const m = (message ?? '').toLowerCase();
  if (m.includes('not found')) return 'companion_missing';
  if (m.includes('forbidden')) return 'companion_forbidden';
  return 'interrupted';
}

/** Short random request id for aiCheck/aiCancel. */
export function newRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
