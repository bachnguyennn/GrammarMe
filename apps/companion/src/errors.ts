import { COMPANION_ERROR_TEXT } from '@grammarme/core/companion';
import type { CompanionErrorCode } from '@grammarme/core/companion';

/** An error that maps to one of the contract's error codes. `message` is safe to show the user. */
export class CompanionError extends Error {
  readonly code: CompanionErrorCode;
  constructor(code: CompanionErrorCode, message?: string) {
    super(message ?? COMPANION_ERROR_TEXT[code]);
    this.name = 'CompanionError';
    this.code = code;
  }
}

/** A plain 401 from the API: the caller refreshes once and retries before giving up. */
export class UnauthorizedError extends CompanionError {
  constructor() {
    super('reauth_required');
    this.name = 'UnauthorizedError';
  }
}

export function toCompanionError(e: unknown): CompanionError {
  return e instanceof CompanionError ? e : new CompanionError('internal');
}
