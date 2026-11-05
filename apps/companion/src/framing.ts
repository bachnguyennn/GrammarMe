/**
 * Chrome native messaging framing: each message is a 32-bit length (native byte order, which is
 * little-endian on every platform Chrome supports) followed by that many bytes of UTF-8 JSON.
 * Chrome refuses host-to-browser messages of 1 MB or more; we refuse incoming ones over 1 MB too.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length >= MAX_MESSAGE_BYTES) throw new RangeError('Native message too large.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export type Frame = { kind: 'message'; value: unknown } | { kind: 'invalid'; reason: 'oversize' | 'json' };

/** Incremental decoder: feed it stdin chunks of any size and get whole frames back. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  /** Bytes of an oversized message still to discard. */
  private skip = 0;

  push(chunk: Buffer): Frame[] {
    const frames: Frame[] = [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buffer.length);
        this.skip -= n;
        this.buffer = this.buffer.subarray(n);
        if (this.skip > 0) break;
        continue;
      }
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        frames.push({ kind: 'invalid', reason: 'oversize' });
        this.skip = length;
        this.buffer = this.buffer.subarray(4);
        continue;
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      try {
        frames.push({ kind: 'message', value: JSON.parse(body) as unknown });
      } catch {
        frames.push({ kind: 'invalid', reason: 'json' });
      }
    }
    return frames;
  }

  /** Bytes of an unfinished frame (for tests and shutdown checks). */
  get pending(): number {
    return this.buffer.length;
  }
}
