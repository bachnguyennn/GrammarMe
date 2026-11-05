import { afterEach, describe, expect, it } from 'vitest';
import { Companion, needsRefresh } from '../src/companion.ts';
import { pkceChallenge } from '../src/oauth.ts';
import { CredentialStore } from '../src/store.ts';
import {
  API,
  cleanupHomes,
  connectedFile,
  discoveryDoc,
  FULL_SCOPE,
  idClaims,
  ISSUED_CLIENT,
  json,
  mockFetch,
  rsaKey,
  signJwt,
  sseResponse,
  tempHome,
  textEvents,
} from './helpers.ts';
import type { Call } from './helpers.ts';

afterEach(cleanupHomes);

const key = rsaKey('k1');

interface FakeOptions {
  scope?: string;
  tokenStatus?: number;
  tokenBody?: Record<string, unknown>;
  refreshError?: string;
  refreshDelayMs?: number;
  revokeStatuses?: number[];
  revokeThrows?: boolean;
  idOverrides?: Record<string, unknown>;
  models?: unknown;
  responses?: (call: Call, signal?: AbortSignal | null) => Response | Promise<Response>;
}

/** A fake auth.openai.com + api.openai.com behind a mocked fetch. */
function fakeOpenAI(o: FakeOptions = {}) {
  let refreshCount = 0;
  let lastNonce = '';
  const revokeStatuses = [...(o.revokeStatuses ?? [200])];
  const m = mockFetch(async (call, signal) => {
    const { url } = call;
    if (url.origin === 'https://auth.openai.com') {
      if (url.pathname === '/.well-known/openid-configuration') return json(discoveryDoc());
      if (url.pathname === '/.well-known/jwks.json') return json({ keys: [key.jwk] });
      if (url.pathname === '/api/accounts/oauth/token') {
        const form = new URLSearchParams(call.body);
        if (form.get('grant_type') === 'refresh_token') {
          refreshCount++;
          if (o.refreshDelayMs) await new Promise((r) => setTimeout(r, o.refreshDelayMs));
          if (o.refreshError) return json({ error: o.refreshError }, 400);
          return json({ access_token: `access-r${refreshCount}`, refresh_token: `refresh-r${refreshCount}`, expires_in: 3600, scope: FULL_SCOPE });
        }
        if (o.tokenStatus && o.tokenStatus !== 200) return json(o.tokenBody ?? { error: 'invalid_grant' }, o.tokenStatus);
        return json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          id_token: signJwt(key, idClaims(Date.now(), { nonce: lastNonce, ...o.idOverrides })),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: o.scope ?? FULL_SCOPE,
          ...o.tokenBody,
        });
      }
      if (url.pathname === '/api/accounts/oauth/revoke') {
        if (o.revokeThrows) throw new TypeError('fetch failed');
        return new Response(null, { status: revokeStatuses.shift() ?? 500 });
      }
    }
    if (url.origin === API) {
      if (url.pathname === '/v1/models') {
        return json(o.models ?? { models: [{ slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' }, { slug: 'gpt-b', display_name: 'GPT B', visibility: 'list' }, { slug: 'gpt-x', visibility: 'hide' }] });
      }
      if (url.pathname === '/v1/responses') return o.responses ? o.responses(call, signal) : sseResponse(textEvents('{"edits":[]}'));
    }
    return json({ error: 'not found' }, 404);
  });
  return {
    ...m,
    setNonce: (n: string) => (lastNonce = n),
    count: (path: string, grant?: string) =>
      m.calls.filter((c) => c.url.pathname === path && (!grant || new URLSearchParams(c.body).get('grant_type') === grant)).length,
  };
}

async function makeCompanion(fake: ReturnType<typeof fakeOpenAI>, seed?: Parameters<CredentialStore['write']>[0], extra: Partial<ConstructorParameters<typeof Companion>[0]> = {}) {
  const home = await tempHome();
  if (seed) await new CredentialStore(home).write(seed);
  return new Companion({ home, env: {}, fetch: fake.fetch, preferredCallbackPort: 0, revokeBackoffMs: 1, ...extra });
}

/** Plays the browser: reads the authorize URL, "consents", and calls the loopback redirect. */
function browser(fake: ReturnType<typeof fakeOpenAI>, extra: Record<string, string> = { client_id: ISSUED_CLIENT }, onUrl?: (u: URL) => void) {
  return (href: string) => {
    const url = new URL(href);
    onUrl?.(url);
    fake.setNonce(url.searchParams.get('nonce') ?? '');
    const cb = new URL(url.searchParams.get('redirect_uri') as string);
    cb.searchParams.set('state', url.searchParams.get('state') as string);
    if (!('error' in extra)) cb.searchParams.set('code', 'auth-code-1');
    for (const [k, v] of Object.entries(extra)) cb.searchParams.set(k, v);
    void fetch(cb).then((r) => r.text());
  };
}

const signal = () => new AbortController().signal;

describe('sign in', () => {
  it('first registration: exchanges the code with the issued client_id and stores the session', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake);
    let authUrl!: URL;
    const status = await c.signIn(browser(fake, { client_id: ISSUED_CLIENT }, (u) => (authUrl = u)), signal());
    expect(status).toMatchObject({ connected: true, account: { email: 'ada@example.com', name: 'Ada', planUsage: true } });

    expect(authUrl.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authUrl.searchParams.get('agent_name_hint')).toBe('GrammarMe');
    expect(authUrl.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(authUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

    const exchange = fake.calls.find((call) => call.url.pathname === '/api/accounts/oauth/token')!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_id')).toBe(ISSUED_CLIENT);
    expect(form.get('code')).toBe('auth-code-1');
    expect(form.get('redirect_uri')).toBe(authUrl.searchParams.get('redirect_uri'));
    expect(form.get('resource')).toBe('https://api.openai.com/v1');
    expect(pkceChallenge(form.get('code_verifier')!)).toBe(authUrl.searchParams.get('code_challenge'));
    expect(exchange.url.search).toBe('');

    const saved = await c.store.read();
    expect(saved.clientId).toBe(ISSUED_CLIENT);
    expect(saved.hostId).toBe(authUrl.searchParams.get('ext_agent_host_id'));
    expect(saved.tokens).toMatchObject({ access: 'access-1', refresh: 'refresh-1', scope: FULL_SCOPE });
    expect(saved.profile).toEqual({ sub: 'user-1', email: 'ada@example.com', name: 'Ada' });
  });

  it('re-authorization uses the saved client_id and id_token_hint, and the same host id', async () => {
    const fake = fakeOpenAI();
    const seed = connectedFile(Date.now());
    const c = await makeCompanion(fake, seed);
    let authUrl!: URL;
    await c.signIn(browser(fake, {}, (u) => (authUrl = u)), signal());
    expect(authUrl.searchParams.get('client_id')).toBe(ISSUED_CLIENT);
    expect(authUrl.searchParams.has('agent_name_hint')).toBe(false);
    expect(authUrl.searchParams.get('id_token_hint')).toBe('id-1');
    expect(authUrl.searchParams.get('ext_agent_host_id')).toBe(seed.hostId);
  });

  it('without the plan scope: stores the identity but reports permission_required', async () => {
    const fake = fakeOpenAI({ scope: 'openid profile email offline_access resource.invoke' });
    const c = await makeCompanion(fake);
    await expect(c.signIn(browser(fake), signal())).rejects.toMatchObject({ code: 'permission_required' });
    expect(await c.status()).toMatchObject({ connected: true, account: { planUsage: false, email: 'ada@example.com' } });
    const before = fake.calls.length;
    await expect(c.check({ task: 'grammar', mode: 'standard', text: 'Hello.' }, signal())).rejects.toMatchObject({ code: 'permission_required' });
    expect(fake.calls.length).toBe(before);
  });

  it('consent denied: nothing is connected', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake);
    await expect(c.signIn(browser(fake, { error: 'access_denied' }), signal())).rejects.toMatchObject({ code: 'consent_denied' });
    const saved = await c.store.read();
    expect(saved.tokens).toBeUndefined();
    expect(saved.hostId).toBeDefined();
    expect(fake.count('/api/accounts/oauth/token')).toBe(0);
  });

  it('an ID token that fails verification stores nothing', async () => {
    const fake = fakeOpenAI({ idOverrides: { nonce: 'not-the-one-we-sent' } });
    const c = await makeCompanion(fake);
    await expect(c.signIn(browser(fake), signal())).rejects.toMatchObject({ code: 'provider_error' });
    expect((await c.store.read()).tokens).toBeUndefined();
  });

  it('a failed code exchange is reported and stores nothing', async () => {
    const fake = fakeOpenAI({ tokenStatus: 400, tokenBody: { error: 'invalid_grant' } });
    const c = await makeCompanion(fake);
    await expect(c.signIn(browser(fake), signal())).rejects.toMatchObject({ code: 'reauth_required' });
    expect((await c.store.read()).tokens).toBeUndefined();
  });

  it('cancelling closes the loopback listener', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake);
    const controller = new AbortController();
    let redirect = '';
    const p = c.signIn((href) => {
      redirect = new URL(href).searchParams.get('redirect_uri')!;
      setTimeout(() => controller.abort(), 10);
    }, controller.signal);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it('times out when the user never comes back', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake, undefined, { signInTimeoutMs: 50 });
    await expect(c.signIn(() => {}, signal())).rejects.toMatchObject({ code: 'timeout' });
  });

  it('the listener serves only GET /auth/callback', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake);
    const controller = new AbortController();
    const p = c.signIn(async (href) => {
      const cb = new URL(new URL(href).searchParams.get('redirect_uri')!);
      expect((await fetch(new URL('/', cb))).status).toBe(404);
      expect((await fetch(new URL('/auth/other', cb))).status).toBe(404);
      expect((await fetch(cb, { method: 'POST' })).status).toBe(404);
      controller.abort();
    }, controller.signal);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('token refresh', () => {
  const expiring = () => connectedFile(Date.now(), {}, { expiresAt: Date.now() + 60_000 });

  it('refreshes near expiry with the issued client_id and stores the rotated refresh token', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake, expiring());
    expect(await c.accessToken()).toBe('access-r1');
    const form = new URLSearchParams(fake.calls.find((x) => x.url.pathname.endsWith('/token'))!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      client_id: ISSUED_CLIENT,
      refresh_token: 'refresh-1',
      resource: 'https://api.openai.com/v1',
    });
    const saved = await c.store.read();
    expect(saved.tokens).toMatchObject({ access: 'access-r1', refresh: 'refresh-r1', id: 'id-1' });
    expect(saved.tokens!.expiresAt).toBeGreaterThan(Date.now() + 3000_000);
  });

  it('does not refresh a fresh token, nor before earliest_refresh_at while still valid', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    expect(await c.accessToken()).toBe('access-1');
    const now = Date.now();
    expect(needsRefresh({ access: 'a', refresh: 'r', id: '', scope: '', expiresAt: now + 60_000, earliestRefreshAt: now + 30_000 }, now)).toBe(false);
    expect(needsRefresh({ access: 'a', refresh: 'r', id: '', scope: '', expiresAt: now - 1, earliestRefreshAt: now + 30_000 }, now)).toBe(true);
    expect(fake.count('/api/accounts/oauth/token')).toBe(0);
  });

  it.each(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])(
    '%s clears tokens (keeping host id and client id) and asks to reconnect',
    async (error) => {
      const fake = fakeOpenAI({ refreshError: error });
      const seed = expiring();
      const c = await makeCompanion(fake, seed);
      await expect(c.accessToken()).rejects.toMatchObject({ code: 'reauth_required' });
      const saved = await c.store.read();
      expect(saved.tokens).toBeUndefined();
      expect(saved.hostId).toBe(seed.hostId);
      expect(saved.clientId).toBe(ISSUED_CLIENT);
      expect((await c.status()).connected).toBe(false);
    },
  );

  it('invalid_client is an internal error with a clear message and keeps tokens', async () => {
    const fake = fakeOpenAI({ refreshError: 'invalid_client' });
    const c = await makeCompanion(fake, expiring());
    await expect(c.accessToken()).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('invalid_client') });
    expect((await c.store.read()).tokens).toBeDefined();
  });

  it('serializes concurrent refreshes within and across processes: one network call', async () => {
    const fake = fakeOpenAI({ refreshDelayMs: 50 });
    const a = await makeCompanion(fake, expiring());
    const b = new Companion({ home: a.store.dir, env: {}, fetch: fake.fetch });
    const tokens = await Promise.all([a.accessToken(), a.accessToken(), b.accessToken(), b.accessToken()]);
    expect(new Set(tokens)).toEqual(new Set(['access-r1']));
    expect(fake.count('/api/accounts/oauth/token', 'refresh_token')).toBe(1);
  });

  it('a 401 triggers one refresh and a retry', async () => {
    let n = 0;
    const fake = fakeOpenAI({ responses: () => (n++ === 0 ? json({ detail: 'Unauthorized' }, 401) : sseResponse(textEvents('OK'))) });
    const c = await makeCompanion(fake, connectedFile(Date.now(), { model: 'gpt-a' }));
    await expect(c.test(signal())).resolves.toBeGreaterThanOrEqual(0);
    const auths = fake.calls.filter((x) => x.url.pathname === '/v1/responses').map((x) => x.headers.get('authorization'));
    expect(auths).toEqual(['Bearer access-1', 'Bearer access-r1']);
  });

  it('a second 401 means the connection was removed: reauth_required and tokens cleared', async () => {
    const fake = fakeOpenAI({ responses: () => json({ detail: 'Unauthorized' }, 401) });
    const c = await makeCompanion(fake, connectedFile(Date.now(), { model: 'gpt-a' }));
    await expect(c.test(signal())).rejects.toMatchObject({ code: 'reauth_required' });
    expect((await c.status()).connected).toBe(false);
    expect((await c.store.read()).clientId).toBe(ISSUED_CLIENT);
  });
});

describe('sign out', () => {
  it('revokes the refresh token, then deletes tokens locally', async () => {
    const fake = fakeOpenAI();
    const seed = connectedFile(Date.now());
    const c = await makeCompanion(fake, seed);
    await expect(c.signOut()).resolves.toEqual({ revoked: true });
    const revoke = fake.calls.find((x) => x.url.pathname.endsWith('/revoke'))!;
    expect(Object.fromEntries(new URLSearchParams(revoke.body))).toEqual({ token: 'refresh-1', token_type_hint: 'refresh_token', client_id: ISSUED_CLIENT });
    const saved = await c.store.read();
    expect(saved).toEqual({ hostId: seed.hostId, clientId: ISSUED_CLIENT });
  });

  it('retries 5xx up to 3 times, then deletes anyway and reports revoked:false', async () => {
    const fake = fakeOpenAI({ revokeStatuses: [503, 502, 500, 500] });
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    await expect(c.signOut()).resolves.toEqual({ revoked: false });
    expect(fake.count('/api/accounts/oauth/revoke')).toBe(4);
    expect((await c.store.read()).tokens).toBeUndefined();
  });

  it('succeeds after a transient failure', async () => {
    const fake = fakeOpenAI({ revokeStatuses: [503, 200] });
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    await expect(c.signOut()).resolves.toEqual({ revoked: true });
  });

  it('network failure: still deletes locally', async () => {
    const fake = fakeOpenAI({ revokeThrows: true });
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    await expect(c.signOut()).resolves.toEqual({ revoked: false });
    expect((await c.store.read()).tokens).toBeUndefined();
  });
});

describe('models', () => {
  it('lists only visible models and validates setModel against the list', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    expect(await c.models()).toEqual([
      { slug: 'gpt-a', displayName: 'GPT A' },
      { slug: 'gpt-b', displayName: 'GPT B' },
    ]);
    expect(fake.calls.find((x) => x.url.pathname === '/v1/models')!.headers.get('authorization')).toBe('Bearer access-1');
    await expect(c.setModel('gpt-b')).resolves.toMatchObject({ model: 'gpt-b' });
    expect((await c.store.read()).model).toBe('gpt-b');
    await expect(c.setModel('gpt-x')).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(fake.count('/v1/models')).toBe(2); // refetched before refusing
  });

  it('setModel fetches the list when none is cached', async () => {
    const fake = fakeOpenAI();
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    await expect(c.setModel('gpt-a')).resolves.toMatchObject({ model: 'gpt-a' });
  });

  it('requires a connection', async () => {
    const c = await makeCompanion(fakeOpenAI());
    await expect(c.models()).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('check', () => {
  const text = 'I has 5 apples and teh pear is red.';

  it('streams the model JSON, sanitizes it and drops unsafe edits', async () => {
    const answer = JSON.stringify({
      edits: [
        { original: 'has', replacement: 'have', contextBefore: 'I ', category: 'grammar', message: 'Agreement.' },
        { original: 'teh', replacement: 'the', contextBefore: 'and ', category: 'spelling', message: 'Spelling.' },
        { original: '5', replacement: 'five', contextBefore: 'has ', category: 'grammar', message: 'Number.' },
        { original: 'purple', replacement: 'violet', contextBefore: '', category: 'spelling', message: 'Invented.' },
        { original: 'red', replacement: 'not red', contextBefore: 'is ', category: 'grammar', message: 'Flip.' },
      ],
    });
    const fake = fakeOpenAI({ responses: () => sseResponse(textEvents(`\`\`\`json\n${answer}\n\`\`\``, 9), 11) });
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    const result = await c.check({ task: 'grammar', mode: 'standard', text }, signal());
    expect(result.model).toBe('gpt-a');
    expect(result.edits.map((e) => [e.original, e.replacement])).toEqual([
      ['has', 'have'],
      ['teh', 'the'],
    ]);
    expect(result.dropped).toBe(3);
    expect((await c.store.read()).model).toBe('gpt-a'); // first listed model was saved

    const body = JSON.parse(fake.calls.find((x) => x.url.pathname === '/v1/responses')!.body) as Record<string, unknown>;
    expect(body.instructions).toContain('TASK: Correct objective errors only');
    expect(body.input).toEqual([{ role: 'user', content: `<text>\n${text}\n</text>` }]);
    expect(body).not.toHaveProperty('text');
  });

  it('unusable model output is a provider_error', async () => {
    const fake = fakeOpenAI({ responses: () => sseResponse(textEvents('Sorry, I cannot help.')) });
    const c = await makeCompanion(fake, connectedFile(Date.now(), { model: 'gpt-a' }));
    await expect(c.check({ task: 'grammar', mode: 'standard', text }, signal())).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('usage limit mid-stream maps to usage_limit and never falls back elsewhere', async () => {
    const fake = fakeOpenAI({
      responses: () => sseResponse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]),
    });
    const c = await makeCompanion(fake, connectedFile(Date.now(), { model: 'gpt-a' }));
    await expect(c.check({ task: 'grammar', mode: 'standard', text }, signal())).rejects.toMatchObject({ code: 'usage_limit' });
    expect(fake.calls.every((x) => x.url.hostname.endsWith('openai.com'))).toBe(true);
    expect(fake.count('/v1/responses')).toBe(1);
  });

  it('cancel aborts the stream with cancelled', async () => {
    const fake = fakeOpenAI({ responses: (_c, s) => sseResponse([{ type: 'response.output_text.delta', delta: '{' }], 100, { hang: true, signal: s }) });
    const c = await makeCompanion(fake, connectedFile(Date.now(), { model: 'gpt-a' }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(c.check({ task: 'grammar', mode: 'standard', text }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a stalled stream hits the check timeout', async () => {
    const fake = fakeOpenAI({ responses: (_c, s) => sseResponse([{ type: 'response.output_text.delta', delta: '{' }], 100, { hang: true, signal: s }) });
    const c = await makeCompanion(fake, connectedFile(Date.now(), { model: 'gpt-a' }), { checkTimeoutMs: 60 });
    await expect(c.check({ task: 'grammar', mode: 'standard', text }, signal())).rejects.toMatchObject({ code: 'timeout' });
  });

  it('not connected', async () => {
    const c = await makeCompanion(fakeOpenAI());
    await expect(c.check({ task: 'grammar', mode: 'standard', text }, signal())).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('no listed models: model_unavailable', async () => {
    const fake = fakeOpenAI({ models: { models: [] } });
    const c = await makeCompanion(fake, connectedFile(Date.now()));
    await expect(c.check({ task: 'grammar', mode: 'standard', text }, signal())).rejects.toMatchObject({ code: 'model_unavailable' });
  });
});
