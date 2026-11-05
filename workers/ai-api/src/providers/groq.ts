/**
 * Groq via its OpenAI-compatible Chat Completions endpoint, with strict JSON-schema structured output
 * (supported on openai/gpt-oss-20b / -120b per Groq's docs, checked 2026-11-04).
 */
import { kindForStatus, parseRetryAfter, providerFetch, ProviderError } from './types.ts';
import type { GenerateInput, Provider } from './types.ts';

export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';
const URL = 'https://api.groq.com/openai/v1/chat/completions';

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

export class GroqProvider implements Provider {
  readonly id = 'groq';
  constructor(
    private readonly apiKey: string,
    readonly model: string = GROQ_DEFAULT_MODEL,
    private readonly reasoningEffort?: string,
  ) {}

  async generate(input: GenerateInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'grammarme_edits', strict: true, schema: input.schema },
      },
      temperature: 0,
      max_completion_tokens: input.maxOutputTokens,
    };
    if (this.reasoningEffort && this.model.startsWith('openai/gpt-oss')) {
      body.reasoning_effort = this.reasoningEffort;
      body.include_reasoning = false;
    }

    const res = await providerFetch(this.id, URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!res.ok) {
      // Groq returns 400 when the model's JSON fails the schema — that is bad output, not bad config.
      const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const schemaMiss = res.status === 400 && /json_validate_failed|does not match the expected schema/i.test(
        `${err?.error?.code ?? ''} ${err?.error?.message ?? ''}`,
      );
      throw new ProviderError(
        this.id,
        schemaMiss ? 'bad_output' : kindForStatus(res.status),
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }

    const data = (await res.json().catch(() => null)) as ChatResponse | null;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) throw new ProviderError(this.id, 'bad_output', res.status);
    return content;
  }
}
