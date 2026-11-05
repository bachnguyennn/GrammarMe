import { describe, expect, it } from 'vitest';
import { AI_MAX_INPUT_CHARS, COMPANION_ERROR_TEXT, isCompanionReply, parseCompanionRequest } from '../src/companion.ts';

describe('parseCompanionRequest (the only operations the companion performs)', () => {
  it('accepts the fixed operations', () => {
    for (const type of ['status', 'signIn', 'signOut', 'models', 'test'] as const) {
      expect(parseCompanionRequest({ id: 'r1', type })).toEqual({ id: 'r1', type });
    }
    expect(parseCompanionRequest({ id: 'r1', type: 'setModel', model: 'gpt-6.1-sol' })).toEqual({
      id: 'r1',
      type: 'setModel',
      model: 'gpt-6.1-sol',
    });
    expect(parseCompanionRequest({ id: 'r2', type: 'cancel', target: 'r1' })).toEqual({ id: 'r2', type: 'cancel', target: 'r1' });
  });

  it('accepts a bounded check and drops unknown fields (no URL or header can be smuggled)', () => {
    const r = parseCompanionRequest({
      id: 'abc',
      type: 'check',
      task: 'tone',
      mode: 'casual',
      text: 'hello',
      url: 'https://example.com',
      headers: { a: 'b' },
    });
    expect(r).toEqual({ id: 'abc', type: 'check', task: 'tone', mode: 'casual', text: 'hello' });
  });

  it('rejects anything else', () => {
    expect(parseCompanionRequest(null)).toBeNull();
    expect(parseCompanionRequest({ type: 'status' })).toBeNull();
    expect(parseCompanionRequest({ id: 'bad id!', type: 'status' })).toBeNull();
    expect(parseCompanionRequest({ id: 'a', type: 'fetch', url: 'https://x' })).toBeNull();
    expect(parseCompanionRequest({ id: 'a', type: 'check', task: 'grammar', mode: 'standard', text: '' })).toBeNull();
    expect(
      parseCompanionRequest({ id: 'a', type: 'check', task: 'grammar', mode: 'standard', text: 'x'.repeat(AI_MAX_INPUT_CHARS + 1) }),
    ).toBeNull();
    expect(parseCompanionRequest({ id: 'a', type: 'check', task: 'rewrite', mode: 'standard', text: 'x' })).toBeNull();
    expect(parseCompanionRequest({ id: 'a', type: 'setModel', model: 'a b' })).toBeNull();
  });
});

describe('isCompanionReply', () => {
  it('accepts done replies and OpenAI authorization URLs only', () => {
    expect(isCompanionReply({ id: 'a', type: 'done', ok: true })).toBe(true);
    expect(isCompanionReply({ id: 'a', type: 'done', ok: false, error: 'usage_limit', message: 'm' })).toBe(true);
    expect(isCompanionReply({ id: 'a', type: 'authUrl', url: 'https://auth.openai.com/api/accounts/authorize?x' })).toBe(true);
    expect(isCompanionReply({ id: 'a', type: 'authUrl', url: 'https://auth.openai.com.evil.example/' })).toBe(false);
    expect(isCompanionReply({ id: 'a', type: 'authUrl', url: 'javascript:alert(1)' })).toBe(false);
    expect(isCompanionReply({ id: 'a', type: 'done', ok: false })).toBe(false);
  });

  it('has user-facing text for every error code, without promising unlimited use', () => {
    for (const text of Object.values(COMPANION_ERROR_TEXT)) {
      expect(text.length).toBeGreaterThan(10);
      expect(text.toLowerCase()).not.toContain('unlimited');
    }
  });
});
