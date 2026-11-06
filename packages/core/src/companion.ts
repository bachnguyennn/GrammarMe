/**
 * The message contract between the GrammarMe Chrome extension and the local ChatGPT companion
 * (apps/companion), which Chrome starts through native messaging.
 *
 * Design rules (see docs/chatgpt.md):
 * - The companion holds every OAuth credential. Nothing in this contract carries a token, so a
 *   token can never reach the extension, a content script or a web page.
 * - Only the fixed operations below exist. The companion is not a proxy: it never takes a URL,
 *   header or arbitrary request body from the extension.
 * - Every request has an `id`. Replies and progress events echo it. A request ends with exactly
 *   one `done` message.
 */
import type { AiEdit, AiTask, WritingMode } from './types.ts';

/** Native messaging host name registered by `apps/companion` (Chrome's naming rules). */
export const COMPANION_HOST = 'com.grammarme.chatgpt';
export const COMPANION_PROTOCOL = 1;

/** Text sent per AI check (UTF-16 code units). */
export const AI_MAX_INPUT_CHARS = 4000;
/** Model output the companion will read before giving up (characters of streamed text). */
export const AI_MAX_OUTPUT_CHARS = 24_000;
/** Most edits returned for one check. */
export const AI_MAX_EDITS = 25;
/** Wall-clock limits enforced by the companion. */
export const AI_CHECK_TIMEOUT_MS = 90_000;
/** OAuth transactions expire after 10 minutes (OpenAI SIWC docs). */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

/* ------------------------------------------------------------------ requests */

export type CompanionRequest =
  | { id: string; type: 'status' }
  | { id: string; type: 'signIn' }
  | { id: string; type: 'signOut' }
  | { id: string; type: 'models' }
  | { id: string; type: 'setModel'; model: string }
  | { id: string; type: 'test' }
  | { id: string; type: 'check'; task: AiTask; mode: WritingMode; text: string }
  | { id: string; type: 'cancel'; target: string };

export type CompanionRequestType = CompanionRequest['type'];

/* ------------------------------------------------------------------ replies */

export type CompanionErrorCode =
  /** No stored ChatGPT session. */
  | 'not_connected'
  /** Signed in, but the grant lacks plan usage (chatgpt.tokens.use.direct). */
  | 'permission_required'
  /** The session can't be refreshed (expired, revoked, disconnected in ChatGPT settings). */
  | 'reauth_required'
  /** The user closed or declined the OpenAI consent screen. */
  | 'consent_denied'
  /** subscription_sharing_usage_limit_exceeded */
  | 'usage_limit'
  /** subscription_sharing_usage_unavailable / user_unavailable: temporary. */
  | 'usage_unavailable'
  /** subscription_sharing_user_not_eligible: plan or region not eligible. */
  | 'not_eligible'
  /** The chosen model isn't available to this account. */
  | 'model_unavailable'
  /** route / capability not supported for plan usage. */
  | 'unsupported'
  | 'too_long'
  | 'bad_request'
  /** Another check or sign-in is already running. */
  | 'busy'
  | 'cancelled'
  | 'timeout'
  /** Could not reach OpenAI. */
  | 'network'
  /** OpenAI returned an error or unusable output. */
  | 'provider_error'
  /** The companion itself failed (storage, configuration). */
  | 'internal';

export interface AccountInfo {
  /** Display only. From the verified ID token; never used for authorization. */
  email?: string;
  name?: string;
  /** True when the grant includes ChatGPT plan usage. */
  planUsage: boolean;
}

export interface ModelInfo {
  slug: string;
  displayName: string;
}

export interface StatusPayload {
  protocol: number;
  companionVersion: string;
  connected: boolean;
  account?: AccountInfo;
  /** The model checks will use, if one is chosen. */
  model?: string;
}

export interface CheckPayload {
  edits: AiEdit[];
  /** Edits the guards rejected (unsafe, ambiguous, out of scope). */
  dropped: number;
  model: string;
}

export type CompanionReply =
  /** Progress: sign-in is waiting for the user in the browser. The URL is OpenAI's authorize page. */
  | { id: string; type: 'authUrl'; url: string }
  | { id: string; type: 'done'; ok: true; status?: StatusPayload; models?: ModelInfo[]; check?: CheckPayload; latencyMs?: number; revoked?: boolean }
  | { id: string; type: 'done'; ok: false; error: CompanionErrorCode; message: string };

/* ------------------------------------------------------------------ validation */

const TASKS: readonly AiTask[] = ['grammar', 'clarity', 'tone'];
const MODES: readonly WritingMode[] = ['standard', 'academic', 'professional', 'casual'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL = /^[A-Za-z0-9._:-]{1,100}$/;

/** Strict parse of a request from the extension. Unknown fields are ignored; anything else is rejected. */
export function parseCompanionRequest(raw: unknown): CompanionRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id)) return null;
  const id = r.id;
  switch (r.type) {
    case 'status':
    case 'signIn':
    case 'signOut':
    case 'models':
    case 'test':
      return { id, type: r.type };
    case 'setModel':
      return typeof r.model === 'string' && MODEL.test(r.model) ? { id, type: 'setModel', model: r.model } : null;
    case 'cancel':
      return typeof r.target === 'string' && ID.test(r.target) ? { id, type: 'cancel', target: r.target } : null;
    case 'check': {
      if (!TASKS.includes(r.task as AiTask) || !MODES.includes(r.mode as WritingMode)) return null;
      if (typeof r.text !== 'string' || r.text.trim().length === 0 || r.text.length > AI_MAX_INPUT_CHARS) return null;
      return { id, type: 'check', task: r.task as AiTask, mode: r.mode as WritingMode, text: r.text };
    }
    default:
      return null;
  }
}

/** Shape check for replies coming back from the companion. */
export function isCompanionReply(raw: unknown): raw is CompanionReply {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return false;
  if (r.type === 'authUrl') return typeof r.url === 'string' && r.url.startsWith('https://auth.openai.com/');
  if (r.type !== 'done') return false;
  return r.ok === true || (r.ok === false && typeof r.error === 'string' && typeof r.message === 'string');
}

/** Plain-language text for each error, for the popup and the in-page panel. */
export const COMPANION_ERROR_TEXT: Record<CompanionErrorCode, string> = {
  not_connected: 'ChatGPT isn’t connected. Open the GrammarMe button in the toolbar and choose Continue with ChatGPT.',
  permission_required: 'Your ChatGPT sign-in didn’t include permission to use your plan. Connect again and allow plan usage.',
  reauth_required: 'Your ChatGPT connection has expired or was removed. Connect again to continue.',
  consent_denied: 'ChatGPT access wasn’t allowed. Nothing was connected.',
  usage_limit: 'You’ve reached your ChatGPT plan’s usage limit for now. Local spelling and grammar checks still work.',
  usage_unavailable: 'ChatGPT plan usage is temporarily unavailable. Try again later; local checks still work.',
  not_eligible: 'This ChatGPT account isn’t eligible to use its plan in other apps (Plus or Pro is required, and some regions aren’t supported).',
  model_unavailable: 'That model isn’t available on your account. Pick another model in GrammarMe’s settings.',
  unsupported: 'OpenAI doesn’t support this request with ChatGPT plan usage.',
  too_long: `That’s too much text for one AI check (the limit is ${AI_MAX_INPUT_CHARS.toLocaleString('en-US')} characters). Select a shorter part.`,
  bad_request: 'GrammarMe sent a request the companion couldn’t accept.',
  busy: 'An AI check is already running.',
  cancelled: 'AI check cancelled.',
  timeout: 'ChatGPT took too long to answer. Try again with less text.',
  network: 'Couldn’t reach OpenAI. Check your internet connection.',
  provider_error: 'ChatGPT returned an error. Try again in a moment.',
  internal: 'The GrammarMe companion hit an unexpected problem. See the troubleshooting guide.',
};
