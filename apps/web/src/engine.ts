import { WorkerLinter } from 'harper.js';
import { binary } from 'harper.js/binary';
import { HarperEngine } from '@grammarme/core/harper';

let engine: HarperEngine | null = null;

/**
 * One Harper instance per page, running in a Web Worker so linting never blocks typing.
 * The 20 MB WASM is fetched once and cached by the browser.
 */
export function getEngine(): HarperEngine {
  engine ??= new HarperEngine(new WorkerLinter({ binary }));
  return engine;
}
