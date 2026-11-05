import { PassThrough } from 'node:stream';
import type { Companion } from '../src/companion.ts';
import { encodeMessage, FrameDecoder } from '../src/framing.ts';
import { runHost } from '../src/host.ts';

/** Drives runHost like Chrome does: framed JSON in, framed JSON out. */
export function hostHarness(companion: Companion) {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new FrameDecoder();
  const received: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  output.on('data', (chunk: Buffer) => {
    for (const f of decoder.push(chunk)) if (f.kind === 'message') received.push(f.value as Record<string, unknown>);
    waiters.splice(0).forEach((w) => w());
  });
  const done = runHost(companion, { input, output });
  return {
    done,
    received,
    send: (msg: unknown) => input.write(encodeMessage(msg)),
    raw: (buf: Buffer) => input.write(buf),
    end: () => input.end(),
    /** Resolves with the first reply matching `pred` (waiting if needed). */
    async waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = received.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(received)}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
}

export const doneFor = (id: string) => (m: Record<string, unknown>) => m.id === id && m.type === 'done';
