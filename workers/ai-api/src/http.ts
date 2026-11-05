import type { AiErrorResponse } from '@grammarme/core';

export type ErrorCode = AiErrorResponse['error'];

/** Matches an Origin header against the allow-list. `http://localhost:*` matches any port. */
export function isOriginAllowed(origin: string, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    if (entry === origin) return true;
    if (entry.endsWith(':*')) {
      const prefix = entry.slice(0, -1); // keep the colon: "http://localhost:"
      if (origin.startsWith(prefix) && /^\d{1,5}$/.test(origin.slice(prefix.length))) return true;
    }
  }
  return false;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  too_long: 413,
  rate_limited: 429,
  quota_exhausted: 429,
  upstream_error: 502,
};

export function errorResponse(
  error: ErrorCode,
  message: string,
  extra: Record<string, string> = {},
  retryAfterSeconds?: number,
  statusOverride?: number,
): Response {
  const body: AiErrorResponse = { error, message };
  const headers = { ...extra };
  if (retryAfterSeconds !== undefined) {
    body.retryAfterSeconds = retryAfterSeconds;
    headers['Retry-After'] = String(retryAfterSeconds);
  }
  return json(body, statusOverride ?? STATUS[error], headers);
}

/** Constant-time string comparison via SHA-256 digests (lengths never leak through timing). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Short, non-reversible id for a client — used as a rate-limit key, never logged with text. */
export async function clientKey(token: string, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${token}|${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Seconds until the next 00:00 UTC (when provider and Cloudflare daily quotas reset). */
export function secondsUntilUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}
