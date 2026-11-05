/**
 * MV3 service worker. Owns the lifecycle of the ONE offscreen document that hosts Harper:
 * created lazily on the first check, closed when the document reports it has been idle.
 * Holds no long-lived state of its own (Chrome may terminate it after ~30 s idle).
 */
import type { CheckOptions } from '@grammarme/core';
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

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(msg)) return false;
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
