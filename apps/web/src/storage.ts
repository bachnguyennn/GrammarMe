import type { Dialect, WritingMode } from '@grammarme/core';

export interface Settings {
  dialect: Dialect;
  mode: WritingMode;
  dictionary: string[];
  disabledRules: string[];
  /** Keep a draft in this browser's localStorage. Never sent anywhere. */
  saveDraft: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  dialect: 'american',
  mode: 'standard',
  dictionary: [],
  disabledRules: [],
  saveDraft: true,
};

const SETTINGS_KEY = 'grammarme:settings';
const DRAFT_KEY = 'grammarme:draft';
/** Saved by older versions for the removed cloud AI check, including an access token. */
const REMOVED_KEYS = ['aiEnabled', 'aiEndpoint', 'aiToken'];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / storage blocked — the app still works, it just won't remember */
  }
}

export function loadSettings(): Settings {
  const raw = read(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const saved = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
    const stale = REMOVED_KEYS.filter((k) => k in saved);
    for (const k of stale) delete saved[k];
    const settings = { ...DEFAULT_SETTINGS, ...saved };
    if (stale.length) saveSettings(settings);
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  write(SETTINGS_KEY, JSON.stringify(s));
}

export function loadDraft(): string | null {
  return read(DRAFT_KEY);
}

export function saveDraft(text: string | null): void {
  write(DRAFT_KEY, text);
}
