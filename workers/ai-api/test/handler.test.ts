import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/index.ts';
import { EXT_ORIGIN, TOKEN, call, checkRequest, errorRes, groqOk, makeEnv, mockFetch, validBody } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GOOD_EDIT = { original: 'I has', replacement: 'I have', contextBefore: '', category: 'grammar', message: 'Agreement.' };

describe('health', () => {
  it('GET /v1/health needs no token and reveals no secrets', async () => {
    const res = await handleRequest(new Request('https://x.test/v1/health'), makeEnv(), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.aiAvailable).toBe(true);
    expect(JSON.stringify(body)).not.toContain('key');
  });
  it('reports aiAvailable=false with no providers configured', async () => {
    const res = await handleRequest(new Request('https://x.test/v1/health'), makeEnv({ GROQ_API_KEY: undefined, GEMINI_API_KEY: undefined }), {});
    expect(((await res.json()) as { aiAvailable: boolean }).aiAvailable).toBe(false);
  });
  it('unknown path -> 404, wrong method -> 405', async () => {
    expect((await call(new Request('https://x.test/nope'))).status).toBe(404);
    expect((await call(new Request('https://x.test/v1/check'))).status).toBe(405);
  });
});

describe('auth', () => {
  it('rejects a missing token with 401 unauthorized', async () => {
    const fetchMock = mockFetch({ groq: () => groqOk([]) });
    const { status, body } = await call(checkRequest(validBody('I has a apple.'), { token: null }));
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: 'unauthorized' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a wrong token', async () => {
    const { status } = await call(checkRequest(validBody('x'), { token: 'wrong-token-wrong-token' }));
    expect(status).toBe(401);
  });
  it('fails closed (503) if the server token is not configured', async () => {
    const { status, body } = await call(checkRequest(validBody('x')), makeEnv({ GRAMMARME_CLIENT_TOKEN: undefined }));
    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'upstream_error' });
  });
});

describe('CORS', () => {
  it('answers preflight for an allowed chrome-extension origin', async () => {
    const res = await handleRequest(
      new Request('https://x.test/v1/check', { method: 'OPTIONS', headers: { Origin: EXT_ORIGIN } }),
      makeEnv(),
      {},
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(EXT_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
  it('allows any localhost port via the http://localhost:* pattern', async () => {
    mockFetch({ groq: () => groqOk([]) });
    const { res, status } = await call(checkRequest(validBody('Fine text.'), { origin: 'http://localhost:5173' }));
    expect(status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });
  it('rejects other origins with 403 and no CORS headers', async () => {
    for (const origin of ['https://evil.example', 'chrome-extension://otherextensionid', 'http://localhost.evil.com:80', 'http://localhost:abc']) {
      const { res, status } = await call(checkRequest(validBody('x'), { origin }));
      expect(status).toBe(403);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });
});

describe('request validation', () => {
  it.each([
    ['non-JSON body', 'not json'],
    ['array body', []],
    ['missing text', { task: 'grammar', mode: 'standard', documentVersion: 1 }],
    ['bad task', validBody('x', { task: 'rewrite' })],
    ['bad mode', validBody('x', { mode: 'pirate' })],
    ['negative version', validBody('x', { documentVersion: -1 })],
    ['fractional version', validBody('x', { documentVersion: 1.5 })],
  ])('400 bad_request: %s', async (_name, body) => {
    const { status, body: res } = await call(checkRequest(body));
    expect(status).toBe(400);
    expect(res).toMatchObject({ error: 'bad_request' });
  });
  it('415 when Content-Type is not JSON', async () => {
    const { status } = await call(checkRequest(validBody('x'), { contentType: 'text/plain' }));
    expect(status).toBe(415);
  });
  it('413 too_long above MAX_INPUT_CHARS, without calling a provider', async () => {
    const fetchMock = mockFetch({ groq: () => groqOk([]) });
    const { status, body } = await call(checkRequest(validBody('a'.repeat(4001))));
    expect(status).toBe(413);
    expect(body).toMatchObject({ error: 'too_long' });
    expect(fetchMock).not.toHaveBeenCalled();
    mockFetch({ groq: () => groqOk([]) });
    expect((await call(checkRequest(validBody('a'.repeat(4000))))).status).toBe(200);
  });
  it('413 for an oversized raw body', async () => {
    const { status } = await call(checkRequest(validBody('a'.repeat(70_000))), makeEnv({ MAX_INPUT_CHARS: '100000' }));
    expect(status).toBe(413);
  });
  it('whitespace-only text returns no edits without calling a provider', async () => {
    const fetchMock = mockFetch({ groq: () => groqOk([]) });
    const { status, body } = await call(checkRequest(validBody('   \n ')));
    expect(status).toBe(200);
    expect(body).toMatchObject({ edits: [], documentVersion: 7 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /v1/check happy path', () => {
  it('returns sanitised edits, echoes documentVersion, reports model and remaining', async () => {
    mockFetch({
      groq: () =>
        groqOk([
          GOOD_EDIT,
          { original: 'He go', replacement: 'He goes', contextBefore: '', category: 'grammar', message: 'Hallucinated.' },
        ]),
    });
    const { status, body } = await call(checkRequest(validBody('Yes. I has a apple.')));
    expect(status).toBe(200);
    expect(body!.documentVersion).toBe(7);
    expect(body!.edits).toHaveLength(1);
    expect(body!.edits[0]).toMatchObject({ original: 'I has', replacement: 'I have', category: 'grammar' });
    expect(body!.model).toBe('groq/openai/gpt-oss-20b');
    expect(body!.remaining).toBe(99);
  });

  it('never logs the request text or edits', async () => {
    const secret = 'My secret diagnosis is xyzzy-confidential.';
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    mockFetch({
      groq: () => groqOk([{ original: 'xyzzy-confidential', replacement: 'xyzzy confidential', contextBefore: '', category: 'spelling', message: 'm' }]),
    });
    await call(checkRequest(validBody(secret)));
    mockFetch({ groq: () => errorRes(500, { error: { message: secret } }), gemini: () => errorRes(500) });
    await call(checkRequest(validBody(secret)));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('xyzzy');
  });
});

describe('rate limiting and daily cap', () => {
  it('in-memory limiter returns 429 rate_limited with Retry-After', async () => {
    mockFetch({ groq: () => groqOk([]) });
    const env = makeEnv({ RATE_LIMIT_PER_MINUTE: '2' });
    const state = {};
    expect((await call(checkRequest(validBody('a.')), env, state)).status).toBe(200);
    expect((await call(checkRequest(validBody('a.')), env, state)).status).toBe(200);
    const { res, status, body } = await call(checkRequest(validBody('a.')), env, state);
    expect(status).toBe(429);
    expect(body).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 60 });
    expect(res.headers.get('Retry-After')).toBe('60');
  });
  it('uses the RATE_LIMITER binding when present', async () => {
    mockFetch({ groq: () => groqOk([]) });
    const limit = vi.fn(async () => ({ success: false }));
    const { status } = await call(checkRequest(validBody('a.')), makeEnv({ RATE_LIMITER: { limit } }));
    expect(status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(limit.mock.calls)).not.toContain(TOKEN);
  });
  it('daily cap returns quota_exhausted until UTC midnight, without calling a provider', async () => {
    const fetchMock = mockFetch({ groq: () => groqOk([]) });
    const env = makeEnv({ DAILY_REQUEST_CAP: '1' });
    const state = {};
    expect((await call(checkRequest(validBody('a.')), env, state)).status).toBe(200);
    const { status, body } = await call(checkRequest(validBody('a.')), env, state);
    expect(status).toBe(429);
    expect(body!.error).toBe('quota_exhausted');
    expect(body!.retryAfterSeconds).toBeGreaterThan(0);
    expect(body!.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('uses a KV counter (integer only) when USAGE_KV is bound', async () => {
    mockFetch({ groq: () => groqOk([]) });
    const store = new Map<string, string>();
    const kv = { get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)) };
    const env = makeEnv({ USAGE_KV: kv, DAILY_REQUEST_CAP: '5' });
    const { body } = await call(checkRequest(validBody('a.')), env);
    expect(body!.remaining).toBe(4);
    expect([...store.values()]).toEqual(['1']);
    expect([...store.keys()][0]).toMatch(/^usage:\d{4}-\d{2}-\d{2}$/);
  });
});
