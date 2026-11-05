/** Incremental Server-Sent Events parser (WHATWG event-stream format, the subset the API uses). */
export interface SseEvent {
  event: string;
  data: string;
}

/** A single line longer than this means the stream is not what we expect. */
export const MAX_SSE_LINE = 1024 * 1024;

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    this.buffer += chunk;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== '\n' && c !== '\r') continue;
      // A trailing CR may be the first half of CRLF split across chunks: wait for more input.
      if (c === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (c === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      this.line(line, out);
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > MAX_SSE_LINE) throw new RangeError('SSE line too long');
    return out;
  }

  /** Flushes an event that wasn't followed by a blank line before the stream ended. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ''), out);
    this.buffer = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}
