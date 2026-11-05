import { vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { handleRequest } from '../src/index.ts';
import type { State } from '../src/index.ts';

export const TOKEN = 'test-token-0123456789abcdef';
export const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GRAMMARME_CLIENT_TOKEN: TOKEN,
    GROQ_API_KEY: 'groq-key',
    GEMINI_API_KEY: 'gemini-key',
    AI_PROVIDERS: 'groq,gemini',
    ALLOWED_ORIGINS: `${EXT_ORIGIN},http://localhost:*`,
    DAILY_REQUEST_CAP: '100',
    RATE_LIMIT_PER_MINUTE: '100',
    ...overrides,
  };
}

export function checkRequest(
  body: unknown,
  opts: { token?: string | null; origin?: string; contentType?: string; method?: string } = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': opts.contentType ?? 'application/json' };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.origin) headers.Origin = opts.origin;
  return new Request('https://api.example.test/v1/check', {
    method: opts.method ?? 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const validBody = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  task: 'grammar',
  mode: 'standard',
  documentVersion: 7,
  ...extra,
});

/** Groq-shaped success response containing the given model JSON. */
export function groqOk(edits: unknown[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits }) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Gemini-shaped success response containing the given model JSON. */
export function geminiOk(edits: unknown[]): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ edits }) }] }, finishReason: 'STOP' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

export function errorRes(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Routes mocked fetch calls by host. */
export function mockFetch(handlers: { groq?: () => Response; gemini?: () => Response }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('api.groq.com') && handlers.groq) return handlers.groq();
    if (url.includes('generativelanguage.googleapis.com') && handlers.gemini) return handlers.gemini();
    throw new TypeError(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export async function call(req: Request, env: Env = makeEnv(), state: State = {}) {
  const res = await handleRequest(req, env, state);
  const text = await res.text();
  return { res, status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}
