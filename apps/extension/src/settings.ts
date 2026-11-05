/** User settings and personal dictionary — pure helpers (storage access lives in the callers). */
import type { Dialect } from '@grammarme/core';
import { normalizeWord } from './protocol.ts';

/** chrome.storage.sync key (synced across the user's Chrome profiles; 8 KB per item limit). */
export const SETTINGS_KEY = 'settings';
/** chrome.storage.local key — the dictionary can outgrow sync quotas, and stays on this device. */
export const DICTIONARY_KEY = 'dictionary';
export const MAX_DICTIONARY_WORDS = 5_000;
export const MAX_DISABLED_SITES = 300;

export interface Settings {
  enabled: boolean;
  /** Hostnames (see `siteKey`) where the user turned GrammarMe off. */
  disabledSites: string[];
  dialect: Dialect;
}

export const DIALECTS: readonly Dialect[] = ['american', 'british', 'canadian', 'australian', 'indian'];

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  disabledSites: [],
  dialect: 'american',
});

/** Accept whatever is in storage (possibly from an older version) and return valid settings. */
export function normalizeSettings(raw: unknown): Settings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const sites = Array.isArray(r.disabledSites)
    ? [...new Set(r.disabledSites.filter((s): s is string => typeof s === 'string').map(siteKey).filter(Boolean))]
    : [];
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SETTINGS.enabled,
    disabledSites: sites.slice(0, MAX_DISABLED_SITES),
    dialect: DIALECTS.includes(r.dialect as Dialect) ? (r.dialect as Dialect) : DEFAULT_SETTINGS.dialect,
  };
}

/** Canonical per-site key: lower-case hostname without a leading `www.`. */
export function siteKey(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

/** Is GrammarMe allowed to run on this hostname? */
export function isActiveOn(settings: Settings, hostname: string): boolean {
  return settings.enabled && !settings.disabledSites.includes(siteKey(hostname));
}

export function withSiteEnabled(settings: Settings, hostname: string, enabled: boolean): Settings {
  const key = siteKey(hostname);
  const rest = settings.disabledSites.filter((s) => s !== key);
  return { ...settings, disabledSites: enabled || !key ? rest : [...rest, key].slice(-MAX_DISABLED_SITES) };
}

export function normalizeDictionary(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const w of raw) {
    if (typeof w !== 'string') continue;
    const n = normalizeWord(w);
    if (n) out.add(n);
  }
  return [...out].slice(0, MAX_DICTIONARY_WORDS);
}

/** Returns the new list, or null if nothing changed (invalid word, duplicate, or list full). */
export function addToDictionary(list: string[], word: string): string[] | null {
  const w = normalizeWord(word);
  if (!w || list.includes(w) || list.length >= MAX_DICTIONARY_WORDS) return null;
  return [...list, w];
}
