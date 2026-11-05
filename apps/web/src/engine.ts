import { WorkerLinter } from 'harper.js';
import { binary } from 'harper.js/binary';
import { HarperEngine } from '@grammarme/core/harper';
import type { CheckOptions, DocumentSnapshot, Suggestion } from '@grammarme/core';

/** How long the first load may take before we say it failed (the WASM is ~9 MB compressed). */
const FIRST_LOAD_TIMEOUT_MS = 120_000;

let engine: HarperEngine | null = null;
let reachable: Promise<void> | null = null;
let loaded = false;

/**
 * harper.js downloads the WASM inside its worker, and a failed download there never rejects: the
 * page would say "Loading…" forever. So the page first checks that the file can be reached (a HEAD
 * request; the real download is then served from the HTTP cache or fetched by the worker) and the
 * first check gets a time limit. Either failure surfaces as "Couldn't load the checker".
 */
function ensureReachable(): Promise<void> {
  reachable ??= fetch(typeof binary.url === 'string' ? binary.url : binary.url.href, { method: 'HEAD' })
    .then((res) => {
      if (!res.ok) throw new Error(`checker download failed (HTTP ${res.status})`);
    })
    .catch((err: unknown) => {
      reachable = null; // let a later attempt try again
      throw err;
    });
  return reachable;
}

function withFirstLoadLimit<T>(work: Promise<T>): Promise<T> {
  if (loaded) return work;
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('checker took too long to load')), FIRST_LOAD_TIMEOUT_MS);
    work.then(
      (v) => {
        loaded = true;
        window.clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function ready(): Promise<HarperEngine> {
  await ensureReachable();
  // One Harper instance per page, in a Web Worker so linting never blocks typing.
  engine ??= new HarperEngine(new WorkerLinter({ binary }));
  return engine;
}

export function getEngine() {
  return {
    async check(doc: DocumentSnapshot, options: CheckOptions): Promise<Suggestion[]> {
      const e = await ready();
      return withFirstLoadLimit(e.check(doc, options));
    },
    async setDictionary(words: string[]): Promise<void> {
      const e = await ready();
      await withFirstLoadLimit(e.setDictionary(words));
    },
  };
}
