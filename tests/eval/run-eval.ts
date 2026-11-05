/**
 * GrammarMe evaluation harness.
 *
 *   node --experimental-strip-types tests/eval/run-eval.ts [--engine harper] [--dialect american]
 *        [--disable RuleA,RuleB] [--passes 5] [--dataset tests/eval/dataset.jsonl] [--out path.json]
 *
 * Runs a SuggestionEngine over tests/eval/dataset.jsonl and reports error-level precision / recall / F1
 * (overall + per category), correct-fix rate, false-positive rate on correct sentences, per-rule
 * breakdown, latency percentiles, setup time and RSS. Writes tests/eval/results/<engine>-latest.json.
 *
 * Plugging in another engine (e.g. the AI worker client): add an entry to ENGINES that returns any
 * object implementing `SuggestionEngine` from packages/core/src/types.ts. Nothing else changes.
 *
 * This file must stay "strip-only" TypeScript (no enums, namespaces or constructor parameter
 * properties) so Node can run it without a build step.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckOptions, Dialect, Suggestion, SuggestionEngine } from '../../packages/core/src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const rssAtStart = process.memoryUsage();

/* ------------------------------------------------------------------ dataset */

export type EvalCategory = 'spelling' | 'punctuation' | 'agreement' | 'tense' | 'article' | 'word-choice' | 'awkward' | 'correct';

export interface EvalExample {
  id: string;
  category: EvalCategory;
  input: string;
  expected: string;
  errors: { original: string; replacement: string }[];
}

interface Span {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

const isWordCh = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Locate each expected error in `input`, left to right. A candidate position is accepted only if the
 * untouched text between errors is identical in `input` and `expected` — so "a" in "I waited for a hour"
 * resolves to the article, not the "a" inside "waited". Throws if the row is inconsistent.
 */
export function alignErrors(ex: EvalExample): Span[] {
  const spans: Span[] = [];
  let ci = 0;
  let co = 0;
  for (const err of ex.errors) {
    let found = -1;
    for (let i = ex.input.indexOf(err.original, ci); i !== -1; i = ex.input.indexOf(err.original, i + 1)) {
      const j = i + err.original.length;
      const cutsWord =
        (isWordCh(err.original[0]) && isWordCh(ex.input[i - 1])) || (isWordCh(err.original.at(-1)) && isWordCh(ex.input[j]));
      if (cutsWord) continue;
      const gap = ex.input.slice(ci, i);
      if (ex.expected.startsWith(gap, co) && ex.expected.startsWith(err.replacement, co + gap.length)) {
        found = i;
        break;
      }
    }
    if (found === -1) throw new Error(`${ex.id}: cannot align error ${JSON.stringify(err)}`);
    const gapLen = found - ci;
    spans.push({ start: found, end: found + err.original.length, ...err });
    co += gapLen + err.replacement.length;
    ci = found + err.original.length;
  }
  if (ex.input.slice(ci) !== ex.expected.slice(co)) throw new Error(`${ex.id}: errors do not turn input into expected`);
  return spans;
}

export function loadDataset(path: string): EvalExample[] {
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, n) => {
      try {
        return JSON.parse(l) as EvalExample;
      } catch {
        throw new Error(`dataset line ${n + 1}: invalid JSON`);
      }
    });
  const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r.id)) throw new Error(`duplicate id ${r.id}`);
    ids.add(r.id);
    if (r.category === 'correct' && (r.errors.length || r.expected !== r.input)) throw new Error(`${r.id}: correct row has errors`);
    if (r.category !== 'correct' && !r.errors.length) throw new Error(`${r.id}: no errors listed`);
    alignErrors(r);
  }
  return rows;
}

/* ------------------------------------------------------------------ engines */

interface LoadedEngine {
  engine: SuggestionEngine;
  /** Free-form facts recorded in the results file (versions, loader mode, ...). */
  meta: Record<string, unknown>;
  dispose?: () => Promise<void>;
}

/** Engine registry. Each loader must fully initialise the engine before resolving. */
const ENGINES: Record<string, () => Promise<LoadedEngine>> = {
  harper: async () => {
    const { HarperEngine } = await importHarperAdapter();
    const { harperBinary } = await import('../../packages/core/test/support/harper-node.ts');
    const { LocalLinter, createBinaryModuleFromUrl } = await import('harper.js');
    const binary = harperBinary(); // resolved once: see harper-node.ts for why paths with spaces need care
    const engine = new HarperEngine(new LocalLinter({ binary: createBinaryModuleFromUrl(binary.url) }));
    await engine.check({ text: '', version: 0 }); // resolves only after linter.setup()
    const pkg = JSON.parse(readFileSync(join(REPO, 'node_modules/harper.js/package.json'), 'utf8')) as { version: string };
    return {
      engine,
      meta: { harperJs: pkg.version, wasmLoader: binary.mode },
      dispose: () => engine.dispose(),
    };
  },
  // ai: async () => ({ engine: new AiEngineClient({ endpoint, mode: 'standard' }), meta: { model } }),
};

/**
 * packages/core/src/harper.ts currently uses a constructor parameter property, which Node's strip-only
 * TypeScript mode rejects (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). Until that is fixed in core, re-run this
 * script once with --experimental-transform-types so the documented command keeps working.
 */
async function importHarperAdapter(): Promise<typeof import('../../packages/core/src/harper.ts')> {
  try {
    return await import('../../packages/core/src/harper.ts');
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' && !process.env.GRAMMARME_EVAL_REEXEC) {
      console.warn(
        '[eval] packages/core/src/harper.ts is not strip-only TypeScript (parameter property). ' +
          'Re-running with --experimental-transform-types.',
      );
      const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: { ...process.env, GRAMMARME_EVAL_REEXEC: '1' },
      });
      process.exit(r.status ?? 1);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ scoring */

const overlaps = (f: { start: number; end: number }, e: Span) =>
  f.start === f.end ? f.start >= e.start && f.start <= e.end : f.start < e.end && e.start < f.end;

/** The flag's top replacement fixes `e` iff applying it alone yields the same sentence as applying `e` alone. */
function fixes(input: string, f: Suggestion, e: Span): boolean {
  const top = f.replacements[0];
  if (top === undefined) return false;
  return input.slice(0, f.start) + top + input.slice(f.end) === input.slice(0, e.start) + e.replacement + input.slice(e.end);
}

function applyAllTop(input: string, flags: Suggestion[]): string {
  let out = input;
  for (const f of [...flags].sort((a, b) => b.start - a.start)) {
    const top = f.replacements[0];
    if (top !== undefined) out = out.slice(0, f.start) + top + out.slice(f.end);
  }
  return out;
}

interface Tally {
  sentences: number;
  flags: number;
  tpFlags: number;
  fpFlags: number;
  expectedErrors: number;
  detected: number;
  correctFix: number;
  sentencesWithFlag: number;
  /** Sentences that contain at least one expected error (denominator for exactSentenceFixRate). */
  errorSentences: number;
  exactSentenceFix: number;
}

const newTally = (): Tally => ({
  sentences: 0,
  flags: 0,
  tpFlags: 0,
  fpFlags: 0,
  expectedErrors: 0,
  detected: 0,
  correctFix: 0,
  sentencesWithFlag: 0,
  errorSentences: 0,
  exactSentenceFix: 0,
});

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

function summarize(t: Tally) {
  const precision = ratio(t.tpFlags, t.flags);
  const recall = ratio(t.detected, t.expectedErrors);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return {
    ...t,
    precision,
    recall,
    f1,
    correctFixRate: ratio(t.correctFix, t.detected),
    autoFixRecall: ratio(t.correctFix, t.expectedErrors),
    sentenceFlagRate: ratio(t.sentencesWithFlag, t.sentences),
    exactSentenceFixRate: ratio(t.exactSentenceFix, t.errorSentences),
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

function latencyStats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { samples: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), mean, max: s.at(-1) ?? NaN };
}

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
const memSnapshot = (m: NodeJS.MemoryUsage) => ({ rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), externalMB: mb(m.external), arrayBuffersMB: mb(m.arrayBuffers) });

/* ------------------------------------------------------------------ main */

interface Args {
  engine: string;
  dialect: Dialect;
  disable: string[];
  passes: number;
  dataset: string;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { engine: 'harper', dialect: 'american', disable: [], passes: 5, dataset: join(HERE, 'dataset.jsonl'), out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (v === undefined) break;
    if (k === '--engine') a.engine = v;
    else if (k === '--dialect') a.dialect = v as Dialect;
    else if (k === '--disable') a.disable = v.split(',').filter(Boolean);
    else if (k === '--passes') a.passes = Math.max(1, Number(v));
    else if (k === '--dataset') a.dataset = resolve(v);
    else if (k === '--out') a.out = resolve(v);
    else continue;
    i++;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const load = ENGINES[args.engine];
  if (!load) throw new Error(`unknown engine "${args.engine}" (known: ${Object.keys(ENGINES).join(', ')})`);
  const dataset = loadDataset(args.dataset);
  const options: CheckOptions = { dialect: args.dialect, disabledRules: args.disable };

  const memBefore = process.memoryUsage();
  const t0 = performance.now();
  const loaded = await load();
  const setupMs = performance.now() - t0;
  const memAfterSetup = process.memoryUsage();
  const { engine } = loaded;

  // Pass 0: accuracy (also warms up). Passes 1..N: latency only.
  let version = 1;
  const results = new Map<string, Suggestion[]>();
  for (const ex of dataset) {
    const out = await engine.check({ text: ex.input, version: version++ }, options);
    results.set(ex.id, out);
  }
  const latencies: number[] = [];
  let deterministic = true;
  for (let p = 0; p < args.passes; p++) {
    for (const ex of dataset) {
      const t = performance.now();
      const out = await engine.check({ text: ex.input, version: version++ }, options);
      latencies.push(performance.now() - t);
      const first = results.get(ex.id)!;
      const same = (s: Suggestion, f: Suggestion | undefined) => !!f && s.start === f.start && s.rule === f.rule && s.replacements[0] === f.replacements[0];
      if (out.length !== first.length || out.some((s, i) => !same(s, first[i]))) deterministic = false;
    }
  }
  // Whole-document latency: every input joined as one ~1.4k-word document.
  const longDoc = dataset.map((e) => e.input).join(' ');
  const longSamples: number[] = [];
  for (let p = 0; p < Math.max(3, args.passes); p++) {
    const t = performance.now();
    await engine.check({ text: longDoc, version: version++ }, options);
    longSamples.push(performance.now() - t);
  }
  const memAfterEval = process.memoryUsage();

  // Scoring
  const overall = newTally();
  const perCategory = new Map<string, Tally>();
  const perRule = new Map<string, { flags: number; tp: number; fp: number; fpOnCorrect: number; correctFix: number }>();
  const correctSubsets = new Map<string, { sentences: number; flagged: number }>();
  const falsePositives: unknown[] = [];
  const misses: unknown[] = [];
  const wrongFixes: unknown[] = [];
  const perExample: unknown[] = [];

  for (const ex of dataset) {
    const flags = results.get(ex.id)!;
    const spans = alignErrors(ex);
    const cat = perCategory.get(ex.category) ?? newTally();
    perCategory.set(ex.category, cat);
    const tallies = [overall, cat];
    const bump = (k: keyof Tally, n = 1) => tallies.forEach((t) => (t[k] += n));

    bump('sentences');
    bump('flags', flags.length);
    bump('expectedErrors', spans.length);
    if (flags.length) bump('sentencesWithFlag');
    if (spans.length) {
      bump('errorSentences');
      if (applyAllTop(ex.input, flags) === ex.expected) bump('exactSentenceFix');
    }

    for (const f of flags) {
      const r = perRule.get(f.rule) ?? { flags: 0, tp: 0, fp: 0, fpOnCorrect: 0, correctFix: 0 };
      perRule.set(f.rule, r);
      r.flags++;
      const hit = spans.filter((e) => overlaps(f, e));
      if (hit.length) {
        bump('tpFlags');
        r.tp++;
        if (hit.some((e) => fixes(ex.input, f, e))) r.correctFix++;
      } else {
        bump('fpFlags');
        r.fp++;
        if (ex.category === 'correct') r.fpOnCorrect++;
        falsePositives.push({ id: ex.id, category: ex.category, input: ex.input, flagged: f.original, rule: f.rule, category_: f.category, replacements: f.replacements, message: f.message });
      }
    }
    const exampleMisses: string[] = [];
    for (const e of spans) {
      const hits = flags.filter((f) => overlaps(f, e));
      if (!hits.length) {
        exampleMisses.push(e.original);
        misses.push({ id: ex.id, category: ex.category, input: ex.input, original: e.original, expected: e.replacement });
        continue;
      }
      bump('detected');
      if (hits.some((f) => fixes(ex.input, f, e))) bump('correctFix');
      else wrongFixes.push({ id: ex.id, input: ex.input, original: e.original, expected: e.replacement, got: hits.map((f) => ({ flagged: f.original, rule: f.rule, top: f.replacements[0] ?? null })) });
    }
    if (ex.category === 'correct') {
      const sub = ex.id.split('-')[1] ?? 'other';
      const c = correctSubsets.get(sub) ?? { sentences: 0, flagged: 0 };
      correctSubsets.set(sub, c);
      c.sentences++;
      if (flags.length) c.flagged++;
    }
    perExample.push({ id: ex.id, category: ex.category, flags: flags.map((f) => ({ s: f.start, e: f.end, o: f.original, rule: f.rule, top: f.replacements[0] ?? null })), missed: exampleMisses });
  }

  const report = {
    meta: {
      date: new Date().toISOString(),
      engine: engine.source === 'harper' ? args.engine : `${args.engine} (${engine.source})`,
      ...loaded.meta,
      options,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      totalMemGB: Math.round(totalmem() / 1024 ** 3),
      dataset: { path: args.dataset.replace(`${REPO}/`, ''), examples: dataset.length, expectedErrors: overall.expectedErrors },
      latencyPasses: args.passes,
      deterministicAcrossPasses: deterministic,
    },
    setup: { msToFirstResult: setupMs },
    memory: {
      processStart: memSnapshot(rssAtStart),
      beforeEngineLoad: memSnapshot(memBefore),
      afterSetup: memSnapshot(memAfterSetup),
      afterEval: memSnapshot(memAfterEval),
    },
    latency: { perSentenceMs: latencyStats(latencies), longDocument: { words: longDoc.split(/\s+/).length, chars: longDoc.length, ...latencyStats(longSamples), rawMsInRunOrder: longSamples } },
    overall: summarize(overall),
    perCategory: Object.fromEntries([...perCategory].map(([k, v]) => [k, summarize(v)])),
    correctSubsets: Object.fromEntries([...correctSubsets].map(([k, v]) => [k, { ...v, rate: ratio(v.flagged, v.sentences) }])),
    perRule: Object.fromEntries([...perRule].sort((a, b) => b[1].flags - a[1].flags)),
    falsePositives,
    misses,
    wrongFixes,
    perExample,
  };

  const outPath = args.out ?? join(HERE, 'results', `${args.engine}-latest.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  printSummary(report, outPath);
  await loaded.dispose?.();
}

/* ------------------------------------------------------------------ printing */

const pct = (x: number | null) => (x === null ? '   n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);
const ms = (x: number) => `${x.toFixed(2)} ms`;

function printSummary(r: any, outPath: string) {
  const lines: string[] = [];
  lines.push(`\nGrammarMe eval — engine=${r.meta.engine} dialect=${r.meta.options.dialect} disabled=[${r.meta.options.disabledRules.join(',')}]`);
  lines.push(`${r.meta.dataset.examples} examples, ${r.meta.dataset.expectedErrors} expected errors · ${r.meta.node} ${r.meta.platform} · ${r.meta.cpu}`);
  lines.push('');
  lines.push('category       sents  errs  flags   TP   FP  precision  recall      F1  fix-rate  sent-flag%');
  const row = (name: string, s: any) =>
    `${name.padEnd(13)} ${String(s.sentences).padStart(5)} ${String(s.expectedErrors).padStart(5)} ${String(s.flags).padStart(6)} ${String(s.tpFlags).padStart(4)} ${String(s.fpFlags).padStart(4)}     ${pct(s.precision)}  ${pct(s.recall)}  ${pct(s.f1)}    ${pct(s.correctFixRate)}      ${pct(s.sentenceFlagRate)}`;
  for (const [k, v] of Object.entries(r.perCategory)) lines.push(row(k, v));
  lines.push(row('OVERALL', r.overall));
  const fpr = r.perCategory.correct;
  lines.push('');
  if (fpr) lines.push(`False-positive rate on correct sentences: ${fpr.sentencesWithFlag}/${fpr.sentences} = ${pct(fpr.sentenceFlagRate)}`);
  lines.push(`  by subset: ${Object.entries(r.correctSubsets).map(([k, v]: [string, any]) => `${k} ${v.flagged}/${v.sentences}`).join(' · ')}`);
  lines.push(`Auto-fix recall (detected AND top replacement right / all errors): ${pct(r.overall.autoFixRecall)}; sentences fully fixed by applying every top replacement: ${pct(r.overall.exactSentenceFixRate)} (${r.overall.exactSentenceFix}/${r.overall.errorSentences})`);
  const l = r.latency.perSentenceMs;
  lines.push(`Latency per sentence (${l.samples} checks): p50 ${ms(l.p50)} · p95 ${ms(l.p95)} · p99 ${ms(l.p99)} · max ${ms(l.max)}`);
  const ld = r.latency.longDocument;
  lines.push(`Latency whole dataset as one doc (${ld.words} words): p50 ${ms(ld.p50)} · max ${ms(ld.max)}`);
  lines.push(`Setup to first result: ${ms(r.setup.msToFirstResult)} · RSS ${r.memory.beforeEngineLoad.rssMB} MB → ${r.memory.afterSetup.rssMB} MB after setup → ${r.memory.afterEval.rssMB} MB after eval`);
  lines.push(`Deterministic across passes: ${r.meta.deterministicAcrossPasses}`);
  lines.push('\nTop rules by flags (flags / TP / FP / FP-on-correct):');
  for (const [rule, v] of Object.entries(r.perRule).slice(0, 12) as [string, any][]) lines.push(`  ${rule.padEnd(28)} ${v.flags} / ${v.tp} / ${v.fp} / ${v.fpOnCorrect}`);
  lines.push(`\nWrote ${outPath.replace(`${REPO}/`, '')}`);
  console.log(lines.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
