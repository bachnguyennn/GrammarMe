/**
 * Google Gemini via the (stateless) generateContent REST method.
 *
 * Why generateContent and not the newer Interactions API: Interactions stores conversation state
 * server-side by default (store=true); generateContent keeps nothing beyond Google's normal
 * policy-enforcement logging. Google calls generateContent "legacy" but supported (checked 2026-11-04).
 * The API key goes in the x-goog-api-key header, never in the URL (URLs end up in logs).
 *
 * PRIVACY: on the unpaid tier Google may use prompts/responses to improve its products and human
 * reviewers may read them. See docs/llm-research.md before enabling this provider.
 */
import { kindForStatus, parseRetryAfter, providerFetch, ProviderError } from './types.ts';
import type { GenerateInput, Provider } from './types.ts';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

interface GeminiError {
  error?: { status?: string; details?: { '@type'?: string; retryDelay?: string }[] };
}

/** Reads google.rpc.RetryInfo.retryDelay ("37s" / "1.5s") from an error body. */
function retryDelayFromBody(body: GeminiError | null): number | undefined {
  for (const d of body?.error?.details ?? []) {
    if (d['@type']?.endsWith('google.rpc.RetryInfo') && d.retryDelay) {
      const secs = Number.parseFloat(d.retryDelay);
      if (Number.isFinite(secs)) return Math.ceil(secs);
    }
  }
  return undefined;
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini';
  constructor(
    private readonly apiKey: string,
    readonly model: string = GEMINI_DEFAULT_MODEL,
    private readonly thinkingLevel?: string,
  ) {}

  async generate(input: GenerateInput): Promise<unknown> {
    const generationConfig: Record<string, unknown> = {
      responseMimeType: 'application/json',
      responseJsonSchema: input.schema,
      // Ignored by Gemini 3.6+ per Google's docs; harmless and helps older models stay deterministic.
      temperature: 0,
      maxOutputTokens: input.maxOutputTokens,
    };
    if (this.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: this.thinkingLevel };

    const res = await providerFetch(this.id, `${BASE}/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: input.user }] }],
        generationConfig,
      }),
      signal: input.signal,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as GeminiError | null;
      const kind = res.status === 429 || body?.error?.status === 'RESOURCE_EXHAUSTED' ? 'quota' : kindForStatus(res.status);
      throw new ProviderError(this.id, kind, res.status, retryDelayFromBody(body) ?? parseRetryAfter(res.headers.get('retry-after')));
    }

    const data = (await res.json().catch(() => null)) as GeminiResponse | null;
    if (!data || data.promptFeedback?.blockReason) throw new ProviderError(this.id, 'bad_output', res.status);
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    if (!text) throw new ProviderError(this.id, 'bad_output', res.status);
    return text;
  }
}
