import { describe, expect, it } from 'vitest';
import { fieldEligibility, type FieldInfo } from '../src/eligibility.ts';

const base: FieldInfo = {
  tagName: 'TEXTAREA',
  type: null,
  autocomplete: null,
  name: 'comment',
  id: null,
  readOnly: false,
  disabled: false,
  ariaHidden: false,
  optedOut: false,
  spellcheck: null,
  width: 400,
  height: 120,
};
const check = (over: Partial<FieldInfo>) => fieldEligibility({ ...base, ...over });

describe('fieldEligibility', () => {
  it('accepts a normal textarea and text/search inputs', () => {
    expect(check({})).toEqual({ eligible: true });
    expect(check({ tagName: 'INPUT', type: 'text', height: 30 })).toEqual({ eligible: true });
    expect(check({ tagName: 'input', type: null, height: 30 })).toEqual({ eligible: true });
    expect(check({ tagName: 'INPUT', type: 'Search', height: 30 })).toEqual({ eligible: true });
  });

  it('never reads password fields', () => {
    expect(check({ tagName: 'INPUT', type: 'password' })).toEqual({ eligible: false, reason: 'password' });
    expect(check({ tagName: 'INPUT', type: ' PASSWORD ' })).toMatchObject({ eligible: false, reason: 'password' });
  });

  it('skips non-prose input types', () => {
    for (const type of ['email', 'url', 'tel', 'number', 'hidden', 'date']) {
      expect(check({ tagName: 'INPUT', type })).toMatchObject({ eligible: false, reason: 'unsupported-input-type' });
    }
    expect(check({ tagName: 'DIV' })).toMatchObject({ reason: 'unsupported-element' });
  });

  it('skips sensitive autocomplete tokens, including section-prefixed ones', () => {
    for (const autocomplete of [
      'cc-number',
      'section-pay cc-csc',
      'one-time-code',
      'current-password',
      'new-password',
      'username',
      'shipping tel',
      'billing email',
    ]) {
      expect(check({ tagName: 'INPUT', type: 'text', autocomplete })).toMatchObject({
        eligible: false,
        reason: 'sensitive-autocomplete',
      });
    }
    expect(check({ autocomplete: 'off' })).toEqual({ eligible: true });
    expect(check({ autocomplete: 'on' })).toEqual({ eligible: true });
  });

  it('skips fields whose name or id looks secret', () => {
    for (const name of ['password', 'user_pwd', 'otp', 'cvv', 'card_number', 'ssn', 'api_key', 'pin']) {
      expect(check({ tagName: 'INPUT', type: 'text', name })).toMatchObject({ reason: 'sensitive-name' });
    }
    expect(check({ name: null, id: 'mfa-code' })).toMatchObject({ reason: 'sensitive-name' });
    expect(check({ name: 'message', id: 'compose-body' })).toEqual({ eligible: true });
    expect(check({ name: 'opinion' })).toEqual({ eligible: true }); // "pin" only matches at the end
  });

  it('skips readonly, disabled, aria-hidden and opted-out fields', () => {
    expect(check({ readOnly: true })).toMatchObject({ reason: 'readonly' });
    expect(check({ disabled: true })).toMatchObject({ reason: 'disabled' });
    expect(check({ ariaHidden: true })).toMatchObject({ reason: 'aria-hidden' });
    expect(check({ optedOut: true })).toMatchObject({ reason: 'opted-out' });
  });

  it('skips code editors (spellcheck=false) and tiny helper textareas', () => {
    expect(check({ spellcheck: 'false' })).toMatchObject({ reason: 'spellcheck-off' });
    expect(check({ spellcheck: 'true' })).toEqual({ eligible: true });
    expect(check({ width: 1, height: 1 })).toMatchObject({ reason: 'too-small' });
    expect(check({ width: 0, height: 0 })).toMatchObject({ reason: 'too-small' });
  });
});
