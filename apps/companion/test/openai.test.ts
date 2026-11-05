import { describe, expect, it } from 'vitest';
import { mapProviderError, parseModelJson, parseModelList, providerErrorCode, streamResponse } from '../src/openai.ts';
import { UnauthorizedError } from '../src/errors.ts';
import { SseParser } from '../src/sse.ts';
import { json, mockFetch, sseResponse, textEvents } from './helpers.ts';
import type { Handler } from './helpers.ts';

describe('SSE parser', () => {
  it('reassembles events split at every possible boundary, including CRLF', () => {
    const text = 'event: a\r\ndata: {"x":1}\r\n\r\n: comment\n\nevent: b\ndata: line1\ndata: line2\n\n';
    for (let size = 1; size <= text.length; size++) {
      const p = new SseParser();
      const out = [];
      for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
      out.push(...p.end());
      expect(out).toEqual([
        { event: 'a', data: '{"x":1}' },
        { event: 'b', data: 'line1\nline2' },
      ]);
    }
  });

  it('flushes a final event without a trailing blank line', () => {
    const p = new SseParser();
    expect(p.push('data: tail')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'message', data: 'tail' }]);
  });
});

function run(handler: Handler, opts: { maxOutputChars?: number; signal?: AbortSignal } = {}) {
  const m = mockFetch(handler);
  const promise = streamResponse({
    fetchFn: m.fetch,
    apiOrigin: 'https://api.openai.com',
    accessToken: 'tok',
    model: 'gpt-test',
    instructions: 'sys',
    input: '<text>\nhi\n</text>',
    maxOutputChars: opts.maxOutputChars ?? 1000,
    signal: opts.signal ?? new AbortController().signal,
  });
  return { promise, calls: m.calls };
}

describe('Responses API streaming', () => {
  it('sends only the allowed fields, store:false and stream:true, with the bearer token', async () => {
    const { promise, calls } = run(() => sseResponse(textEvents('{"edits":[]}')));
    await expect(promise).resolves.toBe('{"edits":[]}');
    const call = calls[0]!;
    expect(call.url.href).toBe('https://api.openai.com/v1/responses');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer tok');
    expect(call.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'store', 'stream']);
    expect(body).toMatchObject({ store: false, stream: true, model: 'gpt-test', instructions: 'sys', input: [{ role: 'user', content: '<text>\nhi\n</text>' }] });
    expect(call.url.search).toBe('');
  });

  it('assembles deltas split across tiny chunks', async () => {
    const text = '{"edits":[{"original":"teh","replacement":"the"}]} — ünïcødé';
    const { promise } = run(() => sseResponse(textEvents(text, 13), 3));
    await expect(promise).resolves.toBe(text);
  });

  it('uses the completed response output when there were no deltas', async () => {
    const { promise } = run(() =>
      sseResponse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } }]),
    );
    await expect(promise).resolves.toBe('OK');
  });

  it('fails if the stream ends without response.completed', async () => {
    const { promise } = run(() => sseResponse([{ type: 'response.output_text.delta', delta: 'partial' }]));
    await expect(promise).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('maps response.failed with a usage-limit code to usage_limit', async () => {
    const { promise } = run(() =>
      sseResponse([
        { type: 'response.output_text.delta', delta: '{"ed' },
        { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } },
      ]),
    );
    await expect(promise).rejects.toMatchObject({ code: 'usage_limit' });
  });

  it('maps response.incomplete and error events', async () => {
    await expect(run(() => sseResponse([{ type: 'response.incomplete', response: {} }])).promise).rejects.toMatchObject({ code: 'provider_error' });
    await expect(run(() => sseResponse([{ type: 'error', code: 'subscription_sharing_usage_unavailable' }])).promise).rejects.toMatchObject({
      code: 'usage_unavailable',
    });
  });

  it('aborts with provider_error when the output exceeds the bound', async () => {
    const { promise } = run(() => sseResponse(textEvents('x'.repeat(500), 50)), { maxOutputChars: 100 });
    await expect(promise).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('stops when the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const { promise } = run((_c, signal) => sseResponse([{ type: 'response.output_text.delta', delta: 'x' }], 100, { hang: true, signal }), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });

  it('maps pre-stream HTTP errors', async () => {
    const cases: [Response, string][] = [
      [json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429), 'usage_limit'],
      [json({ error: { code: 'subscription_sharing_user_not_eligible' } }, 403), 'not_eligible'],
      [json({ detail: 'Unauthorized' }, 401), 'reauth_required'],
      [json({ detail: 'Service unavailable' }, 503), 'provider_error'],
      [json({ error: { code: 'model_not_found' } }, 400), 'model_unavailable'],
      [json({}, 404), 'model_unavailable'],
    ];
    for (const [res, code] of cases) await expect(run(() => res).promise).rejects.toMatchObject({ code });
  });

  it('maps fetch failures to network', async () => {
    await expect(
      run(() => {
        throw new TypeError('fetch failed');
      }).promise,
    ).rejects.toMatchObject({ code: 'network' });
  });
});

describe('error mapping table', () => {
  it.each([
    [429, 'subscription_sharing_usage_limit_exceeded', 'usage_limit'],
    [503, 'subscription_sharing_usage_unavailable', 'usage_unavailable'],
    [503, 'subscription_sharing_user_unavailable', 'usage_unavailable'],
    [403, 'subscription_sharing_user_not_eligible', 'not_eligible'],
    [403, 'subscription_sharing_route_not_supported', 'unsupported'],
    [400, 'subscription_sharing_unsupported_capability', 'unsupported'],
    [401, 'subscription_sharing_invalid_user', 'reauth_required'],
    [404, undefined, 'model_unavailable'],
    [500, undefined, 'provider_error'],
    [429, undefined, 'provider_error'],
    [undefined, 'something_else', 'provider_error'],
  ] as const)('%s %s -> %s', (status, code, expected) => {
    expect(mapProviderError(status, code).code).toBe(expected);
  });

  it('a bare 401 is retryable (refresh once), the invalid-user 401 is not', () => {
    expect(mapProviderError(401, undefined)).toBeInstanceOf(UnauthorizedError);
    expect(mapProviderError(401, 'subscription_sharing_invalid_user')).not.toBeInstanceOf(UnauthorizedError);
  });

  it('finds codes in structured, flat and detail-string bodies', () => {
    expect(providerErrorCode({ error: { code: 'a' } })).toBe('a');
    expect(providerErrorCode({ code: 'b' })).toBe('b');
    expect(providerErrorCode({ detail: 'Error: subscription_sharing_user_unavailable (try later)' })).toBe('subscription_sharing_user_unavailable');
    expect(providerErrorCode({ detail: 'Unauthorized' })).toBeUndefined();
    expect(providerErrorCode(null)).toBeUndefined();
  });
});

describe('model output parsing', () => {
  it('handles fences, prose around JSON and garbage', () => {
    expect(parseModelJson('```json\n{"edits":[]}\n```')).toEqual({ edits: [] });
    expect(parseModelJson('Here you go: {"edits": [1]} hope that helps')).toEqual({ edits: [1] });
    expect(parseModelJson('no json here')).toBeUndefined();
  });
});

describe('model list', () => {
  it('keeps listable models with valid slugs', () => {
    expect(
      parseModelList({
        models: [
          { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' },
          { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-b', visibility: 'list' },
          { slug: 'bad slug!', visibility: 'list' },
          { slug: 'gpt-a', visibility: 'list' },
          { display_name: 'no slug', visibility: 'list' },
        ],
      }),
    ).toEqual([
      { slug: 'gpt-a', displayName: 'GPT A' },
      { slug: 'gpt-b', displayName: 'gpt-b' },
    ]);
  });

  it('also accepts a data array', () => {
    expect(parseModelList({ data: [{ id: 'gpt-c' }, { id: 'gpt-d', visibility: 'hide' }] })).toEqual([{ slug: 'gpt-c', displayName: 'gpt-c' }]);
    expect(parseModelList({})).toEqual([]);
  });
});
