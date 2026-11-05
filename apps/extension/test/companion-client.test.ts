/**
 * The native-messaging client with a fake chrome.runtime: no companion process, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANION_HOST } from '@grammarme/core/companion';
import { callCompanion } from '../src/companion-client.ts';

type Listener = (msg: unknown) => void;

class FakePort {
  sent: Record<string, unknown>[] = [];
  disconnected = false;
  private msgListeners: Listener[] = [];
  private dcListeners: (() => void)[] = [];
  onMessage = { addListener: (fn: Listener) => this.msgListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => this.dcListeners.push(fn) };
  postMessage(m: Record<string, unknown>) {
    this.sent.push(m);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Simulate the companion. */
  reply(m: unknown) {
    for (const l of this.msgListeners) l(m);
  }
  drop(lastError?: string) {
    fake.lastError = lastError ? { message: lastError } : undefined;
    for (const l of this.dcListeners) l();
  }
}

const fake: { port: FakePort | null; host: string | null; lastError?: { message: string }; throwOnConnect?: string } = {
  port: null,
  host: null,
};

beforeEach(() => {
  fake.port = null;
  fake.host = null;
  fake.lastError = undefined;
  fake.throwOnConnect = undefined;
  vi.stubGlobal('chrome', {
    runtime: {
      connectNative(host: string) {
        if (fake.throwOnConnect) throw new Error(fake.throwOnConnect);
        fake.host = host;
        fake.port = new FakePort();
        return fake.port;
      },
      get lastError() {
        return fake.lastError;
      },
    },
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('callCompanion', () => {
  it('connects to the GrammarMe host, sends the request with an id, and resolves on done', async () => {
    const h = callCompanion({ type: 'status' }, { timeoutMs: 1000 });
    expect(fake.host).toBe(COMPANION_HOST);
    const sent = fake.port!.sent[0]!;
    expect(sent.type).toBe('status');
    expect(typeof sent.id).toBe('string');
    fake.port!.reply({ id: 'someone-else', type: 'done', ok: true }); // ignored
    fake.port!.reply({ id: sent.id, type: 'done', ok: true, status: { protocol: 1, companionVersion: '0.1.0', connected: false } });
    const r = await h.result;
    expect(r.ok).toBe(true);
    expect(fake.port!.disconnected).toBe(true); // one port per operation
  });

  it('passes companion errors through with their code', async () => {
    const h = callCompanion({ type: 'test' }, { timeoutMs: 1000 });
    const id = fake.port!.sent[0]!.id;
    fake.port!.reply({ id, type: 'done', ok: false, error: 'usage_limit', message: 'limit' });
    expect(await h.result).toEqual({ ok: false, error: 'usage_limit', message: 'limit' });
  });

  it('reports a missing companion when Chrome cannot find the host', async () => {
    const h = callCompanion({ type: 'status' }, { timeoutMs: 1000 });
    fake.port!.drop('Specified native messaging host not found.');
    expect(await h.result).toMatchObject({ ok: false, error: 'companion_missing' });
  });

  it('reports a forbidden host (extension id not allowed)', async () => {
    const h = callCompanion({ type: 'status' }, { timeoutMs: 1000 });
    fake.port!.drop('Access to the specified native messaging host is forbidden.');
    expect(await h.result).toMatchObject({ ok: false, error: 'companion_forbidden' });
  });

  it('handles connectNative throwing (permission not granted)', async () => {
    fake.throwOnConnect = 'Specified native messaging host not found.';
    const h = callCompanion({ type: 'status' }, { timeoutMs: 1000 });
    expect(await h.result).toMatchObject({ ok: false, error: 'companion_missing' });
  });

  it('forwards only OpenAI authorization URLs during sign-in', async () => {
    const urls: string[] = [];
    const h = callCompanion({ type: 'signIn' }, { timeoutMs: 1000, onAuthUrl: (u) => urls.push(u) });
    const id = fake.port!.sent[0]!.id;
    fake.port!.reply({ id, type: 'authUrl', url: 'https://evil.example/phish' });
    fake.port!.reply({ id, type: 'authUrl', url: 'https://auth.openai.com/api/accounts/authorize?x=1' });
    expect(urls).toEqual(['https://auth.openai.com/api/accounts/authorize?x=1']);
    fake.port!.reply({ id, type: 'done', ok: false, error: 'consent_denied', message: 'no' });
    expect(await h.result).toMatchObject({ error: 'consent_denied' });
  });

  it('cancel sends a cancel for this request and resolves even if the companion stays silent', async () => {
    const h = callCompanion({ type: 'check', task: 'grammar', mode: 'standard', text: 'Hi' }, { timeoutMs: 60_000 });
    const id = fake.port!.sent[0]!.id;
    h.cancel();
    expect(fake.port!.sent[1]).toMatchObject({ type: 'cancel', target: id });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await h.result).toMatchObject({ ok: false, error: 'cancelled' });
    expect(fake.port!.disconnected).toBe(true);
  });

  it('times out, cancels, and frees the port', async () => {
    const h = callCompanion({ type: 'check', task: 'grammar', mode: 'standard', text: 'Hi' }, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    expect(await h.result).toMatchObject({ ok: false, error: 'timeout' });
    expect(fake.port!.sent.some((m) => m.type === 'cancel')).toBe(true);
    expect(fake.port!.disconnected).toBe(true);
  });

  it('a service-worker/companion drop mid-check is reported as interrupted, once', async () => {
    const h = callCompanion({ type: 'check', task: 'grammar', mode: 'standard', text: 'Hi' }, { timeoutMs: 60_000 });
    fake.port!.drop('Native host has exited.');
    fake.port!.reply({ id: fake.port!.sent[0]!.id, type: 'done', ok: true }); // too late, ignored
    expect(await h.result).toMatchObject({ ok: false, error: 'interrupted' });
  });
});
