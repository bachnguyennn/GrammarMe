/**
 * Sign in with ChatGPT (OAuth 2.0 authorization code + PKCE, public client, loopback redirect).
 *
 * First registration uses client_id=dynamic_agent_client plus agent_name_hint; OpenAI then returns
 * this install's own client_id in the callback, which is used for the code exchange and every later
 * request. Re-authorization uses the issued client_id (and id_token_hint when we still have one).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CompanionErrorCode } from '@grammarme/core/companion';
import { AGENT_NAME, DYNAMIC_CLIENT_ID, OPENAI_RESOURCE, PLAN_SCOPE, SCOPES } from './config.ts';
import { CompanionError } from './errors.ts';
import { postForm } from './http.ts';
import type { FetchFn } from './http.ts';

/* ------------------------------------------------------------------ PKCE, state, nonce */

export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))), no padding. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomUrlToken(32); // 43 characters, within RFC 7636's 43..128
  return { verifier, challenge: pkceChallenge(verifier) };
}

/* ------------------------------------------------------------------ authorize URL */

export interface AuthorizeParams {
  authorizationEndpoint: string;
  /** The issued client_id from an earlier sign-in; undefined means first registration. */
  issuedClientId?: string;
  hostId: string;
  /** Saved ID token, sent only on re-authorization. */
  idTokenHint?: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const url = new URL(p.authorizationEndpoint);
  const q = url.searchParams;
  q.set('client_id', p.issuedClientId ?? DYNAMIC_CLIENT_ID);
  if (!p.issuedClientId) q.set('agent_name_hint', AGENT_NAME);
  q.set('ext_agent_host_id', p.hostId);
  if (p.issuedClientId && p.idTokenHint) q.set('id_token_hint', p.idTokenHint);
  q.set('response_type', 'code');
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', SCOPES.join(' '));
  q.set('resource', OPENAI_RESOURCE);
  q.set('state', p.state);
  q.set('nonce', p.nonce);
  q.set('code_challenge', p.codeChallenge);
  q.set('code_challenge_method', 'S256');
  return url.href;
}

/** For logs: the authorize URL with id_token_hint removed. */
export function redactAuthorizeUrl(href: string): string {
  const url = new URL(href);
  if (url.searchParams.has('id_token_hint')) url.searchParams.set('id_token_hint', '[redacted]');
  return url.href;
}

/* ------------------------------------------------------------------ callback */

export type CallbackResult =
  | { ok: true; code: string; clientId?: string }
  | { ok: false; error: CompanionErrorCode; message: string };

const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function parseCallback(params: URLSearchParams, expectedState: string): CallbackResult {
  const fail = (error: CompanionErrorCode, message: string): CallbackResult => ({ ok: false, error, message });
  if (params.get('state') !== expectedState) {
    return fail('provider_error', 'The sign-in response didn’t match this sign-in attempt. Start again from GrammarMe.');
  }
  if (params.has('error')) {
    return fail('consent_denied', 'ChatGPT access wasn’t allowed. Nothing was connected.');
  }
  const code = params.get('code');
  if (!code) return fail('provider_error', 'The sign-in response had no authorization code.');
  const clientId = params.get('client_id');
  if (clientId !== null && !CLIENT_ID.test(clientId)) return fail('provider_error', 'The sign-in response had an invalid client ID.');
  return clientId ? { ok: true, code, clientId } : { ok: true, code };
}

/* ------------------------------------------------------------------ token endpoint */

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scope?: string;
  earliestRefreshAt?: number;
}

/** Error codes from the refresh grant that mean the session is gone for good. */
export const REAUTH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export function oauthErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.error === 'string') return b.error;
  const nested = b.error as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object' && typeof nested.code === 'string') return nested.code;
  if (typeof b.code === 'string') return b.code;
  return undefined;
}

/**
 * The `scope` claim inside an access token (OpenAI documents aud, client_id, scope and iss claims).
 * Used only when the token response leaves `scope` out, which OAuth allows when the grant equals
 * the request. The companion doesn't verify this token; OpenAI's API does on every call. This is
 * only a hint for the permission screen, never an authorization decision.
 */
export function scopeFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const scope = claims.scope ?? claims.scp;
    if (typeof scope === 'string') return scope;
    if (Array.isArray(scope) && scope.every((x) => typeof x === 'string')) return scope.join(' ');
  } catch {
    /* not a JWT */
  }
  return undefined;
}

export function hasPlanScope(scope: string | undefined): boolean {
  return typeof scope === 'string' && scope.split(/\s+/).includes(PLAN_SCOPE);
}

/**
 * earliest_refresh_at's encoding isn't pinned down in the docs we read, so accept: epoch seconds,
 * epoch milliseconds, an ISO-8601 string, or a small number of seconds relative to now.
 */
export function parseEarliestRefreshAt(value: unknown, now: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    if (value < 1e9) return now + value * 1000;
    if (value < 1e12) return value * 1000;
    return value;
  }
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function parseTokenSet(body: unknown, now: number): TokenSet {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.access_token !== 'string' || !b.access_token) {
    throw new CompanionError('provider_error', 'OpenAI’s token response was incomplete.');
  }
  const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600;
  const out: TokenSet = { accessToken: b.access_token, expiresAt: now + expiresIn * 1000 };
  if (typeof b.refresh_token === 'string' && b.refresh_token) out.refreshToken = b.refresh_token;
  if (typeof b.id_token === 'string' && b.id_token) out.idToken = b.id_token;
  if (typeof b.scope === 'string') out.scope = b.scope;
  const earliest = parseEarliestRefreshAt(b.earliest_refresh_at, now);
  if (earliest !== undefined) out.earliestRefreshAt = earliest;
  return out;
}

function tokenEndpointError(status: number, body: unknown): CompanionError {
  const code = oauthErrorCode(body);
  if (code === 'invalid_client') {
    return new CompanionError('internal', 'OpenAI no longer recognises this GrammarMe install (invalid_client). Run `grammarme-companion doctor`, then connect again.');
  }
  if (code && REAUTH_ERRORS.has(code)) return new CompanionError('reauth_required');
  if (code === 'access_denied') return new CompanionError('consent_denied');
  if (status >= 500) return new CompanionError('provider_error');
  return new CompanionError('provider_error', 'OpenAI rejected the sign-in. Try connecting again.');
}

export async function exchangeCode(
  fetchFn: FetchFn,
  tokenEndpoint: string,
  p: { clientId: string; code: string; codeVerifier: string; redirectUri: string; now: number },
  signal?: AbortSignal,
): Promise<TokenSet> {
  const res = await postForm(
    fetchFn,
    tokenEndpoint,
    {
      grant_type: 'authorization_code',
      client_id: p.clientId,
      code: p.code,
      code_verifier: p.codeVerifier,
      redirect_uri: p.redirectUri,
      resource: OPENAI_RESOURCE,
    },
    signal,
  );
  if (res.status !== 200) throw tokenEndpointError(res.status, res.body);
  return parseTokenSet(res.body, p.now);
}

export type RefreshOutcome = { ok: true; tokens: TokenSet } | { ok: false; error: CompanionError; clearTokens: boolean };

export async function refreshGrant(
  fetchFn: FetchFn,
  tokenEndpoint: string,
  p: { clientId: string; refreshToken: string; now: number },
  signal?: AbortSignal,
): Promise<RefreshOutcome> {
  let res;
  try {
    // No `scope`: the refreshed grant keeps what the user approved.
    res = await postForm(fetchFn, tokenEndpoint, {
      grant_type: 'refresh_token',
      client_id: p.clientId,
      refresh_token: p.refreshToken,
      resource: OPENAI_RESOURCE,
    }, signal);
  } catch (e) {
    return { ok: false, error: e instanceof CompanionError ? e : new CompanionError('network'), clearTokens: false };
  }
  if (res.status === 200) {
    try {
      return { ok: true, tokens: parseTokenSet(res.body, p.now) };
    } catch (e) {
      return { ok: false, error: e as CompanionError, clearTokens: false };
    }
  }
  const error = tokenEndpointError(res.status, res.body);
  return { ok: false, error, clearTokens: error.code === 'reauth_required' };
}

/**
 * RFC 7009 revocation of the refresh token. Network failures and 5xx are retried up to 3 times with
 * backoff. Returns true only when OpenAI confirmed (HTTP 200; also returned for already-invalid tokens).
 */
export async function revokeRefreshToken(
  fetchFn: FetchFn,
  revocationEndpoint: string,
  p: { clientId: string; refreshToken: string },
  backoffMs = 500,
): Promise<boolean> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
    try {
      const res = await postForm(fetchFn, revocationEndpoint, {
        token: p.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: p.clientId,
      });
      if (res.status === 200) return true;
      if (res.status < 500) return false;
    } catch {
      // Network error or timeout: retry.
    }
  }
  return false;
}
