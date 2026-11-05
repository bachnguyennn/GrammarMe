# @grammarme/ai-api: opt-in AI check Worker

This Cloudflare Worker gives GrammarMe its optional cloud AI suggestions. Local Harper checks never touch
it. It runs on the Workers Free plan, stores no text, and logs metadata only. For provider choices,
free-tier limits and the privacy caveats, see [`docs/llm-research.md`](../../docs/llm-research.md).

## API

| Route | Auth | Returns |
|---|---|---|
| `GET /v1/health` | none | `{ status: "ok", aiAvailable, promptVersion }` |
| `POST /v1/check` | `Authorization: Bearer <GRAMMARME_CLIENT_TOKEN>` | `AiCheckResponse` or `AiErrorResponse` (types in `@grammarme/core`) |

Request body (`AiCheckRequest`):

```json
{ "text": "...", "task": "grammar|clarity|tone", "mode": "standard|academic|professional|casual", "documentVersion": 3 }
```

The response edits quote text and carry no offsets. The client turns them into offsets with `locateAiEdit()`.
When the server can, it attaches a real `contextBefore` so the client places each edit exactly where the
server validated it.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | Invalid JSON or fields. 404, 405 and 415 also use `bad_request` |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 403 | `unauthorized` | `Origin` header present but not in `ALLOWED_ORIGINS` |
| 413 | `too_long` | `text.length > MAX_INPUT_CHARS` (UTF-16 units, default 4000), or body > 64 KB |
| 429 | `rate_limited` | Per-client limit hit. `retryAfterSeconds` is set |
| 429 | `quota_exhausted` | `DAILY_REQUEST_CAP` reached, or **every** provider returned a quota error. `retryAfterSeconds` is set; the client should fall back to Harper only |
| 502 | `upstream_error` | All providers failed and at least one failure was not a quota error |
| 503 | `upstream_error` | Server misconfigured (no client token, or no provider) |

## Providers and fallback

`AI_PROVIDERS` sets the order. The default is `groq,workers-ai`. A provider whose key or binding is missing
is skipped. If a provider returns a 429, a 5xx, times out (`PROVIDER_TIMEOUT_MS`), returns unparseable
output, or is misconfigured, the Worker tries the next one.

| id | Default model | Output mode |
|---|---|---|
| `groq` | `openai/gpt-oss-20b` (`reasoning_effort: low`) | `response_format: json_schema`, strict |
| `workers-ai` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI JSON Mode |
| `gemini` | `gemini-3.5-flash-lite` | `generateContent` + `responseJsonSchema` (stateless). **Opt-in:** the free tier may use prompts for training. Read the research doc first |

Prompts live in `src/prompts.ts`. Bump `PROMPT_VERSION` whenever you change them.

## Meaning-preservation guards (`src/sanitize.ts`)

Model output is untrusted. An edit is **dropped**, never repaired, when any of these holds:

- **Wrong shape or category**
  - The fields have the wrong shape.
  - The category is not allowed for the task: grammar → spelling, grammar or punctuation; clarity →
    clarity or style; tone → tone or style.
- **Too long:** `original` is over 300 characters or `replacement` is over 400.
- **Doesn't place cleanly**
  - The edit is a no-op.
  - The quote doesn't occur literally in the text (a hallucinated quote).
  - The quote is ambiguous. This uses the same rule as the client's `locateAiEdit`.
- **Adds or removes line breaks.**
- **Touches a protected span:** a URL, email, `` `inline code` ``, file path, file name, `camelCase` or
  `snake_case` identifier, or `fn()` call.
- **Changes a protected token.** Numbers, URLs and code-like tokens must be identical as a multiset in
  the original and the replacement. So "5 May" → "May 5" is kept, but "5" → "five" is dropped.
- **Changes a name:**
  - A name-like capitalised word disappears. A word is name-like if it isn't at a sentence start, or if it
    is at a sentence start but isn't a common word.
  - Or a new capitalised word appears that isn't in the original or anywhere else in the document.
- **Changes the negation count** (not, no, never, n't, without, …).
- **Edits too much of the sentence:**
  - Word-level edit distance is above `max(floor, ratio × sentence tokens)`. Grammar uses 0.34 with a
    floor of 2; clarity and tone use 0.6 with a floor of 4.
  - Or the replacement is more than 3× the original's length plus 20 characters.
- **Overlaps an earlier edit, or goes past `MAX_EDITS`** (default 25).

These are deliberately conservative English heuristics. A dropped good edit costs little because Harper
still runs. A kept bad edit can silently change what the user meant. Tune the thresholds with the eval set
in `tests/eval/`, not by guesswork.

## Security and abuse controls

- **Auth:** shared bearer token, compared in constant time via SHA-256. If the secret is missing or
  shorter than 16 characters, the Worker returns 503 for every request.
- **CORS:** exact `ALLOWED_ORIGINS` entries, such as `chrome-extension://<id>`. `http://localhost:*` and
  `http://127.0.0.1:*` match any port. Requests that send an `Origin` not on the list get 403. Requests
  without an `Origin` (curl, server-side) still need the token.
- **Per-client rate limit:**
  - Uses the `RATE_LIMITER` binding when present (per Cloudflare location, approximate).
  - Otherwise an in-memory limiter per isolate (`RATE_LIMIT_PER_MINUTE`, best-effort).
  - The key is a truncated SHA-256 of token+IP; neither is stored.
- **Daily cap:** `DAILY_REQUEST_CAP` across all clients, reset at 00:00 UTC.
  - In-memory per isolate by default (best-effort).
  - Optionally, a `USAGE_KV` binding stores one integer per day. KV is approximate, and the free plan
    allows 1,000 writes/day.
  - The provider's own free quota is the hard backstop, and it maps to `quota_exhausted`.
- **No text at rest:**
  - Text exists only in memory during the request.
  - Logs hold metadata only (a test enforces this).
  - Upstream error bodies are never logged or returned.
  - `[observability]` is off by default.

## Setup (local)

```sh
cd workers/ai-api
cp .dev.vars.example .dev.vars        # fill in GRAMMARME_CLIENT_TOKEN (openssl rand -base64 32) and GROQ_API_KEY
npx wrangler dev                      # the [ai] binding calls Cloudflare even in dev and needs `wrangler login`
curl -s localhost:8787/v1/check -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"I has a apple.","task":"grammar","mode":"standard","documentVersion":1}'
```

## Deploy (owner, when ready)

```sh
npx wrangler login
npx wrangler secret put GRAMMARME_CLIENT_TOKEN
npx wrangler secret put GROQ_API_KEY            # optional
npx wrangler secret put GEMINI_API_KEY          # optional, opt-in (see docs/llm-research.md)
# edit ALLOWED_ORIGINS in wrangler.toml with your extension id, then:
npx wrangler deploy
```

If the deploy rejects `[[ratelimits]]`, delete that block. The docs don't say whether it is on the Free
plan, and the in-memory limiter takes over automatically.

## Tests

```sh
npx vitest run        # unit tests with fetch mocked; no network, no keys
npx tsc -p tsconfig.json
```

## Known limitations

- The rate limiter and daily cap are approximate. Cloudflare's binding counts per location, and in-memory
  state is per isolate. Real cost safety comes from the provider free tiers, which fail closed with
  `quota_exhausted`.
- `remaining` in the response is the global daily cap minus today's count, not a per-client number.
- The guards are English-centric. Non-English text may see more dropped edits.
- No streaming. One request checks the whole text, up to 4,000 characters.
- Detecting Workers AI quota errors relies on matching the error message, because no stable error code is
  documented.
