/**
 * Cloudflare Workers AI via the `AI` binding (no API key; billed in Neurons, 10,000/day free).
 * JSON Mode is documented for a short model list (llama-3.3-70b-instruct-fp8-fast, llama-3.1-8b-instruct, …)
 * and "can't guarantee" schema adherence, so output is still parsed and sanitised like any other.
 */
import type { AiBinding } from '../env.ts';
import { ProviderError } from './types.ts';
import type { GenerateInput, Provider } from './types.ts';

export const WORKERS_AI_DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Free-allocation / rate errors surface as thrown Errors. Cloudflare does not document a stable error
 * code for "daily Neurons used up" (unverified as of 2026-11-04), so this is a message heuristic.
 */
const QUOTA_RE = /neuron|free allocation|quota|rate.?limit|too many requests|\b429\b/i;

export class WorkersAiProvider implements Provider {
  readonly id = 'workers-ai';
  constructor(
    private readonly ai: AiBinding,
    readonly model: string = WORKERS_AI_DEFAULT_MODEL,
  ) {}

  async generate(input: GenerateInput): Promise<unknown> {
    if (input.signal.aborted) throw new ProviderError(this.id, 'unavailable');
    let result: unknown;
    try {
      const run = this.ai.run(this.model, {
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        response_format: { type: 'json_schema', json_schema: input.schema },
        max_tokens: input.maxOutputTokens,
        temperature: 0,
      });
      const aborted = new Promise<never>((_, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
      result = await Promise.race([run, aborted]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/JSON Mode couldn't be met/i.test(msg)) throw new ProviderError(this.id, 'bad_output');
      throw new ProviderError(this.id, QUOTA_RE.test(msg) ? 'quota' : 'unavailable');
    }
    const response = (result as { response?: unknown } | null)?.response;
    if (typeof response === 'string' && response) return response;
    if (typeof response === 'object' && response !== null) return response; // already-parsed JSON
    throw new ProviderError(this.id, 'bad_output');
  }
}
