# GrammarMe

A free, private, Grammarly-style writing assistant.

**Try it:** [bachnguyennn.github.io/GrammarMe](https://bachnguyennn.github.io/GrammarMe/) (the
editor is at [/editor/](https://bachnguyennn.github.io/GrammarMe/editor/)).

- **Real-time spelling, grammar and punctuation checks.** Spelling and grammar checks run on your
  device. Optional ChatGPT checks send text only when you request one.
- **Underlines with explanations and one-click fixes**: accept, dismiss, undo (Cmd/Ctrl+Z), add to
  dictionary, or turn a rule off.
- **Five English dialects**, and a Casual mode that hides style suggestions.
- **Optional ChatGPT check in the extension**: grammar, clarity and tone edits using **your own
  ChatGPT Plus/Pro plan**, with no API key. It needs a small local companion program, installed
  with one pasted line. Text is sent only when you preview and confirm it
  ([guide](docs/chatgpt.md)).
- **Chrome extension** for text boxes on websites, including Gmail and other rich-text editors. You
  can drag its button anywhere in the box.
- **$0 to run.** No subscriptions, no paid APIs, light enough for an 8 GB laptop. The optional ChatGPT
  check uses a ChatGPT plan you already have.

The grammar engine is [Harper](https://writewithharper.com) (Apache-2.0), compiled to WebAssembly.

## Quick start

Requires Node 22.6+.

```bash
npm install
npm run dev          # web editor at http://localhost:5173
npm test             # all unit tests
npm run typecheck    # TypeScript checks in every package
npm run eval         # grammar accuracy + latency evaluation (tests/eval)
```

### Product website

```bash
npm run build:site   # apps/site/dist: product page at /, editor at /editor/, extension zip, install page
```

`apps/site/dist` is a static folder you can host for free anywhere. Every push to `main` runs the
tests and deploys it to GitHub Pages (`.github/workflows/pages.yml`). No server or secrets are
involved.

### Chrome extension

**No building needed:** download
[GrammarMe-extension.zip](https://bachnguyennn.github.io/GrammarMe/GrammarMe-extension.zip) and
follow the [five install steps](https://bachnguyennn.github.io/GrammarMe/install.html).

From source:

```bash
npm run build -w apps/extension
```

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose
`apps/extension/build`. `npm run e2e -w apps/extension` runs the end-to-end checks in headless
Chrome. See [docs/extension.md](docs/extension.md) for what works where.

### Optional: ChatGPT in the extension

Choose **Continue with ChatGPT** in the extension's toolbar menu. It walks you through two
steps: pasting one line into Terminal (macOS or Linux, no Node needed), then signing in to ChatGPT:

```bash
curl -fsSL https://bachnguyennn.github.io/GrammarMe/companion/install.sh | sh
```

From source: `npm run install-host -w apps/companion`.

Full steps, eligibility, what is sent, and troubleshooting: [docs/chatgpt.md](docs/chatgpt.md).

## How it stays private

| What | Where it goes |
| --- | --- |
| Text you type | Nowhere. Checked by Harper inside your browser. |
| Personal dictionary, settings, draft, button position | Your browser's storage, never a GrammarMe server (draft autosave can be turned off). The extension's settings use Chrome's sync storage, so they follow your Chrome profile if Chrome sync is on. |
| ChatGPT check (extension, opt-in, per send) | The local companion, then OpenAI, using your plan. Up to 4,000 characters, only after you preview them and press **Send to ChatGPT**. Sign-in credentials stay in a private file on your computer ([details](docs/chatgpt.md#what-is-sent-where-it-goes-what-is-stored)). |

## Project layout

```
packages/core     shared Suggestion contract, offset-safe edit helpers, Harper adapter, AI prompts + guards
apps/web          React + Vite editor
apps/site         product website (static HTML on the taste-skill design system)
apps/extension    Chrome MV3 extension
apps/companion    optional local companion for the extension's ChatGPT check
tests/eval        labelled dataset + accuracy/latency runner
docs/             architecture, decisions, evaluation, setup guides
```

Read [docs/architecture.md](docs/architecture.md) and [docs/decisions.md](docs/decisions.md) for the
reasoning behind each choice. What changed in each version is in [CHANGELOG.md](CHANGELOG.md), and
the steps for cutting a version are in
[docs/architecture.md](docs/architecture.md#releases-and-deployment).

## License

MIT for GrammarMe's own code. Harper is Apache-2.0.
