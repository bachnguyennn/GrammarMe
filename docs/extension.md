# GrammarMe Chrome extension (Phase 4 prototype)

Status: **prototype**. It builds, passes type checks and unit tests, and a Node harness drives the built
`background.js` and `offscreen.js` with real Harper WASM.

**Loaded in real Chrome (2026-11-05, Chrome 156, headless, fresh profile, the unzipped download):**
the extension loads with no errors; the offscreen document starts Harper; typing
"I has a apple. This is a sentense with a eror." into a `<textarea>` gave 5 underlines about 1 s
later; clicking "has" opened the card and its "have" fix changed the text, and Cmd+Z undid it; an
`<input type="text">` got its 2 spelling underlines; a password field got none; the popup renders.
Not yet checked by hand in a windowed Chrome: real typing speed, many tabs, idle shutdown, memory.

**For non-developers:** the site serves a ready-to-load zip at
`https://bachnguyennn.github.io/GrammarMe/GrammarMe-extension.zip` with plain steps at
[`install.html`](https://bachnguyennn.github.io/GrammarMe/install.html). The site build
(`npm run build:site`) rebuilds the zip on every deploy.

Scope: `<textarea>`, `<input type="text|search">`, and rich-text editors (`contenteditable`: Gmail,
Outlook on the web, Quill and similar). Google Docs is out of scope (see
[Rich-text editors and Google Docs](#rich-text-editors-contenteditable-and-google-docs)).

## Build, load, test

```sh
cd apps/extension
npm run build        # production build -> apps/extension/build/ (unpacked extension)
node build.mjs --dev # unminified + sourcemaps
npm run watch        # dev build, rebuilds JS on change (re-run for manifest/static changes)
npx vitest run       # unit tests (pure modules only, no DOM)
npx tsc -p tsconfig.json
```

Load it: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose `apps/extension/build`.

Build output (about 19.7 MB, almost all of it the WASM):

| File | Size | Notes |
|---|---|---|
| `harper.wasm` | 20.4 MB (19.5 MiB) | harper.js 3.0.0 full binary, **renamed** (see Memory) |
| `offscreen.js` | ~157 KB | harper.js glue + `HarperEngine` |
| `content.js` | ~26 KB | injected into pages; contains no Harper code |
| `background.js` / `popup.js` | ~3 KB / ~2 KB | |
| `icons/icon-{16,32,48,128}.png` | <2 KB | drawn by `scripts/icons.mjs` at build time (white G on #5c6b54) |
| `licenses/harper.js-LICENSE.txt` | | Apache-2.0 notice for the bundled engine |

## Architecture

```
 page (any tab)                      extension
 ┌───────────────────────┐   check{text,version}   ┌──────────────────┐  lint{text,version,options,addWords}  ┌──────────────────────────┐
 │ content.js            │ ───────────────────────▶│ background.js    │ ─────────────────────────────────────▶│ offscreen.html/.js       │
 │  focusin → controller │ ◀─────────────────────── │ (MV3 service     │ ◀─────────────────────────────────────│  ONE HarperEngine        │
 │  mirror + badge + card│   Suggestion[]          │  worker)         │          Suggestion[]                 │  (LocalLinter + WASM)    │
 └───────────────────────┘                         │  creates/closes  │ ◀── offscreenIdle (after 5 min) ──────│  idle timer              │
          ▲  getSiteInfo                           │  the offscreen   │                                       └──────────────────────────┘
          └──── popup.js (settings in storage.sync) └──────────────────┘
```

- **One engine for the whole browser.** Harper runs only in the offscreen document. Tabs never load it.
- **Lazy creation.** The service worker creates the offscreen document on the first check request, which
  only comes after a user focuses an eligible field that contains non-blank text. Focusing an empty
  field costs nothing.
- **Idle shutdown.** The offscreen document restarts a 5-minute timer on every request. When it
  expires, the document sends `offscreenIdle`, which wakes the service worker, and the worker calls
  `chrome.offscreen.closeDocument()`. That frees all of Harper's memory. The timer lives in the
  document because Chrome stops an idle MV3 service worker after about 30 s, so a timer there would
  never fire. The worker ignores the idle notice if a check is in flight or arrived in the last 30 s.
- **Offscreen reason: `WORKERS`.** Chrome has no "WebAssembly/compute" reason. `WORKERS` ("needs to spawn
  workers") is the closest honest description: the document exists only as a background compute host.
  `DOM_PARSER` would be misleading because we never use `DOMParser`. If Web Store review objects, move
  the `LocalLinter` into a dedicated worker started from the offscreen page with
  `new Worker(chrome.runtime.getURL('engine-worker.js'))`. An extension URL is allowed by the CSP,
  unlike harper.js's blob: worker. That change is about 20 lines and makes the reason literally true,
  but it adds one more JS heap (a few MB).
- **Why `LocalLinter`.** harper.js's `WorkerLinter` builds its worker from a `blob:` URL, which the MV3
  extension CSP blocks. The WASM is fetched from `chrome.runtime.getURL('harper.wasm')`. The manifest
  CSP grants `'wasm-unsafe-eval'`, which WebAssembly compilation requires.
- **Offscreen documents can only use `chrome.runtime`.** Settings (dialect) and the personal dictionary
  therefore travel inside the `lint` message. The worker sends the full dictionary on the first lint
  after it starts or after it creates the document. After that it sends only new words. Importing
  words is idempotent.

### Message protocol (`src/protocol.ts`)

`runtime.sendMessage` from a content script reaches **every** extension page, both the worker and the
offscreen document, so every message has a `target`.

| Message | From → To | Purpose |
|---|---|---|
| `{target:'background', type:'check', text, version}` | content → worker | Returns `{ok:true, version, suggestions}` or `{ok:false, version, error:'disabled'\|'too_long'\|'engine_error'}` |
| `{target:'background', type:'addWord', word}` | content → worker | Saves the word to `storage.local` and pushes it to a running engine |
| `{target:'background', type:'offscreenIdle'}` | offscreen → worker | Asks the worker to close the document |
| `{target:'offscreen', type:'lint' \| 'addWords', …}` | worker → offscreen | The offscreen document ignores any sender that has `sender.tab` (content scripts) |
| `{target:'content', type:'getSiteInfo'}` | popup → content | Returns `{host}` (avoids the `tabs`/`activeTab` permissions) |

The worker re-checks the global switch and the per-site switch against `sender.url` as defence in depth.
It also rejects texts over 20,000 characters (`MAX_CHECK_CHARS`). The content script only keeps
suggestions where `text.slice(start,end) === original` for the version it sent.

## Content script behaviour

Code: `src/content.ts` (controller), `src/overlay.ts` (Shadow DOM UI), `src/apply.ts`.

- **Idle cost on every page:** one capture-phase `focusin` listener and one `runtime.onMessage` listener.
  Settings are read on the first focus. Nothing else runs until an eligible field is focused.
- **Eligibility** (`src/eligibility.ts`, unit-tested). Checked when a field is focused and **again before
  every check request**. Text is never read from:
  - `type=password`, or any input type other than text/search (so not email, url, tel, number, …)
  - fields whose `autocomplete` includes `cc-*`, `one-time-code`, `current-password`/`new-password`,
    `webauthn`, `username`, `email`, `tel*`, `bday*` or `transaction-*`
  - fields whose `name`/`id` looks secret (password, pwd, otp, cvv, card number, ssn, iban, token, api key, pin, …)
  - readonly or disabled fields, and fields that have or are inside `aria-hidden="true"`
  - fields inside `[data-grammarme="off"]`. We also honour Grammarly's `data-gramm="false"` and
    `data-enable-grammarly="false"` opt-outs, which many sites already use on code editors.
  - fields with `spellcheck="false"` (CodeMirror, Monaco, Ace, terminals) and tiny helper textareas (< 40×14 px)
  - sites the user disabled, or everything when the global switch is off
- **Checking:** 400 ms debounce after typing stops, at most one request in flight, and at most one
  queued re-run (`src/scheduler.ts`). If a result comes back for an older version, it is **rebased** onto
  the current text with core `rebaseSuggestions`. An out-of-order result is dropped. On every `input`,
  existing underlines are rebased so they stay in place before the next result arrives.
- **Underlines:** a transparent mirror `div` copies the field's computed font, spacing, padding,
  borders, wrapping, direction and scroll position. It adds padding for the scrollbar so text wraps
  the same way. Underlines are wavy `text-decoration` on transparent text, with `pointer-events: none`.
  The mirror is clipped to scrolling ancestors and the viewport. It is repositioned through one
  `requestAnimationFrame` per change, triggered by field scroll, window scroll (capture), resize and a
  `ResizeObserver`. Text is inserted with `textContent` only, never `innerHTML`.
- **Shadow DOM:** all UI sits inside a closed shadow root on a `<grammarme-overlay>` host. Styles are
  applied as a constructed `CSSStyleSheet`, so a page CSP `style-src` cannot block them, and page CSS
  cannot reach them.
- **Card:** clicking inside an underline, or moving the caret into one with arrow keys, opens a card.
  The card shows the category, the message, up to 3 replacements, **Ignore**, and **Add to dictionary**
  (spelling only). It has `role="dialog"` and aria-labels on every button. **Esc** closes it, from the
  field or from inside the card. While a card is open, **Tab** moves into it. Clicks on the card don't
  move focus or the caret out of the field.
- **Applying** (only on click): `applySuggestion` first checks the version and the text, then
  `focus()` → `setSelectionRange(start,end)` → `execCommand('insertText')` (or `'delete'` for
  removals). This keeps native undo working, and React/Vue controlled inputs receive a real `input`
  event. The fallback is `setRangeText` plus a dispatched `input` event. If the suggestion is stale,
  nothing is changed and the field is re-checked.
- **Badge:** sits inside the field's bottom-right corner, clear of the scrollbar and resize grip, and
  is vertically centred for inputs. It shows the issue count (red), `✓` (green), `…` while checking,
  `–` if the text is too long, or `!` on error. Clicking it opens the first issue.
- **Ignore** is per field, for the current page session, and keyed by rule + text. **Add to dictionary**
  saves the word in `chrome.storage.local` (local only, up to 5,000 words) and hides matching spelling
  issues immediately.

## Popup

`static/popup.html` and `src/popup.ts` provide: a global on/off switch, on/off for the current site
(hostname without `www.`), dialect (US/UK/Canada/Australia/India), a link to the web editor, and a
privacy note. Settings live in `chrome.storage.sync` under `settings`. The popup asks the page's content
script for its hostname, so the extension needs no `tabs` or `activeTab` permission. On pages where
content scripts can't run (`chrome://`, the Web Store, tabs opened before installation), the site
switch is disabled and the popup explains why.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings (sync) and the personal dictionary (local) |
| `offscreen` | The single Harper host document |
| content script on `<all_urls>` | Underlines must be available on any site with a textarea. This shows the install warning "Read and change all your data on all websites". |

There are no `host_permissions`, no `tabs`, no `activeTab` and no network access. The extension
makes no `fetch` calls besides loading its own `harper.wasm`.

**Alternative: `activeTab` with on-demand injection.** Replace `content_scripts` with `activeTab` +
`scripting` and inject `content.js` only when the user clicks the toolbar button or presses a shortcut.
This removes the "all websites" warning and runs no code on pages the user hasn't opted into. The cost
is one click per tab and page load, which is a Grammarly-unlike experience. A middle ground is
`optional_host_permissions: ["<all_urls>"]` plus a popup button "Enable on all sites", with
`chrome.scripting.registerContentScripts` after the user grants it. The owner should decide; see the
questions below.

## Memory and CPU design (8 GB MacBook)

- **One Harper instance.** Measured in Node: ~600 ms setup and ~5 ms per sentence lint. A 12-word check
  took 5 ms on a warm engine; the first check, including WASM load, took about 630 ms. Process RSS
  was about 370–430 MB in Node. Chrome's figure for the offscreen renderer is **not measured yet**.
  Check it in Chrome's Task Manager (manual test step 9).
- **Binary renamed to `harper.wasm` (saves about 54 MB of RSS).** In harper.js 3.0.0, when the binary
  URL contains `harper_wasm_bg.wasm`, the library *also* initialises the slim binary
  (`getDefaultGlueBinary`). Measured in Node with identical lint output: standard name 428 MB RSS,
  renamed 374 MB, slim-only 378 MB. Only one 20 MB binary ships.
- The engine is freed after 5 minutes idle. Empty fields never start it. Texts over 20k characters are
  not checked.
- Content-script cost while idle is near zero. While a field is active, work is event-driven (no
  polling): one rAF per scroll or resize, and a mirror rebuild on input of O(text length) with
  2×issues + 1 nodes.

## Manual test plan (Chrome 116+)

1. Run `npm run build`, then **Load unpacked** `apps/extension/build`. Confirm the service worker has no
   errors. In Task Manager, confirm there is **no** offscreen document yet.
2. Open a page with a textarea (for example `data:text/html,<textarea rows=8 cols=60></textarea>`, or a
   GitHub comment box). Focus the textarea. The badge appears. The engine has not started yet.
3. Type `I has a apple. This is teh best.` and stop. Within about 1 s (the first run includes WASM
   load), red wavy underlines appear under `has`, `a` and `teh`, and the badge shows the count.
4. Click `teh`. A card appears. Click `the`. The text changes, **Cmd+Z** undoes it, and the other
   underlines stay aligned.
5. Keep typing before an underline. The underlines shift with the text and are re-checked after you
   pause.
6. Use the arrow keys to move into an underline. The card opens. **Tab** moves into the card and **Esc**
   returns to the field.
7. **Ignore** removes that issue. **Add to dictionary** on a made-up word removes it, and it stays
   removed after a reload.
8. Test the textarea's scrollbar, resize grip, page scroll and window resize, and a textarea inside a
   scrolling `div`. The underlines must stay glued to the text and clipped to the visible area.
9. Open Chrome's Task Manager and note the "Extension: GrammarMe" offscreen process memory. Leave it
   idle for more than 5 minutes; the process should disappear. Type again; it should come back.
10. Privacy: a `type=password` field, `autocomplete="cc-number"`, `name="otp"`, a field inside
    `data-grammarme="off"`, readonly, and `spellcheck="false"` (for example a CodeMirror editor) must get
    **no** badge or underlines.
11. Popup: turn the current site off. The underlines disappear immediately and stay off after a reload.
    Type `The colour of the color.`: in US English only `colour` is flagged; switch the dialect to UK and only `color` is flagged (verified in Node with harper.js).
12. React-controlled textarea (any React demo): apply a fix, then submit. The app state must contain
    the fixed text.
13. Reload the extension while a page is open. The old overlay must tear itself down without
    console spam.

## Known limitations

- Not loaded or verified in Chrome yet. The overlay geometry, `execCommand` behaviour and the
  offscreen lifecycle have only been reviewed in code and unit-tested at the pure-logic level.
- Iframes are skipped (`all_frames: false`). Some comment widgets live in iframes. Turning this on runs
  the content script in every frame.
- Textareas with CSS transforms or zoom, or with a `position: sticky` header overlapping them, can
  misalign the underlines or show them above the header.
- A "show password" toggle that switches an input from `password` to `text` is only caught if the field's
  name, id or autocomplete marks it as a password. Eligibility is re-checked before every request.
- Ignore is per page session. There is no UI to remove dictionary words yet; that needs
  `Linter.clearWords()` and a re-import.
- `document.execCommand` is deprecated but still the only way to keep native undo. The fallback breaks
  undo.
- Harper only. AI suggestions (clarity/tone) are not wired into the extension. Doing so would send text
  off the device and needs explicit per-request consent.

## Optional ChatGPT check

When ChatGPT is connected, a teal **AI** button appears beside GrammarMe's badge on supported
fields. It opens a panel where the user picks Grammar, Clarity or Tone and sees the exact text to
be sent. It then sends that text through the local companion. The resulting edits are ordinary
suggestions with `source: 'ai'`, marked "· ChatGPT" on their cards.

- Code: `src/ai-scope.ts` (what is sent; placing edits), `src/ai-protocol.ts` (messages),
  `src/companion-client.ts` (native messaging), `src/popup-ai.ts` (connection UI).
- The manifest pins the extension ID with `key`, so the companion can allow exactly this ID.
- `nativeMessaging` is an *optional* permission, requested only when the user chooses Continue
  with ChatGPT.
- User guide: [chatgpt.md](chatgpt.md). Design: [architecture](architecture.md#optional-chatgpt-companion).
- **Tested (mock OpenAI):** `npm run e2e:chatgpt -w apps/extension` runs the real extension in an
  isolated Chrome profile. Chrome launches the real companion over native messaging, and OpenAI's
  auth and API are a local mock. It checks:
  - Sign-in: PKCE and the 127.0.0.1 callback, with the credentials file at `0600`.
  - Popup: the account, models and Test connection.
  - Checking text: the AI button, the exact preview, and edits placed and accepted with undo. A
    numeric rewrite is dropped by the guards.
  - Failures: the usage-limit message with Manage usage, local checks still working, and cancel
    aborting the upstream request.
  - Disconnect: it revokes the session, deletes the tokens and hides the AI button.
  - Every request to OpenAI has `store: false` and `stream: true`, with no unsupported fields.
  - The test copy makes `nativeMessaging` a required permission, because automation can't click
    Chrome's permission prompt.
- **Not tested:** a real ChatGPT account, OpenAI's real consent screen, and real inference.

## Rich-text editors (contenteditable) and Google Docs

- **contenteditable (Gmail, Outlook on the web, Quill, …)** — supported since 2026-11-05.
  1. `src/rich-text.ts` flattens the editing host into plain text with a **text-node offset map**
     (string offset ↔ `{node, offset}`). `<br>` and block elements become `\n`; text characters map
     1:1 (no-break spaces become spaces), so offsets never shift. Quoted replies (`.gmail_quote`,
     Outlook's `#divRplyFwdMsg`, …), `contenteditable="false"` islands, hidden and opt-out subtrees
     are skipped: they aren't the user's writing.
  2. Underlines are **thin bars drawn in the overlay's Shadow DOM** at `Range.getClientRects()`,
     clipped to the visible editor. Nothing is inserted into the editor. (The plan was the CSS Custom
     Highlight API; it was dropped because `::highlight()` rules must live in a page-level stylesheet
     that the page's CSS and CSP can interfere with, and its underline styling is limited.)
  3. A fix builds a `Range` from the map, selects it and calls `execCommand('insertText')`, so the
     editor's own model and undo stay correct. If the text afterwards isn't exactly what was
     expected, GrammarMe does not touch the DOM; it re-reads the text and checks again.
  4. The map is rebuilt on `input` and, through a `MutationObserver`, on edits the page makes itself.
  5. For rich editors `spellcheck="false"` is ignored (Gmail can set it to follow its own setting);
     code editors are skipped by class instead (CodeMirror, Ace, Monaco, `<pre>`/`<code>`).
  - **Tested** (headless Chrome 156, `npm run e2e -w apps/extension`, which drives `e2e/rich.mjs`): a Gmail-style
    compose box with a quoted reply and `spellcheck="false"`, and Quill 2.0.3. In both, typing two
    lines with mistakes gave 5 underlines about 0.8 s later, the quoted reply's mistakes were not
    flagged, "has → have" applied and Cmd+Z undid it, and underlines followed the text when the
    editor scrolled and disappeared when their line scrolled out of view.
  - **Not tested:** real Gmail (needs a signed-in account), Notion, Slack, LinkedIn, Lexical,
    Draft.js, very long documents. Editors inside iframes (TinyMCE, CKEditor 4 classic) aren't
    reached because the content script runs in the top frame only.
- **Google Docs.** It renders to canvas, so there is no editable text DOM to read or underline. Options:
  the Docs "annotated canvas" accessibility mode, which Google offers to approved extensions (requires
  their allow-list), or a Docs add-on built on Apps Script (a separate product, and text goes to Google's
  servers). Recommendation: don't support Google Docs; point users to the web editor.

## Required core changes (requested from the core owner)

1. **`HarperEngine.configure` loses the dictionary and rule config on a dialect change.** In harper.js
   3.0.0, `LocalLinter.setDialect()` frees and recreates the inner linter, so imported words (and
   `setLintConfig`) are lost. After `setDialect`, `HarperEngine` should re-import the words it has
   added (keep a `Set`) and re-apply the disabled-rules config. Reproduced in the extension smoke
   harness: a word added to the dictionary was flagged again after switching dialect. The extension
   works around this in `src/offscreen.ts`. The web app likely has the same bug.
2. Optional: export a `DEFAULT_BINARY_NAME` note, or document in `harper.ts` that the binary URL must not
   contain `harper_wasm_bg.wasm` when using the full flavour, to avoid double-loading about 50 MB.

## Open questions for the owner

1. ~~What is the URL of the web editor?~~ Answered: `https://bachnguyennn.github.io/GrammarMe/editor/`.
2. Keep `<all_urls>` with its install warning, or use the on-demand `activeTab` /
   optional-host-permission model described above?
3. Should GrammarMe check `input[type=search]`? It currently does; search queries are short and rarely
   need fixing.
4. Should the iframe support be turned on (`all_frames: true`)?
