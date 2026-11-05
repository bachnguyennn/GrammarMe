import type { Env } from '../env.ts';
import { GeminiProvider } from './gemini.ts';
import { GroqProvider } from './groq.ts';
import { ProviderError } from './types.ts';
import type { GenerateInput, Provider } from './types.ts';
import { WorkersAiProvider } from './workersAi.ts';

export { ProviderError } from './types.ts';
export type { Provider, GenerateInput } from './types.ts';

/** Gemini is deliberately not in the default order: its free tier may use prompts for training (opt-in only). */
export const DEFAULT_PROVIDER_ORDER = 'groq,workers-ai';

/**
 * Builds the provider chain from AI_PROVIDERS (comma-separated, in priority order), skipping any
 * provider whose secret/binding is missing. Unknown names are ignored.
 */
export function buildProviders(env: Env): Provider[] {
  const order = (env.AI_PROVIDERS ?? DEFAULT_PROVIDER_ORDER)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: Provider[] = [];
  for (const name of new Set(order)) {
    if (name === 'gemini' && env.GEMINI_API_KEY) {
      out.push(new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL || undefined, env.GEMINI_THINKING_LEVEL || undefined));
    } else if (name === 'groq' && env.GROQ_API_KEY) {
      out.push(new GroqProvider(env.GROQ_API_KEY, env.GROQ_MODEL || undefined, env.GROQ_REASONING_EFFORT || undefined));
    } else if (name === 'workers-ai' && env.AI) {
      out.push(new WorkersAiProvider(env.AI, env.WORKERS_AI_MODEL || undefined));
    }
  }
  return out;
}

export interface ChainSuccess {
  ok: true;
  provider: Provider;
  /** Raw output (JSON text or object). */
  output: unknown;
  /** Earlier providers that failed, for metadata logging only. */
  failures: ProviderError[];
}

export interface ChainFailure {
  ok: false;
  failures: ProviderError[];
}

/**
 * Tries providers in order. Any failure moves on to the next provider: quota/5xx/timeouts are the
 * expected case, but a misconfigured key or model on one provider should not take the service down
 * either. `parse` lets the caller reject unusable output (e.g. invalid JSON) so we fall back too.
 */
export async function runWithFallback(
  providers: readonly Provider[],
  input: Omit<GenerateInput, 'signal'>,
  timeoutMs: number,
  parse: (raw: unknown) => unknown | null,
): Promise<ChainSuccess | ChainFailure> {
  const failures: ProviderError[] = [];
  for (const provider of providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await provider.generate({ ...input, signal: controller.signal });
      const parsed = parse(raw);
      if (parsed === null) throw new ProviderError(provider.id, 'bad_output');
      return { ok: true, provider, output: parsed, failures };
    } catch (e) {
      failures.push(e instanceof ProviderError ? e : new ProviderError(provider.id, 'unavailable'));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, failures };
}
