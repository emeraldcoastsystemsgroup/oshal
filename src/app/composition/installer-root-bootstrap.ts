/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind initial local root to a one-use installer proof and commit account, root and consumption atomically.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep established external principals out of the first-install ceremony and serialize observation with root creation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | AUTH-03 identity-provider installations: the local installer may bind the one-use proof to one exact HTTPS issuer and subject (migration 172); that signed-in identity, presenting the proof from the bound origin, becomes root in the same locked transaction, while the local-account ceremony refuses a bound proof and vice versa. Only the bound principal may already exist in the verified-principal inventory.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { bootstrapFirstAdmin, ensureLocalUserSchema, type LocalUser } from '@/features/local-auth';
import { ensurePrincipalDirectorySchema } from '@/features/principal-directory';
import { refreshPrivilegedCache, ensureSwarmRoleSchema } from '@/features/swarm-roles';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { normalizePrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'installer-root-bootstrap' });
const PROOF_TTL_SECONDS = 900;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREATE_SETUP = `CREATE TABLE IF NOT EXISTS oshal_installer_root_setup (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), token_hash TEXT NOT NULL,
  origin TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  completed_sub TEXT, completed_issuer TEXT, completed_at TIMESTAMPTZ
)`;
const BOUND_PAIR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oshal_installer_root_setup_bound_pair' AND conrelid = 'oshal_installer_root_setup'::regclass) THEN
  ALTER TABLE oshal_installer_root_setup ADD CONSTRAINT oshal_installer_root_setup_bound_pair CHECK ((bound_issuer IS NULL) = (bound_sub IS NULL));
END IF; END $$`;
const SETUP_POLICY = `CREATE POLICY oshal_installer_root_setup_system ON oshal_installer_root_setup FOR ALL
  USING (COALESCE(NULLIF(current_setting('oshal.is_operator', true), ''), 'off')::boolean)
  WITH CHECK (COALESCE(NULLIF(current_setting('oshal.is_operator', true), ''), 'off')::boolean)`;
const readiness = new WeakMap<Pool, Promise<void>>();

/** @description Create/validate the non-public installation ceremony store at initialization. @param pool Startup pool. @returns Completion. */
export async function ensureInstallerRootSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'installer root setup', statements: [CREATE_SETUP,
    'ALTER TABLE oshal_installer_root_setup ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE oshal_installer_root_setup FORCE ROW LEVEL SECURITY',
    'DROP POLICY IF EXISTS oshal_installer_root_setup_system ON oshal_installer_root_setup', SETUP_POLICY,
    'ALTER TABLE oshal_installer_root_setup ADD COLUMN IF NOT EXISTS bound_issuer TEXT',
    'ALTER TABLE oshal_installer_root_setup ADD COLUMN IF NOT EXISTS bound_sub TEXT', BOUND_PAIR],
  requirements: [{ table: 'oshal_installer_root_setup', columns: ['singleton', 'token_hash', 'origin', 'expires_at', 'completed_sub', 'completed_issuer', 'completed_at', 'bound_issuer', 'bound_sub'] }] });
}

function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function normalizedOrigin(origin: string): string {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return fail(400, 'a valid setup browser origin is required'); }
  if (parsed.origin !== origin || parsed.username || parsed.password
    || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
    return fail(400, 'setup origin must be HTTPS or local loopback HTTP, without a path');
  }
  return parsed.origin;
}
function digest(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/** One exact identity-provider principal a local installer binds a setup proof to. */
export interface InstallerRootIdentity { issuer: string; subject: string }
/**
 * @description Validate the identity the installer typed: an HTTPS issuer (never a kernel `urn:oshal:*` namespace)
 * and a bounded subject, both compared later byte for byte with the verified session.
 * @param identity Installer-supplied issuer and subject. @returns The same identity, normalized as sessions are.
 */
function boundIdentity(identity: InstallerRootIdentity): InstallerRootIdentity {
  const issuer = normalizePrincipalIssuer(identity.issuer);
  let parsed: URL | null = null;
  try { parsed = issuer ? new URL(issuer) : null; } catch { parsed = null; }
  if (!issuer || !parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return fail(400, 'an exact HTTPS identity-provider issuer is required');
  }
  const subject = identity.subject;
  if (typeof subject !== 'string' || !subject || subject !== subject.trim() || Buffer.byteLength(subject, 'utf8') > 512
    || /[\u0000-\u001f\u007f]/.test(subject)) return fail(400, 'an exact identity-provider subject is required');
  return { issuer, subject };
}

async function initializeInstallationTables(pool: Pool): Promise<void> {
  try {
    await runWithSystemIdentity(() => pool.query(`SELECT u.id, r.user_sub, s.token_hash, s.origin, s.expires_at, s.completed_sub, s.completed_issuer, s.completed_at, s.bound_issuer, s.bound_sub
      FROM oshal_local_users u, swarm_roles r, oshal_installer_root_setup s, oshal_verified_principals p LIMIT 0`));
  } catch (error) {
    logger.error({ err: error }, 'Installer table readiness check failed');
    if (!['42P01', '42703'].includes(String((error as { code?: string }).code))) throw error;
    await ensureLocalUserSchema(pool); await ensureSwarmRoleSchema(pool); await ensureInstallerRootSchema(pool); await ensurePrincipalDirectorySchema(pool);
  }
}
function ensureInstallationReady(pool: Pool): Promise<void> {
  let pending = readiness.get(pool);
  if (!pending) {
    pending = initializeInstallationTables(pool).catch((error) => {
      logger.error({ err: error }, 'Installer setup unavailable'); readiness.delete(pool); throw error;
    });
    readiness.set(pool, pending);
  }
  return pending;
}

async function transaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithSystemIdentity(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // All account/role writers take conflicting row-exclusive locks, including legacy invite/recovery routes.
      await client.query('LOCK TABLE oshal_local_users, swarm_roles, oshal_verified_principals, oshal_installer_root_setup IN EXCLUSIVE MODE');
      const result = await body(client); await client.query('COMMIT'); return result;
    } catch (error) {
      logger.error({ err: error }, 'Installer root transaction failed');
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  });
}
/** No account, role or verified principal exists - except the one exact principal an identity-provider proof is bound to. */
async function requireEmptyInstallation(client: PoolClient, bound?: InstallerRootIdentity): Promise<void> {
  const users = await client.query('SELECT 1 FROM oshal_local_users LIMIT 1');
  const roles = await client.query('SELECT 1 FROM swarm_roles LIMIT 1');
  const principals = bound
    ? await client.query('SELECT 1 FROM oshal_verified_principals WHERE NOT (issuer = $1 AND user_sub = $2) LIMIT 1', [bound.issuer, bound.subject])
    : await client.query('SELECT 1 FROM oshal_verified_principals LIMIT 1');
  if (users.rows.length || roles.rows.length || principals.rows.length) fail(409, 'installation already has accounts or roles; use existing operator recovery');
}

/**
 * @description Local installer-only operation: persist a hash and fixed expiry, returning the transient proof once.
 * An identity-provider installation binds the proof to one exact issuer and subject; a local-account one binds none.
 * @param pool Trusted local installation database. @param origin Exact browser origin chosen by the installer.
 * @param identity Optional exact identity-provider principal that alone may complete this proof.
 * @returns Secret for the installer terminal only; never put it in URLs, files, env templates or logs.
 */
export async function issueInstallerRootSetup(pool: Pool, origin: string, identity?: InstallerRootIdentity): Promise<{
  token: string; expiresAt: string; origin: string; identity?: InstallerRootIdentity }> {
  const allowedOrigin = normalizedOrigin(origin); const token = randomBytes(32).toString('base64url');
  const bound = identity ? boundIdentity(identity) : undefined;
  await ensureInstallationReady(pool);
  return transaction(pool, async (client) => {
    await requireEmptyInstallation(client, bound);
    const { rows } = await client.query(`INSERT INTO oshal_installer_root_setup (singleton, token_hash, origin, expires_at, bound_issuer, bound_sub)
      VALUES (TRUE, $1, $2, NOW() + $3 * INTERVAL '1 second', $4, $5)
      ON CONFLICT (singleton) DO UPDATE SET token_hash=EXCLUDED.token_hash, origin=EXCLUDED.origin, expires_at=EXCLUDED.expires_at,
        bound_issuer=EXCLUDED.bound_issuer, bound_sub=EXCLUDED.bound_sub
      WHERE oshal_installer_root_setup.completed_at IS NULL RETURNING expires_at`,
    [digest(token), allowedOrigin, PROOF_TTL_SECONDS, bound?.issuer ?? null, bound?.subject ?? null]);
    if (!rows[0]) fail(409, 'installer setup is already completed');
    return { token, origin: allowedOrigin, expiresAt: new Date(rows[0].expires_at).toISOString(), ...(bound ? { identity: bound } : {}) };
  });
}

/** Stored ceremony row as read under the setup lock. */
interface SetupRow { token_hash?: unknown; origin?: string; completed_at?: Date | null; expired?: boolean; bound_issuer?: string | null; bound_sub?: string | null }
/**
 * @description Check the presented proof against the locked row in a fixed order: proof and origin, completion, expiry.
 * @param setup Locked ceremony row or undefined. @param token Presented proof. @param origin Normalized request origin.
 * @returns The row, known to hold a live, matching, unconsumed proof.
 */
function verifyProof(setup: SetupRow | undefined, token: string, origin: string): SetupRow {
  const hash = digest(token);
  if (!setup || typeof setup.token_hash !== 'string' || setup.token_hash.length !== hash.length
    || !timingSafeEqual(Buffer.from(setup.token_hash), Buffer.from(hash)) || setup.origin !== origin) {
    return fail(403, 'installer setup proof is invalid');
  }
  if (setup.completed_at) return fail(409, 'installer setup is already completed; sign in');
  if (setup.expired) return fail(410, 'installer setup proof expired; reissue it locally');
  return setup;
}
async function lockedSetup(client: PoolClient): Promise<SetupRow | undefined> {
  const { rows } = await client.query('SELECT *, expires_at <= NOW() AS expired FROM oshal_installer_root_setup WHERE singleton=TRUE FOR UPDATE');
  return rows[0];
}

/** Parameters contain installer proof plus new account credentials; the origin is supplied by the server request boundary. */
export interface InstallerRootInput {
  token: string; origin: string; email: string; displayName?: string | null; password: string;
}
/**
 * @description Consume proof with account+root in one locked transaction. Session issuance must happen after this resolves.
 * @param pool Runtime pool. @param input Origin-bound secret and validated first-account inputs.
 * @returns Created local account, only after durable root/setup commit.
 */
export async function completeInstallerRootSetup(pool: Pool, input: InstallerRootInput): Promise<LocalUser> {
  if (!TOKEN_PATTERN.test(input.token)) return fail(403, 'installer setup proof is required');
  const origin = normalizedOrigin(input.origin);
  await ensureInstallationReady(pool);
  const user = await transaction(pool, async (client) => {
    const setup = verifyProof(await lockedSetup(client), input.token, origin);
    if (setup.bound_issuer) return fail(403, 'installer setup is bound to an identity-provider account; sign in with that account to complete it');
    await requireEmptyInstallation(client);
    const account = await bootstrapFirstAdmin(client, input);
    if (!account) return fail(409, 'an account already exists; sign in');
    await client.query(`INSERT INTO swarm_roles (user_sub, email, display_name, role, granted_by_sub, note)
      VALUES ($1, $2, $3, 'root', $1, 'installer proof: local account bootstrap')`, [account.userSub, account.email, account.displayName]);
    await client.query(`UPDATE oshal_installer_root_setup SET completed_sub=$1, completed_issuer='urn:oshal:local-auth', completed_at=NOW()
      WHERE singleton=TRUE`, [account.userSub]);
    return account;
  });
  await refreshPrivilegedCache(pool);
  return user;
}

/** Identity-provider completion: the verified session identity plus the proof it was handed by the local installer. */
export interface OidcInstallerRootInput {
  token: string; origin: string; issuer: string; subject: string; email?: string | null; displayName?: string | null;
}
/**
 * @description Consume an identity-bound proof and make exactly that verified issuer+subject the swarm root, in one
 * locked transaction. A proof issued for the local-account ceremony, another identity, another origin, or an
 * installation that already has accounts, roles or other principals is refused and nothing is written.
 * @param pool Runtime pool. @param input Proof, request origin and the verified session identity.
 * @returns The elected root identity, only after the durable commit.
 */
export async function completeOidcInstallerRootSetup(pool: Pool, input: OidcInstallerRootInput): Promise<InstallerRootIdentity> {
  if (!TOKEN_PATTERN.test(input.token)) return fail(403, 'installer setup proof is required');
  const origin = normalizedOrigin(input.origin);
  const issuer = normalizePrincipalIssuer(input.issuer);
  await ensureInstallationReady(pool);
  const elected = await transaction(pool, async (client) => {
    const setup = verifyProof(await lockedSetup(client), input.token, origin);
    if (!setup.bound_issuer || !setup.bound_sub || setup.bound_issuer !== issuer || setup.bound_sub !== input.subject) {
      return fail(403, 'installer setup is bound to a different identity');
    }
    const bound = { issuer: setup.bound_issuer, subject: setup.bound_sub };
    await requireEmptyInstallation(client, bound);
    await client.query(`INSERT INTO swarm_roles (user_sub, email, display_name, role, granted_by_sub, note)
      VALUES ($1, $2, $3, 'root', $1, 'installer proof: exact identity-provider issuer and subject')`,
    [bound.subject, input.email ?? null, input.displayName ?? null]);
    await client.query(`UPDATE oshal_installer_root_setup SET completed_sub=$1, completed_issuer=$2, completed_at=NOW()
      WHERE singleton=TRUE`, [bound.subject, bound.issuer]);
    return bound;
  });
  await refreshPrivilegedCache(pool);
  logger.warn({ issuer: elected.issuer }, 'installer root elected for the bound identity-provider principal');
  return elected;
}
