import { afterEach, describe, expect, it } from 'vitest';
import { readdir, readFile, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { companionHome, resolveEndpoints } from '../src/config.ts';
import { CredentialStore } from '../src/store.ts';
import { cleanupHomes, connectedFile, tempHome } from './helpers.ts';

afterEach(cleanupHomes);
const posix = process.platform !== 'win32';

describe('credential store', () => {
  it('creates a 0700 folder and a 0600 file, and round-trips the data', async () => {
    const home = await tempHome();
    const store = new CredentialStore(home);
    const data = connectedFile(Date.now(), { model: 'gpt-x' });
    await store.write(data);
    expect(await store.read()).toEqual(data);
    if (posix) {
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    }
  });

  it('tightens a pre-existing loose folder', async () => {
    const home = await tempHome();
    await mkdir(home, { recursive: true, mode: 0o755 });
    await new CredentialStore(home).write({ hostId: 'h' });
    if (posix) expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it('writes atomically: no temp files are left and the file is always complete JSON', async () => {
    const home = await tempHome();
    const store = new CredentialStore(home);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update((cur) => ({ ...cur, model: `m${i}` }))));
    const files = await readdir(home);
    expect(files.sort()).toEqual(['chatgpt.json']);
    expect(JSON.parse(await readFile(store.file, 'utf8')).model).toMatch(/^m\d+$/);
  });

  it('keeps tokens only inside chatgpt.json', async () => {
    const home = await tempHome();
    const store = new CredentialStore(home);
    await store.write(connectedFile(Date.now()));
    await store.update((cur) => ({ ...cur, model: 'x' }));
    for (const f of await readdir(home)) {
      const text = await readFile(join(home, f), 'utf8');
      if (f !== 'chatgpt.json') expect(text).not.toContain('refresh-1');
    }
  });

  it('treats a damaged file as empty and drops badly typed fields', async () => {
    const home = await tempHome();
    const store = new CredentialStore(home);
    await mkdir(home, { recursive: true });
    await writeFile(store.file, '{not json');
    expect(await store.read()).toEqual({});
    await writeFile(store.file, JSON.stringify({ hostId: 5, clientId: 'c', tokens: { access: 'a' } }));
    expect(await store.read()).toEqual({ clientId: 'c' });
  });

  it('serializes read-modify-write across two store instances (two processes)', async () => {
    const home = await tempHome();
    const a = new CredentialStore(home);
    const b = new CredentialStore(home);
    await a.write({ model: '0' });
    const bump = (s: CredentialStore) => s.update((cur) => ({ ...cur, model: String(Number(cur.model) + 1) }));
    await Promise.all(Array.from({ length: 10 }, (_, i) => bump(i % 2 ? a : b)));
    expect((await a.read()).model).toBe('10');
  });

  it('breaks a stale lock left by a crashed process', async () => {
    const home = await tempHome();
    const store = new CredentialStore(home, { staleLockMs: 1_000 });
    await mkdir(home, { recursive: true });
    await writeFile(store.lockFile, 'dead:pid');
    const old = new Date(Date.now() - 60_000);
    await utimes(store.lockFile, old, old);
    await store.update((cur) => ({ ...cur, model: 'ok' }));
    expect((await store.read()).model).toBe('ok');
  });

  it('honours GRAMMARME_COMPANION_HOME and XDG_CONFIG_HOME', () => {
    expect(companionHome({ GRAMMARME_COMPANION_HOME: '/tmp/x' })).toBe('/tmp/x');
    expect(companionHome({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/grammarme');
  });
});

describe('test hooks', () => {
  it('accept only loopback origins', () => {
    expect(resolveEndpoints({ GRAMMARME_COMPANION_TEST_AUTH_ORIGIN: 'http://127.0.0.1:9999' }).authOrigin).toBe('http://127.0.0.1:9999');
    expect(resolveEndpoints({ GRAMMARME_COMPANION_TEST_API_ORIGIN: 'http://localhost:1/' }).apiOrigin).toBe('http://localhost:1');
    expect(() => resolveEndpoints({ GRAMMARME_COMPANION_TEST_AUTH_ORIGIN: 'https://evil.example' })).toThrow(/127\.0\.0\.1/);
    expect(() => resolveEndpoints({ GRAMMARME_COMPANION_TEST_API_ORIGIN: 'http://127.0.0.1.evil.example' })).toThrow();
    expect(() => resolveEndpoints({ GRAMMARME_COMPANION_TEST_API_ORIGIN: 'file:///etc/passwd' })).toThrow();
    expect(resolveEndpoints({})).toEqual({ authOrigin: 'https://auth.openai.com', apiOrigin: 'https://api.openai.com', testAuth: false });
  });
});
