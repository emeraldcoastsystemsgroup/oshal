#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add one format-aware connector-token codec for
 *   | every Node CLI: v2 per-user envelopes, hkdf1 DEK wrappers, k2 shared-HKDF blobs, and
 *   | read-only compatibility with unprefixed raw-SHA256 legacy blobs. New writes stay per-user.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Match the TypeScript policy boundary: honor the
 *   | explicit envelope-off rollback with k2 writes, deny DEK-store failures by default, allow only
 *   | the logged shared-hkdf break-glass, and compare-and-set legacy DEK wrappers to hkdf1 on read.
 *
 * This CommonJS module deliberately mirrors src/app/routes/connector-token-crypto.ts. CLI tools
 * run as plain Node inside the API image and cannot import TypeScript source at runtime; keeping
 * the constants and derivation vectors here explicit lets parity tests detect any future drift.
 */
'use strict';

const crypto = require('crypto');

const TOKEN_ENVELOPE_V2 = 'v2:';
const TOKEN_SHARED_HKDF_V2 = 'k2:';
const WRAPPED_DEK_HKDF_V1 = 'hkdf1:';
const KEK_HKDF_SALT = Buffer.from('oshal:connector-token:kek:salt:v1', 'utf8');
const KEK_HKDF_INFO = Buffer.from('oshal:connector-token:kek:wrap-and-shared:v1', 'utf8');

/** Resolve the required master secret without any repository-known fallback. */
function sessionSecret(env = process.env) {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is required - the hardcoded dev-key fallback was removed ' +
      '(docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all',
    );
  }
  return secret;
}

/** Historical raw-SHA256 KEK. Exported only for legacy-fixture compatibility tests. */
function legacyKey(env = process.env) {
  return crypto.createHash('sha256').update(sessionSecret(env)).digest();
}

/** Current domain-separated HKDF-SHA256 KEK. */
function currentKey(env = process.env) {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(sessionSecret(env), 'utf8'),
      KEK_HKDF_SALT,
      KEK_HKDF_INFO,
      32,
    ),
  );
}

/** Envelope encryption is enabled by default; only explicit false-like values roll it back. */
function envelopeEnabled(env = process.env) {
  const value = String(env.OSHAL_ENVELOPE_CRYPTO ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

/** DEK-store errors deny by default; this exact value is the sole break-glass posture. */
function envelopeDekFailureMode(env = process.env) {
  return String(env.OSHAL_ENVELOPE_DEK_FAILURE ?? '').trim().toLowerCase() === 'shared-hkdf'
    ? 'shared-hkdf'
    : 'deny';
}

/** AES-256-GCM encrypt to the stable iv:tag:cipher base64 payload. */
function gcmEncryptRaw(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const input = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64')).join(':');
}

/** AES-256-GCM decrypt with an explicit format guard. */
function gcmDecryptRaw(key, blob) {
  const parts = String(blob).split(':');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('connector-token-crypto: invalid encrypted blob format');
  }
  const [iv, tag, encrypted] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
}

/** Unwrap either the current hkdf1 format or an unprefixed legacy DEK wrapper. */
function unwrapDek(wrapped) {
  const value = String(wrapped);
  if (value.startsWith(WRAPPED_DEK_HKDF_V1)) {
    return gcmDecryptRaw(currentKey(), value.slice(WRAPPED_DEK_HKDF_V1.length));
  }
  return gcmDecryptRaw(legacyKey(), value);
}

/** Unwrap a DEK and preserve whether its wrapper needs a one-way format upgrade. */
function unwrapDekWithFormat(wrapped) {
  const value = String(wrapped);
  return {
    dek: unwrapDek(value),
    legacy: !value.startsWith(WRAPPED_DEK_HKDF_V1),
  };
}

/** Wrap a raw DEK with the current versioned KEK. */
function wrapDek(dek) {
  return WRAPPED_DEK_HKDF_V1 + gcmEncryptRaw(currentKey(), dek);
}

/**
 * Read (and optionally create) the caller-owned DEK. Decrypt never creates a replacement for a
 * missing row: doing so would turn a clear configuration/data-loss error into an opaque GCM error.
 */
async function userDek(pool, userSub, options = {}) {
  if (!userSub) throw new Error('connector-token-crypto: userSub is required for a DEK');
  const createIfMissing = options.createIfMissing === true;
  const selected = await pool.query(
    'SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub = $1',
    [userSub],
  );
  if (selected.rows[0]) {
    const stored = String(selected.rows[0].wrapped_dek);
    const unwrapped = unwrapDekWithFormat(stored);
    if (unwrapped.legacy) {
      const upgraded = wrapDek(unwrapped.dek);
      try {
        await pool.query(
          'UPDATE oshal_user_deks SET wrapped_dek = $2 WHERE user_sub = $1 AND wrapped_dek = $3',
          [userSub, upgraded, stored],
        );
      } catch (error) {
        // A successful read remains usable when this caller cannot perform the best-effort
        // migration. A privileged reader can retry the compare-and-set later.
        console.error(
          `connector-token-crypto: legacy DEK wrapper upgrade failed for ${userSub}: ` +
          ((error && error.message) || String(error)),
        );
      }
    }
    return unwrapped.dek;
  }
  if (!createIfMissing) {
    throw new Error(`no DEK row in oshal_user_deks for user ${userSub} (v2 blob but DEK missing)`);
  }

  const candidate = crypto.randomBytes(32);
  await pool.query(
    'INSERT INTO oshal_user_deks (user_sub, wrapped_dek) VALUES ($1, $2) ON CONFLICT (user_sub) DO NOTHING',
    [userSub, wrapDek(candidate)],
  );
  const reread = await pool.query(
    'SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub = $1',
    [userSub],
  );
  if (!reread.rows[0]) {
    throw new Error(`connector-token-crypto: DEK insert for user ${userSub} was not readable`);
  }
  return unwrapDek(reread.rows[0].wrapped_dek);
}

/** Decrypt v2/k2/legacy connector-token formats. */
async function decryptToken(pool, userSub, blob) {
  const value = String(blob);
  if (value.startsWith(TOKEN_ENVELOPE_V2)) {
    // Fail on missing master-key material before a DEK lookup can mask the provisioning error.
    currentKey();
    const dek = await userDek(pool, userSub, { createIfMissing: false });
    return gcmDecryptRaw(dek, value.slice(TOKEN_ENVELOPE_V2.length)).toString('utf8');
  }
  if (value.startsWith(TOKEN_SHARED_HKDF_V2)) {
    return gcmDecryptRaw(currentKey(), value.slice(TOKEN_SHARED_HKDF_V2.length)).toString('utf8');
  }
  return gcmDecryptRaw(legacyKey(), value).toString('utf8');
}

/** Encrypt under the caller's DEK; explicit rollback/unowned writes use versioned shared HKDF. */
async function encryptToken(pool, userSub, plain) {
  if (!envelopeEnabled() || !userSub) {
    return TOKEN_SHARED_HKDF_V2 + gcmEncryptRaw(currentKey(), plain);
  }
  // Resolve the mandatory master key before touching the DEK store. Missing key material must
  // never be mistaken for a store outage eligible for the explicit availability break-glass.
  currentKey();
  try {
    const dek = await userDek(pool, userSub, { createIfMissing: true });
    return TOKEN_ENVELOPE_V2 + gcmEncryptRaw(dek, plain);
  } catch (error) {
    if (envelopeDekFailureMode() === 'shared-hkdf') {
      console.error(
        `connector-token-crypto: DEK path failed for ${userSub}; explicit shared-hkdf break-glass engaged: ` +
        ((error && error.message) || String(error)),
      );
      return TOKEN_SHARED_HKDF_V2 + gcmEncryptRaw(currentKey(), plain);
    }
    const failure = new Error('connector-token-crypto: DEK path failed; token write denied');
    failure.cause = error;
    throw failure;
  }
}

module.exports = {
  TOKEN_ENVELOPE_V2,
  TOKEN_SHARED_HKDF_V2,
  WRAPPED_DEK_HKDF_V1,
  legacyKey,
  currentKey,
  envelopeEnabled,
  envelopeDekFailureMode,
  gcmEncryptRaw,
  gcmDecryptRaw,
  wrapDek,
  unwrapDek,
  unwrapDekWithFormat,
  userDek,
  decryptToken,
  encryptToken,
};
