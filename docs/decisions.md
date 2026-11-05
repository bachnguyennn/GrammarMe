# Decision log

Each entry gives the competing recommendations, the evidence, and the outcome. "Measured" means we
actually ran it; anything else is labelled as reasoning or documentation.

## D1. Grammar engine: Harper vs LanguageTool — **Harper** (local default)

- **Grammar/NLP engineer:** Harper. It's Apache-2.0, runs fully in the browser as WASM, and needs no
  server and no network.
- **Counter-position:** LanguageTool catches more grammar (thousands of rules, mature), but needs
  either its public API, which sends text to a third party and is rate-limited, or a self-hosted
  Java server. That server realistically takes 1–2 GB of RAM plus Docker, which breaks the 8 GB
  constraint.
- **Evidence (measured):** Harper 3.0.0 in Node had a setup time of about 0.6 s and linted a sentence
  in 4–30 ms. Testing in a real browser showed that Harper **misses some subject–verb agreement
  errors**, e.g. "an assistant that check", "a few mistake", "how it work". The precision/recall
  numbers are in `evaluation.md`.
- **Outcome:** Harper as the always-on local engine. Close the recall gap with the opt-in AI check,
  not with a heavyweight server. Revisit if the evaluation shows recall is unacceptable.

## D2. Editor: Tiptap vs plain textarea — **textarea + underline backdrop**

- **Frontend engineer (for Tiptap):** rich text, decorations API, mature ecosystem.
- **Lead (against):** GrammarMe edits plain prose; rich formatting isn't in scope. ProseMirror
  positions differ from string offsets, so every suggestion would need a position mapping layer,
  which is a new class of off-by-one bugs. It also adds roughly 100 KB+ of JS and more re-render work.
- **Outcome:** native textarea. It gives native undo and IME/emoji/accessibility for free, the caret
  never jumps, and the same overlay technique is reused in the extension for website textareas.
  Revisit if rich text (bold, headings) becomes a requirement.

## D3. Web Worker vs main thread — **Worker in the web app, offscreen document in the extension**

- Lint time is small (4–30 ms per sentence, measured), but WASM setup (~0.6 s) and long documents
  would stall typing on the main thread. harper.js ships a `WorkerLinter`, so this cost nothing.
- In the extension, the harper.js worker uses a `blob:` URL that MV3 CSP is likely to block, and
  running Harper per tab would multiply ~hundreds of MB by the tab count. Instead, one `LocalLinter`
  runs in an offscreen document shared by all tabs and closes when idle.

## D4. Per-sentence vs whole-document checking — **whole document for Harper, window for AI**

- Harper is fast enough that whole-document checks stay simple and give Harper full context. The
  rebase logic keeps the UI stable between checks.
- AI receives the whole document if it is ≤ 4,000 characters, otherwise the paragraph around the
  caret. This bounds cost, latency and how much text is sent.
- Revisit with incremental (changed-paragraph) linting if evaluation shows latency over ~50 ms on
  long documents.

## D5. AI provider — **Groq → Workers AI by default; Gemini supported but opt-in** (see `llm-research.md`)

- **The brief's starting point:** Gemini, for its generous free Flash / Flash-Lite models.
- **LLM/security engineers:** keep Gemini out of the default chain.
  - Its unpaid tier may use prompts and responses to improve Google products, and human reviewers
    may read them (verified on Google's pricing page and terms, 2026-11-04).
  - Its terms say not to send personal or confidential information to the free tier, and the free
    tier is not allowed for apps offered in the EEA, UK or Switzerland.
- **Groq:** its terms say it does not train on inputs or outputs, and it offers zero data retention.
  Its free limits are not published on official pages (third-party figures are about 30 RPM and
  1K RPD).
- **Workers AI:** 10,000 Neurons/day free, no training, and no extra account beyond Cloudflare.
- **Outcome:** default `AI_PROVIDERS=groq,workers-ai`. Gemini is implemented and can be enabled by
  the owner after reading its terms.
- **No quality claim yet:** this choice is based on privacy terms and structured-output support. A
  side-by-side quality comparison on `tests/eval` is the next benchmark to run once keys exist.

## D6. Browser-only vs minimal backend — **browser-only by default, optional tiny backend for AI**

- **Security engineer:** API keys must never ship in client code, hence the Worker proxy.
- **Lead:** for a single-user personal tool, the proxy is the user's own free Cloudflare account,
  protected by a bearer token, with CORS, a length cap, rate limits and a daily cap. No database and
  no text logging.
- Everything except AI works with no backend at all.

## D7. Privacy vs personalization — **local-only personalization**

- The personal dictionary, turned-off rules, settings and an optional draft autosave live in the
  browser's `localStorage` / `chrome.storage`. Nothing is synced to a server.
- Draft autosave can be turned off and the saved draft deleted in Settings.

## D8. Ignore semantics

- **Dismiss** hides one issue. Its key is rule + flagged text + the preceding word, so the dismissal
  survives edits elsewhere. (A test caught an earlier 16-character context that broke this.)
- **Turn off this rule** disables a Harper rule globally and can be re-enabled in Settings.
- **Add to dictionary** applies to spelling only.

## D9. Writing modes

- Modes change local behaviour only where that is honest. *Casual* hides style-level suggestions;
  the others show everything.
- The real tone and register differences come from the AI prompts, which receive the mode.
