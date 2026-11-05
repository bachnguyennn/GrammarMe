/**
 * Abuse and cost controls. Only counters and hashed client keys are kept — never request text.
 *
 * Per-client rate limit:
 *  - If the RATE_LIMITER binding is configured (wrangler.toml [[ratelimits]]), use it. Cloudflare
 *    documents it as per-location and eventually consistent (approximate).
 *  - Otherwise an in-memory fixed-window counter per isolate. Best-effort only: Workers may run many
 *    isolates and evict them at any time, so this bounds bursts, not totals.
 *
 * Daily cap (DAILY_REQUEST_CAP, all clients together, resets 00:00 UTC):
 *  - If USAGE_KV is bound, a single integer per UTC day in KV (approximate: KV is eventually
 *    consistent and has no atomic increment; the free plan allows 1,000 KV writes/day, so keep the
 *    cap below that).
 *  - Otherwise in-memory per isolate (best-effort). The provider's own free quota is the real backstop
 *    and is mapped to `quota_exhausted` either way.
 */
import type { CounterKv, RateLimitBinding } from './env.ts';

export interface RateLimiter {
  /** Returns true if the request is allowed. */
  allow(key: string, now?: number): Promise<boolean>;
  /** Seconds a client should wait after being limited. */
  readonly retryAfterSeconds: number;
}

export class BindingRateLimiter implements RateLimiter {
  readonly retryAfterSeconds = 60;
  constructor(private readonly binding: RateLimitBinding) {}
  async allow(key: string): Promise<boolean> {
    try {
      return (await this.binding.limit({ key })).success;
    } catch {
      return true; // Fail open: the daily cap and provider quotas still bound cost.
    }
  }
}

export class MemoryRateLimiter implements RateLimiter {
  readonly retryAfterSeconds = 60;
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly perMinute: number) {}
  async allow(key: string, now = Date.now()): Promise<boolean> {
    const w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      if (this.windows.size > 1000) this.windows.clear(); // bound memory
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.perMinute) return false;
    w.count++;
    return true;
  }
}

export interface UsageCounter {
  /** Current count for the UTC day. */
  get(now?: number): Promise<number>;
  /** Records one model call. */
  increment(now?: number): Promise<number>;
}

const dayKey = (now: number) => `usage:${new Date(now).toISOString().slice(0, 10)}`;

export class MemoryUsageCounter implements UsageCounter {
  private day = '';
  private count = 0;
  async get(now = Date.now()): Promise<number> {
    if (dayKey(now) !== this.day) return 0;
    return this.count;
  }
  async increment(now = Date.now()): Promise<number> {
    const d = dayKey(now);
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
    }
    return ++this.count;
  }
}

export class KvUsageCounter implements UsageCounter {
  constructor(private readonly kv: CounterKv) {}
  async get(now = Date.now()): Promise<number> {
    try {
      return Number((await this.kv.get(dayKey(now))) ?? '0') || 0;
    } catch {
      return 0;
    }
  }
  async increment(now = Date.now()): Promise<number> {
    const next = (await this.get(now)) + 1;
    try {
      await this.kv.put(dayKey(now), String(next), { expirationTtl: 60 * 60 * 48 });
    } catch {
      /* counter is best-effort */
    }
    return next;
  }
}
