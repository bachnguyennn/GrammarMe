/** Small fetch helpers: bounded body reads, form POSTs and signal plumbing. */
import { CompanionError } from './errors.ts';

export type FetchFn = typeof fetch;

/** Default limit for any non-streaming OpenAI request. */
export const REQUEST_TIMEOUT_MS = 20_000;

export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Throws `cancelled` if the caller's own signal fired, else `timeout`/`network`. */
export function fetchFailure(e: unknown, callerSignal: AbortSignal | undefined): CompanionError {
  if (callerSignal?.aborted) return new CompanionError('cancelled');
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return new CompanionError('timeout');
  return new CompanionError('network');
}

/** Reads at most `max` bytes of a response body as text (the rest is discarded). */
export async function readTextBounded(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new CompanionError('provider_error');
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJsonBounded(res: Response, max = 256 * 1024): Promise<unknown> {
  try {
    const text = await readTextBounded(res, max);
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

export interface FormResult {
  status: number;
  body: unknown;
}

/** POSTs application/x-www-form-urlencoded (credentials go in the body, never in the URL). */
export async function postForm(
  fetchFn: FetchFn,
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<FormResult> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: withTimeout(signal, timeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    throw fetchFailure(e, signal);
  }
  return { status: res.status, body: await readJsonBounded(res) };
}

export async function getJson(fetchFn: FetchFn, url: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<FormResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: withTimeout(signal, REQUEST_TIMEOUT_MS), redirect: 'error' });
  } catch (e) {
    throw fetchFailure(e, signal);
  }
  return { status: res.status, body: await readJsonBounded(res, 2 * 1024 * 1024) };
}
