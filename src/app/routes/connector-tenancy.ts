/**
 * Connector tenancy — personal + shared (household) ownership for connections.
 *
 * Implements ADR-042 Phase 1 (app-layer; RLS is Phase 2). A connection in
 * `oshal_connections` is owned EITHER by a user (`tenant_id IS NULL`, personal —
 * the original behavior) OR by a tenant (`tenant_id` set, shared — every member of
 * that tenant may use it). A "tenant" here is usually a `space` (household): a
 * lightweight membership grouping inside the existing realm (NOT ADR-035's
 * realm-per-tenant `org`).
 *
 * Access for a caller = their personal connections ∪ the connections of every
 * tenant they belong to. This module owns the schema, the resolution, and the
 * upsert (so connectors-routes.ts stays under the file-size cap and the partial-
 * index ON CONFLICT logic lives in one place).
 *
 * Backward-compatible: `tenant_id` defaults NULL, so existing personal connections
 * are unaffected and resolution falls back to exactly the old per-user behavior.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-042 Phase 1: oshal_tenants + oshal_tenant_memberships, tenant_id/connected_by_sub on oshal_connections, partial unique indexes (personal vs shared), personal∪shared resolution (household-first), tenant-aware upsert, and minimal household management helpers.
 */

import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { reconcilePerUserSchedules } from '../per-user-schedule-reconcile';

const logger = createChildLogger({ module: 'connector-tenancy' });

/** A connection row as resolved for access (decryption is the caller's job). */
export interface ConnectionRow {
  connection_id: string;
  user_sub: string;
  connected_by_sub: string | null;
  tenant_id: string | null;
  provider: string;
  label: string | null;
  account_key: string | null;
  is_default: boolean;
  account_email: string | null;
  account_id: string | null;
  scopes: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expiry: Date | null;
}

/** How a caller/bot picks among several connections for one provider. All optional;
 *  `connectionId` wins, then `label` (case-insensitive), then `email`, then `tenantId`. */
export interface ConnectionSelector {
  tenantId?: string;
  label?: string;
  email?: string;
  connectionId?: string;
}

/** A tenant (household/space or org) the caller belongs to. */
export interface TenantSummary {
  tenant_id: string;
  kind: string;
  name: string | null;
  role: string;
}

const CONN_COLS =
  'connection_id, user_sub, connected_by_sub, tenant_id, provider, label, account_key, is_default, account_email, account_id, scopes, access_token, refresh_token, expiry';

/**
 * @description Create/upgrade the tenancy schema. Idempotent; safe to call on every
 * boot. Adds the tenant tables, the `tenant_id`/`connected_by_sub` columns, and swaps
 * the old `UNIQUE(user_sub, provider)` for two partial unique indexes (personal vs
 * shared) so a user can hold BOTH a personal and a shared connection for one provider.
 * @param pool - pg pool
 */
export async function ensureTenancySchema(pool: any): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'connector tenancy',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_tenants (
        tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind VARCHAR(16) NOT NULL DEFAULT 'space',
        name TEXT,
        created_by_sub TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS oshal_tenant_memberships (
        tenant_id UUID NOT NULL REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
        user_sub TEXT NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, user_sub)
      )`,
      'ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS tenant_id UUID',
      'ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS connected_by_sub TEXT',
      'ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS label TEXT',
      'ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS account_key TEXT',
      'ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE',
      "UPDATE oshal_connections SET account_key = COALESCE(NULLIF(account_id,''), NULLIF(account_email,''), 'default') WHERE account_key IS NULL",
      "UPDATE oshal_connections SET label = COALESCE(NULLIF(account_email,''), 'default') WHERE label IS NULL",
      'ALTER TABLE oshal_connections DROP CONSTRAINT IF EXISTS oshal_connections_user_sub_provider_key',
      'DROP INDEX IF EXISTS oshal_conn_personal_uq',
      'DROP INDEX IF EXISTS oshal_conn_shared_uq',
      'CREATE UNIQUE INDEX IF NOT EXISTS oshal_conn_personal_acct_uq ON oshal_connections (user_sub, provider, account_key) WHERE tenant_id IS NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS oshal_conn_shared_acct_uq ON oshal_connections (tenant_id, provider, account_key) WHERE tenant_id IS NOT NULL',
    ],
    requirements: [
      { table: 'oshal_tenants', columns: ['tenant_id', 'kind', 'name', 'created_by_sub', 'created_at'] },
      { table: 'oshal_tenant_memberships', columns: ['tenant_id', 'user_sub', 'role', 'created_at'] },
      { table: 'oshal_connections', columns: ['tenant_id', 'connected_by_sub', 'label', 'account_key', 'is_default'] },
    ],
  });
}

/** @description Tenant ids the user belongs to. @param pool @param userSub @returns id array */
export async function getUserTenantIds(pool: any, userSub: string): Promise<string[]> {
  const rows = (await pool.query('SELECT tenant_id FROM oshal_tenant_memberships WHERE user_sub = $1', [userSub])).rows;
  return rows.map((r: any) => String(r.tenant_id));
}

/**
 * @description Every connection the caller may use for a provider — their personal one
 * (tenant_id NULL) plus any owned by a tenant they belong to. Newest first.
 * @param pool @param userSub @param provider - optional provider filter
 * @returns visible connection rows
 */
export async function accessibleConnections(pool: any, userSub: string, provider?: string): Promise<ConnectionRow[]> {
  const tenantIds = await getUserTenantIds(pool, userSub);
  const params: any[] = [userSub, tenantIds];
  let sql = `SELECT ${CONN_COLS} FROM oshal_connections
     WHERE ((user_sub = $1 AND tenant_id IS NULL) OR tenant_id = ANY($2::uuid[]))`;
  if (provider) { params.push(provider); sql += ` AND provider = $3`; }
  sql += ' ORDER BY updated_at DESC';
  return (await pool.query(sql, params)).rows as ConnectionRow[];
}

/**
 * @description Resolve the ONE connection to act on for (caller, provider). With a
 * `tenantId` opt, returns that tenant's connection (or null). Otherwise household-first:
 * a shared connection if any, else the personal one. Returns null if none accessible.
 * @param pool @param userSub @param provider @param opts - { tenantId?: 'personal' | <uuid> }
 * @returns the chosen row or null
 */
export async function resolveConnectionRow(
  pool: any, userSub: string, provider: string, opts?: ConnectionSelector,
): Promise<ConnectionRow | null> {
  let rows = await accessibleConnections(pool, userSub, provider);
  if (!rows.length) return null;
  // Narrow by ownership scope if asked ('personal' or a specific household).
  if (opts?.tenantId === 'personal') rows = rows.filter((r) => r.tenant_id == null);
  else if (opts?.tenantId) rows = rows.filter((r) => String(r.tenant_id) === opts.tenantId);
  if (!rows.length) return null;
  // Explicit selectors (the bot's "work email" / "lake house" → label or email). A named
  // selector with no match returns null so the caller/bot can ask rather than guess.
  if (opts?.connectionId) return rows.find((r) => r.connection_id === opts.connectionId) || null;
  if (opts?.label) {
    const l = opts.label.trim().toLowerCase();
    return rows.find((r) => (r.label || '').trim().toLowerCase() === l) || null;
  }
  if (opts?.email) {
    const e = opts.email.trim().toLowerCase();
    return rows.find((r) => (r.account_email || '').trim().toLowerCase() === e) || null;
  }
  // Nothing specified: explicit default → single → household-first/newest (back-compat).
  return rows.find((r) => r.is_default) || (rows.length === 1 ? rows[0]
    : (rows.find((r) => r.tenant_id != null) || rows[0]));
}

/** @description Are there multiple accessible connections for this provider (so a bare
 *  request is ambiguous and the bot should ask which)? */
export async function connectionCount(pool: any, userSub: string, provider: string): Promise<number> {
  return (await accessibleConnections(pool, userSub, provider)).length;
}

/** @description The sub whose DEK encrypts a row's tokens (grantor for shared, else owner). */
export function ownerSub(row: { connected_by_sub: string | null; user_sub: string }): string {
  return row.connected_by_sub || row.user_sub;
}

/**
 * @description Tenant-aware upsert of a connection. Personal (no tenantId) conflicts on
 * (user_sub, provider); shared conflicts on (tenant_id, provider). Centralizes the
 * partial-index ON CONFLICT so callers just pass the resolved fields.
 */
export async function upsertConnection(pool: any, c: {
  userSub: string; userEmail: string; provider: string; accountEmail: string | null;
  accountId: string | null; scopes: string; encAccess: string | null; encRefresh: string | null;
  expiry: Date | null; tenantId?: string | null; connectedBySub: string; label?: string | null;
}): Promise<void> {
  const shared = !!c.tenantId;
  // Uniqueness is per ACCOUNT (account_key) — re-connecting the same account updates it;
  // a different account adds a new labeled connection.
  const accountKey = c.accountId || c.accountEmail || c.label || 'default';
  const label = (c.label && c.label.trim()) || c.accountEmail || 'default';
  const conflict = shared ? '(tenant_id, provider, account_key) WHERE tenant_id IS NOT NULL'
                          : '(user_sub, provider, account_key) WHERE tenant_id IS NULL';
  await pool.query(
    `INSERT INTO oshal_connections
       (user_sub, user_email, provider, account_email, account_id, scopes, access_token,
        refresh_token, expiry, tenant_id, connected_by_sub, label, account_key, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'connected',NOW())
     ON CONFLICT ${conflict} DO UPDATE SET
       account_email = EXCLUDED.account_email, account_id = EXCLUDED.account_id, scopes = EXCLUDED.scopes,
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, oshal_connections.refresh_token),
       expiry = EXCLUDED.expiry, connected_by_sub = EXCLUDED.connected_by_sub,
       -- preserve the user's existing label on a silent re-auth (no new label given)
       label = COALESCE(NULLIF($12, ''), oshal_connections.label),
       status = 'connected', updated_at = NOW()`,
    [c.userSub, c.userEmail, c.provider, c.accountEmail, c.accountId, c.scopes, c.encAccess,
     c.encRefresh, c.expiry, c.tenantId || null, c.connectedBySub, label, accountKey],
  );
  // Connecting an account may activate per-user "polls" that loaded apps declared
  // (manifest schedules with scope:'per-user' + requiresConnection===provider).
  // Fire-and-forget — never blocks or fails the connection write.
  reconcilePerUserSchedules(c.userSub, c.provider);
}

/** @description Rename a connection's label and/or set it as the provider default for the
 *  caller. Caller must own the personal connection or be a member of the shared tenant. */
export async function relabelConnection(
  pool: any, userSub: string, connectionId: string, opts: { label?: string; makeDefault?: boolean },
): Promise<boolean> {
  const rows = await accessibleConnections(pool, userSub);
  const row = rows.find((r) => r.connection_id === connectionId);
  if (!row) return false;
  if (typeof opts.label === 'string' && opts.label.trim()) {
    await pool.query('UPDATE oshal_connections SET label = $2, updated_at = NOW() WHERE connection_id = $1', [connectionId, opts.label.trim()]);
  }
  if (opts.makeDefault) {
    // One default per provider within the same ownership scope (personal or this tenant).
    const scope = row.tenant_id ? 'tenant_id = $2' : 'user_sub = $2 AND tenant_id IS NULL';
    const scopeVal = row.tenant_id || userSub;
    await pool.query(`UPDATE oshal_connections SET is_default = FALSE WHERE provider = $1 AND ${scope}`, [row.provider, scopeVal]);
    await pool.query('UPDATE oshal_connections SET is_default = TRUE WHERE connection_id = $1', [connectionId]);
  }
  return true;
}

/** @description Is the user an admin of this tenant? (gate for member management) */
export async function isTenantAdmin(pool: any, tenantId: string, userSub: string): Promise<boolean> {
  const r = (await pool.query(
    "SELECT 1 FROM oshal_tenant_memberships WHERE tenant_id = $1 AND user_sub = $2 AND role = 'admin'",
    [tenantId, userSub],
  )).rows[0];
  return !!r;
}

/** @description Is the user a member (any role) of this tenant? */
export async function isTenantMember(pool: any, tenantId: string, userSub: string): Promise<boolean> {
  const r = (await pool.query(
    'SELECT 1 FROM oshal_tenant_memberships WHERE tenant_id = $1 AND user_sub = $2',
    [tenantId, userSub],
  )).rows[0];
  return !!r;
}

/** @description Create a tenant (default kind 'space'/household) and make the creator its admin. */
export async function createTenant(
  pool: any, opts: { name: string; createdBySub: string; kind?: string },
): Promise<TenantSummary> {
  const t = (await pool.query(
    'INSERT INTO oshal_tenants (kind, name, created_by_sub) VALUES ($1,$2,$3) RETURNING tenant_id, kind, name',
    [opts.kind || 'space', opts.name, opts.createdBySub],
  )).rows[0];
  await pool.query(
    "INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING",
    [t.tenant_id, opts.createdBySub],
  );
  logger.info({ tenantId: t.tenant_id, kind: t.kind, by: opts.createdBySub }, 'Tenant created');
  return { tenant_id: String(t.tenant_id), kind: t.kind, name: t.name, role: 'admin' };
}

/** @description Add a member to a tenant (caller must be an admin). Throws if not authorized. */
export async function addMember(
  pool: any, tenantId: string, memberSub: string, byUserSub: string, role = 'member',
): Promise<void> {
  if (!(await isTenantAdmin(pool, tenantId, byUserSub))) throw new Error('not a tenant admin');
  await pool.query(
    `INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, user_sub) DO UPDATE SET role = EXCLUDED.role`,
    [tenantId, memberSub, role === 'admin' ? 'admin' : 'member'],
  );
  logger.info({ tenantId, memberSub, role, by: byUserSub }, 'Tenant member added');
}

/** @description Members of a tenant (admins first). Caller-visibility is the route's job. */
export async function listTenantMembers(pool: any, tenantId: string): Promise<Array<{ user_sub: string; role: string }>> {
  const rows = (await pool.query(
    "SELECT user_sub, role FROM oshal_tenant_memberships WHERE tenant_id = $1 ORDER BY (role = 'admin') DESC, created_at",
    [tenantId],
  )).rows;
  return rows.map((r: any) => ({ user_sub: String(r.user_sub), role: String(r.role) }));
}

/**
 * @description Remove a member from a tenant (caller must be an admin). Refuses to strand the
 * tenant without an admin (cannot remove the last admin). Throws if not authorized.
 */
export async function removeMember(pool: any, tenantId: string, memberSub: string, byUserSub: string): Promise<void> {
  if (!(await isTenantAdmin(pool, tenantId, byUserSub))) throw new Error('not a tenant admin');
  const target = (await pool.query(
    'SELECT role FROM oshal_tenant_memberships WHERE tenant_id = $1 AND user_sub = $2', [tenantId, memberSub],
  )).rows[0];
  if (!target) return;
  if (String(target.role) === 'admin') {
    const admins = (await pool.query(
      "SELECT count(*)::int AS n FROM oshal_tenant_memberships WHERE tenant_id = $1 AND role = 'admin'", [tenantId],
    )).rows[0].n;
    if (admins <= 1) throw new Error('cannot remove the last admin');
  }
  await pool.query('DELETE FROM oshal_tenant_memberships WHERE tenant_id = $1 AND user_sub = $2', [tenantId, memberSub]);
  logger.info({ tenantId, memberSub, by: byUserSub }, 'Tenant member removed');
}

/**
 * @description Change a member's role (caller must be an admin). Refuses to demote the last
 * admin (a tenant must always keep at least one). Throws if unauthorized or member missing.
 */
export async function setMemberRole(
  pool: any, tenantId: string, memberSub: string, role: string, byUserSub: string,
): Promise<void> {
  if (!(await isTenantAdmin(pool, tenantId, byUserSub))) throw new Error('not a tenant admin');
  const newRole = role === 'admin' ? 'admin' : 'member';
  if (newRole === 'member') {
    const target = (await pool.query(
      'SELECT role FROM oshal_tenant_memberships WHERE tenant_id = $1 AND user_sub = $2', [tenantId, memberSub],
    )).rows[0];
    if (target && String(target.role) === 'admin') {
      const admins = (await pool.query(
        "SELECT count(*)::int AS n FROM oshal_tenant_memberships WHERE tenant_id = $1 AND role = 'admin'", [tenantId],
      )).rows[0].n;
      if (admins <= 1) throw new Error('cannot demote the last admin');
    }
  }
  const result = await pool.query(
    'UPDATE oshal_tenant_memberships SET role = $3 WHERE tenant_id = $1 AND user_sub = $2',
    [tenantId, memberSub, newRole],
  );
  if (!result.rowCount) throw new Error('member not found');
  logger.info({ tenantId, memberSub, role: newRole, by: byUserSub }, 'Tenant member role changed');
}

/** @description Tenants the user belongs to, with their role. */
export async function listUserTenants(pool: any, userSub: string): Promise<TenantSummary[]> {
  const rows = (await pool.query(
    `SELECT t.tenant_id, t.kind, t.name, m.role
       FROM oshal_tenant_memberships m JOIN oshal_tenants t ON t.tenant_id = m.tenant_id
      WHERE m.user_sub = $1 ORDER BY t.created_at`,
    [userSub],
  )).rows;
  return rows.map((r: any) => ({ tenant_id: String(r.tenant_id), kind: r.kind, name: r.name, role: r.role }));
}
