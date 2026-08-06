/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add the shared CommonJS CLI reader for exact OIDC subjects from OSHAL_USER_SUB or the scoped workspace file.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_USER_SUBJECT_BYTES = 512;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

/** Error type shared by connector CLIs without disclosing the rejected identity. */
class InvalidUserSubjectError extends TypeError {
  /** @param {string} [label] Field name used only in the bounded diagnostic. */
  constructor(label = 'OSHAL_USER_SUB') {
    super(`${label} must be exact UTF-8, non-empty, control-free, and at most ${MAX_USER_SUBJECT_BYTES} bytes`);
    this.name = 'InvalidUserSubjectError';
    this.code = 'INVALID_USER_SUBJECT';
  }
}

/**
 * @description Validate an asserted subject without trimming, truncating, or normalizing it.
 * @param {unknown} value Candidate identity assertion.
 * @param {string} [label] Field name used only in errors.
 * @returns {string} The exact supplied subject.
 */
function requireExactUserSubject(value, label = 'OSHAL_USER_SUB') {
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
 * @description Read the controller-provided subject from env first, then the scoped cwd file.
 * Empty env means “not forwarded” and falls through; an empty/corrupt existing file fails closed.
 * @param {{env?:NodeJS.ProcessEnv,cwd?:string}} [options] Injectable process inputs for guards.
 * @returns {string|undefined} Exact subject, or undefined only when neither source exists.
 */
function resolveExactUserSubject(options = {}) {
  const env = options.env || process.env;
  if (typeof env.OSHAL_USER_SUB === 'string' && env.OSHAL_USER_SUB.length > 0) {
    return requireExactUserSubject(env.OSHAL_USER_SUB);
  }
  const subjectFile = path.join(options.cwd || process.cwd(), '.oshal-user-sub');
  try { return requireExactUserSubject(fs.readFileSync(subjectFile, 'utf8'), '.oshal-user-sub'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

module.exports = {
  InvalidUserSubjectError,
  MAX_USER_SUBJECT_BYTES,
  requireExactUserSubject,
  resolveExactUserSubject,
};
