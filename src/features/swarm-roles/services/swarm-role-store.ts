/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148): the role store behind the operator gate. Before this, "the first account" (oshal_local_users.bootstrapFirstAdmin, which code calls "the installer is the first admin") and "the admin" (the hand-typed OSHAL_OPERATOR_SUBS env allowlist) were two unconnected systems — no role column, no code path linking them — so on a LOCAL_AUTH box the person who set the very first password got no privilege from it, and on a MOCK_OIDC box privilege came from an installer prompt. That is the "default passwords are confusing" report. swarm_roles makes root a ROW: exactly one, enforced by a partial unique index in the DATABASE rather than by application code, transferable but never deletable while it is the only root. The env allowlist is retained forever as break-glass (operator decision) so an existing deployment adopts this with zero configuration change and a lost root is always recoverable.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { setPrivilegedIdentities, clearPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

const logger = createChildLogger({ module: 'swarm-role-store' });

/** The three roles. `user` is the default for anyone with no row — it is stored only when explicitly assigned. */
export type SwarmRole = 'root' | 'admin' | 'user';

/** The roles that satisfy the operator gate. `user` never does. */
const PRIVILEGED_ROLES: readonly SwarmRole[] = ['root', 'admin'];

/** One role assignment. */
export interface SwarmRoleRow {
  userSub: string;
  email: string | null;
  displayName: string | null;
  role: SwarmRole;
  grantedBySub: string | null;
  grantedAt: string;
  note: string | null;
}

/** Raised for an expected, caller-visible failure so routes can map it to a status. */
export class SwarmRoleError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'SwarmRoleError';
  }
}

/**
 * @description Creates the swarm-role table if absent, at the same lazy-DDL chokepoint
 * oshal_local_users uses.
 *
 * Two schema choices carry the design:
 *  - The `swarm_roles_single_root` PARTIAL UNIQUE INDEX makes "there is at most one root" a
 *    database invariant. Application code cannot race past it, and a second claim fails as a
 *    constraint violation rather than as a lost update — which is what "root" has to mean.
 *  - The table is deliberately NOT owner-RLS'd. Every other user table scopes rows to their
 *    owner, but the privileged-identity cache must read EVERY row under the system identity to
 *    answer "who is an admin", and a policy that hid other people's rows from that load would
 *    silently produce a cache containing only the reader. Access is gated in the ROUTE layer
 *    (root/admin only) instead, and reads run under the system sentinel.
 *
 * @param pool - Postgres pool.
 * @returns Resolves when the table and its invariant index exist.
 */
export async function ensureSwarmRoleSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'swarm role store',
    statements: [
      `CREATE TABLE IF NOT EXISTS swarm_roles (
        user_sub       TEXT PRIMARY KEY,
        email          TEXT,
        display_name   TEXT,
        role           TEXT NOT NULL CHECK (role IN ('root', 'admin', 'user')),
        granted_by_sub TEXT,
        granted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        note           TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS swarm_roles_single_root ON swarm_roles ((role)) WHERE role = 'root'`,
      `CREATE INDEX IF NOT EXISTS swarm_roles_email ON swarm_roles (LOWER(email))`,
    ],
    requirements: [{
      table: 'swarm_roles',
      columns: ['user_sub', 'email', 'role', 'granted_by_sub', 'granted_at'],
    }],
  });
}

/** Row → public shape. The one projection, so a column added later cannot leak by accident. */
function toRoleRow(r: Record<string, unknown>): SwarmRoleRow {
  return {
    userSub: String(r.user_sub),
    email: (r.email as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    role: String(r.role) as SwarmRole,
    grantedBySub: (r.granted_by_sub as string | null) ?? null,
    grantedAt: r.granted_at instanceof Date ? r.granted_at.toISOString() : String(r.granted_at),
    note: (r.note as string | null) ?? null,
  };
}

/**
 * @description Lists every role assignment, newest grant first. Runs under the system identity
 * because the caller-facing gate is the route, not RLS (see ensureSwarmRoleSchema).
 * @param pool - Postgres pool.
 * @returns All assigned roles.
 */
export async function listRoles(pool: Pool): Promise<SwarmRoleRow[]> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT user_sub, email, display_name, role, granted_by_sub, granted_at, note
       FROM swarm_roles
      ORDER BY CASE role WHEN 'root' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, granted_at DESC`,
  ));
  return rows.map(toRoleRow);
}

/**
 * @description Reads one identity's role, or null when they have none (which means `user`).
 * @param pool - Postgres pool.
 * @param userSub - exact OIDC sub.
 * @returns The role row, or null.
 */
export async function getRole(pool: Pool, userSub: string): Promise<SwarmRoleRow | null> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT user_sub, email, display_name, role, granted_by_sub, granted_at, note
       FROM swarm_roles WHERE user_sub = $1`,
    [userSub],
  ));
  return rows.length ? toRoleRow(rows[0]) : null;
}

/**
 * @description The sub holding root, or null when root is unclaimed.
 * @param pool - Postgres pool.
 * @returns The root sub, or null.
 */
export async function getRootSubFromStore(pool: Pool): Promise<string | null> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT user_sub FROM swarm_roles WHERE role = 'root' LIMIT 1`,
  ));
  return rows.length ? String(rows[0].user_sub) : null;
}

/**
 * @description Loads root + admin into the synchronous privileged-identity cache that
 * isOperatorIdentity reads, and returns how many were loaded.
 *
 * On a read failure the cache is CLEARED rather than left as-is. A stale privileged set is the
 * worse failure: a revoked admin would keep access until the next successful load. Cleared, the
 * swarm falls back to the env break-glass allowlist, which is exactly the recovery posture.
 *
 * @param pool - Postgres pool.
 * @returns The number of privileged identities loaded.
 */
export async function refreshPrivilegedCache(pool: Pool): Promise<number> {
  try {
    const { rows } = await runWithSystemIdentity(() => pool.query(
      `SELECT user_sub, email, role FROM swarm_roles WHERE role = ANY($1::text[])`,
      [PRIVILEGED_ROLES],
    ));
    setPrivilegedIdentities(rows.map((r) => ({
      sub: String(r.user_sub),
      email: (r.email as string | null) ?? null,
      role: String(r.role) as 'root' | 'admin',
    })));
    logger.info({ count: rows.length }, 'privileged identity cache refreshed');
    return rows.length;
  } catch (err) {
    clearPrivilegedIdentities();
    logger.error({ err }, 'privileged identity cache refresh FAILED — cache cleared, env break-glass allowlist is now the only operator path');
    throw err;
  }
}

/**
 * @description Claims swarm root for an identity, allowed ONLY while root is unclaimed.
 *
 * This is the step that closes the gap between "the first account" and "the admin". It is
 * deliberately NOT automatic on account creation: a code path that granted root to whoever
 * registered first would be a silent privilege escalation on any box reachable before its first
 * login. The caller (first-run flow or an env break-glass operator) has to ask for it, and the
 * partial unique index guarantees only the first request can win even under a race.
 *
 * @param pool - Postgres pool.
 * @param input - the claiming identity and an optional note recording how root was established.
 * @returns The created root row.
 * @throws SwarmRoleError 409 when root is already held.
 */
export async function claimRoot(
  pool: Pool,
  input: { userSub: string; email?: string | null; displayName?: string | null; note?: string | null },
): Promise<SwarmRoleRow> {
  const userSub = String(input.userSub ?? '').trim();
  if (!userSub) throw new SwarmRoleError(400, 'a subject is required to claim root');

  const existing = await getRootSubFromStore(pool);
  if (existing) {
    throw new SwarmRoleError(409, existing === userSub
      ? 'you already hold swarm root'
      : 'swarm root is already held — transfer it from the current root instead');
  }

  try {
    const { rows } = await runWithSystemIdentity(() => pool.query(
      `INSERT INTO swarm_roles (user_sub, email, display_name, role, granted_by_sub, note)
       VALUES ($1, $2, $3, 'root', $1, $4)
       ON CONFLICT (user_sub) DO UPDATE SET role = 'root', email = EXCLUDED.email,
             display_name = EXCLUDED.display_name, granted_at = NOW(), note = EXCLUDED.note
       RETURNING user_sub, email, display_name, role, granted_by_sub, granted_at, note`,
      [userSub, input.email ?? null, input.displayName ?? null, input.note ?? null],
    ));
    await refreshPrivilegedCache(pool);
    logger.warn({ userSub }, 'SWARM ROOT CLAIMED');
    return toRoleRow(rows[0]);
  } catch (err) {
    // The partial unique index is the race arbiter — a concurrent claim lands here, not above.
    if ((err as { code?: string }).code === '23505') {
      throw new SwarmRoleError(409, 'swarm root was claimed by another request');
    }
    throw err;
  }
}

/**
 * @description Grants or changes a role. Cannot mint root — root arrives only through
 * {@link claimRoot} or {@link transferRoot}, so the single-root invariant has exactly two
 * doors instead of three.
 * @param pool - Postgres pool.
 * @param input - target identity, the role to grant, and the granting caller's sub.
 * @returns The written role row.
 * @throws SwarmRoleError 400 for a bad role, 409 when targeting the sitting root.
 */
export async function grantRole(
  pool: Pool,
  input: {
    userSub: string; email?: string | null; displayName?: string | null;
    role: SwarmRole; grantedBySub: string | null; note?: string | null;
  },
): Promise<SwarmRoleRow> {
  const userSub = String(input.userSub ?? '').trim();
  if (!userSub) throw new SwarmRoleError(400, 'a subject is required');
  if (input.role === 'root') {
    throw new SwarmRoleError(400, 'root cannot be granted — transfer it from the current root');
  }
  if (input.role !== 'admin' && input.role !== 'user') {
    throw new SwarmRoleError(400, `unknown role "${input.role}"`);
  }

  const rootSub = await getRootSubFromStore(pool);
  if (rootSub && rootSub === userSub) {
    throw new SwarmRoleError(409, 'that identity holds swarm root — transfer root before changing their role');
  }

  const { rows } = await runWithSystemIdentity(() => pool.query(
    `INSERT INTO swarm_roles (user_sub, email, display_name, role, granted_by_sub, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_sub) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email,
           display_name = EXCLUDED.display_name, granted_by_sub = EXCLUDED.granted_by_sub,
           granted_at = NOW(), note = EXCLUDED.note
     RETURNING user_sub, email, display_name, role, granted_by_sub, granted_at, note`,
    [userSub, input.email ?? null, input.displayName ?? null, input.role, input.grantedBySub, input.note ?? null],
  ));
  await refreshPrivilegedCache(pool);
  logger.info({ userSub, role: input.role, by: input.grantedBySub }, 'swarm role granted');
  return toRoleRow(rows[0]);
}

/**
 * @description Removes a role assignment, returning that identity to the default `user`.
 * Refuses to remove root, which would leave the swarm with no root at all — the state this
 * whole feature exists to prevent.
 * @param pool - Postgres pool.
 * @param userSub - the identity to strip.
 * @param bySub - the caller, for the log.
 * @returns true when a row was removed, false when there was nothing to remove.
 * @throws SwarmRoleError 409 when the target holds root.
 */
export async function revokeRole(pool: Pool, userSub: string, bySub: string | null): Promise<boolean> {
  const rootSub = await getRootSubFromStore(pool);
  if (rootSub && rootSub === userSub) {
    throw new SwarmRoleError(409, 'swarm root cannot be revoked — transfer root to another identity first');
  }
  const { rowCount } = await runWithSystemIdentity(() => pool.query(
    'DELETE FROM swarm_roles WHERE user_sub = $1', [userSub],
  ));
  await refreshPrivilegedCache(pool);
  logger.info({ userSub, by: bySub, removed: rowCount }, 'swarm role revoked');
  return (rowCount ?? 0) > 0;
}

/**
 * @description Moves root from its current holder to another identity, atomically. The outgoing
 * root is demoted to `admin` rather than dropped — handing over the swarm should not lock the
 * previous owner out of the machine they still administer.
 *
 * Both writes ride ONE transaction because the partial unique index forbids two roots existing
 * even momentarily: the demote must be visible before the promote lands, and a failure between
 * them must leave the original root intact rather than no root at all.
 *
 * @param pool - Postgres pool.
 * @param input - the new root and the caller performing the transfer.
 * @returns The new root row.
 * @throws SwarmRoleError 409 when root is unclaimed or already held by the target.
 */
export async function transferRoot(
  pool: Pool,
  input: { toSub: string; toEmail?: string | null; toDisplayName?: string | null; bySub: string | null },
): Promise<SwarmRoleRow> {
  const toSub = String(input.toSub ?? '').trim();
  if (!toSub) throw new SwarmRoleError(400, 'a target subject is required');

  const currentRoot = await getRootSubFromStore(pool);
  if (!currentRoot) throw new SwarmRoleError(409, 'swarm root is unclaimed — claim it instead of transferring it');
  if (currentRoot === toSub) throw new SwarmRoleError(409, 'that identity already holds swarm root');

  const row = await runWithSystemIdentity(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE swarm_roles SET role = 'admin', granted_at = NOW() WHERE user_sub = $1`, [currentRoot]);
      const { rows } = await client.query(
        `INSERT INTO swarm_roles (user_sub, email, display_name, role, granted_by_sub, note)
         VALUES ($1, $2, $3, 'root', $4, $5)
         ON CONFLICT (user_sub) DO UPDATE SET role = 'root', email = EXCLUDED.email,
               display_name = EXCLUDED.display_name, granted_by_sub = EXCLUDED.granted_by_sub,
               granted_at = NOW(), note = EXCLUDED.note
         RETURNING user_sub, email, display_name, role, granted_by_sub, granted_at, note`,
        [toSub, input.toEmail ?? null, input.toDisplayName ?? null, input.bySub,
          `root transferred from ${currentRoot}`],
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  await refreshPrivilegedCache(pool);
  logger.warn({ from: currentRoot, to: toSub, by: input.bySub }, 'SWARM ROOT TRANSFERRED');
  return toRoleRow(row);
}
