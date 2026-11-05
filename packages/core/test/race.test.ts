/**
 * Rapid-typing race scenarios: edits keep landing while checks for older versions are in flight.
 *
 * Contract under test: a result computed for version N must never be applied to version N+k as-is;
 * it may only be shown/applied after `rebaseSuggestions` moved it to N+k AND it is still applicable.
 *
 * `EditorModel` below is the reference client policy (what the web editor / extension should do)
 * built purely from core primitives.
 */
import { describe, expect, it } from 'vitest';
import { StaleSuggestionError, applySuggestion, isApplicable, rebaseSuggestions } from '../src/suggestions.ts';
import type { DocumentSnapshot, Suggestion } from '../src/types.ts';
import { FakeSpellEngine, fakeCheckSync, isWellFormed, key, pick, rng, sugAt } from './support/fixtures.ts';

type Strategy = 'stepwise' | 'direct';

class EditorModel {
  doc: DocumentSnapshot;
  shown: Suggestion[] = [];
  /** Highest version whose check result has been accepted — older results arriving later are discarded. */
  freshestResult = -1;
  readonly history = new Map<number, string>();

  readonly strategy: Strategy;

  constructor(text: string, strategy: Strategy) {
    this.strategy = strategy;
    this.doc = { text, version: 0 };
    this.history.set(0, text);
  }

  edit(nextText: string): void {
    const prev = this.doc.text;
    if (nextText === prev) return;
    this.doc = { text: nextText, version: this.doc.version + 1 };
    this.history.set(this.doc.version, nextText);
    this.shown = rebaseSuggestions(prev, this.doc, this.shown);
  }

  receive(version: number, result: Suggestion[]): void {
    if (version <= this.freshestResult) return; // an even newer result already won
    let moved = result;
    if (version !== this.doc.version) {
      if (this.strategy === 'direct') {
        moved = rebaseSuggestions(this.history.get(version)!, this.doc, result);
      } else {
        for (let v = version + 1; v <= this.doc.version; v++) {
          moved = rebaseSuggestions(this.history.get(v - 1)!, { text: this.history.get(v)!, version: v }, moved);
        }
      }
    }
    this.freshestResult = version;
    this.shown = moved;
  }
}

/** Invariants that must hold at every moment, whatever arrived in whatever order. */
function assertConsistent(ed: EditorModel, label: string) {
  const fresh = new Set(fakeCheckSync(ed.doc).map(key));
  for (const s of ed.shown) {
    expect(s.documentVersion, label).toBe(ed.doc.version);
    expect(isApplicable(ed.doc, s), label).toBe(true);
    // No ghost underlines: anything shown is something a fresh check of the current text also flags.
    expect(fresh.has(key(s)), `${label}: ghost ${key(s)} in ${JSON.stringify(ed.doc.text)}`).toBe(true);
    const applied = applySuggestion(ed.doc, s);
    expect(isWellFormed(applied.text), label).toBe(true);
  }
}

describe('late results vs. newer versions (deterministic scenarios)', () => {
  it('a raw result for version N throws on N+1..N+k, even when its text is untouched', () => {
    const ed = new EditorModel('I teh cat.', 'direct');
    const lateResult = fakeCheckSync(ed.doc); // version 0
    const typed = ['I teh cat. ', 'I teh cat. H', 'I teh cat. Hi', 'I teh cat. Hi!'];
    for (const t of typed) {
      ed.edit(t);
      for (const s of lateResult) {
        expect(isApplicable(ed.doc, s)).toBe(true); // text matches...
        expect(() => applySuggestion(ed.doc, s)).toThrow(StaleSuggestionError); // ...but version does not
      }
    }
  });

  it('rebases a late result past several keystrokes typed AFTER the flagged word', () => {
    for (const strategy of ['direct', 'stepwise'] as const) {
      const ed = new EditorModel('I recieve mail', strategy);
      const v0 = fakeCheckSync(ed.doc);
      for (const ch of ' daily.') ed.edit(ed.doc.text + ch);
      ed.receive(0, v0);
      expect(ed.shown.map(key)).toEqual(['2:9:recieve']);
      expect(applySuggestion(ed.doc, ed.shown[0]!).text).toBe('I receive mail daily.');
      assertConsistent(ed, strategy);
    }
  });

  it('rebases a late result past keystrokes typed BEFORE the flagged word (including emoji)', () => {
    for (const strategy of ['direct', 'stepwise'] as const) {
      const ed = new EditorModel('teh end', strategy);
      const v0 = fakeCheckSync(ed.doc);
      // Each keystroke lands before the word but never directly against it.
      for (const t of ['😀teh end', '😀 teh end', '😀 O teh end', '😀 Ok teh end']) ed.edit(t);
      ed.receive(0, v0);
      expect(ed.shown.map((s) => ed.doc.text.slice(s.start, s.end))).toEqual(['teh']);
      expect(ed.shown[0]!.start).toBe('😀 Ok '.length);
      assertConsistent(ed, strategy);
    }
  });

  it('drops the late result for a word the user is in the middle of retyping', () => {
    for (const strategy of ['direct', 'stepwise'] as const) {
      const ed = new EditorModel('I teh', strategy);
      const v0 = fakeCheckSync(ed.doc);
      ed.edit('I te'); // backspace
      ed.edit('I t'); // backspace
      ed.edit('I th');
      ed.edit('I the');
      ed.receive(0, v0);
      expect(ed.shown).toEqual([]);
      assertConsistent(ed, strategy);
    }
  });

  it('drops the late result when the word was retyped to the SAME text (ABA) only in stepwise mode', () => {
    // User deletes "h" then retypes it: text at v2 equals v0. A direct rebase sees "no change" and keeps it,
    // which is still safe because the text really is identical; stepwise drops it on the first step.
    const direct = new EditorModel('I teh', 'direct');
    const stepwise = new EditorModel('I teh', 'stepwise');
    for (const ed of [direct, stepwise]) {
      const v0 = fakeCheckSync(ed.doc);
      ed.edit('I te');
      ed.edit('I teh');
      ed.receive(0, v0);
      assertConsistent(ed, ed.strategy);
    }
    expect(direct.shown.map(key)).toEqual(['2:5:teh']);
    expect(stepwise.shown).toEqual([]);
  });

  it('an older result arriving after a newer one is discarded', () => {
    const ed = new EditorModel('teh', 'direct');
    const v0 = fakeCheckSync(ed.doc);
    ed.edit('teh recieve');
    const v1 = fakeCheckSync(ed.doc);
    ed.edit('teh recieve adress');
    ed.receive(1, v1); // newer result first
    ed.receive(0, v0); // stale straggler
    expect(ed.freshestResult).toBe(1);
    expect(ed.shown.map((s) => s.original)).toEqual(['teh', 'recieve']);
    assertConsistent(ed, 'out-of-order');
  });

  it('works with an async engine whose responses resolve out of order', async () => {
    const engine = new FakeSpellEngine();
    // Earlier versions take longer, so responses arrive newest-first.
    engine.delayFor = (d) => 30 - d.version * 10;
    const ed = new EditorModel('', 'stepwise');
    const pending: Promise<void>[] = [];
    for (const t of ['teh', 'teh wrold', 'teh wrold recieve']) {
      ed.edit(t);
      const snapshot = { ...ed.doc };
      pending.push(engine.check(snapshot).then((r) => ed.receive(snapshot.version, r)));
    }
    ed.edit('Oh teh wrold recieve'); // typed while all three are in flight
    await Promise.all(pending);
    expect(engine.calls).toBe(3);
    expect(ed.freshestResult).toBe(3);
    expect(ed.shown.map((s) => s.original)).toEqual(['teh', 'wrold', 'recieve']);
    assertConsistent(ed, 'async');
  });

  it('applying one suggestion makes every other un-rebased suggestion stale', () => {
    const d0: DocumentSnapshot = { text: 'teh wrold', version: 0 };
    const [a, b] = fakeCheckSync(d0);
    const d1 = applySuggestion(d0, a!);
    expect(() => applySuggestion(d1, b!)).toThrow(StaleSuggestionError);
    const [b1] = rebaseSuggestions(d0.text, d1, [b!]);
    expect(applySuggestion(d1, b1!).text).toBe('the world');
  });

  it('rebasing a suggestion after an earlier same-length fix keeps offsets exact across emoji', () => {
    const d0: DocumentSnapshot = { text: '👨‍👩‍👧‍👦 teh 😀 wrold', version: 0 };
    const [a, b] = fakeCheckSync(d0);
    const d1 = applySuggestion(d0, a!);
    const [b1] = rebaseSuggestions(d0.text, d1, [b!]);
    expect(applySuggestion(d1, b1!).text).toBe('👨‍👩‍👧‍👦 the 😀 world');
  });
});

describe('late results vs. newer versions (seeded fuzz)', () => {
  const TOKENS = ['a', 'e', 'h', 't', ' ', '.', ',', "'", 'teh', ' teh ', 'wrold', 'recieve', '😀', '👨‍👩‍👧‍👦', '🇻🇳', 'é', '日本', 'שלום', '\n'];

  function randomEdit(r: () => number, text: string): string {
    const cps = [...text];
    const at = Math.floor(r() * (cps.length + 1));
    const op = r();
    if (op < 0.55 || cps.length === 0) return [...cps.slice(0, at), pick(r, TOKENS), ...cps.slice(at)].join('');
    const del = 1 + Math.floor(r() * Math.min(4, cps.length - Math.min(at, cps.length - 1)));
    const from = Math.min(at, cps.length - 1);
    const insert = op < 0.8 ? '' : pick(r, TOKENS);
    return [...cps.slice(0, from), insert, ...cps.slice(from + del)].join('');
  }

  for (const strategy of ['direct', 'stepwise'] as const) {
    it(`never shows a stale/ghost/unappliable underline (${strategy})`, () => {
      for (let seed = 1; seed <= 60; seed++) {
        const r = rng(seed * 7919);
        const ed = new EditorModel('I teh cat will recieve teh wrold 😀 soon.', strategy);
        const inFlight: { version: number; result: Suggestion[] }[] = [];
        for (let step = 0; step < 80; step++) {
          ed.edit(randomEdit(r, ed.doc.text));
          if (r() < 0.4) inFlight.push({ version: ed.doc.version, result: fakeCheckSync(ed.doc) });
          // Deliver a random in-flight result (random order => out-of-order arrival).
          if (inFlight.length && r() < 0.35) {
            const [job] = inFlight.splice(Math.floor(r() * inFlight.length), 1);
            ed.receive(job!.version, job!.result);
          }
          assertConsistent(ed, `seed=${seed} step=${step} ${strategy}`);
          // A raw (un-rebased) old result is never directly applicable to the current version.
          for (const job of inFlight) {
            if (job.version === ed.doc.version) continue;
            for (const s of job.result) expect(() => applySuggestion(ed.doc, s)).toThrow(StaleSuggestionError);
          }
        }
      }
    });
  }
});

describe('rebase edge cases found while writing the race model', () => {
  // BUG (packages/core/src/suggestions.ts, isWordChar): it tests `text[index]`, a single UTF-16 unit, so a
  // letter outside the BMP (e.g. CJK Extension B "𠀋" U+2000B, or math alphanumerics) typed directly after a
  // flagged word is seen as a lone surrogate => "not a word char" => the old underline is kept, although the
  // word is now "teh𠀋". Expected: [] (dropped). Actual: the "teh" suggestion at 0..3 is kept.
  // Low real-world impact; fix by reading the code point (codePointAt / /\p{L}/u on text.slice).
  it('drops a word when an astral-plane letter is typed directly after it', () => {
    const prev = 'teh';
    const out = rebaseSuggestions(prev, { text: 'teh\u{2000B}', version: 1 }, [sugAt(prev, 'teh', 'the')]);
    expect(out).toEqual([]);
  });
});
