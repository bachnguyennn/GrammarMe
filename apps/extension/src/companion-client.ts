/**
 * Service-worker side of the native-messaging link to the local ChatGPT companion.
 *
 * One port per operation: Chrome starts the companion when the port opens and the companion exits
 * when it closes, so nothing runs between checks. While a port is open (a sign-in or a check), it
 * also keeps this MV3 service worker alive. If the worker is suspended anyway, the port closes, the
 * companion aborts the request, and the caller gets `interrupted`.
 *
 * No message on this link carries a credential (see @grammarme/core/companion).
 */
import {
  COMPANION_ERROR_TEXT,
  COMPANION_HOST,
  isCompanionReply,
  type CompanionReply,
  type CompanionRequest,
} from '@grammarme/core/companion';
import {
  EXTENSION_ERROR_TEXT,
  classifyNativeError,
  newRequestId,
  type AiErrorCode,
  type AiFailure,
} from './ai-protocol.ts';

export type CompanionDone = Extract<CompanionReply, { type: 'done'; ok: true }>;
export type CallResult = CompanionDone | AiFailure;

/** Requests without an id: callCompanion assigns one. */
export type CompanionCall = CompanionRequest extends infer R ? (R extends { id: string } ? Omit<R, 'id'> : never) : never;

export interface CallHandle {
  result: Promise<CallResult>;
  /** Ask the companion to stop; resolves the result with `cancelled`. Safe to call twice. */
  cancel(): void;
}

export function failure(error: AiErrorCode, message?: string): AiFailure {
  const text =
    message ??
    (error in COMPANION_ERROR_TEXT
      ? COMPANION_ERROR_TEXT[error as keyof typeof COMPANION_ERROR_TEXT]
      : EXTENSION_ERROR_TEXT[error as keyof typeof EXTENSION_ERROR_TEXT]);
  return { ok: false, error, message: text };
}

export async function hasNativePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  } catch {
    return false;
  }
}

/** How long to wait for the companion to confirm a cancel before dropping the port. */
const CANCEL_GRACE_MS = 3000;

export function callCompanion(
  call: CompanionCall,
  opts: { timeoutMs: number; onAuthUrl?: (url: string) => void },
): CallHandle {
  const id = newRequestId();
  let settle!: (r: CallResult) => void;
  const result = new Promise<CallResult>((resolve) => (settle = resolve));
  let port: chrome.runtime.Port | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (r: CallResult) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(graceTimer);
    try {
      port?.disconnect(); // the companion sees stdin close and exits
    } catch {
      /* already gone */
    }
    settle(r);
  };

  const sendCancel = (reason: 'cancelled' | 'timeout') => {
    if (done) return;
    try {
      port?.postMessage({ id: newRequestId(), type: 'cancel', target: id });
    } catch {
      /* port closed */
    }
    // Don't wait forever for the confirmation.
    graceTimer = setTimeout(() => finish(failure(reason)), reason === 'timeout' ? 0 : CANCEL_GRACE_MS);
  };

  try {
    port = chrome.runtime.connectNative(COMPANION_HOST);
  } catch (err) {
    finish(failure(classifyNativeError(String((err as Error)?.message ?? err))));
    return { result, cancel: () => undefined };
  }

  port.onMessage.addListener((msg: unknown) => {
    if (!isCompanionReply(msg) || msg.id !== id) return;
    if (msg.type === 'authUrl') {
      opts.onAuthUrl?.(msg.url);
      return;
    }
    if (msg.ok) finish(msg);
    else finish(failure(msg.error, msg.message));
  });
  port.onDisconnect.addListener(() => {
    finish(failure(classifyNativeError(chrome.runtime.lastError?.message)));
  });
  timer = setTimeout(() => sendCancel('timeout'), opts.timeoutMs);
  port.postMessage({ ...call, id });

  return { result, cancel: () => sendCancel('cancelled') };
}
