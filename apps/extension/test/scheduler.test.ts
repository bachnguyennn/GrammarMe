import type { DocumentSnapshot, Suggestion } from '@grammarme/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckScheduler, reconcile } from '../src/scheduler.ts';
import { sug } from './helpers.ts';

/** A fake field + engine whose responses we resolve by hand. */
function setup(opts: { shouldCheck?: (s: DocumentSnapshot) => boolean } = {}) {
  let doc: DocumentSnapshot = { text: '', version: 0 };
  const pending: { snap: DocumentSnapshot; resolve: (s: Suggestion[] | null) => void }[] = [];
  const results: { snap: DocumentSnapshot; suggestions: Suggestion[] }[] = [];
  const scheduler = new CheckScheduler({
    delayMs: 400,
    current: () => doc,
    check: (snap) => new Promise((resolve) => pending.push({ snap, resolve })),
    onResult: (snap, suggestions) => results.push({ snap, suggestions }),
    shouldCheck: opts.shouldCheck,
  });
  const type = (text: string) => {
    doc = { text, version: doc.version + 1 };
    scheduler.schedule();
  };
  /** Engine answer: spelling hit on every "teh" in the text it was given. */
  const answer = (i = 0) => {
    const p = pending.splice(i, 1)[0]!;
    const out: Suggestion[] = [];
    for (let at = p.snap.text.indexOf('teh'); at !== -1; at = p.snap.text.indexOf('teh', at + 1)) {
      out.push(sug(p.snap.text, 'teh', { at, version: p.snap.version }));
    }
    p.resolve(out);
    return p.snap;
  };
  return { scheduler, pending, results, type, answer, doc: () => doc };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('CheckScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces: one check 400 ms after typing stops', async () => {
    const t = setup();
    t.type('t');
    await vi.advanceTimersByTimeAsync(200);
    t.type('te');
    await vi.advanceTimersByTimeAsync(200);
    t.type('teh');
    await vi.advanceTimersByTimeAsync(399);
    expect(t.pending).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.pending).toHaveLength(1);
    expect(t.pending[0]!.snap).toEqual({ text: 'teh', version: 3 });
    t.answer();
    await flush();
    expect(t.results).toHaveLength(1);
    expect(t.results[0]!.suggestions.map((s) => [s.start, s.documentVersion])).toEqual([[0, 3]]);
  });

  it('rebases a stale result onto newer text instead of misplacing underlines', async () => {
    const t = setup();
    t.type('I saw teh cat');
    await vi.advanceTimersByTimeAsync(400);
    t.type('Then I saw teh cat'); // user typed at the start while the check was in flight
    t.answer();
    await flush();
    expect(t.results).toHaveLength(1);
    const [s] = t.results[0]!.suggestions;
    expect(t.results[0]!.snap.version).toBe(2);
    expect(s).toMatchObject({ start: 11, end: 14, original: 'teh', documentVersion: 2 });
    // The newer version is still checked once its debounce elapses.
    await vi.advanceTimersByTimeAsync(400);
    expect(t.pending.map((p) => p.snap.version)).toEqual([2]);
  });

  it('drops underlines the edit touched when rebasing', async () => {
    const t = setup();
    t.type('teh cat');
    await vi.advanceTimersByTimeAsync(400);
    t.type('the cat'); // user fixed it by hand
    t.answer();
    await flush();
    expect(t.results[0]!.suggestions).toEqual([]);
  });

  it('keeps at most one request in flight and never delivers out of order', async () => {
    const t = setup();
    t.type('teh');
    t.scheduler.runNow();
    expect(t.pending).toHaveLength(1);
    t.type('teh teh');
    t.scheduler.runNow(); // in flight -> queued, not sent
    expect(t.pending).toHaveLength(1);
    t.answer();
    await flush();
    // First result delivered (rebased), then the queued re-run is sent for v2.
    expect(t.results.map((r) => r.snap.version)).toEqual([2]);
    expect(t.pending.map((p) => p.snap.version)).toEqual([2]);
    t.answer();
    await flush();
    expect(t.results.map((r) => r.suggestions.length)).toEqual([1, 2]);
  });

  it('does not re-check an unchanged version unless forced', async () => {
    const t = setup();
    t.type('teh');
    t.scheduler.runNow();
    t.answer();
    await flush();
    t.scheduler.runNow();
    expect(t.pending).toHaveLength(0);
    t.scheduler.runNow(true); // e.g. dialect changed
    expect(t.pending).toHaveLength(1);
  });

  it('skips the engine for uncheckable text (e.g. empty) and clears underlines', async () => {
    const t = setup({ shouldCheck: (s) => s.text.trim().length > 0 });
    t.type('   ');
    await vi.advanceTimersByTimeAsync(400);
    expect(t.pending).toHaveLength(0);
    expect(t.results).toEqual([{ snap: { text: '   ', version: 1 }, suggestions: [] }]);
  });

  it('ignores failed checks and everything after dispose', async () => {
    const t = setup();
    t.type('teh');
    t.scheduler.runNow();
    t.pending.shift()!.resolve(null);
    await flush();
    expect(t.results).toHaveLength(0);
    t.type('teh!');
    t.scheduler.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.pending).toHaveLength(0);
  });
});

describe('reconcile', () => {
  it('returns suggestions untouched for the same version and [] for a newer-than-current result', () => {
    const snap = { text: 'teh', version: 4 };
    const s = [sug('teh', 'teh', { version: 4 })];
    expect(reconcile(snap, snap, s)).toEqual(s);
    expect(reconcile(snap, { text: 'teh', version: 3 }, s)).toEqual([]);
  });
});
