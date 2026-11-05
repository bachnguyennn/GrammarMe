/**
 * OpenID Connect pieces: discovery (cached per process), JWKS and ID token verification.
 *
 * The ID token identifies the user for display only. It does not authorize plan usage; that comes
 * from the granted scope (see hasPlanScope in oauth.ts).
 */
import { createPublicKey, verify } from 'node:crypto';
import type { JsonWebKey as NodeJwk } from 'node:crypto';
import { assertTrustedAuthUrl } from './config.ts';
import type { Endpoints } from './config.ts';
import { CompanionError } from './errors.ts';
import { getJson } from './http.ts';
import type { FetchFn } from './http.ts';

export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
}

export interface IdClaims {
  sub: string;
  email?: string;
  name?: string;
}

/** Allowed clock skew for exp/iat. */
export const CLOCK_TOLERANCE_MS = 5_000;

function invalidToken(): CompanionError {
  return new CompanionError('provider_error', 'OpenAI’s sign-in response failed verification. Try connecting again.');
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) throw invalidToken();
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw invalidToken();
  }
}

export class OidcClient {
  private readonly endpoints: Endpoints;
  private readonly fetchFn: FetchFn;
  private discoveryCache?: Discovery;
  private jwksCache?: NodeJwk[];

  constructor(endpoints: Endpoints, fetchFn: FetchFn) {
    this.endpoints = endpoints;
    this.fetchFn = fetchFn;
  }

  async discovery(signal?: AbortSignal): Promise<Discovery> {
    if (this.discoveryCache) return this.discoveryCache;
    const url = `${this.endpoints.authOrigin}/.well-known/openid-configuration`;
    const res = await getJson(this.fetchFn, url, signal).catch((e: unknown) => {
      if (e instanceof CompanionError && e.code === 'cancelled') throw e;
      throw new CompanionError('network');
    });
    if (res.status !== 200 || !res.body || typeof res.body !== 'object') throw new CompanionError('network');
    const d = res.body as Record<string, unknown>;
    if (typeof d.issuer !== 'string' || !d.issuer) throw new CompanionError('provider_error', 'OpenAI sign-in configuration is incomplete.');
    const discovery: Discovery = {
      issuer: d.issuer,
      authorizationEndpoint: assertTrustedAuthUrl(d.authorization_endpoint, this.endpoints),
      tokenEndpoint: assertTrustedAuthUrl(d.token_endpoint, this.endpoints),
      jwksUri: assertTrustedAuthUrl(d.jwks_uri, this.endpoints),
    };
    if (d.revocation_endpoint !== undefined) discovery.revocationEndpoint = assertTrustedAuthUrl(d.revocation_endpoint, this.endpoints);
    this.discoveryCache = discovery;
    return discovery;
  }

  private async jwks(force: boolean, signal?: AbortSignal): Promise<NodeJwk[]> {
    if (this.jwksCache && !force) return this.jwksCache;
    const { jwksUri } = await this.discovery(signal);
    const res = await getJson(this.fetchFn, jwksUri, signal);
    const keys = (res.body as { keys?: unknown } | null)?.keys;
    if (res.status !== 200 || !Array.isArray(keys)) throw new CompanionError('network');
    this.jwksCache = keys.filter((k): k is NodeJwk => !!k && typeof k === 'object');
    return this.jwksCache;
  }

  private async findKey(kid: string | undefined, signal?: AbortSignal): Promise<NodeJwk> {
    const pick = (keys: NodeJwk[]): NodeJwk | undefined =>
      kid ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : undefined;
    // Unknown kid: OpenAI may have rotated keys, so fetch the set once more.
    const key = pick(await this.jwks(false, signal)) ?? pick(await this.jwks(true, signal));
    if (!key) throw invalidToken();
    return key;
  }

  /**
   * Verifies signature (RS256 or ES256), issuer, audience, expiry, issued-at, nonce and subject.
   * `nonce` is required for tokens from the authorization-code exchange.
   */
  async verifyIdToken(token: string, expect: { clientId: string; nonce?: string; now: number }, signal?: AbortSignal): Promise<IdClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw invalidToken();
    const [h, p, s] = parts as [string, string, string];
    const header = decodeSegment(h);
    const alg = header.alg;
    if (alg !== 'RS256' && alg !== 'ES256') throw invalidToken();
    const jwk = await this.findKey(typeof header.kid === 'string' ? header.kid : undefined, signal);
    if (jwk.alg !== undefined && jwk.alg !== alg) throw invalidToken();
    if (jwk.use !== undefined && jwk.use !== 'sig') throw invalidToken();
    if (alg === 'RS256' ? jwk.kty !== 'RSA' : jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw invalidToken();
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw invalidToken();

    let ok = false;
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      const data = Buffer.from(`${h}.${p}`, 'ascii');
      const sig = Buffer.from(s, 'base64url');
      ok = alg === 'RS256' ? verify('sha256', data, key, sig) : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch {
      ok = false;
    }
    if (!ok) throw invalidToken();

    const claims = decodeSegment(p);
    const { issuer } = await this.discovery(signal);
    if (claims.iss !== issuer) throw invalidToken();
    const aud = claims.aud;
    const audOk = typeof aud === 'string' ? aud === expect.clientId : Array.isArray(aud) && aud.includes(expect.clientId);
    if (!audOk) throw invalidToken();
    if (typeof claims.exp !== 'number' || claims.exp * 1000 + CLOCK_TOLERANCE_MS <= expect.now) throw invalidToken();
    if (typeof claims.iat !== 'number' || claims.iat * 1000 - CLOCK_TOLERANCE_MS > expect.now) throw invalidToken();
    if (expect.nonce !== undefined && claims.nonce !== expect.nonce) throw invalidToken();
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw invalidToken();

    const out: IdClaims = { sub: claims.sub };
    if (typeof claims.email === 'string' && claims.email) out.email = claims.email;
    if (typeof claims.name === 'string' && claims.name) out.name = claims.name;
    return out;
  }
}
