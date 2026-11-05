/**
 * MV3 service worker. Owns the lifecycle of the ONE offscreen document that hosts Harper:
 * created lazily on the first check, closed when the document reports it has been idle.
 * Holds no long-lived state of its own (Chrome may terminate it after ~30 s idle).
 */
import type { CheckOptions } from '@grammarme/core';
import { AI_CHECK_TIMEOUT_MS, SIGN_IN_TIMEOUT_MS } from '@grammarme/core/companion';
import {
  AI_READY_KEY,
  AI_SIGNIN_KEY,
  isAiRequest,
  isContentAiRequest,
  type AiCheckRequest,
  type AiCheckResponse,
  type AiModelsResponse,
  type AiRequest,
  type AiSimpleResponse,
  type AiStatusResponse,
  type SignInState,
} from './ai-protocol.ts';
import { callCompanion, failure, hasNativePermission, type CallHandle, type CallResult } from './companion-client.ts';
import {
  isBackgroundRequest,
  normalizeWord,
  validateCheck,
  type AddWordsRequest,
  type CheckRequest,
  type CheckResponse,
  type LintRequest,
} from './protocol.ts';
import {
  DICTIONARY_KEY,
  SETTINGS_KEY,
  addToDictionary,
  isActiveOn,
  normalizeDictionary,
  normalizeSettings,
} from './settings.ts';

const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_JUSTIFICATION =
  'Runs the Harper grammar engine (WebAssembly) once for the whole browser so text is checked locally, ' +
  'without one engine copy per tab.';

/** False after this worker starts or after the document is (re)created: next lint sends the full dictionary. */
let dictionarySynced = false;
let inFlight = 0;
let lastActivity = 0;
let lifecycle: Promise<unknown> = Promise.resolve();

/** Serialise create/close so two tabs can't race to create two documents. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn);
  lifecycle = run.catch(() => undefined);
  return run;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

function ensureOffscreen(): Promise<void> {
  return locked(async () => {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      // There is no "WASM" reason. WORKERS is the closest truthful fit: the document exists only as
      // a background compute host (a worker-like context) for the engine. See docs/extension.md.
      reasons: ['WORKERS'],
      justification: OFFSCREEN_JUSTIFICATION,
    });
    dictionarySynced = false;
  });
}

function closeOffscreenIfIdle(): Promise<void> {
  return locked(async () => {
    if (inFlight > 0 || Date.now() - lastActivity < 30_000) return; // a check just arrived — keep it
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    dictionarySynced = false;
  });
}

async function loadDictionary(): Promise<string[]> {
  const got = await chrome.storage.local.get(DICTIONARY_KEY);
  return normalizeDictionary(got[DICTIONARY_KEY]);
}

async function handleCheck(req: CheckRequest, sender: chrome.runtime.MessageSender): Promise<CheckResponse> {
  const { version } = req;
  const invalid = validateCheck(req);
  if (invalid) return { ok: false, version, error: invalid };
  const settings = normalizeSettings((await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY]);
  // Defence in depth: the content script already checks this before sending.
  let host = '';
  try {
    host = sender.url ? new URL(sender.url).hostname : '';
  } catch {
    host = '';
  }
  if (!isActiveOn(settings, host)) return { ok: false, version, error: 'disabled' };

  const options: CheckOptions = { dialect: settings.dialect };
  inFlight++;
  lastActivity = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      await ensureOffscreen();
      const addWords = dictionarySynced ? undefined : await loadDictionary();
      const lint: LintRequest = { target: 'offscreen', type: 'lint', text: req.text, version, options, addWords };
      try {
        const res = (await chrome.runtime.sendMessage(lint)) as CheckResponse | undefined;
        if (!res) throw new Error('No response from offscreen document');
        if (res.ok && addWords) dictionarySynced = true;
        return res;
      } catch (err) {
        // The document may have been closed between ensureOffscreen() and sendMessage(); retry once.
        if (attempt >= 1) throw err;
      }
    }
  } catch (err) {
    return { ok: false, version, error: 'engine_error', message: String(err) };
  } finally {
    inFlight--;
    lastActivity = Date.now();
  }
}

async function handleAddWord(word: string): Promise<void> {
  const w = normalizeWord(word);
  if (!w) return;
  const list = await loadDictionary();
  const next = addToDictionary(list, w);
  if (!next) return;
  await chrome.storage.local.set({ [DICTIONARY_KEY]: next });
  // Push to a running engine; if none is running, the full list is sent when one is created.
  if (dictionarySynced && (await hasOffscreenDocument())) {
    const msg: AddWordsRequest = { target: 'offscreen', type: 'addWords', words: [w] };
    await chrome.runtime.sendMessage(msg).catch(() => {
      dictionarySynced = false;
    });
  }
}

/* ------------------------------------------------------------------ optional ChatGPT (companion) */

/**
 * nativeMessaging is an optional permission. When the user grants it, a service worker that was
 * already running may not get chrome.runtime.connectNative until it restarts, and an open popup
 * polling every few seconds keeps it from ever going idle. Restart the extension once in that
 * case; the popup closes and the next one finds the companion.
 */
function nativeApiMissing(): boolean {
  return typeof chrome.runtime.connectNative !== 'function';
}
chrome.permissions.onAdded.addListener((p) => {
  if (p.permissions?.includes('nativeMessaging') && nativeApiMissing()) chrome.runtime.reload();
});

const QUICK_TIMEOUT_MS = 20_000;
let signIn: CallHandle | null = null;
/** One AI check per tab at a time; keyed by tab id. */
const checks = new Map<number, { requestId: string; handle: CallHandle }>();

async function setReady(ready: boolean): Promise<void> {
  await chrome.storage.local.set({ [AI_READY_KEY]: { ready } });
}

async function setSignIn(state: SignInState | null): Promise<void> {
  if (state) await chrome.storage.session.set({ [AI_SIGNIN_KEY]: state });
  else await chrome.storage.session.remove(AI_SIGNIN_KEY);
}

/** Losing the session or the plan permission means the in-page AI button should disappear. */
async function noteResult(r: CallResult): Promise<void> {
  if (!r.ok && (r.error === 'not_connected' || r.error === 'reauth_required' || r.error === 'permission_required')) {
    await setReady(false);
  }
}

async function quick(call: Parameters<typeof callCompanion>[0]): Promise<CallResult> {
  if (!(await hasNativePermission())) return failure('permission_missing');
  const r = await callCompanion(call, { timeoutMs: QUICK_TIMEOUT_MS }).result;
  await noteResult(r);
  return r;
}

async function aiStatus(): Promise<AiStatusResponse> {
  const permission = await hasNativePermission();
  const signingIn = signIn !== null;
  if (!permission) return { ok: true, permission, companion: false, signingIn };
  if (nativeApiMissing()) {
    // Granted, but this worker started before the grant (see above): restart to pick it up.
    setTimeout(() => chrome.runtime.reload(), 200);
    return { ok: true, permission, companion: false, signingIn, error: 'interrupted', message: 'Finishing setup: GrammarMe is restarting. Open this menu again.' };
  }
  const r = await quick({ type: 'status' });
  if (!r.ok) {
    const companion = !['companion_missing', 'companion_forbidden', 'interrupted', 'permission_missing'].includes(r.error);
    return { ok: true, permission, companion, signingIn, error: r.error, message: r.message };
  }
  const status = r.status;
  await setReady(Boolean(status?.connected && status.account?.planUsage));
  return { ok: true, permission, companion: true, status, signingIn };
}

async function aiConnect(): Promise<AiSimpleResponse> {
  if (!(await hasNativePermission())) return failure('permission_missing');
  if (signIn) return { ok: true };
  await setSignIn({ state: 'waiting', at: Date.now() });
  const handle = callCompanion(
    { type: 'signIn' },
    {
      // A little longer than the companion's own 10-minute limit, so its answer wins.
      timeoutMs: SIGN_IN_TIMEOUT_MS + 30_000,
      // OpenAI's authorization page, opened in a normal tab. isCompanionReply() only accepts
      // https://auth.openai.com/ URLs here.
      onAuthUrl: (url) => void chrome.tabs.create({ url }),
    },
  );
  signIn = handle;
  void handle.result.then(async (r) => {
    signIn = null;
    if (r.ok) {
      const planUsage = Boolean(r.status?.account?.planUsage);
      await setReady(Boolean(r.status?.connected && planUsage));
      await setSignIn(
        planUsage
          ? { state: 'done', at: Date.now() }
          : { state: 'error', error: 'permission_required', message: failure('permission_required').message, at: Date.now() },
      );
    } else {
      await noteResult(r);
      await setSignIn({ state: 'error', error: r.error, message: r.message, at: Date.now() });
    }
  });
  return { ok: true };
}

async function aiDisconnect(): Promise<AiSimpleResponse> {
  signIn?.cancel();
  const r = await quick({ type: 'signOut' });
  await setReady(false);
  await setSignIn(null);
  return r.ok ? { ok: true, revoked: r.revoked } : r;
}

async function aiModels(): Promise<AiModelsResponse> {
  const r = await quick({ type: 'models' });
  if (!r.ok) return r;
  const st = await quick({ type: 'status' });
  return { ok: true, models: r.models ?? [], selected: st.ok ? st.status?.model : undefined };
}

async function aiCheck(req: AiCheckRequest, sender: chrome.runtime.MessageSender): Promise<AiCheckResponse> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return failure('bad_request');
  const settings = normalizeSettings((await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY]);
  let host = '';
  try {
    host = sender.url ? new URL(sender.url).hostname : '';
  } catch {
    host = '';
  }
  if (!isActiveOn(settings, host)) return failure('disabled');
  if (checks.has(tabId)) return failure('busy');
  if (!(await hasNativePermission())) return failure('permission_missing');

  // The user pressed the button for this exact text; nothing is sent while typing.
  const handle = callCompanion(
    { type: 'check', task: req.task, mode: req.mode, text: req.text },
    { timeoutMs: AI_CHECK_TIMEOUT_MS + 5_000 },
  );
  checks.set(tabId, { requestId: req.requestId, handle });
  try {
    const r = await handle.result;
    await noteResult(r);
    if (!r.ok) return r;
    if (!r.check) return failure('provider_error');
    return { ok: true, edits: r.check.edits, dropped: r.check.dropped, model: r.check.model };
  } finally {
    checks.delete(tabId);
  }
}

function aiCancel(requestId: string, sender: chrome.runtime.MessageSender): void {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  const running = checks.get(tabId);
  if (running?.requestId === requestId) running.handle.cancel();
}

function handleAi(msg: AiRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Content scripts (which run inside web pages) may only check and cancel; account management is
  // for the extension's own pages. Decide by the sender's URL, not by whether it has a tab: the
  // popup can be opened in a tab too.
  const fromExtensionPage = (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
  if (!fromExtensionPage && !isContentAiRequest(msg)) return Promise.resolve(failure('bad_request'));
  switch (msg.type) {
    case 'aiStatus':
      return aiStatus();
    case 'aiConnect':
      return aiConnect();
    case 'aiCancelConnect':
      signIn?.cancel();
      return Promise.resolve({ ok: true });
    case 'aiDisconnect':
      return aiDisconnect();
    case 'aiModels':
      return aiModels();
    case 'aiSetModel':
      return quick({ type: 'setModel', model: msg.model }).then((r) => (r.ok ? { ok: true } : r));
    case 'aiTest':
      return quick({ type: 'test' }).then((r) => (r.ok ? { ok: true, latencyMs: r.latencyMs } : r));
    case 'aiCheck':
      return aiCheck(msg, sender);
    case 'aiCancel':
      aiCancel(msg.requestId, sender);
      return Promise.resolve({ ok: true });
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (isAiRequest(msg)) {
    void handleAi(msg, sender).then(sendResponse, (err: unknown) => sendResponse(failure('internal', String(err))));
    return true;
  }
  if (!isBackgroundRequest(msg)) return false;
  switch (msg.type) {
    case 'check':
      void handleCheck(msg, sender).then(sendResponse);
      return true; // async response
    case 'addWord':
      void handleAddWord(msg.word).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    case 'offscreenIdle':
      if (!sender.tab) void closeOffscreenIfIdle();
      return false;
  }
});
