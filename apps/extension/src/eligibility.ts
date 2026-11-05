/**
 * Which form fields GrammarMe may read. Pure rules over a plain description of the field, so the
 * privacy-critical logic is unit-tested without a DOM. `describeField` (field-dom.ts) builds the
 * description from a real element.
 */

export interface FieldInfo {
  /** Element tag name, any case. */
  tagName: string;
  /** `type` attribute for inputs (null when absent). */
  type: string | null;
  autocomplete: string | null;
  name: string | null;
  id: string | null;
  readOnly: boolean;
  disabled: boolean;
  /** The element or an ancestor has aria-hidden="true". */
  ariaHidden: boolean;
  /** The element or an ancestor opted out (data-grammarme="off", data-gramm="false", …). */
  optedOut: boolean;
  /** Value of the `spellcheck` attribute (null when absent). */
  spellcheck: string | null;
  /** Rendered size in CSS px. */
  width: number;
  height: number;
}

export type IneligibleReason =
  | 'unsupported-element'
  | 'unsupported-input-type'
  | 'password'
  | 'sensitive-autocomplete'
  | 'sensitive-name'
  | 'readonly'
  | 'disabled'
  | 'aria-hidden'
  | 'opted-out'
  | 'spellcheck-off'
  | 'too-small';

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

/** Input types we check. Email/url/tel/number/password etc. are never read. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', '']);

/**
 * `autocomplete` tokens that mark sensitive or non-prose data (HTML spec token names). We never
 * read these fields at all.
 */
const SENSITIVE_AUTOCOMPLETE = [
  /^cc-/,
  /^one-time-code$/,
  /^(current|new)-password$/,
  /^webauthn$/,
  /^username$/,
  /^email$/,
  /^tel(-|$)/,
  /^bday(-|$)/,
  /^transaction-/,
];

/** Heuristic for fields whose name/id says "secret", for sites that don't use autocomplete. */
const SENSITIVE_NAME =
  /(pass(word|wd|code|phrase)?|pwd|secret|otp|one.?time|totp|2fa|mfa|cvv|cvc|csc|card.?(num|no)|ccnum|iban|routing|account.?(num|no)|ssn|social.?security|tax.?id|pin(code)?$|token|api.?key)/i;

export const MIN_FIELD_WIDTH = 40;
export const MIN_FIELD_HEIGHT = 14;

export function fieldEligibility(f: FieldInfo): Eligibility {
  const tag = f.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (f.type ?? '').trim().toLowerCase();
    if (type === 'password') return no('password');
    if (!TEXT_INPUT_TYPES.has(type)) return no('unsupported-input-type');
  } else if (tag !== 'textarea') {
    return no('unsupported-element');
  }
  const tokens = (f.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some((t) => SENSITIVE_AUTOCOMPLETE.some((re) => re.test(t)))) return no('sensitive-autocomplete');
  if ((f.name && SENSITIVE_NAME.test(f.name)) || (f.id && SENSITIVE_NAME.test(f.id))) return no('sensitive-name');
  if (f.disabled) return no('disabled');
  if (f.readOnly) return no('readonly');
  if (f.ariaHidden) return no('aria-hidden');
  if (f.optedOut) return no('opted-out');
  // Code editors (CodeMirror, Monaco, Ace) and many terminals mark their textarea spellcheck="false".
  if ((f.spellcheck ?? '').trim().toLowerCase() === 'false') return no('spellcheck-off');
  // Hidden IME/clipboard helper textareas are tiny or zero-sized.
  if (f.width < MIN_FIELD_WIDTH || f.height < MIN_FIELD_HEIGHT) return no('too-small');
  return { eligible: true };
}

function no(reason: IneligibleReason): Eligibility {
  return { eligible: false, reason };
}

/** Ancestor attributes that turn GrammarMe off for a subtree (ours, plus Grammarly's well-known ones). */
export const OPT_OUT_SELECTOR =
  '[data-grammarme="off"], [data-grammarme="false"], [data-gramm="false"], [data-enable-grammarly="false"]';
