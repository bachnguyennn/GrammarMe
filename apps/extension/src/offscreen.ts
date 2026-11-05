/**
 * Offscreen document: the single Harper instance for the whole browser.
 *
 * Uses `LocalLinter` (not `WorkerLinter`, whose blob: worker is blocked by the extension CSP) with
 * the WASM shipped in the extension package. The binary is renamed to `harper.wasm` on purpose:
 * harper.js 3.0.0 also loads the *slim* binary whenever the URL contains "harper_wasm_bg.wasm",
 * which costs ~50 MB extra RSS (measured in Node) for identical results.
 *
 * Offscreen documents only get `chrome.runtime`, so settings/dictionary arrive in messages.
 */
import { HarperEngine } from '@grammarme/core/harper';
import { LocalLinter, createBinaryModuleFromUrl } from 'harper.js';
import { createIdleTimer } from './idle.ts';
import {
  OFFSCREEN_IDLE_MS,
  isOffscreenRequest,
  type CheckResponse,
  type OffscreenIdleNotice,
  type OffscreenRequest,
} from './protocol.ts';

let engine: HarperEngine | null = null;
function getEngine(): HarperEngine {
  engine ??= new HarperEngine(
    new LocalLinter({ binary: createBinaryModuleFromUrl(chrome.runtime.getURL('harper.wasm'), 'full') }),
  );
  return engine;
}

const idle = createIdleTimer(OFFSCREEN_IDLE_MS, () => {
  const notice: OffscreenIdleNotice = { target: 'background', type: 'offscreenIdle' };
  // Wakes the service worker, which closes this document and frees all of Harper's memory.
  chrome.runtime.sendMessage(notice).catch(() => undefined);
});

/** One job at a time: the engine is configured per request (dialect), so jobs must not interleave. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Every personal-dictionary word imported so far. harper.js 3.0.0's `LocalLinter.setDialect`
 * rebuilds the linter and silently drops imported words, so after a dialect change we apply the
 * dialect first and then re-import these (workaround; see "Required core changes" in docs).
 */
const words = new Set<string>();
let appliedDialect: string | undefined;

async function handle(msg: OffscreenRequest): Promise<CheckResponse | { ok: boolean }> {
  const eng = getEngine();
  if (msg.type === 'addWords') {
    for (const w of msg.words) words.add(w);
    if (msg.words.length) await eng.addWords(msg.words);
    return { ok: true };
  }
  try {
    for (const w of msg.addWords ?? []) words.add(w);
    if (msg.options.dialect !== appliedDialect) {
      await eng.check({ text: '', version: 0 }, msg.options); // applies the dialect (cheap: empty text)
      appliedDialect = msg.options.dialect;
      if (words.size) await eng.addWords([...words]);
    } else if (msg.addWords?.length) {
      await eng.addWords(msg.addWords);
    }
    const suggestions = await eng.check({ text: msg.text, version: msg.version }, msg.options);
    return { ok: true, version: msg.version, suggestions };
  } catch (err) {
    return { ok: false, version: msg.version, error: 'engine_error', message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Only the service worker talks to us; content-script broadcasts (sender.tab set) are ignored.
  if (sender.id !== chrome.runtime.id || sender.tab || !isOffscreenRequest(msg)) return false;
  idle.touch();
  const job = queue.then(() => handle(msg));
  queue = job.catch(() => undefined);
  job.then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: 'engine_error', message: String(err) }));
  return true;
});

idle.touch();
