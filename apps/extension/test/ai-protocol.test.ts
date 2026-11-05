import { describe, expect, it } from 'vitest';
import { AI_MAX_INPUT_CHARS } from '@grammarme/core/companion';
import { classifyNativeError, isAiRequest, isContentAiRequest, newRequestId, type AiRequest } from '../src/ai-protocol.ts';

const check = (over: Record<string, unknown> = {}) => ({
  target: 'background',
  type: 'aiCheck',
  requestId: 'abcdef0123456789',
  task: 'grammar',
  mode: 'standard',
  text: 'I has a apple.',
  ...over,
});

describe('isAiRequest', () => {
  it('accepts well-formed popup and content requests', () => {
    for (const type of ['aiStatus', 'aiConnect', 'aiCancelConnect', 'aiDisconnect', 'aiModels', 'aiTest']) {
      expect(isAiRequest({ target: 'background', type })).toBe(true);
    }
    expect(isAiRequest({ target: 'background', type: 'aiSetModel', model: 'gpt-x' })).toBe(true);
    expect(isAiRequest(check())).toBe(true);
    expect(isAiRequest({ target: 'background', type: 'aiCancel', requestId: 'abcdef0123456789' })).toBe(true);
  });

  it('rejects oversized, empty or malformed checks', () => {
    expect(isAiRequest(check({ text: 'x'.repeat(AI_MAX_INPUT_CHARS + 1) }))).toBe(false);
    expect(isAiRequest(check({ text: '   ' }))).toBe(false);
    expect(isAiRequest(check({ task: 'summarise' }))).toBe(false);
    expect(isAiRequest(check({ mode: 'pirate' }))).toBe(false);
    expect(isAiRequest(check({ requestId: 'short' }))).toBe(false);
    expect(isAiRequest(check({ requestId: '../../etc/passwd' }))).toBe(false);
    expect(isAiRequest(check({ target: 'offscreen' }))).toBe(false);
    expect(isAiRequest({ target: 'background', type: 'aiSetModel', model: '' })).toBe(false);
    expect(isAiRequest({ target: 'background', type: 'aiProxy', url: 'https://example.com' })).toBe(false);
  });

  it('lets web-page contexts (content scripts) only check and cancel', () => {
    expect(isContentAiRequest(check() as AiRequest)).toBe(true);
    expect(isContentAiRequest({ target: 'background', type: 'aiCancel', requestId: 'abcdef0123456789' })).toBe(true);
    expect(isContentAiRequest({ target: 'background', type: 'aiDisconnect' })).toBe(false);
    expect(isContentAiRequest({ target: 'background', type: 'aiStatus' })).toBe(false);
  });
});

describe('classifyNativeError', () => {
  it('maps Chrome native-messaging errors to setup states', () => {
    expect(classifyNativeError('Specified native messaging host not found.')).toBe('companion_missing');
    expect(classifyNativeError('Access to the specified native messaging host is forbidden.')).toBe('companion_forbidden');
    expect(classifyNativeError('Native host has exited.')).toBe('interrupted');
    expect(classifyNativeError(undefined)).toBe('interrupted');
  });
});

describe('newRequestId', () => {
  it('makes ids the protocol accepts', () => {
    const id = newRequestId();
    expect(isAiRequest({ target: 'background', type: 'aiCancel', requestId: id })).toBe(true);
    expect(newRequestId()).not.toBe(id);
  });
});
