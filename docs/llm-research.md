# LLM provider research: free tiers, privacy, recommendation

*Researched 2026-11-04 by reading the official docs pages listed under each section (all accessed 2026-11-04).
Free tiers change often. Re-check the linked pages before you rely on any number here.*

**Scope.** This covers the web editor's opt-in cloud AI check (`workers/ai-api`). Local Harper checking does
not depend on any of it, and the extension's ChatGPT check is separate ([`chatgpt.md`](chatgpt.md)). Constraints: $0/month, personal use, no stored text, no exposed keys.

**Labels used below:**
- **Verified**: read on an official page today.
- **Unverified**: from third-party sources only, or not stated in official docs.
- **Estimate**: arithmetic from verified prices. Not a measurement.

---

## 1. Summary table

| | Google Gemini API (free tier) | Groq (free plan) | Cloudflare Workers AI (free allocation) |
|---|---|---|---|
| Models we would use | `gemini-3.5-flash-lite` (stable). Others with a free tier: `gemini-3.1-flash-lite`, `gemini-3.6-flash`, `gemini-3.8-flash`, `gemini-3-flash-preview` (**verified**: pricing page says "Free of charge") | `openai/gpt-oss-20b` (production; strict JSON schema). Alt: `openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` (**verified**: models page) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` or `@cf/meta/llama-3.1-8b-instruct` (both on the JSON Mode list, **verified**) |
| Free quota | Google publishes no numbers. The docs say "View your active rate limits in AI Studio" and "Limits vary depending on the specific model". Third-party blogs quote ~15–30 RPM and 100–1,500 RPD for Flash/Flash-Lite and contradict each other (**unverified**) | Public page shows only the Developer-plan table and points to the console for Free-plan limits. Third-party sources give gpt-oss-20b as 30 RPM / 1K RPD / 8K TPM / 200K TPD and llama-3.1-8b-instant as 30 RPM / 14.4K RPD (**unverified**) | 10,000 Neurons/day on Free and Paid plans, reset 00:00 UTC. On Free, "further operations will fail with an error" once used (**verified**). Text generation is rate-limited at 300 req/min (**verified**) |
| Structured output | `generateContent` with `responseMimeType: application/json` + `responseJsonSchema` (**verified**, API reference) | `response_format: json_schema`, `strict: true` on gpt-oss-20b/120b (**verified**). Streaming isn't supported with structured outputs | JSON Mode (`response_format: json_schema`) on a short model list. Docs: "can't guarantee" schema adherence; failures raise "JSON Mode couldn't be met" (**verified**) |
| Trains on your prompts? | **Yes on the unpaid tier.** Pricing page "Used to improve our products": Free = Yes, Paid = No. Terms: human reviewers "may read, annotate, and process your API input and output" (**verified**) | No. Services Agreement §4.2: "Groq is not permitted to use Inputs or Outputs for training or fine-tuning" (**verified**) | No. "Cloudflare does not use Customer Content processed by Workers AI to train AI models" (**verified**) |
| Retention | Unpaid: no retention period stated. Paid: logged "for a limited period of time" for abuse detection (**verified**). The newer Interactions API stores state server-side by default (`store=true`); `generateContent` doesn't (**verified**, migration guide) | "By default, Groq does not retain customer data for inference requests." Logs may be kept up to 30 days for troubleshooting or abuse; Zero Data Retention is a console toggle for "all customers" (**verified**). Whether the toggle works on the free plan isn't stated explicitly (**unverified**) | Inputs and outputs aren't retained "after they are no longer needed to process the request", with exceptions for opt-in storage features and legal obligations (**verified**) |
| Other restrictions | 18+ only. Unpaid tier must not be used for apps offered to users in the **EEA, Switzerland or UK**. "Do not submit sensitive, confidential, or personal information to the Unpaid Services." Intended for "professional or business purposes" (**verified**, terms) | "Not for consumer use" (Services Agreement), which fits a developer using their own key. Free services have a liability cap and no indemnity (**verified**) | Needs a Cloudflare account. No extra key, because it is a Worker binding |
| Key handling | API key in `x-goog-api-key` header (Worker secret) | Bearer key (Worker secret) | No key (binding) |

### Rough capacity per request (**estimate**, not measured)

Our system prompt is about 2.2k characters, roughly 550 tokens by the chars/4 rule of thumb. A
1,000-character document adds about 250 tokens. Output for a few edits is about 200 tokens.

- **Workers AI**, from the verified Neuron prices per million tokens:
  - llama-3.3-70b-fp8-fast: 800 × 0.026668 + 200 × 0.204805 ≈ 62 Neurons per request, so about 160 requests/day.
  - llama-3.1-8b-instruct: 800 × 0.025608 + 200 × 0.075147 ≈ 36 Neurons per request, so about 280 requests/day.
  - A full 4,000-character input on the 70B model costs about 82 Neurons, so about 120 requests/day.
- **Groq gpt-oss-20b**, if the unverified 8K TPM / 200K TPD figures are right: about 1–1.5k tokens per request
  (reasoning tokens count as output) gives roughly 6–8 requests/min and 130–200 requests/day.
- **Gemini**: no estimate possible until the owner reads the actual limits in AI Studio.

The Worker's `DAILY_REQUEST_CAP` defaults to 200. Lower it to stay under the smallest quota in your chain.

---

## 2. Cloudflare Workers platform (hosting the API)

| Item | Workers Free plan | Status |
|---|---|---|
| Requests | 100,000/day, reset at midnight UTC. Over the limit, Cloudflare returns error 1027 | verified |
| CPU time | 10 ms per HTTP request. Waiting on network (the LLM call) does not count | verified |
| Subrequests | 50 per invocation. Our worst case is 3, one per provider | verified |
| Memory | 128 MB per isolate | verified |
| Rate Limiting binding | Configured with `[[ratelimits]]` (`simple.limit`, `period` of 10 or 60 s), needs Wrangler ≥ 4.36.0. Counts are "eventually consistent" and local to each Cloudflare location | verified |
| Rate Limiting binding on the **Free** plan | The docs don't say. Community threads ask the same question with no official answer | **unverified** |

How the Worker handles this: if the binding exists it is used. If `wrangler deploy` rejects it, delete the
`[[ratelimits]]` block and the Worker falls back to an in-memory limiter. That limiter is per isolate and
best-effort only.

CPU budget: a local Node micro-benchmark of `sanitizeEdits` on 4,000 characters with 50 proposed edits took
about 0.36 ms (Apple Silicon). This is indicative only and has not been measured on Workers.

---

## 3. Privacy notes (important)

1. **Gemini free tier vs. GrammarMe's privacy promise.**
   - On the unpaid tier, Google may use submitted text and responses to improve its products, and human
     reviewers may read them.
   - Google's own terms say not to send "sensitive, confidential, or personal information" to the unpaid
     tier. A writing assistant routinely sees exactly that kind of text: emails, applications, health or
     legal notes.
   - The unpaid tier also can't be used for apps offered to users in the EEA, Switzerland or UK.
   - **Recommendation:** keep Gemini out of the default chain. Enable it only if the owner explicitly
     accepts these terms, and tell the user in the opt-in UI. The paid tier removes the training clause but
     breaks the $0 constraint.
2. **Groq**: contractually no training. No retention by default, but abuse and troubleshooting logs may be
   kept up to 30 days. Turn on **Zero Data Retention** in the Groq console under Data Controls; we haven't
   confirmed it works on the free plan.
3. **Workers AI**: no training and no retention, and the text never leaves Cloudflare, where the Worker
   already runs. Don't enable AI Gateway logging or caching, because those would store prompts.
4. **Our Worker** doesn't store or log text:
   - Logs carry metadata only: task, mode, character count, provider, latency, and edit/drop counts.
     A test asserts that the document text never appears in logs.
   - Upstream error bodies are never logged or forwarded, because they may echo the user's text.
   - The optional KV binding stores one integer per UTC day.
   - Observability is disabled in `wrangler.toml` by default.
5. **Gemini Interactions API:** Google now recommends it over `generateContent`, but it stores state
   server-side by default. We use the stateless `generateContent`, which Google calls "legacy" but still
   supports. If we migrate, we must send `store: false`.

---

## 4. Recommendation

**Default chain: `groq` → `workers-ai`. Gemini stays opt-in and off by default.**

- **Groq `openai/gpt-oss-20b` first.** It has the best verified privacy terms of the three external APIs
  (no training, ZDR available), strict JSON-schema output (fewer malformed responses), and a free plan with
  no card required.
- **Workers AI fallback.** It needs no extra key, has no training and no retention, uses the same Cloudflare
  account, and has a hard free ceiling of 10k Neurons/day with no surprise billing on the Free plan. Its JSON
  Mode is weaker, which the server-side sanitiser absorbs.
- **Gemini** is implemented and tested, but switched on only when the owner accepts the free-tier data terms
  and isn't serving EEA/UK/CH users.

**This is not a quality ranking.** We have no measured evaluation yet, and nothing here claims one model
corrects better than another.

---

## 5. How to evaluate (proposal for `tests/eval/`)

The QA agent is building a dataset at `tests/eval/`. Proposed protocol:

1. **Dataset.** Each item is `{text, task, mode, expectedEdits[], mustNotChange[]}`.
   - Include clean texts, where the correct answer is no edits.
   - Include adversarial texts: names, numbers, URLs, code, negations, and prompt-injection lines such as
     "ignore previous instructions".
2. **Run** each provider and model through the real Worker code path (`buildSystemPrompt` → provider →
   `sanitizeEdits` → `locateAiEdit`). Pin `PROMPT_VERSION` and the model id in every result row.
3. **Metrics.** Compute every metric before and after the sanitiser, so we can see what the guards remove.
   - Precision, recall and F0.5 on applied edits (precision-weighted, as in GEC evaluation; compare the
     corrected text against references).
   - **False-positive rate on clean text.** This is the most important metric for user trust.
   - **Meaning-violation rate:** applied edits that change a `mustNotChange` span.
   - Edits dropped per guard (the `dropped` histogram in the logs).
   - Schema-failure rate, p50/p95 latency, and tokens or Neurons per request.
4. **Decide** the default model per task from these numbers only. Re-run whenever the prompt version, the
   model id, or the guard thresholds change.

Also measure real free-plan limits during this run: read them from the Groq console and AI Studio, and
record the 429 behaviour. That replaces the unverified numbers above.

---

## 6. Sources (all accessed 2026-11-04)

**Google Gemini:**
- Pricing (free-tier models; "Used to improve our products"). `ai.google.dev/gemini-api/docs/pricing`
  redirects here: https://aistudio.google.com/docs/pricing
- Rate limits (no free-tier numbers published; points to AI Studio):
  https://aistudio.google.com/docs/rate-limits
- Terms (unpaid vs paid data use, human review, EEA/CH/UK, 18+, no sensitive data):
  https://aistudio.google.com/docs/terms
- Models and lifecycle (3.5 Flash-Lite stable; 2.5 Flash deprecated, routes to 3.5 Flash-Lite on
  2026-12-01; 2.0 Flash shut down): https://aistudio.google.com/docs/models
- generateContent reference (`responseJsonSchema`; temperature ignored on 3.6 Flash and newer;
  `thinkingConfig`): https://aistudio.google.com/api-reference/generate-content
- Interactions migration (server-side state by default, `store=false`):
  https://aistudio.google.com/docs/migrate-to-interactions
- "generateContent … is considered a legacy API": https://aistudio.google.com/llms.txt

**Groq:**
- Rate limits (Developer table only; 429 + `retry-after`; org-level limits):
  https://console.groq.com/docs/rate-limits
- Models: https://console.groq.com/docs/models
- Structured outputs: https://console.groq.com/docs/structured-outputs
- Reasoning (`reasoning_effort`, `include_reasoning`): https://console.groq.com/docs/reasoning
- Your data (retention, ZDR): https://console.groq.com/docs/your-data
- Services Agreement §4.2 (no training on Inputs/Outputs):
  https://console.groq.com/docs/legal/services-agreement

**Cloudflare:**
- Workers AI pricing (10,000 Neurons/day, per-model Neuron costs):
  https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers AI limits: https://developers.cloudflare.com/workers-ai/platform/limits/
- Workers AI JSON Mode: https://developers.cloudflare.com/workers-ai/features/json-mode/
- Workers AI data usage: https://developers.cloudflare.com/workers-ai/platform/data-usage/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

**Third-party (unverified figures only):**
- https://tinkerllm.com/blog/gemini-api-free-tier-limits-rate-quotas/
- https://yingtu.ai/en/blog/google-gemini-api-free-tier
- https://localaimaster.com/blog/groq-api-free-guide
- https://eesel.ai/blog/groq-pricing
