/**
 * Connector Token Crypto — envelope encryption with a per-user data key (DEK).
 *
 * THE PROBLEM IT FIXES: `oshal_connections` today encrypts every user's access/refresh
 * tokens with ONE legacy key — `SHA256(SESSION_SECRET)`. Leak `SESSION_SECRET` and you decrypt
 * EVERY user's tokens. That doesn't scale to multi-tenant.
 *
 * ENVELOPE MODEL: each user gets a random 32-byte DEK. Their tokens are encrypted with
 * THEIR DEK (AES-256-GCM). The DEK itself is wrapped (encrypted) by the master KEK
 * (versioned HKDF-SHA256 from `SESSION_SECRET`) and stored in `oshal_user_deks`. No single DEK
 * decrypts all users' tokens — compromising one user's DEK exposes only that user. The KEK can be
 * rotated by re-wrapping DEKs without re-encrypting tokens.
 *
 * SAFETY / ROLLOUT:
 *  - Envelope encryption is ON by default (2026-07-20). Set `OSHAL_ENVELOPE_CRYPTO=false` to roll
 *    back to a versioned shared-HKDF blob. When ON, `encryptToken` emits a `v2:`-prefixed
 *    per-user-DEK blob; new writes upgrade automatically on the next re-connect / token refresh.
 *  - `decryptToken` is format-aware REGARDLESS of the flag: a `v2:`-prefixed blob is DEK-
 *    decrypted; an unprefixed legacy (pre-migration, raw-SHA256 KEK) blob remains readable, while
 *    `k2:` shared blobs and `hkdf1:` DEK wrappers use domain-separated HKDF-SHA256. Legacy uses the
 *    SAME SESSION_SECRET it was written under. So turning the flag on does NOT strand any
 *    already-connected user's tokens — they keep reading, and re-encrypt to v2 on next write.
 *  - KEY ABSENCE IS FAIL-LOUD IN EVERY MODE: with `SESSION_SECRET` unset, key derivation THROWS rather
 *    than derive an at-rest key from a hardcoded dev constant. This also applies to the explicit
 *    envelope-off rollback because legacy blobs still require a real secret-derived KEK. It never
 *    silently downgrades to plaintext or a repository-known key.
 *  - Self-contained: re-derives the KEK from SESSION_SECRET; does NOT touch the PKCE/state
 *    crypto in connectors-routes.ts (those stay on the KEK by design — they're not per-user).
 *  - A DEK-store error FAILS CLOSED by default. The only availability fallback is the explicit
 *    `OSHAL_ENVELOPE_DEK_FAILURE=shared-hkdf` break-glass, which is logged and emits `k2:`; there
 *    is no silent downgrade to the legacy raw-SHA256 format.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-user DEK envelope encryption for connector tokens, gated by OSHAL_ENVELOPE_CRYPTO (default off, backward-compatible with legacy single-key blobs).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: kek() now fails loud on a missing SESSION_SECRET in EVERY mode - the crypto-OFF break-glass branch still derived the key from the hardcoded dev constant, i.e. rolling back envelope crypto silently downgraded every user's at-rest tokens to a key any reader of this public repo can compute. There is no legitimate deployment shape where a well-known key beats an explicit failure. Guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Flipped OSHAL_ENVELOPE_CRYPTO default OFF->ON (explicit 'false'/'0'/'no'/'off' = rollback). decryptToken already reads legacy single-key blobs (format-aware) so no already-connected user's tokens are stranded. Made key absence FAIL-LOUD: kek() now throws when SESSION_SECRET is unset AND crypto is ON, instead of silently deriving a weak KEK from the hardcoded dev constant. Dev fallback retained only when crypto is OFF.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Version the KEK boundary: new shared blobs use k2: and new/re-read DEK wrappers use hkdf1:, both derived with domain-separated HKDF-SHA256; unprefixed raw-SHA256 blobs stay readable and legacy DEK wrappers rewrap by compare-and-set on read. DEK-store failure now denies by default, with only an explicit logged OSHAL_ENVELOPE_DEK_FAILURE=shared-hkdf break-glass. Missing DEK rows no longer mint an unrelated key during decrypt.
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

/** Version tag on per-user-DEK token blobs. */
export const CONNECTOR_TOKEN_ENVELOPE_V2 = 'v2:';
/** Version tag on shared-key token blobs using the current HKDF KEK. */
export const CONNECTOR_TOKEN_SHARED_HKDF_V2 = 'k2:';
/** Version tag on stored DEK wrappers using the current HKDF KEK. */
export const CONNECTOR_WRAPPED_DEK_HKDF_V1 = 'hkdf1:';

const KEK_HKDF_SALT = Buffer.from('oshal:connector-token:kek:salt:v1', 'utf8');
const KEK_HKDF_INFO = Buffer.from('oshal:connector-token:kek:wrap-and-shared:v1', 'utf8');

/** True when envelope encryption is enabled. Default ON; explicit false/0/no/off = rollback. */
export function envelopeEnabled(): boolean {
  const v = (process.env.OSHAL_ENVELOPE_CRYPTO ?? 'true').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}

/** DEK-store failure posture: deny by default; only an exact shared-hkdf value enables fallback. */
export function envelopeDekFailureMode(env: NodeJS.ProcessEnv = process.env): 'deny' | 'shared-hkdf' {
  return String(env.OSHAL_ENVELOPE_DEK_FAILURE ?? '').trim().toLowerCase() === 'shared-hkdf'
    ? 'shared-hkdf'
    : 'deny';
}

/**
 * Resolve the mandatory master secret. Key derivation is version-specific below.
 * FAIL-LOUD on key absence in EVERY mode: SESSION_SECRET unset throws rather than deriving the
 * KEK from a hardcoded dev constant — that would wrap every user's DEK (and every legacy token)
 * under a key any reader of this public repo can compute, i.e. no real at-rest protection. The
 * historical crypto-OFF break-glass fallback was removed 2026-07-31 (SECURITY-HARDENING 3.1/9):
 * a box without the secret cannot decrypt real data anyway, so the only thing the fallback ever
 * enabled was silently WRITING new secrets under a public key. Never downgrades to plaintext.
 */
function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'connector-token-crypto: SESSION_SECRET is unset — refusing to derive an at-rest key from a hardcoded dev constant (the dev fallback was removed; docs/security/SECURITY-HARDENING.md 3.1/9). Set SESSION_SECRET.',
    );
  }
  return secret;
}

/** Historical raw-SHA256 KEK, retained only to read pre-versioned blobs during migration. */
function legacyKek(env: NodeJS.ProcessEnv = process.env): Buffer {
  return crypto.createHash('sha256').update(sessionSecret(env)).digest();
}

/** Current domain-separated HKDF-SHA256 KEK used for all new wrappers/shared blobs. */
function currentKek(env: NodeJS.ProcessEnv = process.env): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(sessionSecret(env), 'utf8'), KEK_HKDF_SALT, KEK_HKDF_INFO, 32),
  );
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
  const parts = String(blob).split(':');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('connector-token-crypto: invalid encrypted blob format');
  }
  const [iv, tag, enc] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]);
}

/** Encrypt a shared-key token in the current, explicitly versioned HKDF format. */
function encryptSharedToken(plain: string): string {
  return CONNECTOR_TOKEN_SHARED_HKDF_V2 + gcmEncrypt(currentKek(), plain);
}

/** Unwrap a DEK and report whether its legacy wrapper should be migrated. */
function unwrapStoredDek(wrapped: string): { dek: Buffer; legacy: boolean } {
  if (wrapped.startsWith(CONNECTOR_WRAPPED_DEK_HKDF_V1)) {
    return {
      dek: gcmDecrypt(currentKek(), wrapped.slice(CONNECTOR_WRAPPED_DEK_HKDF_V1.length)),
      legacy: false,
    };
  }
  return { dek: gcmDecrypt(legacyKek(), wrapped), legacy: true };
}

/** Wrap a DEK under the current domain-separated KEK. */
function wrapCurrentDek(dek: Buffer): string {
  return CONNECTOR_WRAPPED_DEK_HKDF_V1 + gcmEncrypt(currentKek(), dek);
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
 * @description Get (and optionally lazily create) a user's DEK, unwrapped to raw 32 bytes. The
 * stored form is KEK-wrapped; legacy wrappers are rewrapped by compare-and-set on read. Concurrent first-use is race-safe via
 * INSERT ... ON CONFLICT DO NOTHING then re-read.
 * @param pool - pg pool
 * @param userSub - the connection owner's OIDC sub
 * @param createIfMissing - Whether a missing row may be created (false on decrypt).
 * @returns the user's 32-byte DEK
 */
async function getUserDek(pool: QueryablePool, userSub: string, createIfMissing: boolean): Promise<Buffer> {
  const existing = (await pool.query('SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub = $1', [userSub])).rows[0];
  if (existing) {
    const stored = String(existing.wrapped_dek);
    const unwrapped = unwrapStoredDek(stored);
    if (unwrapped.legacy) {
      const upgraded = wrapCurrentDek(unwrapped.dek);
      try {
        await pool.query(
          'UPDATE oshal_user_deks SET wrapped_dek = $2 WHERE user_sub = $1 AND wrapped_dek = $3',
          [userSub, upgraded, stored],
        );
      } catch (err) {
        // Migration is best-effort after successful legacy decrypt. Do not strand a token merely
        // because the caller can read but not update; the next privileged read can retry.
        logger.warn({ err, userSub }, 'Legacy connector DEK wrapper could not be upgraded');
      }
    }
    return unwrapped.dek;
  }
  if (!createIfMissing) {
    throw new Error(`connector-token-crypto: no DEK row for user ${userSub}`);
  }
  const dek = crypto.randomBytes(32);
  const wrapped = wrapCurrentDek(dek);
  await pool.query(
    'INSERT INTO oshal_user_deks (user_sub, wrapped_dek) VALUES ($1, $2) ON CONFLICT (user_sub) DO NOTHING',
    [userSub, wrapped],
  );
  // A racing request may have inserted first — re-read so everyone shares one DEK.
  const row = (await pool.query('SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub = $1', [userSub])).rows[0];
  if (!row) {
    throw new Error(`connector-token-crypto: DEK insert for user ${userSub} was not readable`);
  }
  return unwrapStoredDek(String(row.wrapped_dek)).dek;
}

/**
 * @description Encrypt a connector token for at-rest storage. With the flag ON and a userSub
 * present, uses the user's DEK and emits a `v2:`-prefixed blob. Otherwise emits a versioned
 * `k2:` shared-HKDF blob. Unprefixed raw-SHA256 blobs are read-only legacy compatibility.
 * @param pool - pg pool (needed only for the DEK path)
 * @param userSub - the token owner's OIDC sub
 * @param plain - the plaintext token
 * @returns the at-rest blob
 */
export async function encryptToken(pool: QueryablePool, userSub: string | undefined, plain: string): Promise<string> {
  if (!envelopeEnabled() || !userSub) return encryptSharedToken(plain);
  // Resolve the master key FIRST: currentKek() fail-louds here if SESSION_SECRET is unset,
  // so key absence throws before we ever mint a DEK or fall back — never a silent downgrade.
  currentKek();
  try {
    const dek = await getUserDek(pool, userSub, true);
    return CONNECTOR_TOKEN_ENVELOPE_V2 + gcmEncrypt(dek, plain);
  } catch (err) {
    if (envelopeDekFailureMode() === 'shared-hkdf') {
      logger.error({ err, userSub }, 'encryptToken: DEK path failed; explicit shared-HKDF break-glass engaged');
      return encryptSharedToken(plain);
    }
    logger.error({ err, userSub }, 'encryptToken: DEK path failed; denying write');
    const failure = new Error('connector-token-crypto: DEK path failed; token write denied');
    (failure as Error & { cause?: unknown }).cause = err;
    throw failure;
  }
}

/**
 * @description Decrypt a connector token. Format-aware regardless of the flag: a `v2:` blob
 * is DEK-decrypted (for the given user); `k2:` uses the current shared HKDF key; an unprefixed
 * legacy blob uses the historical raw-SHA256 key. This keeps staged migrations readable.
 * @param pool - pg pool (needed only for the DEK path)
 * @param userSub - the token owner's OIDC sub
 * @param blob - the at-rest blob
 * @returns the plaintext token
 */
export async function decryptToken(pool: QueryablePool, userSub: string | undefined, blob: string): Promise<string> {
  if (blob.startsWith(CONNECTOR_TOKEN_ENVELOPE_V2)) {
    if (!userSub) throw new Error('decryptToken: v2 blob requires a userSub');
    // Validate master-key availability before touching the DEK store. Otherwise a missing row can
    // mask the more fundamental key-provisioning failure and produce a misleading recovery path.
    currentKek();
    const dek = await getUserDek(pool, userSub, false);
    return gcmDecrypt(dek, blob.slice(CONNECTOR_TOKEN_ENVELOPE_V2.length)).toString('utf8');
  }
  if (blob.startsWith(CONNECTOR_TOKEN_SHARED_HKDF_V2)) {
    return gcmDecrypt(currentKek(), blob.slice(CONNECTOR_TOKEN_SHARED_HKDF_V2.length)).toString('utf8');
  }
  return gcmDecrypt(legacyKek(), blob).toString('utf8');
}
