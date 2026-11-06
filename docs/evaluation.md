# GrammarMe — Evaluation & QA Report

*Measured 2026-11-04 (local time; the results files record UTC `2026-11-05T03:42Z`). Machine: Apple Silicon MacBook (Apple M1 Pro, 16 GB), Node 24 (v24.15.0), harper.js 3.0.0, vitest 4.0.18, TypeScript 5.9.3.*

Every number below was copied from a real run: the eval output in `tests/eval/results/*.json` and the vitest/tsc output. Nothing is rounded up. Percentages carry one decimal, and the raw counts are given next to them.

> **This is the baseline report.** Sections 3–8 describe Harper's stock rules on 2026-11-04. GrammarMe
> now ships different defaults, and every bug in §6 has been fixed. For the current figures, see
> [the update at the end](#update--shipped-defaults-2026-11-04).

---

## 1. How to reproduce

```bash
# unit + integration tests (from packages/core)
cd packages/core && npx vitest run && npx tsc -p tsconfig.json

# evaluation (from repo root) — default config, writes tests/eval/results/harper-latest.json
node --experimental-strip-types tests/eval/run-eval.ts
# variants used in this report
node --experimental-strip-types tests/eval/run-eval.ts --disable SplitWords,ExpandTimeShorthands,LongSentences --out tests/eval/results/harper-recommended.json
node --experimental-strip-types tests/eval/run-eval.ts --dialect british --out tests/eval/results/harper-british.json
```

Flags: `--engine` (default `harper`), `--dialect` (default `american`), `--disable A,B`, `--passes N` (latency passes, default 5), `--dataset`, `--out`.

`npm run eval` (from the repo root) runs the same default command.

> **Note:** an earlier `harper.ts` used a constructor parameter property, which `--experimental-strip-types` rejects (§6, bug 4, now fixed). The harness still carries a guard: if that syntax ever comes back, it prints a warning and re-runs itself with `--experimental-transform-types`. With the current core the guard never triggers.
>
> **Repo path with spaces:** harper.js 3.0.0 can't open its WASM from a file path containing a space, and this repo lives under `…/Data Engineer Project/…`. `packages/core/test/support/harper-node.ts` handles this by trying, in order:
> 1. the `GRAMMARME_HARPER_WASM` override;
> 2. the installed file;
> 3. a copy in `os.tmpdir()`, which is what runs here (`"wasmLoader": "tmp-copy"` in the results);
> 4. a `data:` URL as a last resort.

**Plugging in an AI engine:** add an entry to `ENGINES` in `tests/eval/run-eval.ts` that returns any `SuggestionEngine` (from `packages/core/src/types.ts`). Scoring, latency and the report format are engine-agnostic.

---

## 2. Methodology

### Dataset — `tests/eval/dataset.jsonl`
The dataset has **171 hand-written English sentences** and **128 expected errors**. Each row has the fields `{id, category, input, expected, errors:[{original, replacement}]}`.

| category | sentences | errors | what it covers |
|---|---:|---:|---|
| spelling | 28 | 30 | common misspellings (*recieve, seperate, definately, adress*) |
| punctuation | 16 | 16 | stray spaces before `,`/`?`, doubled punctuation, missing apostrophes (*cant, Lets, childrens*), missing space after `.` |
| agreement | 19 | 19 | pronoun–verb (*He go, They was*) and noun–verb (*The list of items are*) agreement |
| tense | 13 | 14 | wrong past/participle forms (*has went, I seen, didn't knew, drived*) |
| article | 15 | 15 | a/an, including sound-based cases (*a hour, an university, an one-time*) |
| word-choice | 22 | 22 | homophones and confusables (*their/there/they're, its/it's, your/you're, could of, then/than, effect/affect*) |
| awkward | 12 | 12 | wordiness (*in order to, due to the fact that, at this point in time, end result*) |
| correct | 46 | 0 | correct sentences used to measure false positives, in six subsets (below) |

The `correct` rows are split into subsets, encoded in the id as `ok-<subset>-NN`:
- **plain** (10): ordinary sentences.
- **tricky** (11): correct but easy to get wrong, e.g. *Its handle…*, *Who's coming…*, *Whose laptop…*, *If I were you*, *An hour later*, *A university*, *The data were…*.
- **jargon** (11): technical text such as *Kubernetes, getUserById, NODE_ENV, p95, 340 ms, ETL, S3, kubectl*.
- **names** (6): proper nouns such as *São Paulo, Nguyễn Văn An, Joaquín, Reykjavík, Rue de Rivoli, Acme Corp.*
- **british** (4): British spellings such as *colour, apologise, organisation, analyse, theatre, centre*.
- **quotes** (4): straight and curly quotes, plus a quoted nonstandard word (*"irregardless"*).

The harness validates the dataset on load. It aligns each `original` to a unique, word-bounded position whose surrounding text is unchanged in `expected`, and it fails if applying the errors doesn't turn `input` into `expected`.

### Scoring (error level)
- **Flag:** one suggestion returned by the engine.
- **True-positive flag:** its range overlaps an expected error's `original` range. A zero-width flag counts if it touches the range.
- **Precision** = TP flags ÷ all flags. Flags on `correct` sentences are all false positives.
- **Recall** = expected errors overlapped by at least one flag ÷ all expected errors.
- **F1** = harmonic mean of precision and recall.
- **Correct-fix rate:** among detected errors, the share where applying the flag's top replacement on its own yields exactly the same sentence as applying the expected fix on its own. This tolerates span differences, e.g. Harper flagging `a` and `a apple` both count if the result is identical.
- **Auto-fix recall:** errors that were detected *and* correctly fixed ÷ all errors.
- **Sentences fully fixed:** applying every top replacement gives exactly `expected`, measured over the 125 sentences that contain errors.
- **FP rate on correct sentences:** correct sentences with at least one flag ÷ 46.
- **Latency:** wall-clock time of `engine.check()` per sentence, over 5 passes × 171 sentences (855 checks) after an untimed accuracy and warm-up pass. "Long document" is all 171 inputs joined into one 1,196-word text, checked 5 times.
- **Setup:** time from engine construction to the first result on an empty document.
- **Memory:** `process.memoryUsage().rss` before the engine loads, after setup, and after the eval.

The engine runs with American dialect and Harper's default rules unless stated otherwise. 95% intervals are Wilson score intervals.

---

## 3. Results — Harper (default config, American)

`tests/eval/results/harper-latest.json`

| category | sents | errors | flags | TP | FP | precision | recall | F1 | fix-rate | sentences flagged |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| spelling | 28 | 30 | 30 | 30 | 0 | 100.0% | 100.0% | 100.0% | 80.0% | 100.0% |
| punctuation | 16 | 16 | 10 | 10 | 0 | 100.0% | 62.5% | 76.9% | 80.0% | 62.5% |
| agreement | 19 | 19 | 10 | 10 | 0 | 100.0% | 52.6% | 69.0% | 100.0% | 52.6% |
| tense | 13 | 14 | 8 | 8 | 0 | 100.0% | 57.1% | 72.7% | 100.0% | 61.5% |
| article | 15 | 15 | 15 | 15 | 0 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| word-choice | 22 | 22 | 16 | 16 | 0 | 100.0% | 72.7% | 84.2% | 100.0% | 72.7% |
| awkward | 12 | 12 | 0 | 0 | 0 | n/a | 0.0% | n/a | n/a | 0.0% |
| correct | 46 | 0 | 24 | 0 | 24 | — | — | — | — | **30.4%** |
| **overall** | 171 | 128 | 113 | 89 | 24 | **78.8%** | **69.5%** | **73.9%** | **91.0%** | 59.1% |

**Headline figures with 95% intervals:**
- **Precision:** 89/113 = 78.8% (70.3–85.3%)
- **Recall:** 89/128 = 69.5% (61.1–76.8%)
- **Correct-fix rate:** 81/89 = 91.0% (83.3–95.4%)
- **FP rate on correct sentences:** 14/46 = 30.4% (19.1–44.8%)
  - by subset: plain 0/10 · tricky 0/11 · jargon 5/11 · names 4/6 · british 4/4 · quotes 1/4
- **Auto-fix recall:** 81/128 = 63.3%
- **Sentences fully fixed:** 79/125 = 63.2%

All 24 false positives fell on `correct` sentences: Harper raised no spurious flags in the sentences that contained errors. It also got every one of the 11 "tricky" correct sentences right, including possessive *Its*, *Who's/Whose*, the subjunctive *were*, and *An hour* / *A university*.

### Performance
| metric | value |
|---|---|
| latency per sentence (855 checks) | p50 **1.22 ms** · p95 **1.51 ms** · p99 1.69 ms · mean 1.26 ms · max 2.29 ms |
| 1,196-word document (5 runs, in order) | 235.66, 44.37, 43.42, 42.19, 43.74 ms → p50 **43.74 ms**. The first long check is about 5× slower. |
| setup to first result | **564.67 ms** (tmp-copy loader) |
| RSS | 79.6 MB before → **371.1 MB after setup** → 597.0 MB after eval |
| determinism | identical flags, ranges and top replacements across all 5 passes within one engine instance |

Across the five file-based runs today (tmp-copy, or a space-free copy via `GRAMMARME_HARPER_WASM`), setup took 558–590 ms, RSS after setup was 370–379 MB, and RSS after the eval was 541–598 MB.

**The loader mode matters.** Earlier runs used the `data:` URL fallback and measured setup **1016–1092 ms** and RSS after setup **648–676 MB** (RSS after eval 613–890 MB), with identical accuracy. The base64 copy of the 20 MB WASM roughly doubles the cost, so it's kept only as a last resort. The browser app fetches the WASM over HTTP, so this only affects Node and the extension.

### Variants
| config | precision | recall | F1 | fix-rate | FP sentences |
|---|---:|---:|---:|---:|---:|
| default (American) | 78.8% (89/113) | 69.5% | 73.9% | 91.0% (81/89) | 14/46 = 30.4% |
| `--disable SplitWords,ExpandTimeShorthands,LongSentences` | 80.2% (89/111) | 69.5% | 74.5% | **93.3% (83/89)** | 14/46 = 30.4% |
| `--dialect british` | 83.2% (89/107) | 69.5% | 75.7% | 91.0% (81/89) | **10/46 = 21.7%** (british subset 0/4) |

- **Disabling the three rules.** SpellCheck then corrects *adress→address*, *wether→weather* and *mantain→maintain*, which SplitWords had "fixed" as *a dress*, *wet her* and *manta in*. That lifts the spelling fix-rate from 80.0% to 90.0%. It also removes the two *ms → milliseconds* false positives. The FP-sentence count is unchanged because SpellCheck still flags *p95* in that same sentence.
- **The tense fix-rate drop in that row (100% → 87.5%) is noise, not an effect of the config.** Harper's `RegularIrregulars` rule returns `["drove","driven"]` in a non-deterministic order. Across four fresh linter instances I observed both orders, and also a flip after a lint-config change within one instance. One example (*drived*) can therefore move the fix-rate by ±1.
- **The British run** removes all 6 British-spelling false positives (*colour, apologise, organisation, analyse, theatre, centre*) and adds none on this dataset. The dataset contains few American-only spellings (a limitation).

---

## 4. Notable false positives and misses

### False positives on correct sentences (default config, all 24)
| rule | count | examples (flagged → top suggestion) |
|---|---:|---|
| SpellCheck | 20 | **jargon:** `getUserById` (no suggestion), `p95`→*pa*, `ENV` (from NODE_ENV)→*End*, `ETL`→*Eel*, `S3`→*So*, `kubectl`→*puberty*. **names:** `São`→*So*, `Paulo`→*Pablo*, `Nguyễn`→*Nguyen*, `Văn`→*Van*, `Rivoli`→*Rival*, `Siobhan`→*Sideman*, `Joaquín`→*Joaquin*. **British:** `colour, apologise, organisation, analyse, theatre, centre`. **quoted word:** `"irregardless"`→*regardless* |
| ExpandTimeShorthands | 2 | `340 ms`, `120 ms` → *milliseconds* |
| AnA | 1 | the Vietnamese name *Nguyễn Văn **An*** → *A* |
| SentenceCapitalization | 1 | *Acme Corp. **met** with…* → *Met* (period of an abbreviation treated as a sentence end) |

Of SpellCheck's 50 flags, 20 (40%) were false positives, and every one of them was a proper noun, an identifier, an acronym or a British spelling. SpellCheck also accounts for all 30 spelling detections, so it must stay on; it needs filtering, not disabling (§5).

### Misses (39 of 128 errors)
- **awkward 12/12 missed.** Harper flagged none of *in order to, due to the fact that, at this point in time, made a decision, the reason why is because, in the process of, each and every, in spite of the fact that, revert back, end result, plan ahead, merge together*.
- **agreement 9/19 missed.** Harper catches pronoun subjects (*He go, She don't, They was, We was, I has, You was*), but *none* of the noun-phrase subjects: *The list of items **are***, *My brother **have***, *The dogs **barks***, *Everyone **have***, *The results of the survey **was***, *There **is** many reasons*, *Each of the students **have***, *My parents **lives***, *The server **crash***.
- **tense 6/14 missed.** Time-adverbial tense is never caught: *Yesterday I **go**… **buy***, *Last year we **visit***, *When I was young, I **play***. It also misses *I **seen** that movie* and *had already **leave***.
- **word-choice 6/22 missed:** *Your welcome*, *your right*, *Who's car*, *except my apology*, *to much work*, *there coming*.
- **punctuation 6/16 missed:** `Wait,,`, *Lets go*, `test.This`, *milk eggs and bread*, a question ending in `.`, *My sisters car*.

### Detected but wrongly fixed (8 of 89, default config)
| error | rule | top suggestion | comment |
|---|---|---|---|
| *adress* | SplitWords | *a dress* | SpellCheck gives *address* when SplitWords is off |
| *wether* | SplitWords | *wet her* | SpellCheck gives *weather* when SplitWords is off |
| *mantain* | SplitWords | *manta in* | SpellCheck gives *maintain* when SplitWords is off |
| *untill* | WrongNegative | *distill* | |
| *writting* | SpellCheck | *writhing* | ranking issue; *writing* is not first |
| *relly* | SpellCheck | *rely* | |
| `..` | EllipsisLength | `...` | arguably acceptable |
| *wont* | NominalWants | *want* | should be *won't* |

### Upstream Harper behaviour that affects product quality
- **LongSentences masks every other lint inside a run-on sentence.** Harper removes overlapping lints, and LongSentences spans the whole sentence and carries no replacement. Once a sentence passes roughly 40 words, typos inside it are no longer reported. Repro: `"I recieve mail" + " and more"×24 + "."` returns only `LongSentences`; disabling that rule brings `recieve` back. This is pinned by a test in `packages/core/test/harper.test.ts`.
- **`RegularIrregulars` suggestion order is non-deterministic** (see the variants section above).

---

## 5. Recommendations

**Status on 2026-11-06:** 1–4, 7, 9 and 10 are done. 6 is done for code-like tokens and acronyms, but
not for foreign proper nouns. 8 is available as two opt-in AI routes, but their quality is unmeasured.
5 isn't done: the dialect still defaults to American.

**Default rule configuration** (`disabledRules`):
1. **`LongSentences`: disable.** It hides real errors in long sentences (above) and offers no fix. Show sentence length from `stats.ts` instead.
2. **`SplitWords`: disable.** All 3 of its detections had wrong top fixes; with it off, SpellCheck fixes the same words correctly (spelling fix-rate 80.0% → 90.0%).
3. **`ExpandTimeShorthands`: disable.** It's a style nit that misfires on technical writing (*340 ms*).
4. **Keep** SpellCheck, AnA, the agreement rules, the its/it's and their/there family, and SentenceCapitalization. They have high precision here; SentenceCapitalization's one false positive was an abbreviation.

**Product and engine:**
5. **Default the dialect from the user's locale** (e.g. `en-GB` → British). On this dataset that cut correct sentences flagged from 30.4% to 21.7% and made the British subset 0/4.
6. **Filter SpellCheck output before display** (core change; owner of `src/`). Skip tokens that look like code or acronyms: camelCase, snake_case, containing digits, ALL-CAPS of 5 letters or fewer, or inside backticks. Consider skipping capitalised words containing non-ASCII letters (likely foreign proper nouns). By inspection, 9 of the 20 SpellCheck false positives (*getUserById, p95, S3, ENV, ETL, São, Nguyễn, Văn, Joaquín*) match these patterns; this is not yet measured with a filter in place.
7. **Make "Add to dictionary" prominent**, since most remaining false positives are names. The dictionary-loss-on-dialect-change bug (§6, bug 1) is now fixed and has a regression test, so this is safe to ship. Persist the list and restore it with `setDictionary`.
8. **Use the AI engine for what Harper structurally misses:** wordiness (0/12), noun-phrase agreement (0/9 caught), and tense driven by time adverbials. Precision on the error rows was 100%, so Harper's flags are safe to show first. AI should add suggestions, not replace Harper's.
9. **Prevent the strip-types regression** by adding `"erasableSyntaxOnly": true` to `tsconfig.base.json` (TS ≥ 5.8). Before the core fix, its only error was `harper.ts(109,15)`; after it, core plus the eval harness compile cleanly with the flag on.
10. **Serialise `HarperEngine.check`** with a small promise queue (§6, bug 3) before the UI can change dialect while a check is in flight.

---

## 6. Bugs found (core is read-only for QA, so each is pinned by a failing test)

**All nine are fixed.** Each open bug was pinned by an `it.fails` test, so `vitest run` stayed green. When a bug was fixed, its test started *failing*: that was the signal to change it to a plain `it`. No `it.fails` pins remain.

| # | where | repro → expected vs actual | severity |
|---|---|---|---|
| 1 ✅ fixed | `harper.ts` `HarperEngine.configure` (root cause: harper.js `LocalLinter.setDialect` frees and recreates the inner linter) | `addWords(['Zorblaxian'])`, then `check(t,{dialect:'british'})` → expected no flag; **actual: SpellCheck flags it again** (personal dictionary lost) | high; **fixed** (words are re-imported after `setDialect`), regression test added |
| 2 ✅ fixed | same | `check(t,{dialect:'american',disabledRules:['SpellCheck']})` → `[]`, then `check(t,{dialect:'british',disabledRules:['SpellCheck']})` → expected `[]`; **actual: `problm` flagged**. `sameSet` skipped re-applying the config that `setDialect` reset. | high; **fixed**, regression test added |
| 3 ✅ fixed | `harper.ts` `HarperEngine.check` (calls aren't serialised) | `Promise.all([check(t,{dialect:'british'}), check(t,{dialect:'american'})])` → **rejects with `Error: null pointer passed to rust`**. Concurrent checks with the *same* options are fine (25 in parallel tested). | medium; **fixed** (checks are serialized) |
| 4 ✅ fixed | `harper.ts:109` `constructor(private linter: Linter)` | `node --experimental-strip-types` → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, which broke `npm run eval`. | medium (tooling); **fixed** by the lead (the harness guard is now inert) |
| 5 ✅ fixed | `suggestions.ts` `locateAiEdit` | text `"I saw a dog and a apple."`, edit `{original:"a", replacement:"an", contextBefore:"with "}` → expected `null`; **actual: placed at 3..4, the "a" inside "saw"**. When contextBefore is provided but not found, the ambiguity guard is skipped. | medium (AI safety); **fixed** |
| 6 ✅ fixed | `suggestions.ts` `isWordChar` | rebase `"teh"` → `"teh́"` (combining accent typed after a flagged word) → expected dropped; **actual: kept at 0..3**. `\p{M}` is not treated as a word character. | low; **fixed** |
| 7 ✅ fixed | `suggestions.ts` `isWordChar` | rebase `"teh"` → `"teh\u{2000B}"` (astral letter) → expected dropped; **actual: kept**, because it checks a single UTF-16 unit | low; **fixed** |
| 8 ✅ fixed | `stats.ts` `WORD` regex | `textStats("résumé writers").words` → expected 2; **actual: 3** (NFD accents split words) | low–medium; **fixed** |
| 9 ✅ fixed | `stats.ts` sentence regex | `textStats('He said "Stop." Then he left.').sentences` → expected 2; **actual: 1** (a terminator before a closing quote or bracket is not counted) | low; **fixed** |

**Upstream harper.js 3.0.0 issues (not ours, worth reporting):**
- `fs.readFile(new URL(binary).pathname)` doesn't percent-decode, so the WASM fails to load (ENOENT) from any path containing a space. The fix is `fileURLToPath`.
- `setDialect` discards dictionary and config; this was the root cause of bugs 1–3, which are now worked around in `HarperEngine`.
- LongSentences masks other lints.
- `RegularIrregulars` returns suggestions in a non-deterministic order.

Open product questions (`it.todo`): should `textStats().characters` count graphemes rather than UTF-16 units (one family emoji currently counts as 11)? Should `locateAiEdit` reject ranges that split a surrogate pair?

---

## 7. Test suite summary

**Current (`npm test`, 2026-11-06): 34 files, 470 passed, 0 failed, 2 todo.**

| package | tests |
|---|---:|
| `packages/core` | 163 passed, 2 todo |
| `apps/companion` | 134 |
| `apps/extension` | 83 |
| `apps/web` | 11 |
| `workers/ai-api` | 79 |

The rest of this section is the 2026-11-04 baseline for `packages/core`.

`cd packages/core && npx vitest run` gave **5 files, 157 tests: 155 passed, 0 failed, 2 todo**. The 155 passes include the 6 `it.fails` pins for still-open bugs (3, 5, 6, 7, 8, 9). The suite runs in about 3.1 s, of which the Harper file takes about 2.9 s. `npx tsc -p tsconfig.json` passes with 0 errors.

| file | tests | focus |
|---|---:|---|
| `suggestions.test.ts` | 62 | hash/id, isApplicable, applySuggestion (stale version in both directions, text mismatch), diffRange (surrogate widening, 3,000-case seeded fuzz), rebase (word-boundary rules, emoji/ZWJ/flag/NFD/CJK/RTL shifts), resolveOverlaps (ranking, zero-width, 500-case fuzz), locateAiEdit safety, countByCategory |
| `race.test.ts` | 12 | reference editor model: late results across keystrokes, ABA retyping, out-of-order arrival, an async engine; a seeded fuzz (60 seeds × 80 edits × 2 strategies) asserting that nothing shown is stale, a "ghost" or unappliable, and that raw old results always throw `StaleSuggestionError` |
| `stats.test.ts` | 40 | syllables, words, sentences, reading time, the Flesch value (hand-computed 116), label thresholds, Unicode |
| `harper-adapter.test.ts` | 27 | `codePointToUtf16`, `resolveSpan` fallback, `categoryForLintKind`, `lintToSuggestion` with fake lints (Remove/InsertAfter, dedupe, cap of 5) |
| `harper.test.ts` | 16 | real WASM: offsets after emoji/ZWJ/flag/NFD/CJK/RTL/CRLF, grammar rules, rule ids are config keys, disabledRules on/off, dialect (*colour/grey* versus *color*), addWords, `setDictionary`, dictionary and rules surviving a dialect switch, 25 concurrent checks, the LongSentences masking, a 1k-word smoke test, and 1 `it.fails` pin (bug 3) |

Shared helpers: `test/support/harper-node.ts` loads Harper in Node: `GRAMMARME_HARPER_WASM` override, then the installed file, then a tmp-copy, then a `data:` URL; `test/support/fixtures.ts` provides suggestion builders, a seeded PRNG and a fake engine.

---

## 8. Limitations of the dataset and the numbers
- **Small and single-author.** 171 short sentences written by one person (the QA agent), with no second annotator. The 95% intervals are wide (FP rate 19.1–44.8%), so differences of a few points between configs aren't significant.
- **One error per sentence, mostly, and short sentences.** That flatters precision on error rows (100% here) and says nothing about long-document behaviour. LongSentences masking, for example, never triggers in the dataset.
- **Synthetic errors.** These are "textbook" errors chosen by the author, so the category mix doesn't reflect real user error frequencies. Awkward phrasing is subjective, and a single `expected` rewrite is used.
- **The correct-fix check accepts only one answer.** Valid alternatives count as wrong (e.g. *canceled/cancelled*; *These kinds of* vs *This kind of*).
- **American-centric.** British/American coverage is thin (4 British sentences, almost no American-only spellings), so the British run can't show regressions on American text.
- **Latency is for single sentences on an M1 Pro in Node.** Browser `WorkerLinter` latency, and older or low-end devices, are not measured.
- **Run-to-run noise.** Accuracy was identical across three repeated default runs, but `RegularIrregulars` ordering can move one example. RSS after the eval varies by up to about 280 MB between runs.

## Update — shipped defaults (2026-11-04)

Following the recommendations above, `HarperEngine` now ships with LongSentences, SplitWords and
ExpandTimeShorthands off (`DEFAULT_DISABLED_RULES`) and skips spelling flags on code-like tokens and
acronyms (`looksLikeCode`: camelCase, snake_case, paths, letter+digit mixes, ALL-CAPS). Re-running
`npm run eval` (American dialect, same dataset, same machine) measured:

| Metric | Before (Harper defaults) | After (GrammarMe defaults) |
| --- | --- | --- |
| Precision | 89/113 = 78.8% | 89/106 = 84.0% |
| Recall | 89/128 = 69.5% | 89/128 = 69.5% |
| F1 | 73.9% | 76.1% |
| Top replacement correct | 91.0% | 93.3% |
| Correct sentences flagged | 14/46 = 30.4% | 10/46 = 21.7% |

Remaining false positives on correct sentences are names (4/6, e.g. Siobhan, São Paulo) and British
spellings under the American dialect (4/4). Names are best handled by "Add to dictionary"; British
spellings by choosing the right dialect. Recall gaps (wordiness 0/12, agreement with noun subjects,
tense from time words) are what the optional AI check is for — its quality has **not** been measured yet.

Also fixed from the QA bug list: concurrent checks are now serialized (no WASM crash with mixed
dialects), `locateAiEdit` rejects ambiguous quotes when `contextBefore` doesn't match, rebasing treats
combining marks and astral letters as part of a word, and word/sentence counts handle NFD accents and
closing quotes. All previously pinned `it.fails` tests now pass as regular tests.

**Re-run on 2026-11-06:** `npm run eval` on the same dataset gave the same accuracy: precision 89/106,
recall 89/128, top replacement correct 83/89, and 10/46 correct sentences flagged.
