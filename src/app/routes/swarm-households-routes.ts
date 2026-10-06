/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-8): GET /api/admin/households, every household of the swarm with its members and their roles, for the Swarm Admin households screen. GET /api/tenants answers only the caller's own memberships; an operator reads every oshal_tenants and oshal_tenant_memberships row through the RLS operator arm (migration 060), so this is one query under the request identity, mounted behind requiresOperator. Each household says whether THIS operator may manage it: migration 174's membership fence lets only a household's own admin add or change memberships, with no operator arm, so an operator who is not that household's admin can see it but not change it, and the reply says so instead of letting a screen offer a write the database will refuse. External-identity members (migration 135) are counted per household, since they belong without appearing in the memberships table.
 */

import { Router as createRouter, type Request, type Router } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'swarm-households-routes' });

/** One member of a household. */
export interface HouseholdMember {
  sub: string;
  role: 'admin' | 'member';
  joinedAt: string | null;
}

/** One household as the Swarm Admin screen shows it. */
export interface HouseholdView {
  tenantId: string;
  kind: string;
  name: string | null;
  createdBySub: string | null;
  createdAt: string | null;
  members: HouseholdMember[];
  /** People from an external identity provider who belong to it (migration 135): managed by any swarm admin on the access screen, not here. */
  externalMembers: number;
  /** The caller's own role in it, or null when the caller is not a member. */
  myRole: 'admin' | 'member' | null;
  /** True only when the caller is this household's admin: the one identity the membership fence (migration 174) lets change it. */
  manageable: boolean;
}

interface HouseholdRow {
  tenant_id: string;
  kind: string;
  name: string | null;
  created_by_sub: string | null;
  created_at: string | Date | null;
  member_sub: string | null;
  member_role: string | null;
  member_since: string | Date | null;
}

const toIso = (value: string | Date | null): string | null => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

/**
 * @description Counts the external-identity members per household (oshal_external_tenant_memberships,
 * migration 135, visible to an operator). A deployment without that table answers no counts.
 * @param pool - Postgres pool, identity-stamped per request.
 * @returns tenant id to count.
 */
async function countExternalMembers(pool: Pool): Promise<Map<string, number>> {
  try {
    const result = await pool.query<{ tenant_id: string; n: number }>('SELECT tenant_id, count(*)::int AS n FROM oshal_external_tenant_memberships GROUP BY tenant_id');
    return new Map(result.rows.map((row) => [String(row.tenant_id), Number(row.n)]));
  } catch (err) {
    logger.debug({ err }, 'external tenant memberships not counted (table absent or unreadable)');
    return new Map();
  }
}

/**
 * @description Reads every household the request identity may see (an operator: all of them) with
 * its members, and marks the ones the caller may manage.
 * @param pool - Postgres pool, identity-stamped per request.
 * @param callerSub - The caller's subject, or null.
 * @returns The households, oldest first; members with admins first.
 */
export async function listHouseholds(pool: Pool, callerSub: string | null): Promise<HouseholdView[]> {
  const result = await pool.query<HouseholdRow>(`
    SELECT t.tenant_id, t.kind, t.name, t.created_by_sub, t.created_at,
           m.user_sub AS member_sub, m.role AS member_role, m.created_at AS member_since
      FROM oshal_tenants t
      LEFT JOIN oshal_tenant_memberships m ON m.tenant_id = t.tenant_id
     ORDER BY t.created_at, t.tenant_id, (m.role = 'admin') DESC, m.created_at, m.user_sub
  `);
  const external = await countExternalMembers(pool);
  const households = new Map<string, HouseholdView>();
  for (const row of result.rows) {
    const id = String(row.tenant_id);
    let household = households.get(id);
    if (!household) {
      household = { tenantId: id, kind: String(row.kind), name: row.name, createdBySub: row.created_by_sub, createdAt: toIso(row.created_at), members: [], externalMembers: external.get(id) ?? 0, myRole: null, manageable: false };
      households.set(id, household);
    }
    if (row.member_sub) {
      const role: HouseholdMember['role'] = row.member_role === 'admin' ? 'admin' : 'member';
      household.members.push({ sub: String(row.member_sub), role, joinedAt: toIso(row.member_since) });
      if (callerSub !== null && row.member_sub === callerSub) {
        household.myRole = role;
        household.manageable = role === 'admin';
      }
    }
  }
  return [...households.values()];
}

/**
 * @description Builds the /api/admin/households router. Mounted behind requiresAuth and
 * requiresOperator; the query itself runs under the caller's identity, so the RLS arms decide what
 * is visible and the reply never widens beyond them.
 * @param deps - The pool (null: no database, 503).
 * @returns The router.
 */
export function createSwarmHouseholdsRoutes(deps: { pool: Pool | null }): Router {
  const router = createRouter();
  router.get('/', async (req: Request, res) => {
    if (!deps.pool) {
      res.status(503).json({ error: 'households_unavailable', message: 'This swarm has no database, so it has no households.' });
      return;
    }
    const { sub } = getCaller(req);
    try {
      const households = await listHouseholds(deps.pool, sub);
      res.json({ households, count: households.length, note: "A household's members from this swarm's directory are managed by its own admins: an operator who is not one of them sees them here but cannot add or change them (the membership fence). Members from an external identity provider are managed on the access screen." });
    } catch (err) {
      logger.error({ err }, 'GET /api/admin/households failed');
      res.status(500).json({ error: 'households_unavailable' });
    }
  });
  return router;
}
