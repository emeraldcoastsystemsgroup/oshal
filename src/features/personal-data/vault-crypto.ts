/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Vault at-rest encryption (ADR-057 "encrypt the file"). Per-user AES-256-GCM for PII content fields (entity/edge label + attrs) and a keyed HMAC for the natural-key resolver index (lookup-preserving but irreversible). The key is HKDF-SHA256(SESSION_SECRET, salt=ownerSub) — derived, never stored in the vault file — so a leaked DB/volume/backup is opaque without SESSION_SECRET. Internet-facing deployment requirement.
 */

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const ENC_PREFIX = 'v1:';
const keyCache = new Map<string, Buffer>();

/** The master secret all vault keys derive from. Required — fail loud rather than store PII in cleartext. */
function masterSecret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET (>=16 chars) is required for personal-data vault encryption');
  }
  return Buffer.from(s, 'utf8');
}

/** Per-user 256-bit key via HKDF-SHA256 (approved KDF), salted by the owner sub so each user's vault uses a distinct key. */
function keyFor(ownerSub: string): Buffer {
  let k = keyCache.get(ownerSub);
  if (!k) {
    k = Buffer.from(crypto.hkdfSync('sha256', masterSecret(), Buffer.from(ownerSub, 'utf8'), Buffer.from('oshal-vault-v1'), 32));
    keyCache.set(ownerSub, k);
  }
  return k;
}

/** True if a stored value is one of our encrypted envelopes (vs legacy plaintext). */
export function isEncrypted(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(ENC_PREFIX);
}

/** True if a stored match_key is already a keyed-HMAC index (64 hex chars) vs legacy plaintext. */
export function isIndexKey(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * @description Encrypt a content field (label / attrs JSON) for at-rest storage.
 * Returns a `v1:`-prefixed base64 envelope (iv|tag|ciphertext). Null/undefined pass through.
 */
export function encryptField(ownerSub: string, plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted — idempotent
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyFor(ownerSub), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * @description Decrypt a stored content field. Legacy plaintext (no `v1:` prefix) is returned
 * unchanged so pre-encryption rows still read; an undecryptable value is returned as-is rather
 * than throwing, so a single bad row never breaks the broker.
 */
export function decryptField(ownerSub: string, stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!isEncrypted(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, keyFor(ownerSub), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return stored;
  }
}

/**
 * @description Deterministic, lookup-preserving, irreversible index for a natural-key match
 * string (e.g. `person|email=a@b.com`). Stored in resolver_index instead of the plaintext key so
 * equality lookups still work while emails/domains/symbols are not readable from a leaked DB.
 */
export function indexKey(ownerSub: string, matchKey: string): string {
  return crypto.createHmac('sha256', keyFor(ownerSub)).update(matchKey, 'utf8').digest('hex');
}
