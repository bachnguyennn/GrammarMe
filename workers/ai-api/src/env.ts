/**
 * Worker environment (bindings, vars, secrets) and parsed runtime config.
 *
 * Secrets (set with `wrangler secret put <NAME>`, or `.dev.vars` locally):
 *   GRAMMARME_CLIENT_TOKEN, GEMINI_API_KEY, GROQ_API_KEY
 * Everything else is a plain var in wrangler.toml.
 */

/** Minimal view of the Workers AI binding — we only call `run`. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Minimal view of the Rate Limiting binding (see wrangler.toml `[[ratelimits]]`). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Minimal view of a KV namespace, used only for an integer usage counter (never for text). */
export interface CounterKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  // --- secrets ---
  GRAMMARME_CLIENT_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;

  // --- vars ---
  /** Comma-separated provider order, e.g. "gemini,groq,workers-ai". First configured one is tried first. */
  AI_PROVIDERS?: string;
  /** Comma-separated exact origins. `http://localhost:*` / `http://127.0.0.1:*` match any port. */
  ALLOWED_ORIGINS?: string;
  GEMINI_MODEL?: string;
  /** Optional Gemini 3+ thinking level ("minimal" | "low" | ...). Unset = model default. */
  GEMINI_THINKING_LEVEL?: string;
  GROQ_MODEL?: string;
  /** gpt-oss only: "low" | "medium" | "high". Unset = provider default. */
  GROQ_REASONING_EFFORT?: string;
  WORKERS_AI_MODEL?: string;
  MAX_INPUT_CHARS?: string;
  MAX_EDITS?: string;
  /** Hard cap on successful-or-attempted model calls per UTC day, across all clients. */
  DAILY_REQUEST_CAP?: string;
  /** Used only when the RATE_LIMITER binding is absent (in-memory, per isolate). */
  RATE_LIMIT_PER_MINUTE?: string;
  PROVIDER_TIMEOUT_MS?: string;

  // --- bindings (all optional) ---
  AI?: AiBinding;
  RATE_LIMITER?: RateLimitBinding;
  USAGE_KV?: CounterKv;
}

export interface Config {
  maxInputChars: number;
  maxEdits: number;
  dailyCap: number;
  ratePerMinute: number;
  providerTimeoutMs: number;
  allowedOrigins: string[];
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function readConfig(env: Env): Config {
  return {
    maxInputChars: int(env.MAX_INPUT_CHARS, 4000, 1, 20_000),
    maxEdits: int(env.MAX_EDITS, 25, 1, 100),
    dailyCap: int(env.DAILY_REQUEST_CAP, 200, 0, 1_000_000),
    ratePerMinute: int(env.RATE_LIMIT_PER_MINUTE, 10, 1, 10_000),
    providerTimeoutMs: int(env.PROVIDER_TIMEOUT_MS, 20_000, 1_000, 60_000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
