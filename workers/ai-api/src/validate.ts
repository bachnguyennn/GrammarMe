import type { AiCheckRequest, AiTask, WritingMode } from '@grammarme/core';

export const TASKS: readonly AiTask[] = ['grammar', 'clarity', 'tone'];
export const MODES: readonly WritingMode[] = ['standard', 'academic', 'professional', 'casual'];

export type RequestValidation =
  | { ok: true; value: AiCheckRequest }
  | { ok: false; error: 'bad_request' | 'too_long'; message: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Strictly validates an AiCheckRequest. Unknown fields are ignored (not echoed anywhere).
 * Length is measured in UTF-16 code units, the same unit as the shared offset convention.
 */
export function validateCheckRequest(body: unknown, maxInputChars: number): RequestValidation {
  if (!isObject(body)) return { ok: false, error: 'bad_request', message: 'Body must be a JSON object.' };
  const { text, task, mode, documentVersion } = body;
  if (typeof text !== 'string') return { ok: false, error: 'bad_request', message: '`text` must be a string.' };
  if (typeof task !== 'string' || !(TASKS as readonly string[]).includes(task)) {
    return { ok: false, error: 'bad_request', message: `\`task\` must be one of ${TASKS.join(', ')}.` };
  }
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
    return { ok: false, error: 'bad_request', message: `\`mode\` must be one of ${MODES.join(', ')}.` };
  }
  if (typeof documentVersion !== 'number' || !Number.isSafeInteger(documentVersion) || documentVersion < 0) {
    return { ok: false, error: 'bad_request', message: '`documentVersion` must be a non-negative integer.' };
  }
  if (text.length > maxInputChars) {
    return {
      ok: false,
      error: 'too_long',
      message: `Text is ${text.length} characters; the AI check accepts at most ${maxInputChars}. Check a smaller selection.`,
    };
  }
  return { ok: true, value: { text, task: task as AiTask, mode: mode as WritingMode, documentVersion } };
}
