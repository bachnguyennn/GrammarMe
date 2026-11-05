/**
 * GrammarMe AI API — Cloudflare Worker.
 *
 *   GET  /v1/health  -> { status: "ok", aiAvailable, promptVersion }
 *   POST /v1/check   -> AiCheckResponse | AiErrorResponse   (Authorization: Bearer <GRAMMARME_CLIENT_TOKEN>)
 *
 * Privacy: request text is held in memory only for the duration of the request, is sent only to the
 * configured model provider(s), and is never logged or stored. Logs contain metadata only.
 */
import type { AiCheckResponse } from '@grammarme/core';
import { readConfig } from './env.ts';
import type { Config, Env } from './env.ts';
import { clientKey, corsHeaders, errorResponse, isOriginAllowed, json, safeEqual, secondsUntilUtcMidnight } from './http.ts';
import { BindingRateLimiter, KvUsageCounter, MemoryRateLimiter, MemoryUsageCounter } from './limits.ts';
import type { RateLimiter, UsageCounter } from './limits.ts';
import { PROMPT_VERSION, buildSystemPrompt, buildUserPrompt, editsJsonSchema } from './prompts.ts';
import { buildProviders, runWithFallback } from './providers/index.ts';
import type { ProviderError } from './providers/index.ts';
import { extractEditList, sanitizeEdits } from './sanitize.ts';
import { validateCheckRequest } from './validate.ts';

/** Hard ceiling on the request body, independent of MAX_INPUT_CHARS (JSON escaping can inflate). */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_QUOTA_RETRY_SECONDS = 60;

/** Per-isolate state. Exposed so tests can inject fresh instances. */
export interface State {
  memoryLimiter?: MemoryRateLimiter;
  memoryUsage?: MemoryUsageCounter;
}

const isolateState: State = {};

function rateLimiterFor(env: Env, config: Config, state: State): RateLimiter {
  if (env.RATE_LIMITER) return new BindingRateLimiter(env.RATE_LIMITER);
  state.memoryLimiter ??= new MemoryRateLimiter(config.ratePerMinute);
  return state.memoryLimiter;
}

function usageCounterFor(env: Env, state: State): UsageCounter {
  if (env.USAGE_KV) return new KvUsageCounter(env.USAGE_KV);
  state.memoryUsage ??= new MemoryUsageCounter();
  return state.memoryUsage;
}

/** Parses model output into the raw edit list, or null if it is unusable (triggers fallback). */
export function parseModelOutput(raw: unknown): unknown[] | null {
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return extractEditList(value);
}

function log(event: Record<string, unknown>): void {
  // Metadata only. Never add request text, edits, or upstream bodies here.
  console.log(JSON.stringify({ svc: 'grammarme-ai-api', ...event }));
}

export async function handleRequest(request: Request, env: Env, state: State = isolateState): Promise<Response> {
  const config = readConfig(env);
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');

  // CORS is a browser-side guard only; the bearer token is the real authentication. Requests without
  // an Origin (curl, server-to-server) are allowed through to the token check.
  if (origin && !isOriginAllowed(origin, config.allowedOrigins)) {
    return errorResponse('unauthorized', 'Origin not allowed.', {}, undefined, 403);
  }
  const cors = corsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (url.pathname === '/v1/health') {
    if (request.method !== 'GET') return errorResponse('bad_request', 'Method not allowed.', cors, undefined, 405);
    return json({ status: 'ok', aiAvailable: buildProviders(env).length > 0, promptVersion: PROMPT_VERSION }, 200, cors);
  }

  if (url.pathname !== '/v1/check') return errorResponse('bad_request', 'Not found.', cors, undefined, 404);
  if (request.method !== 'POST') return errorResponse('bad_request', 'Method not allowed.', cors, undefined, 405);

  // --- auth ---
  const expected = env.GRAMMARME_CLIENT_TOKEN;
  if (!expected || expected.length < 16) {
    log({ evt: 'misconfigured', reason: 'client_token_missing_or_short' });
    return errorResponse('upstream_error', 'Server is not configured.', cors, undefined, 503);
  }
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !(await safeEqual(token, expected))) {
    return errorResponse('unauthorized', 'Missing or invalid token.', cors);
  }

  // --- body ---
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return errorResponse('bad_request', 'Content-Type must be application/json.', cors, undefined, 415);
  }
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) return errorResponse('too_long', 'Request body is too large.', cors);
  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_BYTES) return errorResponse('too_long', 'Request body is too large.', cors);
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return errorResponse('bad_request', 'Body is not valid JSON.', cors);
  }
  const validation = validateCheckRequest(body, config.maxInputChars);
  if (!validation.ok) return errorResponse(validation.error, validation.message, cors);
  const req = validation.value;

  // --- per-client rate limit ---
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const limiter = rateLimiterFor(env, config, state);
  if (!(await limiter.allow(await clientKey(token, ip)))) {
    return errorResponse('rate_limited', 'Too many requests. Slow down.', cors, limiter.retryAfterSeconds);
  }

  const usage = usageCounterFor(env, state);
  if (req.text.trim() === '') {
    const empty: AiCheckResponse = { documentVersion: req.documentVersion, edits: [], model: 'none' };
    return json(empty, 200, cors);
  }

  const providers = buildProviders(env);
  if (providers.length === 0) {
    log({ evt: 'misconfigured', reason: 'no_provider' });
    return errorResponse('upstream_error', 'No AI provider is configured.', cors, undefined, 503);
  }

  // --- daily cap ---
  const used = await usage.get();
  if (used >= config.dailyCap) {
    return errorResponse('quota_exhausted', 'Daily AI limit reached. Using local checks only.', cors, secondsUntilUtcMidnight());
  }
  const count = await usage.increment();

  // --- model call with fallback ---
  const started = Date.now();
  const result = await runWithFallback(
    providers,
    {
      system: buildSystemPrompt(req.task, req.mode),
      user: buildUserPrompt(req.text),
      schema: editsJsonSchema(req.task),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    config.providerTimeoutMs,
    parseModelOutput,
  );
  const failures = (fs: ProviderError[]) => fs.map((f) => ({ provider: f.provider, kind: f.kind, status: f.status }));

  if (!result.ok) {
    log({ evt: 'check_failed', task: req.task, mode: req.mode, chars: req.text.length, ms: Date.now() - started, failures: failures(result.failures) });
    const allQuota = result.failures.length > 0 && result.failures.every((f) => f.kind === 'quota');
    const retries = result.failures.map((f) => f.retryAfterSeconds).filter((n): n is number => n !== undefined);
    const retryAfter = retries.length ? Math.max(1, Math.min(...retries)) : undefined;
    if (allQuota) {
      return errorResponse('quota_exhausted', 'AI provider quota exhausted. Using local checks only.', cors, retryAfter ?? DEFAULT_QUOTA_RETRY_SECONDS);
    }
    return errorResponse('upstream_error', 'AI provider unavailable. Using local checks only.', cors, retryAfter);
  }

  const { edits, dropped } = sanitizeEdits(result.output as unknown[], req.text, req.task, config.maxEdits);
  log({
    evt: 'check_ok',
    task: req.task,
    mode: req.mode,
    chars: req.text.length,
    provider: result.provider.id,
    model: result.provider.model,
    ms: Date.now() - started,
    proposed: (result.output as unknown[]).length,
    kept: edits.length,
    dropped,
    failures: failures(result.failures),
  });

  const response: AiCheckResponse = {
    documentVersion: req.documentVersion,
    edits,
    model: `${result.provider.id}/${result.provider.model}`,
    remaining: Math.max(0, config.dailyCap - count),
  };
  return json(response, 200, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      log({ evt: 'unhandled', error: e instanceof Error ? e.name : 'unknown' });
      return errorResponse('upstream_error', 'Internal error.', {}, undefined, 500);
    }
  },
} satisfies ExportedHandler<Env>;
