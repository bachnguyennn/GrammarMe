# Agent handoffs — milestone 1 (2026-11-04)

Four workstreams ran in parallel, each in its own folder, coordinated by the Lead Architect.
Test counts below are from actual runs on the date above.

> **This is a record of milestone 1, not the current status.** For that, see
> [`extension.md`](extension.md), [`evaluation.md`](evaluation.md) and the
> [changelog](../CHANGELOG.md).

| Workstream | Owner | Folder | Tests |
| --- | --- | --- | --- |
| Architecture, core contract, web editor | Lead + Frontend/Grammar (same agent) | `packages/core/src`, `apps/web`, `docs/architecture.md`, `docs/decisions.md` | web 6/6 |
| Chrome extension | Extension engineer | `apps/extension`, `docs/extension.md` | 35/35, tsc clean, build 19.7 MB (mostly WASM) |
| AI Worker + provider research | LLM + Backend/Security engineer | `workers/ai-api`, `docs/llm-research.md` | 79/79 (fetch mocked), tsc clean, `wrangler deploy --dry-run` OK |
| QA, evaluation | QA engineer | `packages/core/test`, `tests/eval`, `docs/evaluation.md` | core 158/158 (+2 todo) |

## Cross-team issues found and resolved

1. **Dialect switch dropped the dictionary and disabled rules.** Found by the extension engineer and
   confirmed by QA. harper.js 3.0.0 rebuilds the linter in `setDialect`. Fixed in `HarperEngine`;
   regression tests were added.
2. **Concurrent mixed-dialect checks crashed the WASM** (QA). Fixed by serializing checks.
3. **AI quote placement was ambiguous when `contextBefore` didn't match** (QA). Fixed in `locateAiEdit`.
4. **Unicode rebase gaps** with combining marks and astral letters (QA). Fixed in `isWordChar`.
5. **harper.js can't load WASM from a file path containing spaces in Node** (Lead). The tests and
   eval copy the WASM to a temp directory.
6. **TS parameter properties broke Node type-stripping** for the eval runner (Lead). `packages/core`
   now enforces `erasableSyntaxOnly`.

## Not yet verified

- The extension has not been loaded into a real Chrome yet. It was tested only with unit tests and
  a Node harness. There is a manual plan in `docs/extension.md`.
  - Done 2026-11-05: see the next section.
- The AI Worker has not been called against a real provider (no keys were used), and AI correction
  quality is unmeasured.
- In-browser memory use has not been measured. Node RSS with Harper loaded is about 370 MB.

## Next phase recommendations

- Load the extension and run the manual test plan. Then add contenteditable support (Gmail etc.)
  using the CSS Custom Highlight API.
  - Done 2026-11-05: loaded in headless Chrome 156 (`npm run e2e -w apps/extension`), and
    contenteditable support added with drawn underlines instead of the Highlight API
    (`src/rich-text.ts`, `src/editable.ts`). Real Gmail still needs a hand check by the owner.
- Deploy the Worker on a free Cloudflare account and run `tests/eval` through the AI engine to
  compare Groq, Workers AI and (if accepted) Gemini on identical examples.
  - Dropped 2026-11-06: the Worker was removed (decision D13).
- Measure Chrome memory for the web app and the extension's offscreen document.
