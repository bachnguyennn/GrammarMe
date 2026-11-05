import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_SCOPE } from '../src/config.ts';
import type { CredentialFile } from '../src/store.ts';

export const ISSUER = 'https://auth.openai.com';
export const AUTH = 'https://auth.openai.com';
export const API = 'https://api.openai.com';
export const ISSUED_CLIENT = 'oaiapp_test123';
export const FULL_SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

const homes: string[] = [];
export async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gm-companion-'));
  homes.push(dir);
  return join(dir, 'grammarme');
}
export async function cleanupHomes(): Promise<void> {
  while (homes.length) await rm(homes.pop() as string, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ keys + JWT */

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function rsaKey(kid = 'test-key'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

export function ecKey(kid = 'ec-key'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signJwt(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const alg = key.jwk.alg as string;
  const input = `${b64({ alg, typ: 'JWT', kid: key.kid, ...header })}.${b64(claims)}`;
  const sig =
    alg === 'ES256'
      ? sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
      : sign('sha256', Buffer.from(input), key.privateKey);
  return `${input}.${sig.toString('base64url')}`;
}

export function idClaims(now: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const s = Math.floor(now / 1000);
  return { iss: ISSUER, aud: ISSUED_CLIENT, sub: 'user-1', email: 'ada@example.com', name: 'Ada', iat: s, exp: s + 3600, ...overrides };
}

/* ------------------------------------------------------------------ fetch mock */

export interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

export type Handler = (call: Call, signal?: AbortSignal | null) => Response | Promise<Response>;

export function mockFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === 'string' ? init.body : '';
    const call: Call = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(call, init?.signal);
  };
  return { fetch: fn as typeof fetch, calls };
}

export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function discoveryDoc(origin = AUTH, issuer = ISSUER): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${origin}/api/accounts/authorize`,
    token_endpoint: `${origin}/api/accounts/oauth/token`,
    revocation_endpoint: `${origin}/api/accounts/oauth/revoke`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
  };
}

/** Builds an SSE body from event objects, split into chunks of `chunkSize` characters. */
export function sseResponse(events: Record<string, unknown>[], chunkSize = 7, opts: { hang?: boolean; signal?: AbortSignal | null } = {}): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        if (opts.hang) {
          return new Promise<void>((_, reject) => {
            const fail = () => {
              const err = new DOMException('aborted', 'AbortError');
              controller.error(err);
              reject(err);
            };
            if (opts.signal?.aborted) fail();
            opts.signal?.addEventListener('abort', fail);
          });
        }
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(i, i + chunkSize));
      i += chunkSize;
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export function textEvents(text: string, pieces = 5): Record<string, unknown>[] {
  const size = Math.ceil(text.length / pieces) || 1;
  const out: Record<string, unknown>[] = [{ type: 'response.created', response: { id: 'resp_1' } }];
  for (let i = 0; i < text.length; i += size) out.push({ type: 'response.output_text.delta', delta: text.slice(i, i + size) });
  out.push({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } });
  return out;
}

export function connectedFile(now: number, overrides: Partial<CredentialFile> = {}, tokenOverrides: Record<string, unknown> = {}): CredentialFile {
  return {
    hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555',
    clientId: ISSUED_CLIENT,
    profile: { sub: 'user-1', email: 'ada@example.com', name: 'Ada' },
    tokens: { access: 'access-1', refresh: 'refresh-1', id: 'id-1', expiresAt: now + 3600_000, scope: FULL_SCOPE, ...tokenOverrides },
    ...overrides,
  };
}
