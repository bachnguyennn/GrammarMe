import { describe, expect, it } from 'vitest';
import {
  MAX_CHECK_CHARS,
  isBackgroundRequest,
  isCheckResponse,
  isContentRequest,
  isOffscreenRequest,
  normalizeWord,
  validateCheck,
} from '../src/protocol.ts';

describe('message guards', () => {
  it('routes by target so broadcasts are not double-handled', () => {
    const check = { target: 'background', type: 'check', text: 'hi', version: 3 };
    expect(isBackgroundRequest(check)).toBe(true);
    expect(isOffscreenRequest(check)).toBe(false);
    const lint = { target: 'offscreen', type: 'lint', text: 'hi', version: 3, options: {} };
    expect(isOffscreenRequest(lint)).toBe(true);
    expect(isBackgroundRequest(lint)).toBe(false);
    expect(isContentRequest({ target: 'content', type: 'getSiteInfo' })).toBe(true);
    expect(isContentRequest(check)).toBe(false);
  });

  it('rejects malformed requests', () => {
    expect(isBackgroundRequest(null)).toBe(false);
    expect(isBackgroundRequest('check')).toBe(false);
    expect(isBackgroundRequest({ target: 'background', type: 'check', text: 1, version: 0 })).toBe(false);
    expect(isBackgroundRequest({ target: 'background', type: 'check', text: 'a', version: -1 })).toBe(false);
    expect(isBackgroundRequest({ target: 'background', type: 'check', text: 'a', version: 1.5 })).toBe(false);
    expect(isBackgroundRequest({ target: 'background', type: 'nope' })).toBe(false);
    expect(isOffscreenRequest({ target: 'offscreen', type: 'lint', text: 'a', version: 0, options: {}, addWords: [1] })).toBe(false);
    expect(isOffscreenRequest({ target: 'offscreen', type: 'addWords', words: ['ok'] })).toBe(true);
  });

  it('recognises check responses', () => {
    expect(isCheckResponse({ ok: true, version: 1, suggestions: [] })).toBe(true);
    expect(isCheckResponse({ ok: false, version: 1, error: 'disabled' })).toBe(true);
    expect(isCheckResponse({ ok: true, version: 1 })).toBe(false);
    expect(isCheckResponse(undefined)).toBe(false);
  });

  it('refuses over-long texts before they cost CPU', () => {
    const req = { target: 'background', type: 'check', version: 0 } as const;
    expect(validateCheck({ ...req, text: 'a'.repeat(MAX_CHECK_CHARS) })).toBeNull();
    expect(validateCheck({ ...req, text: 'a'.repeat(MAX_CHECK_CHARS + 1) })).toBe('too_long');
  });
});

describe('normalizeWord', () => {
  it('accepts single words and trims them', () => {
    expect(normalizeWord('  GrammarMe ')).toBe('GrammarMe');
    expect(normalizeWord('café')).toBe('café');
    expect(normalizeWord("o'clock")).toBe("o'clock");
  });
  it('rejects empty, multi-word, letterless or huge input', () => {
    expect(normalizeWord('')).toBeNull();
    expect(normalizeWord('two words')).toBeNull();
    expect(normalizeWord('1234')).toBeNull();
    expect(normalizeWord('a'.repeat(65))).toBeNull();
  });
});
