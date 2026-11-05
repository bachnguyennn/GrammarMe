import { describe, expect, it } from 'vitest';
import type { Companion } from '../src/companion.ts';
import { CompanionError } from '../src/errors.ts';
import { doneFor, hostHarness } from './hostio.ts';

/** A stub Companion whose check/signIn wait for cancellation. */
function stub(): Companion {
  const waitAbort = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new CompanionError('cancelled')), { once: true }));
  return {
    status: async () => ({ protocol: 1, companionVersion: '0.1.0', connected: false }),
    check: (_input: unknown, signal: AbortSignal) => waitAbort(signal),
    signIn: (onUrl: (u: string) => void, signal: AbortSignal) => {
      onUrl('https://auth.openai.com/api/accounts/authorize?x=1');
      return waitAbort(signal);
    },
    models: async () => {
      throw new Error('boom with secret details');
    },
  } as unknown as Companion;
}

describe('native messaging host', () => {
  it('answers status with protocol info', async () => {
    const h = hostHarness(stub());
    h.send({ id: 's1', type: 'status' });
    expect(await h.waitFor(doneFor('s1'))).toEqual({ id: 's1', type: 'done', ok: true, status: { protocol: 1, companionVersion: '0.1.0', connected: false } });
    h.end();
    await h.done;
  });

  it('rejects malformed requests, unknown types and over-long text', async () => {
    const h = hostHarness(stub());
    h.send({ id: 'b1', type: 'fetch', url: 'https://example.com' });
    h.send({ type: 'status' });
    h.send({ id: 'b3', type: 'check', task: 'grammar', mode: 'standard', text: 'x'.repeat(4001) });
    h.send({ id: 'b4', type: 'check', task: 'poetry', mode: 'standard', text: 'hi' });
    h.raw(Buffer.from([3, 0, 0, 0, 0x7b, 0x7b, 0x7b]));
    expect(await h.waitFor(doneFor('b1'))).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await h.waitFor(doneFor('b3'))).toMatchObject({ ok: false, error: 'too_long' });
    expect(await h.waitFor(doneFor('b4'))).toMatchObject({ ok: false, error: 'bad_request' });
    await h.waitFor((m) => m.id === '' && m.error === 'bad_request');
    expect(h.received.filter((m) => m.id === '')).toHaveLength(2);
    h.end();
    await h.done;
  });

  it('allows one check at a time and cancels by id', async () => {
    const h = hostHarness(stub());
    h.send({ id: 'c1', type: 'check', task: 'grammar', mode: 'standard', text: 'Hello there.' });
    h.send({ id: 'c2', type: 'check', task: 'grammar', mode: 'standard', text: 'Hello again.' });
    expect(await h.waitFor(doneFor('c2'))).toMatchObject({ ok: false, error: 'busy' });
    h.send({ id: 'x1', type: 'cancel', target: 'c1' });
    expect(await h.waitFor(doneFor('c1'))).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await h.waitFor(doneFor('x1'))).toMatchObject({ ok: true });
    // The slot is free again.
    h.send({ id: 'c3', type: 'check', task: 'grammar', mode: 'standard', text: 'Third.' });
    h.send({ id: 'x2', type: 'cancel', target: 'c3' });
    expect(await h.waitFor(doneFor('c3'))).toMatchObject({ error: 'cancelled' });
    h.end();
    await h.done;
  });

  it('sends authUrl progress for signIn and allows only one sign-in', async () => {
    const h = hostHarness(stub());
    h.send({ id: 'i1', type: 'signIn' });
    expect(await h.waitFor((m) => m.id === 'i1' && m.type === 'authUrl')).toMatchObject({ url: expect.stringMatching(/^https:\/\/auth\.openai\.com\//) });
    h.send({ id: 'i2', type: 'signIn' });
    expect(await h.waitFor(doneFor('i2'))).toMatchObject({ ok: false, error: 'busy' });
    h.end(); // Chrome closed the port: sign-in is aborted and the loop ends.
    await h.done;
    expect(h.received.find((m) => m.id === 'i1' && m.type === 'done')).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('turns unexpected exceptions into a generic internal error', async () => {
    const h = hostHarness(stub());
    h.send({ id: 'm1', type: 'models' });
    const reply = await h.waitFor(doneFor('m1'));
    expect(reply).toMatchObject({ ok: false, error: 'internal' });
    expect(JSON.stringify(reply)).not.toContain('secret');
    h.end();
    await h.done;
  });

  it('aborts running work when stdin ends', async () => {
    let aborted = false;
    const companion = {
      check: (_i: unknown, signal: AbortSignal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new CompanionError('cancelled'));
          }),
        ),
    } as unknown as Companion;
    const h = hostHarness(companion);
    h.send({ id: 'c1', type: 'check', task: 'tone', mode: 'casual', text: 'yo' });
    await new Promise((r) => setTimeout(r, 20));
    h.end();
    await h.done;
    expect(aborted).toBe(true);
  });
});
