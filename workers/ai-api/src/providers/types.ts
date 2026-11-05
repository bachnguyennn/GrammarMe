export interface GenerateInput {
  system: string;
  user: string;
  /** JSON Schema the output must follow (strict-mode compatible). */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface Provider {
  /** Stable id used in AI_PROVIDERS and in the response `model` field, e.g. "gemini". */
  readonly id: string;
  readonly model: string;
  /** Returns the model's raw JSON text (or an already-parsed object for bindings that parse it). */
  generate(input: GenerateInput): Promise<unknown>;
}

/**
 * Normalised provider failure.
 *  quota       — provider said 429 / RESOURCE_EXHAUSTED / out of free allocation.
 *  unavailable — 5xx, timeout, network error.
 *  bad_output  — response missing, blocked by safety filters, or not parseable JSON.
 *  config      — 400/401/403/404: our key, model name or request is wrong.
 */
export type ProviderErrorKind = 'quota' | 'unavailable' | 'bad_output' | 'config';

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    // Message deliberately carries no upstream body: upstream errors may echo the user's text.
    super(`${provider}: ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ProviderError';
  }
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'quota';
  if (status >= 500) return 'unavailable';
  return 'config';
}

/** Parses a Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

/** fetch() wrapper that turns network failures/timeouts into ProviderError('unavailable'). */
export async function providerFetch(provider: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ProviderError(provider, 'unavailable');
  }
}
