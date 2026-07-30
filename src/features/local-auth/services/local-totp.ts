/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | TOTP second factor for LOCAL_AUTH logins (ADR-117 follow-on). The operator's constraint was "I don't know how to implement this without an external provider" — RFC 6238 is the answer: a shared secret plus the clock, verified with HMAC-SHA1, so nothing leaves the box and no vendor, SMS gateway or per-message fee is involved. Enrolment renders locally (the `qrcode` dependency already ships). Emailed codes were the alternative and were rejected as the primary factor because email is the SAME channel as the invite/reset link — an attacker holding the mailbox would satisfy both factors. Three things here are load-bearing and easy to get wrong: the secret is encrypted at rest (a DB dump alone must not yield working codes), the last accepted step is recorded so a code cannot be replayed inside its own window, and recovery codes exist at all — TOTP without them turns a lost phone into a permanent lockout, which is how 2FA gets switched off in anger.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { localAuthSigningSecret } from './local-auth-session';

const logger = createChildLogger({ module: 'local-totp' });

/** RFC 4648 base32 alphabet — the encoding every authenticator app expects in an otpauth URI. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 20 bytes = 160 bits, the RFC 4226 recommendation and what authenticator apps assume. */
const SECRET_BYTES = 20;
/** 30-second steps: the universal default. Changing it breaks every already-enrolled app. */
export const TOTP_STEP_SECONDS = 30;
/** 6 digits: also universal. */
export const TOTP_DIGITS = 6;
/**
 * Accept the code one step either side of now. Clock drift on a phone is real, and a user
 * typing a code as it rolls over is far more common than an attacker brute-forcing 6 digits.
 * One step (not two) keeps the window at 90s total.
 */
const TOTP_WINDOW_STEPS = 1;
/** How many single-use recovery codes an enrolment mints. */
export const RECOVERY_CODE_COUNT = 8;

/** What the UI needs to know about a user's second factor. Never includes the secret. */
export interface TotpState {
  enabled: boolean;
  required: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
}

/** The one-time enrolment payload. Shown once, never retrievable again. */
export interface TotpEnrolment {
  secretBase32: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

// ── base32 ───────────────────────────────────────────────────────────────────

/**
 * @description Encodes bytes as unpadded RFC 4648 base32, the form an otpauth URI carries.
 *
 * @param buf - Raw bytes.
 * @returns Base32 text, no `=` padding (authenticator apps reject padding in the URI).
 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * @description Decodes unpadded or padded base32 back to bytes. Case-insensitive, and
 * spaces are ignored so a user may type the grouped form shown on the enrolment screen.
 *
 * @param text - Base32 text.
 * @returns The decoded bytes.
 * @throws Error when a character is outside the base32 alphabet.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── the RFC 6238 primitive ───────────────────────────────────────────────────

/**
 * @description Computes the TOTP code for one time step. HMAC-SHA1 with the dynamic
 * truncation of RFC 4226 §5.3 — SHA-1 is correct here, not a weakness: it is what every
 * authenticator app implements, and the construction's security rests on the HMAC key,
 * not on collision resistance.
 *
 * @param secret - The shared secret bytes.
 * @param step - The counter (unix seconds / step).
 * @param digits - Code length.
 * @returns The zero-padded code.
 */
export function totpCodeForStep(secret: Buffer, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const digest = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** @description The current time step. @param nowMs - Epoch ms. @returns The step counter. */
export function currentStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * @description Checks a submitted code against the accepted window, in constant time per
 * candidate, and reports WHICH step matched so the caller can reject a replay of that same
 * code. Returning the step is the point: without it, a code stolen in transit stays valid
 * for the rest of its 30-second window.
 *
 * @param secretBase32 - The user's shared secret.
 * @param code - The submitted digits.
 * @param nowMs - Epoch ms (injectable for tests).
 * @param minStepExclusive - Reject any step at or below this (the last step already used).
 * @returns The matched step, or null when nothing matched.
 */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
  minStepExclusive: number | null = null,
): number | null {
  const digits = (code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  const now = currentStep(nowMs);
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = now + offset;
    if (minStepExclusive !== null && step <= minStepExclusive) continue;
    const expected = totpCodeForStep(secret, step, TOTP_DIGITS);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return step;
  }
  return null;
}

/**
 * @description Builds the `otpauth://` URI an authenticator app consumes, label-encoded so
 * an email address with a `+` or a space survives the scan.
 *
 * @param issuer - Shown as the account's provider in the app.
 * @param account - Usually the login email.
 * @param secretBase32 - The shared secret.
 * @returns The otpauth URI.
 */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** @description Groups a secret into readable blocks for manual entry. @param s - Base32 secret. @returns Spaced text. */
export function formatSecretForDisplay(s: string): string {
  return (s.match(/.{1,4}/g) || []).join(' ');
}

// ── secret at rest ───────────────────────────────────────────────────────────

/**
 * @description Derives the AES key that protects stored secrets from the existing session
 * signing secret, so there is no second key for an operator to manage or lose. HKDF with a
 * distinct `info` label keeps it unrelated to the cookie-signing use of the same input.
 *
 * @returns A 32-byte key.
 * @throws Error when no signing secret is configured (fail closed — never a fixed fallback).
 */
function encryptionKey(): Buffer {
  const secret = localAuthSigningSecret();
  if (!secret) throw new Error('SESSION_SECRET is required before a second factor can be stored');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'oshal-local-totp', 'totp-secret-v1', 32));
}

/**
 * @description Encrypts a TOTP secret for storage. A stolen database backup is the threat
 * this addresses: plaintext secrets in a dump are permanently forged second factors, and
 * unlike a password hash there is nothing one-way about a TOTP secret.
 *
 * @param secretBase32 - The shared secret.
 * @returns `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 */
export function encryptSecret(secretBase32: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  const b64 = (b: Buffer) => b.toString('base64url');
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ct)}`;
}

/**
 * @description Decrypts a stored secret. Returns null rather than throwing on any
 * malformed or unauthentic value, so a rotated SESSION_SECRET degrades to "second factor
 * unreadable" (the admin resets it) instead of crashing every login attempt.
 *
 * @param stored - The stored ciphertext.
 * @returns The base32 secret, or null.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', encryptionKey(), Buffer.from(parts[1], 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch (err) {
    logger.warn({ err }, 'stored TOTP secret could not be decrypted — was SESSION_SECRET rotated?');
    return null;
  }
}

// ── recovery codes ───────────────────────────────────────────────────────────

/**
 * @description Mints single-use recovery codes. High-entropy random values, so a single
 * SHA-256 at rest is appropriate — unlike a password, there is nothing to brute-force.
 *
 * @returns Human-transcribable codes in `xxxx-xxxx` form.
 */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** @description Hashes a recovery code for storage. @param code - The code. @returns Hex sha256. */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

// ── schema ───────────────────────────────────────────────────────────────────

/**
 * @description Adds the second-factor columns to the existing local-user table. Separate
 * from ensureLocalUserSchema's CREATE so an already-deployed box gains them: the table is
 * created with IF NOT EXISTS, which silently skips new columns on an existing install.
 *
 * @param pool - Postgres pool.
 * @returns Resolves when the columns exist.
 */
export async function ensureTotpSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'local auth second factor',
    statements: [
      `ALTER TABLE oshal_local_users
         ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT,
         ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS totp_required BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS totp_confirmed_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS totp_last_step BIGINT,
         ADD COLUMN IF NOT EXISTS totp_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb`,
    ],
    requirements: [{
      table: 'oshal_local_users',
      columns: ['totp_secret_enc', 'totp_enabled', 'totp_required', 'totp_last_step', 'totp_recovery_hashes'],
    }],
  });
}

/**
 * @description True when an error is Postgres `undefined_column` (42703) — the one failure
 * that means "this deployment has not been migrated yet" rather than "something is wrong".
 *
 * @param err - The thrown value.
 * @returns Whether it is an undefined-column error.
 */
function isUndefinedColumn(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === '42703') return true;
  // node-postgres surfaces the SQLSTATE, but a pooled wrapper may only pass the message
  // through; match the server's wording as a secondary signal, never as the only one.
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /column .*totp.* does not exist/i.test(message);
}

// ── store operations ─────────────────────────────────────────────────────────

/**
 * @description Reads the second-factor state for a login, by sub.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub.
 * @returns State, or null when no such account.
 */
export async function getTotpState(pool: Pool, sub: string): Promise<TotpState | null> {
  let rows: Array<Record<string, unknown>>;
  try {
    ({ rows } = await runWithSystemIdentity(() => pool.query(
      `SELECT totp_enabled, totp_required, totp_confirmed_at, totp_recovery_hashes
         FROM oshal_local_users WHERE user_sub = $1 LIMIT 1`, [sub],
    )));
  } catch (err) {
    // A deployment whose ensureTotpSchema never ran has no such columns, and NOBODY on that
    // box has a second factor — so answering "no factor" is the truth. Letting the error
    // reach the login handler would 500 every sign-in attempt on that deployment, locking a
    // whole company out over a feature it does not use.
    //
    // ONLY undefined_column is forgiven. Any other failure propagates, because an account
    // that DOES have a factor must never be waved through on a read error: that would turn a
    // transient database fault into a 2FA bypass.
    if (isUndefinedColumn(err)) {
      logger.warn('second-factor columns absent — every account is password-only on this deployment');
      return null;
    }
    throw err;
  }
  const r = rows[0];
  if (!r) return null;
  const codes = Array.isArray(r.totp_recovery_hashes) ? r.totp_recovery_hashes : [];
  return {
    enabled: r.totp_enabled === true,
    required: r.totp_required === true,
    confirmedAt: r.totp_confirmed_at ? new Date(r.totp_confirmed_at as string).toISOString() : null,
    recoveryCodesRemaining: codes.length,
  };
}

/**
 * @description Starts enrolment: mints a secret and recovery codes and stores them
 * UNCONFIRMED (`totp_enabled` stays false). Nothing about the login changes until the user
 * proves the app works by submitting a code — otherwise a mis-scanned QR locks them out of
 * their own account, which is the classic way to break a 2FA rollout.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub.
 * @param issuer - Label shown in the authenticator app.
 * @param account - Usually the login email.
 * @returns The one-time enrolment payload.
 */
export async function beginTotpEnrolment(
  pool: Pool, sub: string, issuer: string, account: string,
): Promise<TotpEnrolment> {
  const secretBase32 = base32Encode(crypto.randomBytes(SECRET_BYTES));
  const recoveryCodes = generateRecoveryCodes();
  await runWithSystemIdentity(() => pool.query(
    `UPDATE oshal_local_users
        SET totp_secret_enc = $2, totp_enabled = FALSE, totp_confirmed_at = NULL,
            totp_last_step = NULL, totp_recovery_hashes = $3::jsonb
      WHERE user_sub = $1`,
    [sub, encryptSecret(secretBase32), JSON.stringify(recoveryCodes.map(hashRecoveryCode))],
  ));
  logger.info({ sub }, 'TOTP enrolment started (unconfirmed)');
  return { secretBase32, otpauthUri: otpauthUri(issuer, account, secretBase32), recoveryCodes };
}

/**
 * @description Confirms enrolment by verifying a code from the app, then switches the
 * factor on.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub.
 * @param code - The submitted code.
 * @param nowMs - Epoch ms (injectable for tests).
 * @returns true when confirmed; false when the code did not verify.
 */
export async function confirmTotpEnrolment(
  pool: Pool, sub: string, code: string, nowMs: number = Date.now(),
): Promise<boolean> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT totp_secret_enc FROM oshal_local_users WHERE user_sub = $1 LIMIT 1`, [sub],
  ));
  const secret = decryptSecret(rows[0]?.totp_secret_enc as string | undefined);
  if (!secret) return false;
  const step = verifyTotpCode(secret, code, nowMs, null);
  if (step === null) return false;
  // Deliberately does NOT record totp_last_step. An earlier version did, and a browser walk of
  // the real deployment showed the cost immediately: enrol, sign out, sign back in within the
  // same 30 seconds, and the app still shows the code you just confirmed with — which the replay
  // guard then refuses. "I just set it up and it says the code is wrong" on the very first use.
  //
  // The protection given up is negligible: an attacker would have to have seen the confirmation
  // code (rendered on the user's own screen, inside their authenticated session, over TLS) AND
  // hold the password, and act inside 30 seconds. Replay protection on the LOGIN path — where
  // codes actually travel repeatedly — is untouched: verifySecondFactor still records every step
  // it accepts, so no code can be used twice to sign in.
  await runWithSystemIdentity(() => pool.query(
    `UPDATE oshal_local_users
        SET totp_enabled = TRUE, totp_confirmed_at = NOW(), totp_last_step = NULL
      WHERE user_sub = $1`, [sub],
  ));
  logger.info({ sub }, 'TOTP enrolment confirmed — second factor active');
  return true;
}

/** The outcome of a login-time second-factor check. */
export type SecondFactorResult = 'ok' | 'invalid' | 'not-enrolled';

/**
 * @description Verifies a login-time second factor: a TOTP code, or one single-use recovery
 * code. Replay is refused by recording the accepted step and rejecting anything at or below
 * it, so a code observed in transit is dead the moment it is used.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub.
 * @param code - TOTP digits or a recovery code.
 * @param nowMs - Epoch ms (injectable for tests).
 * @returns 'ok', 'invalid', or 'not-enrolled' when the account has no usable secret.
 */
export async function verifySecondFactor(
  pool: Pool, sub: string, code: string, nowMs: number = Date.now(),
): Promise<SecondFactorResult> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT totp_secret_enc, totp_last_step, totp_recovery_hashes
       FROM oshal_local_users WHERE user_sub = $1 LIMIT 1`, [sub],
  ));
  const row = rows[0];
  if (!row) return 'invalid';
  const secret = decryptSecret(row.totp_secret_enc as string | undefined);
  if (!secret) return 'not-enrolled';

  const lastStep = row.totp_last_step === null || row.totp_last_step === undefined
    ? null : Number(row.totp_last_step);
  const step = verifyTotpCode(secret, code, nowMs, lastStep);
  if (step !== null) {
    await runWithSystemIdentity(() => pool.query(
      'UPDATE oshal_local_users SET totp_last_step = $2 WHERE user_sub = $1', [sub, step],
    ));
    return 'ok';
  }
  return (await consumeRecoveryCode(pool, sub, code, row.totp_recovery_hashes)) ? 'ok' : 'invalid';
}

/**
 * @description Spends a single-use recovery code, removing it so it cannot be reused.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub.
 * @param code - The candidate recovery code.
 * @param storedHashes - The account's remaining code hashes.
 * @returns true when a code matched and was consumed.
 */
async function consumeRecoveryCode(
  pool: Pool, sub: string, code: string, storedHashes: unknown,
): Promise<boolean> {
  const hashes: string[] = Array.isArray(storedHashes) ? storedHashes.map(String) : [];
  if (!hashes.length) return false;
  const candidate = hashRecoveryCode(code);
  if (!hashes.includes(candidate)) return false;
  const remaining = hashes.filter((h) => h !== candidate);
  await runWithSystemIdentity(() => pool.query(
    'UPDATE oshal_local_users SET totp_recovery_hashes = $2::jsonb WHERE user_sub = $1',
    [sub, JSON.stringify(remaining)],
  ));
  logger.warn({ sub, remaining: remaining.length }, 'recovery code used for second factor');
  return true;
}

/**
 * @description Switches the second factor off and destroys the secret and recovery codes.
 * Used both by a user turning it off and by an administrator resetting a lost device.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub.
 * @returns Resolves when cleared.
 */
export async function disableTotp(pool: Pool, sub: string): Promise<void> {
  await runWithSystemIdentity(() => pool.query(
    `UPDATE oshal_local_users
        SET totp_secret_enc = NULL, totp_enabled = FALSE, totp_confirmed_at = NULL,
            totp_last_step = NULL, totp_recovery_hashes = '[]'::jsonb
      WHERE user_sub = $1`, [sub],
  ));
  logger.warn({ sub }, 'TOTP disabled — second factor cleared');
}

/**
 * @description Sets or clears the administrator's requirement that an account use a second
 * factor. Requiring it does not enrol anybody: the login path sends an un-enrolled user
 * with `required` set into enrolment instead of refusing them, so turning this on cannot
 * lock a user out of an account they have never set up.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub.
 * @param required - Whether the factor is mandatory.
 * @returns Resolves when stored.
 */
export async function setTotpRequired(pool: Pool, sub: string, required: boolean): Promise<void> {
  await runWithSystemIdentity(() => pool.query(
    'UPDATE oshal_local_users SET totp_required = $2 WHERE user_sub = $1', [sub, required],
  ));
  logger.info({ sub, required }, 'TOTP requirement changed');
}
