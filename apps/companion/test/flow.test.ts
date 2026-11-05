/**
 * End to end over real sockets: a mock OpenAI (auth + API) on 127.0.0.1 reached through the
 * GRAMMARME_COMPANION_TEST_* hooks, the companion's real loopback listener, and the native
 * messaging host loop. The "browser" requests the authorize URL from the mock, which redirects to
 * the companion's callback with code, state and the issued client_id.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Companion } from '../src/companion.ts';
import { cleanupHomes, FULL_SCOPE, rsaKey, signJwt, tempHome } from './helpers.ts';
import { doneFor, hostHarness } from './hostio.ts';

const key = rsaKey('flow');
let server: Server;
let origin = '';
const seen: { authorize?: URLSearchParams; token?: URLSearchParams; responses?: Record<string, unknown>; revoked?: string } = {};
const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();

const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      switch (url.pathname) {
        case '/.well-known/openid-configuration':
          return send(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/api/accounts/authorize`,
            token_endpoint: `${origin}/api/accounts/oauth/token`,
            revocation_endpoint: `${origin}/api/accounts/oauth/revoke`,
            jwks_uri: `${origin}/.well-known/jwks.json`,
          });
        case '/.well-known/jwks.json':
          return send(res, 200, { keys: [key.jwk] });
        case '/api/accounts/authorize': {
          seen.authorize = url.searchParams;
          const code = `code-${codes.size + 1}`;
          const redirect = url.searchParams.get('redirect_uri')!;
          codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, redirect });
          const back = new URL(redirect);
          back.searchParams.set('code', code);
          back.searchParams.set('state', url.searchParams.get('state')!);
          back.searchParams.set('client_id', 'oaiapp_flow');
          res.writeHead(302, { Location: back.href });
          return res.end();
        }
        case '/api/accounts/oauth/token': {
          const form = new URLSearchParams(body);
          seen.token = form;
          const grant = codes.get(form.get('code') ?? '');
          if (!grant || form.get('redirect_uri') !== grant.redirect || form.get('client_id') !== 'oaiapp_flow') return send(res, 400, { error: 'invalid_grant' });
          const now = Math.floor(Date.now() / 1000);
          return send(res, 200, {
            access_token: 'flow-access',
            refresh_token: 'flow-refresh',
            id_token: signJwt(key, { iss: origin, aud: 'oaiapp_flow', sub: 'u-flow', email: 'flow@example.com', nonce: grant.nonce, iat: now, exp: now + 3600 }),
            token_type: 'Bearer',
            expires_in: 3600,
            scope: FULL_SCOPE,
          });
        }
        case '/api/accounts/oauth/revoke':
          seen.revoked = new URLSearchParams(body).get('token') ?? '';
          res.writeHead(200);
          return res.end();
        case '/v1/models':
          if (req.headers.authorization !== 'Bearer flow-access') return send(res, 401, { detail: 'Unauthorized' });
          return send(res, 200, { models: [{ slug: 'gpt-flow', display_name: 'GPT Flow', visibility: 'list' }] });
        case '/v1/responses': {
          if (req.headers.authorization !== 'Bearer flow-access') return send(res, 401, { detail: 'Unauthorized' });
          seen.responses = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const answer = JSON.stringify({ edits: [{ original: 'recieve', replacement: 'receive', contextBefore: 'We ', category: 'spelling', message: 'Spelling.' }] });
          const events = [
            { type: 'response.created' },
            ...answer.match(/.{1,10}/g)!.map((d) => ({ type: 'response.output_text.delta', delta: d })),
            { type: 'response.completed', response: { status: 'completed' } },
          ];
          const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
          let i = 0;
          const tick = () => {
            if (i >= text.length) return res.end();
            res.write(text.slice(i, (i += 17)));
            setImmediate(tick);
          };
          return tick();
        }
        default:
          return send(res, 404, {});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(cleanupHomes);

describe('full flow over native messaging', () => {
  it('signs in through the loopback callback, then runs a check', async () => {
    const companion = new Companion({
      home: await tempHome(),
      env: { GRAMMARME_COMPANION_TEST_AUTH_ORIGIN: origin, GRAMMARME_COMPANION_TEST_API_ORIGIN: origin },
      preferredCallbackPort: 0,
    });
    const h = hostHarness(companion);

    h.send({ id: 'sign', type: 'signIn' });
    const auth = await h.waitFor((m) => m.id === 'sign' && m.type === 'authUrl');
    // The browser: follow OpenAI's redirect back to the companion's callback page.
    const page = await fetch(auth.url as string, { redirect: 'follow' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('You can close this tab and return to GrammarMe');

    const signed = await h.waitFor(doneFor('sign'));
    expect(signed).toMatchObject({ ok: true, status: { connected: true, account: { email: 'flow@example.com', planUsage: true } } });
    expect(JSON.stringify(h.received)).not.toMatch(/flow-access|flow-refresh/);
    expect(seen.authorize?.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

    h.send({ id: 'chk', type: 'check', task: 'grammar', mode: 'professional', text: 'We recieve the files daily.' });
    const checked = await h.waitFor(doneFor('chk'));
    expect(checked).toMatchObject({
      ok: true,
      check: { model: 'gpt-flow', dropped: 0, edits: [{ original: 'recieve', replacement: 'receive', category: 'spelling' }] },
    });
    expect(seen.responses).toMatchObject({ store: false, stream: true, model: 'gpt-flow' });

    h.send({ id: 'out', type: 'signOut' });
    expect(await h.waitFor(doneFor('out'))).toMatchObject({ ok: true, revoked: true, status: { connected: false } });
    expect(seen.revoked).toBe('flow-refresh');

    h.end();
    await h.done;
  });
});
