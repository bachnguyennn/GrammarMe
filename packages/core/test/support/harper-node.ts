/**
 * Load a real harper.js LocalLinter in Node (tests + eval harness).
 *
 * Why not just `createBinaryModuleFromUrl(pathToFileURL(wasm).href)`?
 * harper.js 3.0.0 reads file URLs with `fs.readFile(new URL(binary).pathname)`, which does NOT
 * percent-decode. Any install path containing a space (e.g. ".../Data Engineer Project/...")
 * becomes ".../Data%20Engineer%20Project/..." and fails with ENOENT.
 *
 * Strategy, in order:
 *   1. `GRAMMARME_HARPER_WASM` env override (benchmarks / CI).
 *   2. The installed wasm, if its file URL round-trips unchanged.
 *   3. A copy in os.tmpdir() (both the full and the slim glue wasm, which harper loads side by side).
 *      Measured on an M1 Pro: ~0.58 s setup / ~380 MB RSS, vs ~1.0 s / ~650 MB for option 4.
 *   4. A `data:` URL of the bytes (same mechanism as `harper.js/binaryInlined`).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalLinter, createBinaryModuleFromUrl } from 'harper.js';

const FULL = 'harper_wasm_bg.wasm';
const SLIM = 'harper_wasm_slim_bg.wasm';

export function harperWasmPath(): string {
  if (process.env.GRAMMARME_HARPER_WASM) return process.env.GRAMMARME_HARPER_WASM;
  const entry = fileURLToPath(import.meta.resolve('harper.js'));
  return join(dirname(entry), FULL);
}

/** True if harper.js can open this path through a file URL (i.e. nothing gets percent-encoded). */
const loadableAsFileUrl = (path: string) => new URL(pathToFileURL(path).href).pathname === path;

function copyToTmp(wasm: string): string | null {
  try {
    const src = dirname(wasm);
    const { size, mtimeMs } = statSync(wasm);
    const dir = join(tmpdir(), `grammarme-harper-${size}-${Math.round(mtimeMs)}`);
    const target = join(dir, FULL);
    if (!loadableAsFileUrl(target)) return null;
    mkdirSync(dir, { recursive: true });
    for (const name of [FULL, SLIM]) {
      const from = join(src, name);
      const to = join(dir, name);
      if (!existsSync(from)) continue;
      if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
      const partial = `${to}.${process.pid}.part`; // atomic: parallel workers never see half a file
      copyFileSync(from, partial);
      renameSync(partial, to);
    }
    return target;
  } catch {
    return null;
  }
}

/** URL harper.js can actually load on this machine, plus which strategy produced it. */
export function harperBinary(): { url: string; mode: 'file-url' | 'tmp-copy' | 'data-url' } {
  const wasm = harperWasmPath();
  if (loadableAsFileUrl(wasm)) return { url: pathToFileURL(wasm).href, mode: 'file-url' };
  const copy = copyToTmp(wasm);
  if (copy) return { url: pathToFileURL(copy).href, mode: 'tmp-copy' };
  return { url: `data:application/wasm;base64,${readFileSync(wasm).toString('base64')}`, mode: 'data-url' };
}

export function harperBinaryUrl(): string {
  return harperBinary().url;
}

/** A fresh, not-yet-set-up LocalLinter. HarperEngine calls `setup()` itself. */
export function createNodeLinter(): LocalLinter {
  return new LocalLinter({ binary: createBinaryModuleFromUrl(harperBinaryUrl()) });
}
