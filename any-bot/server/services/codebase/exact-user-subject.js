/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the any-bot runtime twin of the kernel exact-subject contract so every owner/tool/scoped-file boundary preserves bytes and rejects invalid assertions consistently.
 */
'use strict';

const MAX_USER_SUBJECT_BYTES = 512;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

/** Stable validation error that callers can map without inspecting identity text. */
class InvalidUserSubjectError extends TypeError {
  /**
   * @description Creates a bounded diagnostic that never echoes the supplied subject.
   * @param {string} [label] - Field name used in the error message.
   */
  constructor(label = 'userSub') {
    super(`${label} must be exact UTF-8, non-empty, control-free, and at most ${MAX_USER_SUBJECT_BYTES} bytes`);
    this.name = 'InvalidUserSubjectError';
    this.code = 'INVALID_USER_SUBJECT';
  }
}

/**
 * @description Validates and returns an OIDC subject unchanged. An unpaired surrogate fails the
 * UTF-8 round trip, while surrounding or all-whitespace identity bytes remain significant.
 * @param {unknown} value - Candidate asserted subject.
 * @param {string} [label] - Field name used only in errors.
 * @returns {string} The exact supplied string.
 * @throws {InvalidUserSubjectError} For every invalid supplied value.
 */
function requireExactUserSubject(value, label = 'userSub') {
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
 * @description Returns undefined only for nullish absence; invalid supplied values still throw.
 * @param {unknown} value - Optional asserted subject.
 * @param {string} [label] - Field name used only in errors.
 * @returns {string|undefined} Exact subject or genuine absence.
 */
function optionalExactUserSubject(value, label = 'userSub') {
  return value === undefined || value === null ? undefined : requireExactUserSubject(value, label);
}

module.exports = {
  InvalidUserSubjectError,
  MAX_USER_SUBJECT_BYTES,
  optionalExactUserSubject,
  requireExactUserSubject,
};
