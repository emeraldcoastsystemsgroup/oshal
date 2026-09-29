/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: read the location store's row-level-security posture from a live database's catalog, so the running build can be checked where it takes effect (the Test Lab card) with the same rule the static guard applies to the migrations: every location table present, ENABLE and FORCE on, at least one policy, no policy and no function a policy reaches mentioning oshal.is_operator (operator decision Q2), the membership fence, the creator fence and the tenant-admin helper installed, and whether the connecting role is one row-level security applies to at all. Catalog reads only; nothing is written.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: the device identity fence (migration 176, location_device_identity_fence) joins the functions always checked for the operator bypass token, so both the static guard and this catalog read cover it though no policy calls it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5: migration 177's SECURITY DEFINER functions that no policy calls (the restricted-invitation acceptance, the grantee projection, the dispatch marker and the erase's group-rule half) join the always-checked set, so a bypass token in any of them fails the static guard and this catalog read.
 *
 * @module location/services/location-rls-posture
 */

import { createChildLogger } from '@/shared/logger';
import { LOCATION_TABLES } from '../model/location-types';

const log = createChildLogger({ module: 'location-rls-posture' });

/** @description The token whose presence in a location policy or a helper it reaches is a bypass. */
export const LOCATION_OPERATOR_BYPASS_TOKEN = 'is_operator';

/**
 * @description Functions checked even when no location policy names them: the membership and
 * creator fences and the tenant-admin helper, which ADR-169 D3 says decide regardless of is_operator.
 */
export const LOCATION_FENCE_FUNCTIONS: readonly string[] = [
  'oshal_is_tenant_admin', 'oshal_tenant_membership_fence', 'oshal_tenant_creator_fence', 'location_device_identity_fence',
  'location_accept_restricted_invite', 'location_shared_presence', 'location_mark_fire_dispatched',
  'location_erase_session_rule_references',
];

const CALLED_NAME = /\b([a-z_][a-z0-9_]*)\s*\(/gi;

/** @description One location table as the catalog reports it. */
export interface LocationTablePosture {
  table: string;
  present: boolean;
  enabled: boolean;
  forced: boolean;
  policies: number;
}

/** @description The location store's row-level-security posture on one database. */
export interface LocationRlsPosture {
  tables: LocationTablePosture[];
  /** `policy <table>.<name>` or `function <name>` for every place the bypass token appears. */
  bypasses: string[];
  /** Every function whose body was checked. */
  functionsChecked: string[];
  membershipFence: boolean;
  creatorFence: boolean;
  tenantAdminHelper: boolean;
  /** The connecting role, and whether row-level security can apply to it at all. */
  role: { superuser: boolean; bypassRls: boolean };
}

/** The part of a pg Pool or Client this needs. */
export interface LocationCatalogReader {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * @description Follow function calls from a set of texts through the known function bodies.
 * @param roots - Texts to start from (policy expressions).
 * @param seeds - Function names always included when known.
 * @param bodies - Known function bodies by name.
 * @returns Every reachable known function name, sorted.
 */
export function reachableLocationFunctions(roots: readonly string[], seeds: readonly string[], bodies: Map<string, string>): string[] {
  const seen = new Set<string>();
  const queue = seeds.filter((s) => bodies.has(s));
  const enqueueCalls = (text: string): void => {
    for (const m of text.matchAll(CALLED_NAME)) {
      const name = m[1].toLowerCase();
      if (bodies.has(name) && !seen.has(name)) queue.push(name);
    }
  };
  roots.forEach(enqueueCalls);
  while (queue.length) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    enqueueCalls(bodies.get(name) ?? '');
  }
  return [...seen].sort();
}

/**
 * @description Policies on location tables and the bypasses among them and the functions they reach.
 * @param db - A catalog reader.
 * @returns Policy counts per table, the bypass list and the functions checked.
 */
async function policyPosture(db: LocationCatalogReader): Promise<{ counts: Map<string, number>; bypasses: string[]; functionsChecked: string[] }> {
  const policies = (await db.query(`SELECT tablename, policyname, COALESCE(qual, '') AS qual, COALESCE(with_check, '') AS with_check
    FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'location\\_%' ORDER BY tablename, policyname`)).rows;
  const functions = (await db.query(`SELECT p.proname, p.prosrc FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)).rows;
  const bodies = new Map(functions.map((f) => [String(f.proname), String(f.prosrc)]));
  const texts = policies.map((p) => `${String(p.qual)} ${String(p.with_check)}`);
  const counts = new Map<string, number>();
  const bypasses: string[] = [];
  policies.forEach((p, i) => {
    counts.set(String(p.tablename), (counts.get(String(p.tablename)) ?? 0) + 1);
    if (texts[i].includes(LOCATION_OPERATOR_BYPASS_TOKEN)) bypasses.push(`policy ${String(p.tablename)}.${String(p.policyname)}`);
  });
  const functionsChecked = reachableLocationFunctions(texts, LOCATION_FENCE_FUNCTIONS, bodies);
  for (const name of functionsChecked) {
    if ((bodies.get(name) ?? '').includes(LOCATION_OPERATOR_BYPASS_TOKEN)) bypasses.push(`function ${name}`);
  }
  return { counts, bypasses: bypasses.sort(), functionsChecked };
}

/**
 * @description Read the location store's row-level-security posture from the catalog.
 * @param db - A pool or client; catalog reads only.
 * @returns Per-table posture, bypasses, fence presence and the connecting role's RLS exemption.
 */
export async function inspectLocationRlsPosture(db: LocationCatalogReader): Promise<LocationRlsPosture> {
  const started = Date.now();
  const rel = (await db.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
  [[...LOCATION_TABLES]])).rows;
  const byName = new Map(rel.map((r) => [String(r.relname), r]));
  const { counts, bypasses, functionsChecked } = await policyPosture(db);
  const tables = LOCATION_TABLES.map((table) => ({
    table,
    present: byName.has(table),
    enabled: byName.get(table)?.relrowsecurity === true,
    forced: byName.get(table)?.relforcerowsecurity === true,
    policies: counts.get(table) ?? 0,
  }));
  const triggers = (await db.query(`SELECT t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal
    AND t.tgname IN ('oshal_tenant_membership_fence', 'oshal_tenant_creator_fence')`)).rows.map((r) => String(r.tgname));
  const helper = (await db.query(`SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'oshal_is_tenant_admin'`)).rows[0];
  const role = (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0] ?? {};
  log.debug({ op: 'inspect-rls-posture', count: tables.length, durationMs: Date.now() - started }, 'location rls posture read');
  return {
    tables, bypasses, functionsChecked,
    membershipFence: triggers.includes('oshal_tenant_membership_fence'),
    creatorFence: triggers.includes('oshal_tenant_creator_fence'),
    tenantAdminHelper: Number(helper?.count ?? 0) > 0,
    role: { superuser: role.rolsuper === true, bypassRls: role.rolbypassrls === true },
  };
}
