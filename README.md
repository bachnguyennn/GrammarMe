# GrammarMe

A free, private, Grammarly-style writing assistant.

**Try it:** [bachnguyennn.github.io/GrammarMe](https://bachnguyennn.github.io/GrammarMe/) (the
editor is at [/editor/](https://bachnguyennn.github.io/GrammarMe/editor/)).

- **Real-time spelling, grammar and punctuation checks** that run entirely on your device. Nothing
  you type is sent anywhere.
- **Underlines with explanations and one-click fixes**: accept, dismiss, undo (Cmd/Ctrl+Z), add to
  dictionary, or turn a rule off.
- **Writing modes** (Standard, Academic, Professional, Casual) and five English dialects.
- **Optional AI check** for clarity, fluency and tone. It is off by default, runs only when you press
  the button, and uses your own free Cloudflare Worker. Edits are kept small and must preserve your
  meaning and voice.
- **Chrome extension** for text boxes on websites, including Gmail and other rich-text editors.
- **$0 to run.** No subscriptions, no paid APIs, light enough for an 8 GB laptop.

The grammar engine is [Harper](https://writewithharper.com) (Apache-2.0), compiled to WebAssembly.

## Quick start

Requires Node 22.6+.

```bash
npm install
npm run dev          # web editor at http://localhost:5173
npm test             # all unit tests
npm run eval         # grammar accuracy + latency evaluation (tests/eval)
```

### Product website

```bash
npm run build:site   # apps/site/dist: product page at /, editor at /editor/, extension zip, install page
```

`apps/site/dist` is a static folder you can host for free anywhere. Every push to `main` runs the
tests and deploys it to GitHub Pages (`.github/workflows/pages.yml`). No server or secrets are
involved; the optional AI Worker is not part of the site.

### Chrome extension

**No building needed:** download
[GrammarMe-extension.zip](https://bachnguyennn.github.io/GrammarMe/GrammarMe-extension.zip) and
follow the [five install steps](https://bachnguyennn.github.io/GrammarMe/install.html).

From source:

```bash
npm run build -w apps/extension
```

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose
`apps/extension/build`. See [docs/extension.md](docs/extension.md) for what works where.

### Optional: AI suggestions

See [workers/ai-api/README.md](workers/ai-api/README.md) to deploy the free Cloudflare Worker. Then
open **Settings → Cloud AI suggestions** in the editor, paste the Worker URL and your access token,
and press **AI check**.

## How it stays private

| What | Where it goes |
| --- | --- |
| Text you type | Nowhere. Checked by Harper inside your browser. |
| Personal dictionary, settings, draft | Your browser's local storage only (draft autosave can be turned off). |
| AI check (opt-in, per click) | Your own Worker, then the model provider you configured. Up to 4,000 characters per request; never logged by the Worker. Check your provider's data terms (see [docs/llm-research.md](docs/llm-research.md)). |

## Project layout

```
packages/core     shared Suggestion contract, offset-safe edit helpers, Harper adapter
apps/web          React + Vite editor
apps/site         product website (static HTML on the taste-skill design system)
apps/extension    Chrome MV3 extension
workers/ai-api    optional Cloudflare Worker for AI suggestions
tests/eval        labelled dataset + accuracy/latency runner
docs/             architecture, decisions, evaluation, research
```

Read [docs/architecture.md](docs/architecture.md) and [docs/decisions.md](docs/decisions.md) for the
reasoning behind each choice.

## License

MIT for GrammarMe's own code. Harper is Apache-2.0.
