/**
 * The two OpenAI API calls the companion makes with a ChatGPT plan token: POST /v1/responses
 * (streamed) and GET /v1/models. Nothing else. Never ChatGPT backend-api endpoints, and never any
 * other billing path or provider as a fallback.
 */
import type { CompanionErrorCode, ModelInfo } from '@grammarme/core/companion';
import { CompanionError, UnauthorizedError } from './errors.ts';
import { fetchFailure, readJsonBounded, withTimeout, REQUEST_TIMEOUT_MS } from './http.ts';
import type { FetchFn } from './http.ts';
import { SseParser } from './sse.ts';

/* ------------------------------------------------------------------ error mapping */

export const PROVIDER_CODE_MAP: Readonly<Record<string, CompanionErrorCode>> = {
  subscription_sharing_usage_limit_exceeded: 'usage_limit',
  subscription_sharing_usage_unavailable: 'usage_unavailable',
  subscription_sharing_user_unavailable: 'usage_unavailable',
  subscription_sharing_user_not_eligible: 'not_eligible',
  subscription_sharing_route_not_supported: 'unsupported',
  subscription_sharing_unsupported_capability: 'unsupported',
  subscription_sharing_invalid_user: 'reauth_required',
  model_not_found: 'model_unavailable',
};

/** Pulls an error code out of `{error:{code}}`, `{code}`, `{error:"..."}` or a `{detail}` that names one. */
export function providerErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.code === 'string' && e.code) return e.code;
    if (typeof e.type === 'string' && PROVIDER_CODE_MAP[e.type]) return e.type;
  }
  if (typeof err === 'string' && err) return err;
  if (typeof b.code === 'string' && b.code) return b.code;
  if (typeof b.detail === 'string') {
    const m = /\b(subscription_sharing_[a-z_]+|model_not_found)\b/.exec(b.detail);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Maps an HTTP status and/or provider error code to a contract error. A bare 401 becomes an
 * UnauthorizedError so the caller can refresh once and retry.
 */
export function mapProviderError(status: number | undefined, code: string | undefined, notFound: CompanionErrorCode = 'model_unavailable'): CompanionError {
  const mapped = code ? PROVIDER_CODE_MAP[code] : undefined;
  if (mapped) return new CompanionError(mapped);
  if (status === 401) return new UnauthorizedError();
  if (status === 404) return new CompanionError(notFound);
  return new CompanionError('provider_error');
}

/* ------------------------------------------------------------------ output parsing */

/** Tolerant JSON extraction: strips ``` fences, else takes the outermost {...}. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // fall through
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      // fall through
    }
  }
  return undefined;
}

/** Text from a completed response object, used if the stream carried no deltas. */
function outputTextOf(response: unknown): string {
  const output = (response as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return '';
  let text = '';
  for (const item of output) {
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown } | null;
      if (p?.type === 'output_text' && typeof p.text === 'string') text += p.text;
    }
  }
  return text;
}

/* ------------------------------------------------------------------ Responses API */

export interface ResponsesCall {
  fetchFn: FetchFn;
  apiOrigin: string;
  accessToken: string;
  model: string;
  instructions: string;
  input: string;
  maxOutputChars: number;
  signal: AbortSignal;
}

/**
 * Streams one Responses API call and returns the output text. Succeeds only after
 * `response.completed`. Throws CompanionError (or the AbortError if `signal` fired).
 */
export async function streamResponse(call: ResponsesCall): Promise<string> {
  // Only these fields. In particular no text.format, tools, temperature, metadata, user, etc.
  const body = {
    model: call.model,
    instructions: call.instructions,
    input: [{ role: 'user', content: call.input }],
    store: false,
    stream: true,
  };
  let res: Response;
  try {
    res = await call.fetchFn(`${call.apiOrigin}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${call.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: call.signal,
      redirect: 'error',
    });
  } catch (e) {
    if (call.signal.aborted) throw e;
    throw new CompanionError('network');
  }
  if (!res.ok) {
    const errBody = await readJsonBounded(res, 64 * 1024);
    throw mapProviderError(res.status, providerErrorCode(errBody));
  }
  if (!res.body) throw new CompanionError('provider_error');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let text = '';
  let completed = false;

  const handle = (eventName: string, data: string): void => {
    if (data === '[DONE]') return;
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      obj = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof obj.type === 'string' ? obj.type : eventName;
    switch (type) {
      case 'response.output_text.delta':
        if (typeof obj.delta === 'string') {
          text += obj.delta;
          if (text.length > call.maxOutputChars) throw new CompanionError('provider_error', 'ChatGPT’s answer was longer than GrammarMe accepts.');
        }
        return;
      case 'response.completed':
        if (!text) text = outputTextOf(obj.response).slice(0, call.maxOutputChars + 1);
        if (text.length > call.maxOutputChars) throw new CompanionError('provider_error', 'ChatGPT’s answer was longer than GrammarMe accepts.');
        completed = true;
        return;
      case 'response.failed': {
        const err = (obj.response as { error?: unknown } | undefined)?.error;
        throw mapProviderError(undefined, providerErrorCode({ error: err }));
      }
      case 'response.incomplete':
        throw new CompanionError('provider_error', 'ChatGPT stopped before finishing its answer.');
      case 'error':
        throw mapProviderError(undefined, providerErrorCode(obj) ?? providerErrorCode({ error: obj }));
      default:
        return;
    }
  };

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) {
        for (const ev of parser.end()) handle(ev.event, ev.data);
        break;
      }
      let events;
      try {
        events = parser.push(decoder.decode(value, { stream: true }));
      } catch {
        throw new CompanionError('provider_error');
      }
      for (const ev of events) {
        handle(ev.event, ev.data);
        if (completed) break;
      }
    }
  } catch (e) {
    if (e instanceof CompanionError || call.signal.aborted) throw e;
    throw new CompanionError('network');
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!completed) throw new CompanionError('provider_error', 'ChatGPT’s answer ended unexpectedly.');
  return text;
}

/* ------------------------------------------------------------------ models */

const MODEL_SLUG = /^[A-Za-z0-9._:-]{1,100}$/;

/** Keeps listable models. Accepts `{models:[…]}` (documented) or `{data:[…]}`. */
export function parseModelList(body: unknown): ModelInfo[] {
  const b = (body ?? {}) as { models?: unknown; data?: unknown };
  const fromModels = Array.isArray(b.models);
  const items = fromModels ? (b.models as unknown[]) : Array.isArray(b.data) ? (b.data as unknown[]) : [];
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    // Documented field; tolerate its absence only in the generic `data` shape.
    if (m.visibility !== 'list' && (fromModels || m.visibility !== undefined)) continue;
    const slug = typeof m.slug === 'string' ? m.slug : typeof m.id === 'string' ? m.id : '';
    if (!MODEL_SLUG.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const name = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim().slice(0, 100) : slug;
    out.push({ slug, displayName: name });
  }
  return out;
}

export async function fetchModels(fetchFn: FetchFn, apiOrigin: string, accessToken: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  let res: Response;
  try {
    res = await fetchFn(`${apiOrigin}/v1/models`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    throw fetchFailure(e, signal);
  }
  const body = await readJsonBounded(res, 2 * 1024 * 1024);
  if (!res.ok) throw mapProviderError(res.status, providerErrorCode(body), 'provider_error');
  if (!body || typeof body !== 'object') throw new CompanionError('provider_error');
  return parseModelList(body);
}
