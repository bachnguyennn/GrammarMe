# GrammarMe architecture

GrammarMe is a free, private writing assistant. Grammar, spelling and punctuation checks run
**on your device** with [Harper](https://writewithharper.com) (Rust compiled to WebAssembly).
Cloud AI suggestions are optional, off by default, and only run when you press a button.

```
                       ┌──────────────────────────── your browser ────────────────────────────┐
  you type ──────────► │ <textarea>  (owns text, caret, native undo)                          │
                       │    │ input event → version++ → rebase underlines (instant, no network)│
                       │    ▼ 300 ms debounce                                                 │
                       │ HarperEngine ──► Web Worker (harper.js WASM, ~20 MB, loaded once)    │
                       │    │ Suggestion[] for version N → rebased onto current version       │
                       │    ▼                                                                 │
                       │ backdrop underlines + popover + sidebar  ──► accept = execCommand    │
                       └──────────────┬───────────────────────────────────────────────────────┘
                                      │ only when you press "AI check" (opt-in)
                                      ▼
                  workers/ai-api (Cloudflare Worker, your account, free plan)
                       │ auth token · CORS · length cap · rate + daily cap · no logging of text
                       ▼
                  LLM provider (Gemini / Groq / Workers AI — see llm-research.md)
```

## Packages

| Path | What it is |
| --- | --- |
| `packages/core` | Shared contract (`Suggestion`, AI request/response types), offset-safe editing helpers, Harper adapter (`@grammarme/core/harper`), text statistics. No UI. |
| `apps/web` | The editor (React + Vite). Runs Harper in a Web Worker. |
| `apps/extension` | Chrome MV3 extension (text boxes and rich-text editors such as Gmail). One shared Harper instance in an offscreen document. |
| `workers/ai-api` | Optional Cloudflare Worker that proxies AI checks with the provider key kept server-side. |
| `tests/eval` | Labelled evaluation dataset + runner that measures precision/recall/latency. |

## The suggestion contract

Defined once in `packages/core/src/types.ts`; every component uses it.

```ts
interface Suggestion {
  id: string;            // stable hash of source|rule|range|original
  start: number;         // UTF-16 code units (JS string index), inclusive
  end: number;           // exclusive; text.slice(start, end) === original
  original: string;
  replacements: string[];// best first; '' = delete; [] = explain only
  category: 'spelling' | 'grammar' | 'punctuation' | 'clarity' | 'style' | 'tone';
  source: 'harper' | 'ai';
  message: string;
  rule: string;          // Harper rule name, or ai-<category>
  documentVersion: number;
}
```

**Offsets are UTF-16 code units** because that is what `String.prototype.slice`, `textarea.selectionStart`
and DOM `Range` use. harper.js 3.0.0 already reports UTF-16 indices (verified with emoji input);
`resolveSpan()` re-verifies every span against `get_problem_text()` and falls back to code-point
conversion, so an upstream change cannot silently misplace a correction.

> Deviation from the original brief: `replacement: string` became `replacements: string[]`, because
> Harper returns several candidates (e.g. *problm → problem / probe / prob*) and the UI shows up to three.

## Staying correct while the user types

Every edit increments `documentVersion`. Three rules keep the text safe:

1. **Rebase, don't wait.** On each keystroke, `rebaseSuggestions()` diffs the old and new text (one
   contiguous change), keeps underlines before the edit, shifts those after it, and drops any the
   edit touched. Typing a letter right next to a word counts as touching it. Underlines never drift
   and never flicker off while a check is pending.
2. **Late results are rebased too.** A Harper result for version N that arrives at version N+3 is
   rebased from N's text to the current text, not applied as-is.
3. **Applying is guarded.** `applySuggestion()` and the editor's `accept()` refuse unless the
   suggestion's version is current *and* `text.slice(start, end) === original`.

AI edits are located by **quoting** text, not by offsets (models count characters badly).
`locateAiEdit()` finds the quote (using `contextBefore` to disambiguate), rejects missing,
ambiguous or no-op edits, and only then creates a `Suggestion`.

## Editor design

A native `<textarea>` sits on top of a backdrop `<div>` with identical font metrics and wrapping.
The textarea owns text, caret, selection and the undo stack; the backdrop only draws underlines.
Accepting a suggestion selects the range and calls `document.execCommand('insertText')`, so Cmd/Ctrl+Z
undoes it like any edit. The textarea grows with its content, so the page scrolls rather than the
textarea, and the backdrop never needs scroll syncing.

## Resource use (8 GB MacBook)

- One Harper instance per page (web) or per browser (extension, offscreen document closed when idle).
- harper.js WASM is ~20 MB on disk (8.5 MB gzipped over the network, cached after first load).
- Measured in Node 24: setup ≈ 0.6 s, a sentence lints in 4–30 ms, process RSS ≈ 420 MB with Harper
  loaded. In-browser memory has **not** been measured yet; see `evaluation.md` for numbers we have.
- No network requests while typing. AI requests happen only on a button press.
