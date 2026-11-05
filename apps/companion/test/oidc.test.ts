import { describe, expect, it } from 'vitest';
import { resolveEndpoints } from '../src/config.ts';
import { OidcClient } from '../src/oidc.ts';
import { AUTH, discoveryDoc, ecKey, idClaims, ISSUED_CLIENT, json, mockFetch, rsaKey, signJwt } from './helpers.ts';
import type { TestKey } from './helpers.ts';

const NOW = 1_800_000_000_000;
const key = rsaKey('k1');

function client(keys: TestKey[] | (() => TestKey[]), discovery = discoveryDoc()) {
  const m = mockFetch(({ url }) => {
    if (url.pathname === '/.well-known/openid-configuration') return json(discovery);
    if (url.pathname === '/.well-known/jwks.json') return json({ keys: (typeof keys === 'function' ? keys() : keys).map((k) => k.jwk) });
    return json({}, 404);
  });
  return { oidc: new OidcClient(resolveEndpoints({}), m.fetch), calls: m.calls };
}

const verify = (oidc: OidcClient, token: string, nonce = 'n1') => oidc.verifyIdToken(token, { clientId: ISSUED_CLIENT, nonce, now: NOW });

describe('ID token verification', () => {
  it('accepts a valid RS256 token and returns display claims', async () => {
    const { oidc } = client([key]);
    await expect(verify(oidc, signJwt(key, idClaims(NOW, { nonce: 'n1' })))).resolves.toEqual({ sub: 'user-1', email: 'ada@example.com', name: 'Ada' });
  });

  it('accepts an audience array containing the issued client_id', async () => {
    const { oidc } = client([key]);
    await expect(verify(oidc, signJwt(key, idClaims(NOW, { nonce: 'n1', aud: ['other', ISSUED_CLIENT] })))).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('accepts ES256 when the JWK says so', async () => {
    const ec = ecKey();
    const { oidc } = client([ec]);
    await expect(verify(oidc, signJwt(ec, idClaims(NOW, { nonce: 'n1' })))).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('rejects a bad signature', async () => {
    const other = rsaKey('k1'); // same kid, different key
    const { oidc } = client([key]);
    await expect(verify(oidc, signJwt(other, idClaims(NOW, { nonce: 'n1' })))).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('rejects a tampered payload', async () => {
    const { oidc } = client([key]);
    const [h, , s] = signJwt(key, idClaims(NOW, { nonce: 'n1' })).split('.');
    const forged = Buffer.from(JSON.stringify(idClaims(NOW, { nonce: 'n1', sub: 'attacker' }))).toString('base64url');
    await expect(verify(oidc, `${h}.${forged}.${s}`)).rejects.toMatchObject({ code: 'provider_error' });
  });

  it.each([
    ['wrong audience', { aud: 'oaiapp_someone_else' }],
    ['wrong nonce', { nonce: 'n2' }],
    ['expired', { exp: Math.floor(NOW / 1000) - 10 }],
    ['wrong issuer', { iss: 'https://auth.example.com' }],
    ['missing iat', { iat: undefined }],
    ['iat in the future', { iat: Math.floor(NOW / 1000) + 60 }],
    ['empty sub', { sub: '' }],
  ])('rejects %s', async (_name, overrides) => {
    const { oidc } = client([key]);
    await expect(verify(oidc, signJwt(key, idClaims(NOW, { nonce: 'n1', ...overrides })))).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('tolerates 5 s of clock skew on exp', async () => {
    const { oidc } = client([key]);
    await expect(verify(oidc, signJwt(key, idClaims(NOW, { nonce: 'n1', exp: Math.floor(NOW / 1000) - 3 })))).resolves.toBeTruthy();
  });

  it('rejects alg none and HS256', async () => {
    const { oidc } = client([key]);
    const claims = Buffer.from(JSON.stringify(idClaims(NOW, { nonce: 'n1' }))).toString('base64url');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${claims}.`;
    await expect(verify(oidc, none)).rejects.toMatchObject({ code: 'provider_error' });
    await expect(verify(oidc, signJwt(key, idClaims(NOW, { nonce: 'n1' }), { alg: 'HS256' }))).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('refetches the JWKS once for an unknown kid (key rotation)', async () => {
    const rotated = rsaKey('k2');
    let current = [key];
    const { oidc, calls } = client(() => current);
    await verify(oidc, signJwt(key, idClaims(NOW, { nonce: 'n1' })));
    current = [key, rotated];
    await expect(verify(oidc, signJwt(rotated, idClaims(NOW, { nonce: 'n1' })))).resolves.toBeTruthy();
    expect(calls.filter((c) => c.url.pathname.endsWith('jwks.json'))).toHaveLength(2);
  });

  it('refuses discovery documents that point away from openai.com', async () => {
    const { oidc } = client([key], { ...discoveryDoc(), token_endpoint: 'https://evil.example/token' });
    await expect(oidc.discovery()).rejects.toMatchObject({ code: 'provider_error' });
    const { oidc: plain } = client([key], { ...discoveryDoc(), token_endpoint: `${AUTH.replace('https', 'http')}/token` });
    await expect(plain.discovery()).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('reports network when discovery is unreachable', async () => {
    const oidc = new OidcClient(resolveEndpoints({}), (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(oidc.discovery()).rejects.toMatchObject({ code: 'network' });
  });
});
