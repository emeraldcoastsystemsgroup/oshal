/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added purpose-bound per-owner AES-256-GCM encryption for biometric speaker embeddings with no plaintext fallback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added previous-key decrypt fallback for safe controller-only profile-secret rotation; encryption remains current-key only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added key-id envelopes and rewrap metadata so legacy ciphertext can be counted and durably migrated before removing the previous key.
 */

import crypto from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import { normalizeSpeakerEmbedding } from './speaker-matcher';

const CURRENT_PREFIX = 'speaker-v2:';
const LEGACY_PREFIX = 'speaker-v1:';
const KEY_INFO = Buffer.from('oshal-speaker-embedding-v1', 'utf8');
const AAD_PREFIX = 'oshal-speaker-profile:';
const logger = createChildLogger({ module: 'speaker-embedding-crypto' });

/** @description Decrypted embedding plus whether storage must rewrite it with the current key. */
export interface SpeakerEmbeddingDecryption {
  embedding: number[];
  requiresRewrap: boolean;
}

/**
 * @description Returns the non-secret identifier embedded in newly encrypted envelopes.
 * @returns Truncated SHA-256 key identifier suitable for counting legacy database rows.
 */
export function currentSpeakerEmbeddingKeyId(): string {
  return secretKeyId(currentSecret());
}

/**
 * @description Checks an envelope marker without decrypting biometric material.
 * @param envelope - Stored versioned ciphertext.
 * @returns Whether the row is legacy or encrypted by a non-current key.
 */
export function speakerEmbeddingNeedsRewrap(envelope: string): boolean {
  return !envelope.startsWith(`${CURRENT_PREFIX}${currentSpeakerEmbeddingKeyId()}:`);
}

/**
 * @description Encrypts a normalized embedding with a purpose-bound per-owner current key.
 * @param ownerSub - Authenticated profile owner.
 * @param embedding - Finite speaker vector.
 * @returns Key-id-versioned AES-256-GCM envelope.
 */
export function encryptSpeakerEmbedding(ownerSub: string, embedding: readonly number[]): string {
  const secretValue = currentSecret();
  const payload = encryptPayload(ownerSub, embedding, secretValue);
  return `${CURRENT_PREFIX}${secretKeyId(secretValue)}:${payload}`;
}

/**
 * @description Decrypts and validates an owner-bound embedding using current or configured previous key.
 * @param ownerSub - Authenticated profile owner used as key salt and authenticated data.
 * @param envelope - Stored versioned ciphertext.
 * @returns Normalized speaker vector.
 */
export function decryptSpeakerEmbedding(ownerSub: string, envelope: string): number[] {
  return decryptSpeakerEmbeddingForRotation(ownerSub, envelope).embedding;
}

/**
 * @description Decrypts an envelope and signals when the caller must persist a current-key rewrite.
 * @param ownerSub - Authenticated profile owner.
 * @param envelope - Legacy or key-id-versioned ciphertext.
 * @returns Embedding plus durable-rotation requirement.
 */
export function decryptSpeakerEmbeddingForRotation(
  ownerSub: string,
  envelope: string,
): SpeakerEmbeddingDecryption {
  const parsed = parseEnvelope(envelope);
  const current = currentSecret();
  const previous = previousSecret();
  try {
    if (parsed.keyId === secretKeyId(current)) {
      return { embedding: decryptPayload(ownerSub, parsed.bytes, current), requiresRewrap: false };
    }
    if (parsed.keyId && previous && parsed.keyId === secretKeyId(previous)) {
      return { embedding: decryptPayload(ownerSub, parsed.bytes, previous), requiresRewrap: true };
    }
    return decryptLegacyOrUnknown(ownerSub, parsed, current, previous);
  } finally {
    parsed.bytes.fill(0);
  }
}

function currentSecret(): string {
  const value = process.env.SPEAKER_PROFILE_SECRET || process.env.SESSION_SECRET || '';
  if (value.length < 16) {
    throw new Error('SPEAKER_PROFILE_SECRET or SESSION_SECRET (>=16 chars) is required for speaker embedding encryption');
  }
  return value;
}

function previousSecret(): string | null {
  const value = process.env.SPEAKER_PROFILE_SECRET_PREVIOUS || '';
  if (!value) return null;
  if (value.length < 16) throw new Error('SPEAKER_PROFILE_SECRET_PREVIOUS must contain at least 16 characters');
  return value;
}

function secretKeyId(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function ownerKey(ownerSub: string, secretValue: string): Buffer {
  if (!ownerSub) throw new Error('speaker embedding owner is required');
  const secret = Buffer.from(secretValue, 'utf8');
  try {
    return Buffer.from(crypto.hkdfSync(
      'sha256', secret, Buffer.from(ownerSub, 'utf8'), KEY_INFO, 32,
    ));
  } finally {
    secret.fill(0);
  }
}

function encryptPayload(ownerSub: string, embedding: readonly number[], secret: string): string {
  const iv = crypto.randomBytes(12);
  const key = ownerKey(ownerSub, secret);
  const plaintext = serializeEmbedding(embedding);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${AAD_PREFIX}${ownerSub}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

function decryptPayload(ownerSub: string, bytes: Buffer, secret: string): number[] {
  const key = ownerKey(ownerSub, secret);
  let plaintext: Buffer | null = null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${ownerSub}`, 'utf8'));
    decipher.setAuthTag(bytes.subarray(12, 28));
    plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    return deserializeEmbedding(plaintext);
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

function decryptLegacyOrUnknown(
  ownerSub: string,
  parsed: { keyId: string | null; bytes: Buffer },
  current: string,
  previous: string | null,
): SpeakerEmbeddingDecryption {
  if (parsed.keyId) throw new Error(`speaker embedding key ${parsed.keyId} is not configured`);
  try {
    return { embedding: decryptPayload(ownerSub, parsed.bytes, current), requiresRewrap: true };
  } catch (error) {
    if (!previous) throw error;
    logger.warn({ operation: 'decryptPreviousKey' }, 'Legacy profile needs previous speaker key');
    return { embedding: decryptPayload(ownerSub, parsed.bytes, previous), requiresRewrap: true };
  }
}

function parseEnvelope(envelope: string): { keyId: string | null; bytes: Buffer } {
  if (envelope.startsWith(CURRENT_PREFIX)) {
    const separator = envelope.indexOf(':', CURRENT_PREFIX.length);
    const keyId = envelope.slice(CURRENT_PREFIX.length, separator);
    if (separator < 0 || !/^[a-f0-9]{16}$/.test(keyId)) throw new Error('speaker embedding key id is invalid');
    return validateEnvelopeBytes(keyId, envelope.slice(separator + 1));
  }
  if (envelope.startsWith(LEGACY_PREFIX)) {
    return validateEnvelopeBytes(null, envelope.slice(LEGACY_PREFIX.length));
  }
  throw new Error('unsupported speaker embedding envelope');
}

function validateEnvelopeBytes(keyId: string | null, encoded: string) {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 45) {
    bytes.fill(0);
    throw new Error('speaker embedding envelope is truncated');
  }
  return { keyId, bytes };
}

function serializeEmbedding(embedding: readonly number[]): Buffer {
  const normalized = normalizeSpeakerEmbedding(embedding);
  const bytes = Buffer.allocUnsafe(4 + (normalized.length * 8));
  bytes.writeUInt32BE(normalized.length, 0);
  normalized.forEach((value, index) => bytes.writeDoubleBE(value, 4 + (index * 8)));
  return bytes;
}

function deserializeEmbedding(bytes: Buffer): number[] {
  if (bytes.length < 20) throw new Error('encrypted speaker embedding payload is truncated');
  const dimensions = bytes.readUInt32BE(0);
  if (dimensions < 2 || bytes.length !== 4 + (dimensions * 8)) {
    throw new Error('encrypted speaker embedding dimensions are invalid');
  }
  return normalizeSpeakerEmbedding(Array.from(
    { length: dimensions }, (_, index) => bytes.readDoubleBE(4 + (index * 8)),
  ));
}
