import { describe, expect, it } from 'vitest';
import { encodeMessage, FrameDecoder, MAX_MESSAGE_BYTES } from '../src/framing.ts';

describe('native messaging framing', () => {
  it('encodes a 4-byte little-endian length then UTF-8 JSON', () => {
    const frame = encodeMessage({ id: 'a', text: 'héllo' });
    const body = JSON.stringify({ id: 'a', text: 'héllo' });
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(body));
    expect(frame.subarray(4).toString('utf8')).toBe(body);
  });

  it('round-trips several messages delivered one byte at a time', () => {
    const msgs = [{ id: '1', type: 'status' }, { id: '2', text: 'ünïcødé ✓' }, { id: '3' }];
    const all = Buffer.concat(msgs.map(encodeMessage));
    const d = new FrameDecoder();
    const out: unknown[] = [];
    for (const byte of all) for (const f of d.push(Buffer.from([byte]))) out.push(f.kind === 'message' ? f.value : f);
    expect(out).toEqual(msgs);
    expect(d.pending).toBe(0);
  });

  it('decodes several frames from one chunk and keeps a partial tail', () => {
    const a = encodeMessage({ id: 'a' });
    const b = encodeMessage({ id: 'b' });
    const d = new FrameDecoder();
    const first = d.push(Buffer.concat([a, b.subarray(0, 5)]));
    expect(first).toEqual([{ kind: 'message', value: { id: 'a' } }]);
    expect(d.push(b.subarray(5))).toEqual([{ kind: 'message', value: { id: 'b' } }]);
  });

  it('rejects incoming messages over 1 MB, skips their bytes and keeps going', () => {
    const d = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_MESSAGE_BYTES + 10, 0);
    const frames = d.push(header);
    expect(frames).toEqual([{ kind: 'invalid', reason: 'oversize' }]);
    // Feed the oversized body in pieces, then a valid frame.
    const junk = Buffer.alloc(MAX_MESSAGE_BYTES + 10, 0x61);
    expect(d.push(junk.subarray(0, 1000))).toEqual([]);
    expect(d.push(Buffer.concat([junk.subarray(1000), encodeMessage({ id: 'ok' })]))).toEqual([{ kind: 'message', value: { id: 'ok' } }]);
  });

  it('reports invalid JSON without losing sync', () => {
    const bad = Buffer.from('{nope');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bad.length, 0);
    const d = new FrameDecoder();
    expect(d.push(Buffer.concat([header, bad, encodeMessage({ id: 'x' })]))).toEqual([
      { kind: 'invalid', reason: 'json' },
      { kind: 'message', value: { id: 'x' } },
    ]);
  });

  it('refuses to send messages of 1 MB or more', () => {
    expect(() => encodeMessage({ big: 'x'.repeat(MAX_MESSAGE_BYTES) })).toThrow(RangeError);
  });
});
