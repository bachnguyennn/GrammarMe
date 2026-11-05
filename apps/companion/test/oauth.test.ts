import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, createPkce, hasPlanScope, parseCallback, parseEarliestRefreshAt, pkceChallenge, redactAuthorizeUrl } from '../src/oauth.ts';
import { FULL_SCOPE } from './helpers.ts';

const base = {
  authorizationEndpoint: 'https://auth.openai.com/api/accounts/authorize',
  hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555',
  redirectUri: 'http://127.0.0.1:1455/auth/callback',
  state: 'state-1',
  nonce: 'nonce-1',
  codeChallenge: 'challenge-1',
};

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates a 43-char base64url verifier and its unpadded S256 challenge', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(pkceChallenge(verifier));
    expect(challenge).not.toContain('=');
    expect(createPkce().verifier).not.toBe(verifier);
  });
});

describe('authorize URL', () => {
  it('first registration: dynamic client, agent name hint, no id_token_hint', () => {
    const url = new URL(buildAuthorizeUrl({ ...base, idTokenHint: 'ignored-without-client' }));
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe(base.authorizationEndpoint);
    expect(q.get('client_id')).toBe('dynamic_agent_client');
    expect(q.get('agent_name_hint')).toBe('GrammarMe');
    expect(q.get('ext_agent_host_id')).toBe(base.hostId);
    expect(q.has('id_token_hint')).toBe(false);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(q.get('scope')).toBe(FULL_SCOPE);
    expect(q.get('resource')).toBe('https://api.openai.com/v1');
    expect(q.get('state')).toBe('state-1');
    expect(q.get('nonce')).toBe('nonce-1');
    expect(q.get('code_challenge')).toBe('challenge-1');
    expect(q.get('code_challenge_method')).toBe('S256');
  });

  it('re-authorization: issued client_id, id_token_hint, no agent name hint', () => {
    const q = new URL(buildAuthorizeUrl({ ...base, issuedClientId: 'oaiapp_abc', idTokenHint: 'eyJ.hint.sig' })).searchParams;
    expect(q.get('client_id')).toBe('oaiapp_abc');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('id_token_hint')).toBe('eyJ.hint.sig');
  });

  it('redacts id_token_hint for logs', () => {
    const href = buildAuthorizeUrl({ ...base, issuedClientId: 'oaiapp_abc', idTokenHint: 'secret.id.token' });
    expect(redactAuthorizeUrl(href)).not.toContain('secret.id.token');
  });
});

describe('callback parsing', () => {
  const params = (q: Record<string, string>) => new URLSearchParams(q);

  it('captures the code and the issued client_id', () => {
    expect(parseCallback(params({ code: 'c1', state: 's', client_id: 'oaiapp_xyz' }), 's')).toEqual({ ok: true, code: 'c1', clientId: 'oaiapp_xyz' });
  });

  it('rejects a state mismatch', () => {
    const r = parseCallback(params({ code: 'c1', state: 'other' }), 's');
    expect(r).toMatchObject({ ok: false, error: 'provider_error' });
  });

  it('maps error=access_denied (and any error) to consent_denied', () => {
    expect(parseCallback(params({ error: 'access_denied', state: 's' }), 's')).toMatchObject({ ok: false, error: 'consent_denied' });
    expect(parseCallback(params({ error: 'server_error', state: 's' }), 's')).toMatchObject({ ok: false, error: 'consent_denied' });
  });

  it('rejects a missing code or a malformed client_id', () => {
    expect(parseCallback(params({ state: 's' }), 's')).toMatchObject({ ok: false, error: 'provider_error' });
    expect(parseCallback(params({ state: 's', code: 'c', client_id: 'bad id<>' }), 's')).toMatchObject({ ok: false });
  });
});

describe('grant helpers', () => {
  it('requires chatgpt.tokens.use.direct as a whole scope word', () => {
    expect(hasPlanScope(FULL_SCOPE)).toBe(true);
    expect(hasPlanScope('openid profile email offline_access')).toBe(false);
    expect(hasPlanScope('chatgpt.tokens.use.direct.extra')).toBe(false);
    expect(hasPlanScope(undefined)).toBe(false);
  });

  it('reads earliest_refresh_at in several encodings', () => {
    const now = 1_800_000_000_000;
    expect(parseEarliestRefreshAt(1_800_000_600, now)).toBe(1_800_000_600_000);
    expect(parseEarliestRefreshAt(1_800_000_600_000, now)).toBe(1_800_000_600_000);
    expect(parseEarliestRefreshAt(600, now)).toBe(now + 600_000);
    expect(parseEarliestRefreshAt('2027-01-15T08:00:00Z', now)).toBe(Date.parse('2027-01-15T08:00:00Z'));
    expect(parseEarliestRefreshAt(null, now)).toBeUndefined();
  });
});

describe('scopeFromAccessToken (token response without `scope`)', () => {
  const jwt = (claims: Record<string, unknown>) =>
    ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  it('reads a string or array scope claim, and nothing from opaque tokens', async () => {
    const { scopeFromAccessToken, hasPlanScope } = await import('../src/oauth.ts');
    expect(hasPlanScope(scopeFromAccessToken(jwt({ scope: 'openid chatgpt.tokens.use.direct' })))).toBe(true);
    expect(scopeFromAccessToken(jwt({ scp: ['openid', 'offline_access'] }))).toBe('openid offline_access');
    expect(scopeFromAccessToken('opaque-token')).toBeUndefined();
    expect(scopeFromAccessToken('a.!!!.c')).toBeUndefined();
  });
});
