/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the shared exact OIDC-subject contract: preserve valid UTF-8 bytes and reject absent-shape, empty, control-bearing, or over-512-byte assertions without trimming or truncation.
 */

/** Maximum UTF-8 size accepted for an authenticated OIDC subject. */
export const MAX_USER_SUBJECT_BYTES = 512;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * @description Stable validation error used at trust boundaries so invalid asserted identities
 * cannot silently collapse into the ownerless/system namespace.
 */
export class InvalidUserSubjectError extends TypeError {
  /** Stable machine-readable code for HTTP and runtime error mapping. */
  public readonly code = 'INVALID_USER_SUBJECT';

  /**
   * @description Creates an invalid-subject error without echoing the sensitive identity value.
   * @param label - Human-readable field name used in the diagnostic.
   */
  constructor(label = 'userSub') {
    super(`${label} must be exact UTF-8, non-empty, control-free, and at most ${MAX_USER_SUBJECT_BYTES} bytes`);
    this.name = 'InvalidUserSubjectError';
  }
}

/**
 * @description Validates one asserted OIDC subject without changing a single character. JavaScript
 * strings containing unpaired surrogates fail the UTF-8 round trip, preventing replacement-character
 * aliasing; surrounding and all-whitespace values remain distinct, valid identities.
 * @param value - Candidate subject from a trusted identity boundary.
 * @param label - Field name used only in errors.
 * @returns The original string, byte-for-byte at UTF-8 serialization time.
 * @throws InvalidUserSubjectError when the assertion is not a valid exact subject.
 */
export function requireExactUserSubject(value: unknown, label = 'userSub'): string {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new InvalidUserSubjectError(label);
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_USER_SUBJECT_BYTES || bytes.toString('utf8') !== value) {
    throw new InvalidUserSubjectError(label);
  }
  return value;
}

/**
 * @description Distinguishes a genuinely absent optional subject from an invalid supplied one.
 * This is load-bearing: invalid caller input must never be reinterpreted as a system dispatch.
 * @param value - Optional asserted subject.
 * @param label - Field name used only in errors.
 * @returns Undefined only for nullish absence; otherwise the unchanged validated subject.
 */
export function optionalExactUserSubject(value: unknown, label = 'userSub'): string | undefined {
  return value === undefined || value === null ? undefined : requireExactUserSubject(value, label);
}

/**
 * @description Boolean schema predicate for values that already must be strings.
 * @param value - Candidate string.
 * @returns True only when {@link requireExactUserSubject} would return it unchanged.
 */
export function isExactUserSubject(value: string): boolean {
  try {
    requireExactUserSubject(value);
    return true;
  } catch {
    return false;
  }
}
