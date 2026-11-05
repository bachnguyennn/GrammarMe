import type { Dialect, WritingMode } from '@grammarme/core';

export interface Settings {
  dialect: Dialect;
  mode: WritingMode;
  dictionary: string[];
  disabledRules: string[];
  /** Cloud AI is off unless the user turns it on AND configures an endpoint. */
  aiEnabled: boolean;
  aiEndpoint: string;
  aiToken: string;
  /** Keep a draft in this browser's localStorage. Never sent anywhere. */
  saveDraft: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  dialect: 'american',
  mode: 'standard',
  dictionary: [],
  disabledRules: [],
  aiEnabled: false,
  aiEndpoint: '',
  aiToken: '',
  saveDraft: true,
};

const SETTINGS_KEY = 'grammarme:settings';
const DRAFT_KEY = 'grammarme:draft';

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
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
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
