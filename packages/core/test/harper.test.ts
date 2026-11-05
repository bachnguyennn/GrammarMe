/**
 * End-to-end tests of HarperEngine against the real harper.js 3.0.0 WASM (LocalLinter).
 * Slow-ish: setup ~0.5–1 s per linter and ~400 MB RSS, so one shared engine is used wherever the test
 * does not mutate engine state; state-mutating tests get their own engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HarperEngine } from '../src/harper.ts';
import { applySuggestion } from '../src/suggestions.ts';
import type { DocumentSnapshot, Suggestion } from '../src/types.ts';
import { isWellFormed } from './support/fixtures.ts';
import { createNodeLinter } from './support/harper-node.ts';

const TIMEOUT = 60_000;
let engine: HarperEngine;
const extraEngines: HarperEngine[] = [];

async function freshEngine(): Promise<HarperEngine> {
  const e = new HarperEngine(createNodeLinter());
  extraEngines.push(e);
  await e.check({ text: '', version: 0 }); // wait for setup
  return e;
}

beforeAll(async () => {
  engine = new HarperEngine(createNodeLinter());
  await engine.check({ text: '', version: 0 });
}, TIMEOUT);

afterAll(async () => {
  await Promise.all([engine, ...extraEngines].map((e) => e?.dispose()));
});

const d = (text: string, version = 1): DocumentSnapshot => ({ text, version });
const find = (r: Suggestion[], original: string) => r.find((s) => s.original === original);

/** Contract every Harper result must satisfy, for any input. */
function assertContract(doc: DocumentSnapshot, r: Suggestion[]) {
  for (let i = 0; i < r.length; i++) {
    const s = r[i]!;
    expect(doc.text.slice(s.start, s.end), JSON.stringify(s)).toBe(s.original);
    expect(s.documentVersion).toBe(doc.version);
    expect(s.source).toBe('harper');
    expect(s.id).toMatch(/^harper-/);
    expect(s.replacements.length).toBeLessThanOrEqual(5);
    expect(s.replacements).not.toContain(s.original);
    if (i > 0) expect(s.start).toBeGreaterThanOrEqual(r[i - 1]!.start);
    if (s.replacements.length) {
      const out = applySuggestion(doc, s);
      expect(isWellFormed(out.text)).toBe(true);
    }
  }
}

describe('HarperEngine (real WASM)', { timeout: TIMEOUT }, () => {
  it('returns an empty list for empty and clean text', async () => {
    expect(await engine.check(d(''))).toEqual([]);
    expect(await engine.check(d('This sentence is perfectly fine.'))).toEqual([]);
  });

  it('flags a spelling error with UTF-16 offsets, version stamp and a useful top replacement', async () => {
    const doc = d('I will recieve the package tomorrow.', 42);
    const r = await engine.check(doc);
    assertContract(doc, r);
    const s = find(r, 'recieve')!;
    expect(s).toMatchObject({ start: 7, end: 14, category: 'spelling', rule: 'SpellCheck', documentVersion: 42 });
    expect(s.replacements[0]).toBe('receive');
  });

  it('offsets are UTF-16 after surrogate-pair emoji (😀😀 Their is a problm here.)', async () => {
    const doc = d('😀😀 Their is a problm here.');
    const r = await engine.check(doc);
    assertContract(doc, r);
    expect(r.map((s) => [s.original, s.start, s.end])).toEqual([
      ['Their', 5, 10],
      ['problm', 16, 22],
    ]);
  });

  it('offsets are correct after ZWJ sequences, flags, combining accents, CJK and RTL', async () => {
    const cases: [string, string][] = [
      ['👨‍👩‍👧‍👦 Their is a problm.', 'problm'],
      ['🇻🇳 I has a problm.', 'problm'],
      ['Café is nice but teh food is bad.', 'teh'], // NFD é before the error
      ['Café crème is nice but teh food is bad.', 'teh'], // NFC
      ['日本語 text has a problm here.', 'problm'],
      ['שלום and this is a problm.', 'problm'],
      ['Hello\r\nwrold, this is fine.', 'wrold'],
    ];
    for (const [text, bad] of cases) {
      const doc = d(text);
      const r = await engine.check(doc);
      assertContract(doc, r);
      const s = find(r, bad);
      expect(s, `${bad} in ${JSON.stringify(text)} -> ${JSON.stringify(r.map((x) => x.original))}`).toBeDefined();
      expect(s!.start).toBe(text.indexOf(bad));
    }
  });

  it('flags grammar: agreement, a/an, its/it’s, their/there', async () => {
    const r1 = await engine.check(d('He go to school every day.'));
    expect(find(r1, 'go')?.replacements[0]).toBe('goes');
    const r2 = await engine.check(d('She bought a apple.'));
    expect(find(r2, 'a')?.replacements[0]).toBe('an');
    const r3 = await engine.check(d("The dog wagged it's tail."));
    expect(find(r3, "it's")?.replacements[0]).toBe('its');
    const r4 = await engine.check(d('Their is a problem.'));
    expect(find(r4, 'Their')?.replacements[0]).toBe('There');
  });

  it('every emitted rule id is a real lint-config key (so "ignore rule" can disable it)', async () => {
    const descriptions = await engine.ruleDescriptions();
    const texts = ['He go to school.', 'She bought a apple.', 'Their is a problm.', 'the the cat', "Its a nice day and it's tail wagged."];
    for (const t of texts) {
      for (const s of await engine.check(d(t))) expect(Object.keys(descriptions)).toContain(s.rule);
    }
  });

  it('disabledRules turns a rule off and an empty list turns it back on', async () => {
    const e = await freshEngine();
    const doc = d('This is a problm.');
    expect(find(await e.check(doc), 'problm')).toBeDefined();
    expect(await e.check(doc, { disabledRules: ['SpellCheck'] })).toEqual([]);
    expect(find(await e.check(doc, { disabledRules: [] }), 'problm')).toBeDefined();
    // Unknown rule ids are ignored, not fatal.
    expect(find(await e.check(doc, { disabledRules: ['NoSuchRule'] }), 'problm')).toBeDefined();
  });

  it('dialect: "colour"/"grey" flagged in American, accepted in British; "color" flagged in British', async () => {
    const e = await freshEngine();
    const uk = d('The colour of the sky is grey.');
    const am = await e.check(uk, { dialect: 'american' });
    expect(find(am, 'colour')?.replacements[0]).toBe('color');
    expect(find(am, 'grey')).toBeDefined();
    expect(await e.check(uk, { dialect: 'british' })).toEqual([]);
    expect(find(await e.check(d('The color is nice.'), { dialect: 'british' }), 'color')).toBeDefined();
  });

  it('addWords removes a spelling flag', async () => {
    const e = await freshEngine();
    const doc = d('Zorblaxian is the name of our app.');
    expect(find(await e.check(doc), 'Zorblaxian')).toBeDefined();
    await e.addWords(['Zorblaxian']);
    expect(find(await e.check(doc), 'Zorblaxian')).toBeUndefined();
  });

  it('many concurrent checks with the same options all resolve with correct versions (rapid typing)', async () => {
    // Keep every sentence short — see the LongSentences test below for why.
    const docs = Array.from({ length: 25 }, (_, i) => d(`I recieve mail.${' More text here.'.repeat(i)}`, i));
    const results = await Promise.all(docs.map((doc) => engine.check(doc)));
    results.forEach((r, i) => {
      assertContract(docs[i]!, r);
      expect(find(r, 'recieve')).toBeDefined();
    });
  });

  // Upstream behaviour worth knowing (not a GrammarMe bug): Harper removes overlapping lints, and the
  // explain-only LongSentences lint spans the WHOLE sentence — so once a sentence is long enough (~40+ words)
  // every spelling/grammar lint inside it disappears. Disabling LongSentences brings them back.
  // Recommendation: disable LongSentences in Harper and compute sentence length from stats.ts instead.
  it('LongSentences is off by default, so typos inside a run-on sentence are still flagged', async () => {
    const e = await freshEngine();
    const doc = d(`I recieve mail${' and more'.repeat(24)}.`);
    const result = await e.check(doc);
    expect(result.map((s) => s.rule)).not.toContain('LongSentences');
    expect(find(result, 'recieve')?.rule).toBe('SpellCheck');
  });

  it('never flags code-like tokens or acronyms as misspellings', async () => {
    const doc = d('Call getUserById then deploy to S3 with the ETL job via user_service.py today.');
    const result = await engine.check(doc);
    for (const word of ['getUserById', 'S3', 'ETL', 'user_service.py']) {
      expect(result.find((s) => s.original.includes(word) && s.category === 'spelling')).toBeUndefined();
    }
  });

  it('checks a ~1,000-word document in well under a second (smoke perf bound, generous)', async () => {
    const para = 'The quick brown fox jumps over the lazy dog while the team reviews the quarterly report. ';
    const doc = d(para.repeat(64)); // ~1,000 words
    const t0 = performance.now();
    const r = await engine.check(doc);
    const ms = performance.now() - t0;
    assertContract(doc, r);
    expect(ms).toBeLessThan(5_000);
  });

  // Regression tests for bugs found by QA and fixed in core: harper.js 3.0.0 implements setDialect by
  // freeing the inner WASM linter and building a new one, which drops imported words AND the lint config.
  // HarperEngine now re-imports words and re-applies disabledRules after every dialect change.
  it('personal dictionary survives a dialect switch', async () => {
    const e = await freshEngine();
    await e.addWords(['Zorblaxian']);
    const doc = d('Zorblaxian is the name of our app.');
    expect(find(await e.check(doc, { dialect: 'american' }), 'Zorblaxian')).toBeUndefined();
    expect(find(await e.check(doc, { dialect: 'british' }), 'Zorblaxian')).toBeUndefined();
    expect(find(await e.check(doc, { dialect: 'australian' }), 'Zorblaxian')).toBeUndefined();
  });

  it('disabledRules stay disabled across a dialect switch, and re-enable afterwards', async () => {
    const e = await freshEngine();
    const doc = d('This is a problm.');
    expect(await e.check(doc, { dialect: 'american', disabledRules: ['SpellCheck'] })).toEqual([]);
    expect(await e.check(doc, { dialect: 'british', disabledRules: ['SpellCheck'] })).toEqual([]);
    expect(find(await e.check(doc, { dialect: 'british', disabledRules: [] }), 'problm')).toBeDefined();
  });

  it('setDictionary replaces the dictionary (removed words are flagged again) and survives a dialect switch', async () => {
    const e = await freshEngine();
    const doc = d('Zorblaxian and Quimbletron are our apps.');
    await e.setDictionary(['Zorblaxian', 'Quimbletron']);
    expect(await e.check(doc, { dialect: 'american' })).toEqual([]);
    await e.setDictionary(['Quimbletron']);
    const r = await e.check(doc, { dialect: 'american' });
    expect(find(r, 'Zorblaxian')).toBeDefined();
    expect(find(r, 'Quimbletron')).toBeUndefined();
    const br = await e.check(doc, { dialect: 'british' });
    expect(find(br, 'Zorblaxian')).toBeDefined();
    expect(find(br, 'Quimbletron')).toBeUndefined();
    await e.setDictionary([]);
    expect(find(await e.check(doc, { dialect: 'british' }), 'Quimbletron')).toBeDefined();
  });

  // BUG (packages/core/src/harper.ts, HarperEngine.check): calls are not serialized. If two checks with
  // different dialects overlap, one call's setDialect frees the WASM linter the other is using and the
  // promise rejects with "Error: null pointer passed to rust". (Same-options concurrency is fine — see above.)
  // Repro: Promise.all([check(t,{dialect:'british'}), check(t,{dialect:'american'})]) -> rejects.
  // Fix: run configure+lint through a single promise queue/mutex inside HarperEngine.
  it('concurrent checks with different dialects both resolve with the right dialect', async () => {
    const e = await freshEngine();
    const doc = d('The colour is nice.');
    const [br, am] = await Promise.all([e.check(doc, { dialect: 'british' }), e.check(doc, { dialect: 'american' })]);
    expect(find(br, 'colour')).toBeUndefined();
    expect(find(am, 'colour')).toBeDefined();
  });
});
