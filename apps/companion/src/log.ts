/**
 * Minimal diagnostics on stderr. stdout belongs to the native messaging channel and must never be
 * written to. Log event names and error codes only: never text, edits, tokens, URLs or claims.
 */
export function logEvent(event: string, detail?: Record<string, string | number | boolean | undefined>): void {
  const parts = [`grammarme-companion: ${event}`];
  for (const [k, v] of Object.entries(detail ?? {})) if (v !== undefined) parts.push(`${k}=${String(v)}`);
  process.stderr.write(`${parts.join(' ')}\n`);
}
