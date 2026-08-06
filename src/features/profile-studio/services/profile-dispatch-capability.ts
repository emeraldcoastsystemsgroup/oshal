/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define short-lived one-use Profile Studio result capabilities, exact opaque-subject callback validation, and domain-separated token hashing for the atomic plan-store boundary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reuse the kernel exact-subject validator so callback identity accepts and rejects the same bytes as the A2A task envelope.
 */

import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { isExactUserSubject } from '@/shared/security/exact-user-subject';

/** @description The sole mutation a Profile Studio dispatch capability may authorize. */
export const PROFILE_CALLBACK_OPERATION = 'resolve-profile-plan' as const;
/** @description Thirty minutes bounds a browser run without turning its callback into standing access. */
export const PROFILE_CALLBACK_TTL_MS = 30 * 60 * 1000;

const OpaqueSubjectSchema = z.string().refine(isExactUserSubject, 'userSub is not a valid exact subject');
const ResultNoteSchema = z.string().max(4000).refine(isValidResultNote, 'note is not valid bounded UTF-8');

/** @description Exact immutable binding carried by trusted remote runtime callback metadata. */
export const ProfileCallbackContextSchema = z.object({
  userSub: OpaqueSubjectSchema,
  generation: z.number().int().positive().safe(),
  clientId: z.string().min(1).max(200),
  operation: z.literal(PROFILE_CALLBACK_OPERATION),
}).strict();

/** @description Strict Profile Studio result accepted from the browser worker. */
export const ProfileCallbackResultSchema = z.object({
  result: z.enum(['applied', 'failed']),
  note: ResultNoteSchema,
}).strict();

/** @description Strict callback body; unknown fields and alternate nesting are rejected. */
export const ProfileCallbackRequestSchema = z.object({
  taskId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  context: ProfileCallbackContextSchema,
  result: ProfileCallbackResultSchema,
}).strict();

/** @description Parsed immutable callback request inferred from its strict schema. */
export type ProfileCallbackRequest = z.infer<typeof ProfileCallbackRequestSchema>;

/** @description Plaintext-once issuance plus the digest and expiry persisted by the plan store. */
export interface ProfileDispatchCapability {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * @description Mints 256 bits of entropy for one dispatch and stores only its domain-separated hash.
 * @param nowMs - Issuance time used to compute the short expiry; injectable for deterministic tests.
 * @returns Plaintext-once capability metadata for the trusted task envelope and database binding.
 */
export function mintProfileDispatchCapability(nowMs = Date.now()): ProfileDispatchCapability {
  const token = `pscap_${randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenHash: hashProfileDispatchCapability(token),
    expiresAt: new Date(nowMs + PROFILE_CALLBACK_TTL_MS),
  };
}

/**
 * @description Hashes a syntactically valid capability with an operation-specific domain prefix.
 * @param token - Plaintext capability presented once by trusted remote runtime code.
 * @returns Lowercase SHA-256 digest stored and compared by PostgreSQL.
 */
export function hashProfileDispatchCapability(token: string): string {
  if (!/^pscap_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid profile callback capability');
  return createHash('sha256').update(`${PROFILE_CALLBACK_OPERATION}\0${token}`, 'utf8').digest('hex');
}

/**
 * @description Reads the dedicated callback header without trimming or accepting alternate schemes.
 * @param value - Express header value.
 * @returns The syntactically valid token, or null on missing/malformed input.
 */
export function parseProfileDispatchCapability(value: unknown): string | null {
  return typeof value === 'string' && /^pscap_[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** @description Keeps callback notes textual, bounded, and safe for exact JSON/database transport. */
function isValidResultNote(value: string): boolean {
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > 8000) return false;
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}
