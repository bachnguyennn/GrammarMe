import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProviders, runWithFallback } from '../src/providers/index.ts';
import { GeminiProvider } from '../src/providers/gemini.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { ProviderError, parseRetryAfter } from '../src/providers/types.ts';
import type { Provider } from '../src/providers/types.ts';
import { WorkersAiProvider } from '../src/providers/workersAi.ts';
import { parseModelOutput } from '../src/index.ts';
import { call, checkRequest, errorRes, geminiOk, groqOk, makeEnv, mockFetch, validBody } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EDIT = { original: 'I has', replacement: 'I have', contextBefore: '', category: 'grammar', message: 'Agreement.' };
const input = { system: 'sys', user: '<text>\nI has\n</text>', schema: { type: 'object' }, maxOutputTokens: 100 };
const signal = () => new AbortController().signal;

describe('provider selection', () => {
  it('follows AI_PROVIDERS order and skips providers without keys/bindings', () => {
    expect(buildProviders(makeEnv({ AI_PROVIDERS: 'gemini,groq' })).map((p) => p.id)).toEqual(['gemini', 'groq']);
    expect(buildProviders(makeEnv({ AI_PROVIDERS: 'gemini,groq', GEMINI_API_KEY: undefined })).map((p) => p.id)).toEqual(['groq']);
    expect(buildProviders(makeEnv({ AI_PROVIDERS: 'workers-ai,groq' })).map((p) => p.id)).toEqual(['groq']);
    const ai = { run: vi.fn() };
    expect(buildProviders(makeEnv({ AI_PROVIDERS: 'workers-ai,groq', AI: ai })).map((p) => p.id)).toEqual(['workers-ai', 'groq']);
  });
  it('default order excludes Gemini (free-tier data terms are opt-in)', () => {
    expect(buildProviders(makeEnv({ AI_PROVIDERS: undefined })).map((p) => p.id)).toEqual(['groq']);
  });
});

describe('Gemini request/response', () => {
  it('sends the key in a header (not the URL) and asks for JSON-schema output', async () => {
    const fetchMock = mockFetch({ gemini: () => geminiOk([EDIT]) });
    const out = await new GeminiProvider('secret-key', 'gemini-3.5-flash-lite').generate({ ...input, signal: signal() });
    expect(parseModelOutput(out)).toEqual([EDIT]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toEqual({ type: 'object' });
    expect(body.systemInstruction.parts[0].text).toBe('sys');
  });
  it('maps 429 RESOURCE_EXHAUSTED + RetryInfo to quota with retryAfterSeconds', async () => {
    mockFetch({
      gemini: () =>
        errorRes(429, {
          error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] },
        }),
    });
    await expect(new GeminiProvider('k').generate({ ...input, signal: signal() })).rejects.toMatchObject({
      kind: 'quota',
      status: 429,
      retryAfterSeconds: 37,
    });
  });
  it('treats safety blocks / empty candidates as bad_output', async () => {
    mockFetch({ gemini: () => errorRes(200, { promptFeedback: { blockReason: 'SAFETY' } }) });
    await expect(new GeminiProvider('k').generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'bad_output' });
  });
  it('ignores thought parts', async () => {
    mockFetch({
      gemini: () => errorRes(200, { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"edits":[]}' }] } }] }),
    });
    expect(await new GeminiProvider('k').generate({ ...input, signal: signal() })).toBe('{"edits":[]}');
  });
});

describe('Groq request/response', () => {
  it('uses strict json_schema, bearer auth, and low reasoning effort for gpt-oss', async () => {
    const fetchMock = mockFetch({ groq: () => groqOk([EDIT]) });
    await new GroqProvider('gk', 'openai/gpt-oss-20b', 'low').generate({ ...input, signal: signal() });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gk');
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(body.reasoning_effort).toBe('low');
  });
  it('maps 429 + retry-after header to quota', async () => {
    mockFetch({ groq: () => errorRes(429, {}, { 'retry-after': '12' }) });
    await expect(new GroqProvider('gk').generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'quota', retryAfterSeconds: 12 });
  });
  it('maps 5xx to unavailable, 401 to config, schema 400 to bad_output', async () => {
    mockFetch({ groq: () => errorRes(503) });
    await expect(new GroqProvider('gk').generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'unavailable' });
    mockFetch({ groq: () => errorRes(401) });
    await expect(new GroqProvider('gk').generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'config' });
    mockFetch({ groq: () => errorRes(400, { error: { code: 'json_validate_failed', message: 'Generated JSON does not match the expected schema.' } }) });
    await expect(new GroqProvider('gk').generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'bad_output' });
  });
  it('maps network errors to unavailable and never puts upstream bodies in the error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(new GroqProvider('gk').generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'unavailable' });
    mockFetch({ groq: () => errorRes(500, { error: { message: 'echo: I has a apple' } }) });
    const err = await new GroqProvider('gk').generate({ ...input, signal: signal() }).catch((e: ProviderError) => e);
    expect(String((err as Error).message)).not.toContain('apple');
  });
});

describe('Workers AI binding', () => {
  it('passes JSON mode and accepts string or parsed responses', async () => {
    const run = vi.fn(async () => ({ response: { edits: [EDIT] } }));
    const out = await new WorkersAiProvider({ run }).generate({ ...input, signal: signal() });
    expect(parseModelOutput(out)).toEqual([EDIT]);
    expect(run).toHaveBeenCalledWith('@cf/meta/llama-3.3-70b-instruct-fp8-fast', expect.objectContaining({ response_format: expect.objectContaining({ type: 'json_schema' }) }));
  });
  it('maps neuron-allocation errors to quota and others to unavailable', async () => {
    const quota = { run: vi.fn(async () => { throw new Error('You have used up your daily free allocation of 10,000 neurons'); }) };
    await expect(new WorkersAiProvider(quota).generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'quota' });
    const down = { run: vi.fn(async () => { throw new Error('InferenceUpstreamError'); }) };
    await expect(new WorkersAiProvider(down).generate({ ...input, signal: signal() })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('fallback chain', () => {
  const fake = (id: string, impl: () => Promise<unknown>): Provider => ({ id, model: 'm', generate: impl });

  it('falls back on quota, 5xx and unparseable output; returns the first good result', async () => {
    const result = await runWithFallback(
      [
        fake('a', async () => { throw new ProviderError('a', 'quota', 429, 30); }),
        fake('b', async () => { throw new ProviderError('b', 'unavailable', 503); }),
        fake('c', async () => 'not json'),
        fake('d', async () => '{"edits":[]}'),
      ],
      input,
      1000,
      parseModelOutput,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider.id).toBe('d');
      expect(result.failures.map((f) => f.kind)).toEqual(['quota', 'unavailable', 'bad_output']);
    }
  });
  it('times out a hung provider and moves on', async () => {
    const slow: Provider = {
      id: 'slow',
      model: 'm',
      generate: ({ signal: s }) => new Promise((_, reject) => s.addEventListener('abort', () => reject(new ProviderError('slow', 'unavailable')))),
    };
    const result = await runWithFallback([slow, fake('ok', async () => '[]')], input, 20, parseModelOutput);
    expect(result.ok && result.provider.id).toBe('ok');
  });
});

describe('end-to-end fallback and error mapping through the handler', () => {
  it('Groq 429 -> falls back to Gemini and succeeds', async () => {
    const fetchMock = mockFetch({ groq: () => errorRes(429, {}, { 'retry-after': '5' }), gemini: () => geminiOk([EDIT]) });
    const { status, body } = await call(checkRequest(validBody('Yes. I has a apple.')));
    expect(status).toBe(200);
    expect(body!.model).toBe('gemini/gemini-3.5-flash-lite');
    expect(body!.edits).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('all providers out of quota -> 429 quota_exhausted with the smallest retryAfter', async () => {
    mockFetch({
      groq: () => errorRes(429, {}, { 'retry-after': '40' }),
      gemini: () => errorRes(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '9s' }] } }),
    });
    const { status, body, res } = await call(checkRequest(validBody('I has.')));
    expect(status).toBe(429);
    expect(body).toEqual({ error: 'quota_exhausted', message: expect.any(String), retryAfterSeconds: 9 });
    expect(res.headers.get('Retry-After')).toBe('9');
  });
  it('quota without a retry hint still returns retryAfterSeconds', async () => {
    mockFetch({ groq: () => errorRes(429), gemini: () => errorRes(429) });
    const { body } = await call(checkRequest(validBody('I has.')));
    expect(body).toMatchObject({ error: 'quota_exhausted', retryAfterSeconds: 60 });
  });
  it('mixed failures -> 502 upstream_error', async () => {
    mockFetch({ groq: () => errorRes(429), gemini: () => errorRes(500) });
    const { status, body } = await call(checkRequest(validBody('I has.')));
    expect(status).toBe(502);
    expect(body!.error).toBe('upstream_error');
  });
  it('no provider configured -> 503 upstream_error', async () => {
    const { status } = await call(checkRequest(validBody('I has.')), makeEnv({ GROQ_API_KEY: undefined, GEMINI_API_KEY: undefined }));
    expect(status).toBe(503);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('7')).toBe(7);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(9);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
