/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic JSON canonicalization and SHA-256 request binding so a valid task token cannot authorize mutated prompt, entitlement, credential, or provider-intent fields.
 */

import { createHash } from 'node:crypto';

const MAX_CANONICAL_REQUEST_BYTES = 5 * 1_024 * 1_024;

/** @description Sanitized failure for a body that cannot be represented as bounded JSON. */
export class DelegationRequestBindingError extends Error {
  /** @description Creates a non-secret canonicalization failure. */
  constructor() {
    super('Delegation request body cannot be bound');
    this.name = 'DelegationRequestBindingError';
  }
}

/**
 * @description Computes a deterministic lowercase SHA-256 digest over the complete semantic JSON
 * request body. Object keys are sorted recursively; array order remains authoritative; undefined
 * object properties are omitted exactly as JSON.stringify omits them. Unsupported/cyclic values and
 * bodies beyond the bot parser's 5 MiB ceiling fail closed.
 * @param body - Controller request object or bot-side parsed JSON body.
 * @returns Sixty-four lowercase hexadecimal SHA-256 characters.
 */
export function delegationRequestBodySha256(body: unknown): string {
  try {
    const canonical = canonicalJson(body, new Set<object>());
    if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_REQUEST_BYTES) {
      throw new DelegationRequestBindingError();
    }
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  } catch (error) {
    if (error instanceof DelegationRequestBindingError) throw error;
    throw new DelegationRequestBindingError();
  }
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DelegationRequestBindingError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return canonicalArray(value, ancestors);
  if (isPlainRecord(value)) return canonicalRecord(value, ancestors);
  throw new DelegationRequestBindingError();
}

function canonicalArray(values: readonly unknown[], ancestors: Set<object>): string {
  return whileVisiting(values, ancestors, () => {
    const entries = values.map((value) => canonicalJson(value, ancestors));
    return `[${entries.join(',')}]`;
  });
}

function canonicalRecord(value: Record<string, unknown>, ancestors: Set<object>): string {
  return whileVisiting(value, ancestors, () => {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`);
    return `{${entries.join(',')}}`;
  });
}

function whileVisiting<T extends object>(
  value: T,
  ancestors: Set<object>,
  operation: () => string,
): string {
  if (ancestors.has(value)) throw new DelegationRequestBindingError();
  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
