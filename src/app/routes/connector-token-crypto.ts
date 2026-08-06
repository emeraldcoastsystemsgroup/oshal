/**
 * Connector Token Crypto — envelope encryption with a per-user data key (DEK).
 *
 * THE PROBLEM IT FIXES: `oshal_connections` today encrypts every user's access/refresh
 * tokens with ONE key — `SHA256(SESSION_SECRET)`. Leak `SESSION_SECRET` and you decrypt
 * EVERY user's tokens. That doesn't scale to multi-tenant.
 *
 * ENVELOPE MODEL: each user gets a random 32-byte DEK. Their tokens are encrypted with
 * THEIR DEK (AES-256-GCM). The DEK itself is wrapped (encrypted) by the master KEK
 * (`SHA256(SESSION_SECRET)`) and stored in `oshal_user_deks`. No single key decrypts all
 * users' tokens — compromising one user's DEK exposes only that user. The KEK can be
 * rotated by re-wrapping DEKs without re-encrypting tokens.
 *
 * SAFETY / ROLLOUT:
 *  - Envelope encryption is ON by default (2026-07-20). Set `OSHAL_ENVELOPE_CRYPTO=false` to roll
 *    back to the legacy single-key behavior. When ON, `encryptToken` emits a `v2:`-prefixed
 *    per-user-DEK blob; new writes upgrade automatically on the next re-connect / token refresh.
 *  - `decryptToken` is format-aware REGARDLESS of the flag: a `v2:`-prefixed blob is DEK-
 *    decrypted; an unprefixed legacy (pre-migration, single-KEK) blob is KEK-decrypted with the
 *    SAME SESSION_SECRET it was written under. So turning the flag on does NOT strand any
 *    already-connected user's tokens — they keep reading, and re-encrypt to v2 on next write.
 *  - KEY ABSENCE IS FAIL-LOUD IN EVERY MODE: with `SESSION_SECRET` unset, `kek()` THROWS rather
 *    than derive an at-rest key from a hardcoded dev constant. This also applies to the explicit
 *    envelope-off rollback because legacy blobs still require a real secret-derived KEK. It never
 *    silently downgrades to plaintext or a repository-known key.
 *  - Self-contained: re-derives the KEK from SESSION_SECRET; does NOT touch the PKCE/state
 *    crypto in connectors-routes.ts (those stay on the KEK by design — they're not per-user).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-user DEK envelope encryption for connector tokens, gated by OSHAL_ENVELOPE_CRYPTO (default off, backward-compatible with legacy single-key blobs).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: kek() now fails loud on a missing SESSION_SECRET in EVERY mode - the crypto-OFF break-glass branch still derived the key from the hardcoded dev constant, i.e. rolling back envelope crypto silently downgraded every user's at-rest tokens to a key any reader of this public repo can compute. There is no legitimate deployment shape where a well-known key beats an explicit failure. Guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Flipped OSHAL_ENVELOPE_CRYPTO default OFF->ON (explicit 'false'/'0'/'no'/'off' = rollback). decryptToken already reads legacy single-key blobs (format-aware) so no already-connected user's tokens are stranded. Made key absence FAIL-LOUD: kek() now throws when SESSION_SECRET is unset AND crypto is ON, instead of silently deriving a weak KEK from the hardcoded dev constant. Dev fallback retained only when crypto is OFF.
 *
 * @module connector-token-crypto
 */
import crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

const logger = createChildLogger({ module: 'connector-token-crypto' });

/** Minimal pool contract (avoids importing pg types here). */
interface QueryablePool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Version tag on envelope (DEK) blobs. Legacy blobs have no prefix. */
const V2 = 'v2:';

/** True when envelope encryption is enabled. Default ON; explicit false/0/no/off = rollback. */
export function envelopeEnabled(): boolean {
  const v = (process.env.OSHAL_ENVELOPE_CRYPTO ?? 'true').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}

/**
 * Master key-encryption-key — SHA256(SESSION_SECRET). Wraps DEKs (and decrypts legacy tokens).
 * FAIL-LOUD on key absence in EVERY mode: SESSION_SECRET unset throws rather than deriving the
 * KEK from a hardcoded dev constant — that would wrap every user's DEK (and every legacy token)
 * under a key any reader of this public repo can compute, i.e. no real at-rest protection. The
 * historical crypto-OFF break-glass fallback was removed 2026-07-31 (SECURITY-HARDENING 3.1/9):
 * a box without the secret cannot decrypt real data anyway, so the only thing the fallback ever
 * enabled was silently WRITING new secrets under a public key. Never downgrades to plaintext.
 */
function kek(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'connector-token-crypto: SESSION_SECRET is unset — refusing to derive an at-rest key from a hardcoded dev constant (the dev fallback was removed; docs/security/SECURITY-HARDENING.md 3.1/9). Set SESSION_SECRET.',
    );
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/** AES-256-GCM encrypt → `iv:tag:cipher` (base64). Mirrors the legacy format exactly. */
function gcmEncrypt(key: Buffer, plain: Buffer | string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain as crypto.BinaryLike), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** AES-256-GCM decrypt of an `iv:tag:cipher` blob → raw bytes. */
function gcmDecrypt(key: Buffer, blob: string): Buffer {
  const [iv, tag, enc] = blob.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]);
}

/**
 * @description Create the per-user DEK table if absent. Call once at boot alongside the
 * connections schema. Safe to call repeatedly.
 * @param pool - pg pool
 */
export async function ensureDekSchema(pool: QueryablePool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool: pool as never,
    moduleName: 'connector token crypto',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_user_deks (
        user_sub TEXT PRIMARY KEY,
        wrapped_dek TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    requirements: [
      { table: 'oshal_user_deks', columns: ['user_sub', 'wrapped_dek', 'created_at'] },
    ],
  });
}

/**
 * @description Get (or lazily create) a user's DEK, unwrapped to raw 32 bytes. The stored
 * form is KEK-wrapped; we unwrap on read. Concurrent first-use is race-safe via
 * INSERT ... ON CONFLICT DO NOTHING then re-read.
 * @param pool - pg pool
 * @param userSub - the connection owner's OIDC sub
 * @returns the user's 32-byte DEK
 */
async function getUserDek(pool: QueryablePool, userSub: string): Promise<Buffer> {
  const existing = (await pool.query('SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub = $1', [userSub])).rows[0];
  if (existing) return gcmDecrypt(kek(), String(existing.wrapped_dek));
  const dek = crypto.randomBytes(32);
  const wrapped = gcmEncrypt(kek(), dek);
  await pool.query(
    'INSERT INTO oshal_user_deks (user_sub, wrapped_dek) VALUES ($1, $2) ON CONFLICT (user_sub) DO NOTHING',
    [userSub, wrapped],
  );
  // A racing request may have inserted first — re-read so everyone shares one DEK.
  const row = (await pool.query('SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub = $1', [userSub])).rows[0];
  return row ? gcmDecrypt(kek(), String(row.wrapped_dek)) : dek;
}

/**
 * @description Encrypt a connector token for at-rest storage. With the flag ON and a userSub
 * present, uses the user's DEK and emits a `v2:`-prefixed blob. Otherwise emits the legacy
 * KEK blob (no prefix) — identical to the prior behavior.
 * @param pool - pg pool (needed only for the DEK path)
 * @param userSub - the token owner's OIDC sub
 * @param plain - the plaintext token
 * @returns the at-rest blob
 */
export async function encryptToken(pool: QueryablePool, userSub: string | undefined, plain: string): Promise<string> {
  if (!envelopeEnabled() || !userSub) return gcmEncrypt(kek(), plain);
  // Resolve the master key FIRST: kek() fail-louds here if SESSION_SECRET is unset (crypto ON),
  // so key absence throws before we ever mint a DEK or fall back — never a silent downgrade.
  const master = kek();
  try {
    const dek = await getUserDek(pool, userSub);
    return V2 + gcmEncrypt(dek, plain);
  } catch (err) {
    // A TRANSIENT DEK-path failure (e.g. a DB blip minting/reading the wrapped DEK) must not fail
    // the connection — fall back to the legacy KEK blob. That is still real AES-256-GCM at-rest
    // crypto under SESSION_SECRET (NOT plaintext), and decryptToken reads it. Key absence already
    // threw above, so this fallback never runs without a real key.
    logger.error({ err, userSub }, 'encryptToken: DEK path failed, falling back to legacy KEK');
    return gcmEncrypt(master, plain);
  }
}

/**
 * @description Decrypt a connector token. Format-aware regardless of the flag: a `v2:` blob
 * is DEK-decrypted (for the given user); a legacy blob is KEK-decrypted. This lets the flag
 * be toggled without stranding tokens.
 * @param pool - pg pool (needed only for the DEK path)
 * @param userSub - the token owner's OIDC sub
 * @param blob - the at-rest blob
 * @returns the plaintext token
 */
export async function decryptToken(pool: QueryablePool, userSub: string | undefined, blob: string): Promise<string> {
  if (blob.startsWith(V2)) {
    if (!userSub) throw new Error('decryptToken: v2 blob requires a userSub');
    const dek = await getUserDek(pool, userSub);
    return gcmDecrypt(dek, blob.slice(V2.length)).toString('utf8');
  }
  return gcmDecrypt(kek(), blob).toString('utf8');
}
