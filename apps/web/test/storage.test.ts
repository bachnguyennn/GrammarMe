import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/storage.ts';

const KEY = 'grammarme:settings';

describe('loadSettings', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('deletes the removed cloud AI settings, including the saved token', () => {
    store.set(KEY, JSON.stringify({ dialect: 'british', aiEnabled: true, aiEndpoint: 'https://x.example', aiToken: 'secret' }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, dialect: 'british' });
    expect(store.get(KEY)).not.toContain('secret');
    expect(store.get(KEY)).not.toContain('aiEndpoint');
  });

  it('leaves current settings as they are', () => {
    const saved = JSON.stringify({ ...DEFAULT_SETTINGS, mode: 'casual' });
    store.set(KEY, saved);
    expect(loadSettings().mode).toBe('casual');
    expect(store.get(KEY)).toBe(saved);
  });
});
