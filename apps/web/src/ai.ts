import {
  locateAiEdit,
  type AiCheckRequest,
  type AiCheckResponse,
  type AiErrorResponse,
  type AiTask,
  type DocumentSnapshot,
  type Suggestion,
  type WritingMode,
} from '@grammarme/core';

export const AI_MAX_CHARS = 4000;

export type AiResult =
  | { ok: true; suggestions: Suggestion[]; model: string; remaining?: number; dropped: number }
  | { ok: false; message: string };

/**
 * Pick what to send: the whole document if it fits, otherwise the paragraph around the caret.
 * Returns the text and where it starts in the document so quotes can be located.
 */
export function aiWindow(text: string, caret: number): { text: string; offset: number } {
  if (text.length <= AI_MAX_CHARS) return { text, offset: 0 };
  const start = text.lastIndexOf('\n\n', Math.max(0, caret - 1));
  const from = start === -1 ? 0 : start + 2;
  const endIdx = text.indexOf('\n\n', caret);
  const to = Math.min(endIdx === -1 ? text.length : endIdx, from + AI_MAX_CHARS);
  return { text: text.slice(from, to), offset: from };
}

export async function runAiCheck(opts: {
  endpoint: string;
  token: string;
  doc: DocumentSnapshot;
  caret: number;
  task: AiTask;
  mode: WritingMode;
  signal?: AbortSignal;
}): Promise<AiResult> {
  const { text, offset } = aiWindow(opts.doc.text, opts.caret);
  if (!text.trim()) return { ok: false, message: 'Nothing to check yet.' };
  const body: AiCheckRequest = { text, task: opts.task, mode: opts.mode, documentVersion: opts.doc.version };
  let res: Response;
  try {
    res = await fetch(new URL('/v1/check', opts.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { ok: false, message: 'Cancelled.' };
    return { ok: false, message: 'Could not reach the AI service. Local checks are still running.' };
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as AiErrorResponse | null;
    const wait = e?.retryAfterSeconds ? ` Try again in ${Math.ceil(e.retryAfterSeconds / 60)} min.` : '';
    const reason =
      e?.error === 'quota_exhausted' || e?.error === 'rate_limited'
        ? `The free AI quota is used up for now.${wait}`
        : e?.error === 'unauthorized'
          ? 'The AI token was rejected. Check Settings.'
          : (e?.message ?? `AI service error (${res.status}).`);
    return { ok: false, message: `${reason} Local checks are still running.` };
  }
  const data = (await res.json()) as AiCheckResponse;
  const suggestions: Suggestion[] = [];
  let dropped = 0;
  for (const edit of data.edits ?? []) {
    // Locate inside the window we sent, then validate against the full document.
    const s = locateAiEdit(opts.doc, edit, offset);
    if (s && s.end <= offset + text.length) suggestions.push(s);
    else dropped++;
  }
  return { ok: true, suggestions, model: data.model, remaining: data.remaining, dropped };
}
