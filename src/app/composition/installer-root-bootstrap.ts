/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind initial local root to a one-use installer proof and commit account, root and consumption atomically.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { bootstrapFirstAdmin, ensureLocalUserSchema, type LocalUser } from '@/features/local-auth';
import { refreshPrivilegedCache, ensureSwarmRoleSchema } from '@/features/swarm-roles';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'installer-root-bootstrap' });
const PROOF_TTL_SECONDS = 900;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREATE_SETUP = `CREATE TABLE IF NOT EXISTS oshal_installer_root_setup (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), token_hash TEXT NOT NULL,
  origin TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  completed_sub TEXT, completed_issuer TEXT, completed_at TIMESTAMPTZ
)`;
const SETUP_POLICY = `CREATE POLICY oshal_installer_root_setup_system ON oshal_installer_root_setup FOR ALL
  USING (COALESCE(NULLIF(current_setting('oshal.is_operator', true), ''), 'off')::boolean)
  WITH CHECK (COALESCE(NULLIF(current_setting('oshal.is_operator', true), ''), 'off')::boolean)`;
const readiness = new WeakMap<Pool, Promise<void>>();

/** @description Create/validate the non-public installation ceremony store at initialization. @param pool Startup pool. @returns Completion. */
export async function ensureInstallerRootSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'installer root setup', statements: [CREATE_SETUP,
    'ALTER TABLE oshal_installer_root_setup ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE oshal_installer_root_setup FORCE ROW LEVEL SECURITY',
    'DROP POLICY IF EXISTS oshal_installer_root_setup_system ON oshal_installer_root_setup', SETUP_POLICY],
  requirements: [{ table: 'oshal_installer_root_setup', columns: ['singleton', 'token_hash', 'origin', 'expires_at', 'completed_sub', 'completed_issuer', 'completed_at'] }] });
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

async function initializeInstallationTables(pool: Pool): Promise<void> {
  try {
    await pool.query(`SELECT u.id, r.user_sub, s.token_hash, s.origin, s.expires_at, s.completed_sub, s.completed_issuer, s.completed_at
      FROM oshal_local_users u, swarm_roles r, oshal_installer_root_setup s LIMIT 0`);
  } catch (error) {
    logger.error({ err: error }, 'Installer table readiness check failed');
    if ((error as { code?: string }).code !== '42P01') throw error;
    await ensureLocalUserSchema(pool); await ensureSwarmRoleSchema(pool); await ensureInstallerRootSchema(pool);
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
      await client.query('LOCK TABLE oshal_local_users, swarm_roles, oshal_installer_root_setup IN EXCLUSIVE MODE');
      const result = await body(client); await client.query('COMMIT'); return result;
    } catch (error) {
      logger.error({ err: error }, 'Installer root transaction failed');
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  });
}
async function requireEmptyInstallation(client: PoolClient): Promise<void> {
  const users = await client.query('SELECT 1 FROM oshal_local_users LIMIT 1');
  const roles = await client.query('SELECT 1 FROM swarm_roles LIMIT 1');
  if (users.rows.length || roles.rows.length) fail(409, 'installation already has accounts or roles; use existing operator recovery');
}

/**
 * @description Local installer-only operation: persist a hash and fixed expiry, returning the transient proof once.
 * @param pool Trusted local installation database. @param origin Exact browser origin chosen by the installer.
 * @returns Secret for the installer terminal only; never put it in URLs, files, env templates or logs.
 */
export async function issueInstallerRootSetup(pool: Pool, origin: string): Promise<{ token: string; expiresAt: string; origin: string }> {
  const allowedOrigin = normalizedOrigin(origin); const token = randomBytes(32).toString('base64url');
  await ensureInstallationReady(pool);
  return transaction(pool, async (client) => {
    await requireEmptyInstallation(client);
    const { rows } = await client.query(`INSERT INTO oshal_installer_root_setup (singleton, token_hash, origin, expires_at)
      VALUES (TRUE, $1, $2, NOW() + $3 * INTERVAL '1 second')
      ON CONFLICT (singleton) DO UPDATE SET token_hash=EXCLUDED.token_hash, origin=EXCLUDED.origin, expires_at=EXCLUDED.expires_at
      WHERE oshal_installer_root_setup.completed_at IS NULL RETURNING expires_at`, [digest(token), allowedOrigin, PROOF_TTL_SECONDS]);
    if (!rows[0]) fail(409, 'installer setup is already completed');
    return { token, origin: allowedOrigin, expiresAt: new Date(rows[0].expires_at).toISOString() };
  });
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
    const { rows } = await client.query('SELECT *, expires_at <= NOW() AS expired FROM oshal_installer_root_setup WHERE singleton=TRUE FOR UPDATE');
    const setup = rows[0]; const hash = digest(input.token);
    if (!setup || typeof setup.token_hash !== 'string' || setup.token_hash.length !== hash.length
      || !timingSafeEqual(Buffer.from(setup.token_hash), Buffer.from(hash)) || setup.origin !== origin) {
      return fail(403, 'installer setup proof is invalid');
    }
    if (setup.completed_at) return fail(409, 'installer setup is already completed; sign in');
    if (setup.expired) return fail(410, 'installer setup proof expired; reissue it locally');
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
