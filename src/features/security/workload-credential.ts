/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add random 256-bit workload credentials, hash-only storage helpers, constant-time verification, and shared identifier/scope validation.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CREDENTIAL_PREFIX = 'oshal_wk_';
const WORKLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** @description One generated credential shown once to an operator or secret provisioner. */
export interface GeneratedWorkloadCredential {
  /** Random 256-bit bearer secret; persist it only in the owning workload secret store. */
  credential: string;
  /** Non-secret key id recorded with the corresponding hash. */
  keyId: string;
}

/**
 * @description Generates a cryptographically random 256-bit workload credential and independent
 * key id. The caller receives plaintext once; the PostgreSQL store accepts only its SHA-256 hash.
 * @returns A one-time plaintext credential and non-secret key identifier.
 */
export function generateWorkloadCredential(): GeneratedWorkloadCredential {
  return {
    credential: `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`,
    keyId: randomBytes(12).toString('base64url'),
  };
}

/**
 * @description Validates and hashes a full-entropy workload credential for durable storage.
 * SHA-256 is appropriate here because the input is a uniformly random 256-bit secret, not a
 * human password. No plaintext or reversible representation is retained.
 * @param credential - Exact generated workload credential.
 * @returns Lowercase SHA-256 hexadecimal digest.
 */
export function hashWorkloadCredential(credential: string): string {
  validateCredential(credential);
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/**
 * @description Compares a presented high-entropy credential to one stored digest in constant time.
 * Invalid credential/hash shapes return false without exposing which validation failed.
 * @param credential - Exact presented workload credential.
 * @param expectedHash - Stored lowercase SHA-256 digest.
 * @returns True only for an exact valid credential match.
 */
export function workloadCredentialHashMatches(credential: string, expectedHash: string): boolean {
  try {
    if (!HASH_PATTERN.test(expectedHash)) return false;
    const actual = Buffer.from(hashWorkloadCredential(credential), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * @description Validates a stable non-secret workload identifier.
 * @param value - Candidate workload id.
 * @returns The exact accepted identifier.
 */
export function requireWorkloadId(value: string): string {
  if (typeof value !== 'string' || !WORKLOAD_ID_PATTERN.test(value)) {
    throw new Error('Workload identifier is invalid');
  }
  return value;
}

/**
 * @description Validates a bounded non-secret credential key identifier.
 * @param value - Candidate key id.
 * @returns The exact accepted key identifier.
 */
export function requireWorkloadKeyId(value: string): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new Error('Workload credential key identifier is invalid');
  }
  return value;
}

/**
 * @description Validates, deduplicates, and sorts a least-privilege workload scope set.
 * @param scopes - Candidate scope array.
 * @param maximum - Maximum entries admitted by the consuming schema.
 * @returns Stable exact scope list.
 */
export function normalizeWorkloadScopes(scopes: readonly string[], maximum = 16): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > maximum) {
    throw new Error('Workload scopes are invalid');
  }
  const normalized = scopes.map((scope) => {
    if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
      throw new Error('Workload scope is invalid');
    }
    return scope;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error('Workload scopes must be unique');
  return normalized.sort();
}

function validateCredential(value: string): void {
  if (typeof value !== 'string' || !value.startsWith(CREDENTIAL_PREFIX)) {
    throw new Error('Workload credential is invalid');
  }
  const encoded = value.slice(CREDENTIAL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('Workload credential is invalid');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) {
    throw new Error('Workload credential is invalid');
  }
}
