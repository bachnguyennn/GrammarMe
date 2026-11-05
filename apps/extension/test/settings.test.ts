import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_DICTIONARY_WORDS,
  addToDictionary,
  isActiveOn,
  normalizeDictionary,
  normalizeSettings,
  siteKey,
  withSiteEnabled,
} from '../src/settings.ts';

describe('settings', () => {
  it('fills defaults and repairs bad stored values', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ enabled: 'yes', dialect: 'klingon', disabledSites: 'x' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ enabled: false, dialect: 'british', disabledSites: ['WWW.Example.com', 'example.com', 3] })).toEqual({
      enabled: false,
      dialect: 'british',
      disabledSites: ['example.com'],
    });
  });

  it('keys sites by hostname without www', () => {
    expect(siteKey('WWW.Reddit.com')).toBe('reddit.com');
    expect(siteKey('mail.google.com')).toBe('mail.google.com');
  });

  it('toggles a site and respects the global switch', () => {
    let s = normalizeSettings({});
    expect(isActiveOn(s, 'www.example.com')).toBe(true);
    s = withSiteEnabled(s, 'www.example.com', false);
    expect(s.disabledSites).toEqual(['example.com']);
    expect(isActiveOn(s, 'example.com')).toBe(false);
    expect(isActiveOn(s, 'other.com')).toBe(true);
    s = withSiteEnabled(s, 'example.com', false); // idempotent
    expect(s.disabledSites).toEqual(['example.com']);
    s = withSiteEnabled(s, 'example.com', true);
    expect(s.disabledSites).toEqual([]);
    expect(isActiveOn({ ...s, enabled: false }, 'other.com')).toBe(false);
  });

  it('adds dictionary words once and caps the list', () => {
    expect(addToDictionary([], ' Harper ')).toEqual(['Harper']);
    expect(addToDictionary(['Harper'], 'Harper')).toBeNull();
    expect(addToDictionary([], 'two words')).toBeNull();
    const full = Array.from({ length: MAX_DICTIONARY_WORDS }, (_, i) => `w${i}`);
    expect(addToDictionary(full, 'more')).toBeNull();
    expect(normalizeDictionary(['a', 'a', 7, 'b c', 'ok'])).toEqual(['a', 'ok']);
    expect(normalizeDictionary(null)).toEqual([]);
  });
});
