/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local invited-user store (ADR-117). Standalone deployments (a client box with no IdP) need a controlled login: an admin invites a user by email, the invitee follows a one-time link to set a password, and only invited people can sign in. This module owns the oshal_local_users table, scrypt password hashing (Node built-in — no new crypto dependency), the deterministic `local-<sha256(email)[0..16]>` sub (the SAME formula the installer's LocalSub writes into MOCK_OIDC_SUB, so sub-keyed data survives the switch from open mock mode to gated login), and the one-time invite tokens (oshal_inv_ prefixed, sha256 at rest, single-use, 7-day expiry — the PAT trade). Passwords hash into Postgres, NOT the Vault surface: hashes are one-way material that belongs in the identity DB (how Keycloak/AD do it), and the login path must not depend on the Vault facade whose runtime is not built (ADR-040).
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'local-user-store' });

/** Invite-token prefix — recognizable (like oshal_pat_) so secret scanners and humans can spot a leak. */
export const INVITE_TOKEN_PREFIX = 'oshal_inv_';
/** Random payload size; 24 bytes → 48 hex chars of entropy (same trade as the PAT store). */
const TOKEN_BYTES = 24;
/** Invite links stop working after this long; the admin re-invites to mint a fresh one. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** NIST-style policy: a real minimum length, no composition theater. */
export const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;

// scrypt parameters, self-described in every stored hash so they can be raised later
// without invalidating existing credentials (verify reads the params from the hash).
const SCRYPT_LOG2_N = 14; // N = 16384
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

/** A local login account. `passwordHash` never leaves this module. */
export interface LocalUser {
  id: string;
  email: string;
  displayName: string | null;
  userSub: string;
  status: 'invited' | 'active' | 'disabled';
  tokenVersion: number;
  createdAt: string | null;
  activatedAt: string | null;
  lastLoginAt: string | null;
  inviteExpiresAt: string | null;
}

/**
 * @description Derives the deterministic platform sub for a local login email. This is
 * byte-for-byte the installer's LocalSub formula (scripts/oshal-install.ps1 / .sh write it
 * into MOCK_OIDC_SUB), so the identity — and every sub-keyed row — carries over when a
 * deployment switches from open MOCK_OIDC to gated LOCAL_AUTH, and an app can pre-bind a
 * user's rows (e.g. a CRM rep record) before the invitee has ever logged in.
 *
 * @param email - The login email; trimmed and lowercased before hashing.
 * @returns The `local-` prefixed 16-hex-char sub.
 */
export function localSubForEmail(email: string): string {
  const normalized = normalizeEmail(email);
  return `local-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

/**
 * @description Canonical email normalization for the store — one lowercase/trim rule so
 * lookups, unique constraints, and sub derivation can never disagree about identity.
 *
 * @param email - Raw email input.
 * @returns Trimmed, lowercased email.
 */
export function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * @description Lightweight shape check before we mint accounts for garbage input. Not an
 * RFC validator — the invite email bouncing is the real validator; this only refuses
 * obviously-not-an-address strings.
 *
 * @param email - Normalized email candidate.
 * @returns true when the string looks like a plausible address.
 */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * @description Hashes a password with Node's built-in scrypt into a self-describing
 * string (`scrypt$<log2N>$<r>$<p>$<saltB64>$<hashB64>`), so the cost parameters can be
 * raised later without breaking stored credentials.
 *
 * @param password - The plaintext password (never logged, never stored).
 * @returns The encoded hash string for storage.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: 1 << SCRYPT_LOG2_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return ['scrypt', SCRYPT_LOG2_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * @description Verifies a password against a stored self-describing scrypt hash in
 * constant time. A malformed stored hash verifies as false rather than throwing, so a
 * corrupted row degrades to a failed login instead of a 500 on the login path.
 *
 * @param password - The plaintext candidate.
 * @param stored - The encoded hash from the database.
 * @returns true only when the password matches.
 */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  try {
    const [, log2n, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: 1 << Number(log2n), r: Number(r), p: Number(p),
    });
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'stored password hash unreadable — treating as no-match');
    return false;
  }
}

/**
 * @description Mints a one-time invite token. The plaintext travels in the invite link
 * exactly once; only its sha256 lands in the database (the PAT trade: 192 bits of entropy
 * makes an unsalted fast hash safe and keeps the lookup a single indexed equality).
 *
 * @returns The plaintext token (`oshal_inv_` + 48 hex chars).
 */
export function generateInviteToken(): string {
  return `${INVITE_TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('hex')}`;
}

/**
 * @description Storage/lookup hash for invite tokens — sha256 hex.
 *
 * @param token - Plaintext invite token.
 * @returns Hex digest.
 */
export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * @description Creates the local-user store if absent (lazy-DDL chokepoint, mirroring
 * oshal_cli_tokens) with owner RLS applied at creation. Reads on the login path run under
 * the SYSTEM identity sentinel (they necessarily precede any request identity); admin
 * reads ride the operator GUC.
 *
 * @param pool - Postgres pool.
 * @returns Resolves when the table + policies exist.
 */
export async function ensureLocalUserSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'local auth store',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_local_users (
        id                TEXT PRIMARY KEY,
        email             TEXT UNIQUE NOT NULL,
        display_name      TEXT,
        user_sub          TEXT UNIQUE NOT NULL,
        password_hash     TEXT,
        status            TEXT NOT NULL DEFAULT 'invited',
        token_version     INTEGER NOT NULL DEFAULT 1,
        invite_token_hash TEXT,
        invite_expires_at TIMESTAMPTZ,
        invited_by_sub    TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        activated_at      TIMESTAMPTZ,
        last_login_at     TIMESTAMPTZ
      )`,
      ...buildOwnerRlsPolicyStatements('oshal_local_users', 'user_sub'),
    ],
    requirements: [{
      table: 'oshal_local_users',
      columns: ['id', 'email', 'user_sub', 'password_hash', 'status', 'token_version', 'invite_token_hash'],
    }],
  });
}

/** Row → public shape; the one projection, so password/token material can't leak by accident. */
function toLocalUser(r: Record<string, unknown>): LocalUser {
  return {
    id: String(r.id),
    email: String(r.email),
    displayName: (r.display_name as string | null) ?? null,
    userSub: String(r.user_sub),
    status: r.status as LocalUser['status'],
    tokenVersion: Number(r.token_version),
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
    activatedAt: r.activated_at ? new Date(r.activated_at as string).toISOString() : null,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at as string).toISOString() : null,
    inviteExpiresAt: r.invite_expires_at ? new Date(r.invite_expires_at as string).toISOString() : null,
  };
}

/** Result of creating/renewing an invite — the plaintext token appears exactly once. */
export interface InviteResult {
  user: LocalUser;
  /** Plaintext one-time token for the invite link; never persisted. */
  token: string;
  /** ISO expiry of the link. */
  expiresAt: string;
}

/**
 * @description Creates an invited user (or renews the invite on an existing non-disabled
 * account — re-inviting is also the admin-driven password-reset path). Renewal replaces
 * the previous token, so at most one live invite link exists per account.
 *
 * @param pool - Postgres pool.
 * @param input - email (required), optional display name, and the inviting admin's sub.
 * @returns The user row plus the one-time plaintext token.
 */
export async function upsertInvite(
  pool: Pool,
  input: { email: string; displayName?: string | null; invitedBySub?: string | null },
): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) throw httpError(400, 'that does not look like an email address');
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `INSERT INTO oshal_local_users (id, email, display_name, user_sub, status, invite_token_hash, invite_expires_at, invited_by_sub)
       VALUES ($1, $2, $3, $4, 'invited', $5, $6, $7)
     ON CONFLICT (email) DO UPDATE SET
       invite_token_hash = EXCLUDED.invite_token_hash,
       invite_expires_at = EXCLUDED.invite_expires_at,
       display_name      = COALESCE(EXCLUDED.display_name, oshal_local_users.display_name)
     WHERE oshal_local_users.status <> 'disabled'
     RETURNING *`,
    [crypto.randomUUID(), email, input.displayName ?? null, localSubForEmail(email),
      hashInviteToken(token), expiresAt, input.invitedBySub ?? null],
  ));
  if (!rows[0]) throw httpError(409, 'that account is disabled — re-enable it before re-inviting');
  return { user: toLocalUser(rows[0]), token, expiresAt: expiresAt.toISOString() };
}

/**
 * @description Looks up the account behind a plaintext invite token, enforcing expiry.
 * Used by the invite page to show whose invitation it is before a password is chosen.
 *
 * @param pool - Postgres pool.
 * @param token - Plaintext token from the link.
 * @returns The user, or null when the token is unknown, spent, or expired.
 */
export async function findByInviteToken(pool: Pool, token: string): Promise<LocalUser | null> {
  if (!token || !token.startsWith(INVITE_TOKEN_PREFIX)) return null;
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT * FROM oshal_local_users
      WHERE invite_token_hash = $1 AND status <> 'disabled'
        AND invite_expires_at IS NOT NULL AND invite_expires_at > NOW()
      LIMIT 1`,
    [hashInviteToken(token)],
  ));
  return rows[0] ? toLocalUser(rows[0]) : null;
}

/**
 * @description Redeems an invite token: sets the password, activates the account, spends
 * the token (single-use), and bumps token_version so any session minted under an older
 * password dies. This is both first-time activation AND the admin-driven reset path.
 *
 * @param pool - Postgres pool.
 * @param token - Plaintext token from the link.
 * @param password - The chosen password (validated here).
 * @returns The activated user, or null when the token is unknown/spent/expired.
 */
export async function acceptInvite(pool: Pool, token: string, password: string): Promise<LocalUser | null> {
  assertPasswordPolicy(password);
  if (!token || !token.startsWith(INVITE_TOKEN_PREFIX)) return null;
  const passwordHash = hashPassword(password);
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `UPDATE oshal_local_users SET
       password_hash = $2, status = 'active', token_version = token_version + 1,
       invite_token_hash = NULL, invite_expires_at = NULL,
       activated_at = COALESCE(activated_at, NOW())
     WHERE invite_token_hash = $1 AND status <> 'disabled'
       AND invite_expires_at IS NOT NULL AND invite_expires_at > NOW()
     RETURNING *`,
    [hashInviteToken(token), passwordHash],
  ));
  return rows[0] ? toLocalUser(rows[0]) : null;
}

/**
 * @description Verifies an email+password login. Returns the user only for an ACTIVE
 * account with a matching password; every other case — unknown email, invited-but-not-
 * activated, disabled, wrong password — returns null so the route can answer with one
 * generic message (no account enumeration). Runs the hash even for unknown emails so
 * response timing does not distinguish "no such user" from "wrong password".
 *
 * @param pool - Postgres pool.
 * @param email - Login email.
 * @param password - Plaintext candidate.
 * @returns The user on success, else null.
 */
export async function verifyLogin(pool: Pool, email: string, password: string): Promise<LocalUser | null> {
  const normalized = normalizeEmail(email);
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT * FROM oshal_local_users WHERE email = $1 LIMIT 1`, [normalized],
  ));
  const row = rows[0] as Record<string, unknown> | undefined;
  // Burn the same scrypt cost on unknown emails (decoy hash) as on real ones.
  const stored = row && row.status === 'active' ? (row.password_hash as string | null) : DECOY_HASH;
  const ok = verifyPassword(password, stored);
  if (!row || row.status !== 'active' || !ok) return null;
  void runWithSystemIdentity(() =>
    pool.query('UPDATE oshal_local_users SET last_login_at = NOW() WHERE id = $1', [row.id]),
  ).catch((err) => logger.warn({ err }, 'last_login_at update failed'));
  return toLocalUser(row);
}

/**
 * @description Session-validity snapshot for the cookie injector: status + token_version
 * by sub. Cached by the caller (the injector), not here.
 *
 * @param pool - Postgres pool.
 * @param sub - The `local-…` sub from a session cookie.
 * @returns Minimal identity fields, or null when no such account exists.
 */
export async function getSessionSnapshot(
  pool: Pool, sub: string,
): Promise<{ status: string; tokenVersion: number; email: string; displayName: string | null } | null> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT status, token_version, email, display_name FROM oshal_local_users WHERE user_sub = $1 LIMIT 1`, [sub],
  ));
  const r = rows[0];
  if (!r) return null;
  return {
    status: String(r.status), tokenVersion: Number(r.token_version),
    email: String(r.email), displayName: (r.display_name as string | null) ?? null,
  };
}

/**
 * @description True when no local accounts exist yet — the signal that /login should
 * offer the create-the-first-administrator form (the installer is the first admin).
 *
 * @param pool - Postgres pool.
 * @returns true when the store is empty.
 */
export async function isStoreEmpty(pool: Pool): Promise<boolean> {
  const { rows } = await runWithSystemIdentity(() => pool.query('SELECT 1 FROM oshal_local_users LIMIT 1'));
  return rows.length === 0;
}

/**
 * @description Creates the FIRST account, active immediately with a password — the
 * installer bootstrap. Race-guarded: the insert only lands while the table is empty
 * (single statement, so two concurrent bootstraps cannot both win).
 *
 * @param pool - Postgres pool.
 * @param input - email, display name, password.
 * @returns The created admin user, or null when an account already existed.
 */
export async function bootstrapFirstAdmin(
  pool: Pool, input: { email: string; displayName?: string | null; password: string },
): Promise<LocalUser | null> {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) throw httpError(400, 'that does not look like an email address');
  assertPasswordPolicy(input.password);
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `INSERT INTO oshal_local_users (id, email, display_name, user_sub, status, password_hash, activated_at)
     SELECT $1, $2, $3, $4, 'active', $5, NOW()
      WHERE NOT EXISTS (SELECT 1 FROM oshal_local_users)
     RETURNING *`,
    [crypto.randomUUID(), email, input.displayName ?? null, localSubForEmail(email), hashPassword(input.password)],
  ));
  return rows[0] ? toLocalUser(rows[0]) : null;
}

/**
 * @description Lists every local account (metadata only — hashes and token material never
 * leave the server). Admin-surface read; runs under the caller's identity, so RLS lets the
 * operator/trusted-service context see all rows.
 *
 * @param pool - Postgres pool.
 * @returns All users, newest first.
 */
export async function listUsers(pool: Pool): Promise<LocalUser[]> {
  const { rows } = await pool.query('SELECT * FROM oshal_local_users ORDER BY created_at DESC');
  return rows.map(toLocalUser);
}

/**
 * @description Sets an account's status. Disabling bumps token_version so live sessions
 * die at the injector's next snapshot; enabling leaves the password untouched (an enabled
 * account with no password still can't log in until re-invited).
 *
 * @param pool - Postgres pool.
 * @param id - Account id.
 * @param status - 'active' or 'disabled'.
 * @returns The updated user, or null when the id is unknown.
 */
export async function setUserStatus(pool: Pool, id: string, status: 'active' | 'disabled'): Promise<LocalUser | null> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `UPDATE oshal_local_users SET status = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *`,
    [id, status],
  ));
  return rows[0] ? toLocalUser(rows[0]) : null;
}

/**
 * @description Fetches one account by id (admin surface).
 *
 * @param pool - Postgres pool.
 * @param id - Account id.
 * @returns The user, or null.
 */
export async function getUserById(pool: Pool, id: string): Promise<LocalUser | null> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    'SELECT * FROM oshal_local_users WHERE id = $1 LIMIT 1', [id],
  ));
  return rows[0] ? toLocalUser(rows[0]) : null;
}

/** Throws a 400 when the password fails policy — one message, used by accept + bootstrap. */
function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw httpError(400, `passwords need at least ${PASSWORD_MIN_LENGTH} characters`);
  }
}

/** Error with an HTTP status the route layer maps straight onto the response. */
function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// A real hash of random bytes, computed once at module load, so unknown-email logins
// spend the same scrypt cost as wrong-password logins (timing-equalized enumeration guard).
const DECOY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));
