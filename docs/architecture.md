# GrammarMe architecture

GrammarMe is a free, private writing assistant. Grammar, spelling and punctuation checks run
**on your device** with [Harper](https://writewithharper.com) (Rust compiled to WebAssembly).
AI suggestions are optional, off by default, and only run when you press a button. There are two
AI routes: the web editor can use your own Cloudflare Worker, and the Chrome extension can use your
own ChatGPT plan through a local companion (see [below](#optional-chatgpt-companion)).

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
| `packages/core` | Shared contract (`Suggestion`, AI request/response types), offset-safe editing helpers, Harper adapter (`@grammarme/core/harper`), AI prompts and output guards shared by every AI route (`@grammarme/core/ai`), the extension↔companion message contract (`@grammarme/core/companion`), text statistics. No UI. |
| `apps/web` | The editor (React + Vite). Runs Harper in a Web Worker. |
| `apps/site` | Static product site, install and privacy pages. Its build also packages the editor at `/editor/`, the extension zip and `companion/install.sh`. |
| `apps/extension` | Chrome MV3 extension (text boxes and rich-text editors such as Gmail). One shared Harper instance in an offscreen document. |
| `apps/companion` | Optional local program for the extension's "Check with ChatGPT": Sign in with ChatGPT (OAuth on `127.0.0.1`), credential storage, and Responses API calls. Started by Chrome through native messaging. |
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

## Optional ChatGPT companion

The extension's "Check with ChatGPT" uses OpenAI's
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) token sharing
for open-source local apps. Requests count against the user's ChatGPT plan, with no API key.
User guide: [chatgpt.md](chatgpt.md).

```
 web page (content script)            extension service worker           apps/companion (local Node)              OpenAI
 ┌──────────────────────────┐ aiCheck ┌────────────────────────┐ native  ┌──────────────────────────────┐ HTTPS  ┌─────────────────────┐
 │ AI button → preview →    │────────▶│ one port per operation │ messag- │ fixed ops only: status,      │───────▶│ auth.openai.com     │
 │ "Send to ChatGPT"        │◀────────│ (permission: optional  │ ing     │ signIn, signOut, models,     │        │ (OAuth, PKCE, JWKS) │
 │ edits → underlines,      │ edits   │ nativeMessaging)       │◀───────▶│ setModel, test, check        │───────▶│ api.openai.com/v1/  │
 │ accept = execCommand     │         │ no tokens, ever        │ stdio   │ tokens in ~/.config/grammarme│        │ responses, models   │
 └──────────────────────────┘         └────────────────────────┘         │ (0600); prompts + guards     │        └─────────────────────┘
                                                                          │ from @grammarme/core/ai      │
                                                                          └──────────────────────────────┘
```

Why a companion is needed:

- **OpenAI requires a loopback callback.** It documents only a loopback redirect,
  `http://127.0.0.1:<port>/auth/callback`, with a listener started before the browser opens. It
  doesn't mention browser extensions. An extension can't listen on a port, and capturing the
  redirect inside Chrome would be an undocumented workaround.
- **Credentials belong on disk.** OpenAI asks for owner-only files that are never committed or
  logged. A local process fits that; extension storage doesn't.

Design points:

- **Native messaging:** the host manifest lists GrammarMe's fixed extension ID (pinned with
  `manifest.json`'s `key`) in `allowed_origins`, and the companion re-checks the caller origin.
  There's no listening port except the brief sign-in callback. Chrome starts the companion per
  operation, and it exits when the port closes.
- **The companion is not a proxy:** `@grammarme/core/companion` defines the only operations. No
  request carries a URL, header or token. Text is capped at 4,000 characters, output at 24,000,
  and a check times out at 90 s. A tab can run one check at a time, and cancelling aborts the
  request.
- **Plan permission, not just sign-in:** the companion checks that the grant includes
  `chatgpt.tokens.use.direct`. A valid ID token alone isn't enough.
- **No silent fallback:** usage-limit and eligibility errors are shown as they are. Nothing
  switches to API billing or another provider.
- **Untrusted output:** the model's JSON goes through the same guards as the Worker route
  (`sanitizeEdits`). The extension then places each edit only inside the range that was sent
  (`placeAiEdits`), drops overlaps and ambiguous quotes, and rebases onto newer text. Edits the
  user has since changed are dropped. Accepting goes through `execCommand`, so native undo works.
- **Service-worker suspension:** an open native port keeps the MV3 worker alive during a sign-in
  or check. If it stops anyway, the port closes, the companion aborts, and the page shows
  "interrupted".
- **Installing it:** one pasted line runs `apps/companion/install.sh`, which downloads the
  companion from the latest GitHub release and checks it against `SHA256SUMS`. People with
  Node 22.6+ get the small `.mjs` build; everyone else gets a standalone build with Node inside
  ([decision D12](decisions.md#d12-installing-the-companion--one-pasted-line-with-a-standalone-build-2026-11-05)).

## Releases and deployment

| Trigger | Workflow | What it does |
| --- | --- | --- |
| Push to `main` | `.github/workflows/pages.yml` | Runs the tests, builds `apps/site/dist` and deploys it to GitHub Pages. |
| Push a `v*` tag, or run it by hand for an existing tag | `.github/workflows/release.yml` | Runs the tests, builds the extension zip and every companion build, and publishes them with `SHA256SUMS` to a GitHub Release. |

The two are independent. The site's extension zip and `install.sh` come from `main`, so they can be
ahead of the latest release. The companion itself always comes from the latest release.

The release builds the standalone companion on macOS (Apple silicon) and Linux (x64, arm64). The
Intel Mac build is cross-built on the Apple silicon runner. A failed standalone build doesn't block
the release; `install.sh` then asks the person to install Node instead.

To cut a version:

1. Set the same version in every `package.json` (the root, `apps/*`, `packages/core`,
   `workers/ai-api`) and in `apps/companion/src/version.ts`, then run `npm install` to update
   `package-lock.json`. Leave `apps/extension/manifest.json` alone: its build overwrites the
   version from `apps/extension/package.json`.
2. Move the changelog's **Unreleased** notes under the new version and date.
3. Commit, tag `vX.Y.Z`, and push the commit and the tag.
