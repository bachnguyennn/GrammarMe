/**
 * The example paragraph must show off mistakes the engine really catches, in every dialect, and
 * accepting each top fix must leave a clean paragraph. Runs the real Harper WASM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HarperEngine } from '../../../packages/core/src/harper.ts';
import { resolveOverlaps } from '../../../packages/core/src/suggestions.ts';
import type { Dialect } from '../../../packages/core/src/types.ts';
import { createNodeLinter } from '../../../packages/core/test/support/harper-node.ts';
import { SAMPLE, SAMPLE_FIXED } from '../src/sample.ts';

const DIALECTS: Dialect[] = ['american', 'british', 'canadian', 'australian', 'indian'];
let engine: HarperEngine;

beforeAll(async () => {
  engine = new HarperEngine(createNodeLinter());
  await engine.check({ text: '', version: 0 });
}, 60_000);
afterAll(async () => {
  await engine?.dispose?.();
});

describe('editor example paragraph', () => {
  for (const dialect of DIALECTS) {
    it(`flags the five planted mistakes and fixes cleanly (${dialect})`, async () => {
      const opts = { dialect, disabledRules: [] as string[] };
      const first = resolveOverlaps(await engine.check({ text: SAMPLE, version: 0 }, opts));
      expect(first.map((s) => s.original)).toEqual(['Its', 'Their', 'recieve', 'a', 'sentense']);

      let text = SAMPLE;
      for (let v = 1; v < 10; v++) {
        const list = resolveOverlaps(await engine.check({ text, version: v }, opts));
        if (!list.length) break;
        const s = list[0]!;
        text = text.slice(0, s.start) + (s.replacements[0] ?? '') + text.slice(s.end);
      }
      expect(text).toBe(SAMPLE_FIXED);
      expect(await engine.check({ text, version: 99 }, opts)).toEqual([]);
    }, 30_000);
  }
});
