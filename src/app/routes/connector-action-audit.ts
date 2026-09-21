/**
 * Connector write-action audit READ (the other half of migration 083).
 *
 * The write tier records every attempt in `connector_action_audit` — append-only, params hashed, one
 * row before the provider call and one after. Until now nothing could read it back, so the trail was
 * only reachable with a psql session: a user could not see what was published on their behalf, which
 * makes the approval gate a promise rather than something you can check.
 *
 * GET /api/connectors/actions/audit is that read, and it is CALLER-SCOPED by construction: `user_sub`
 * comes from the OIDC session and is bound into the predicate — never from a query param, a body, or
 * a header. There is deliberately no operator-wide variant here; a cross-user view is a different
 * decision with a different gate.
 *
 * Mounted on the marketplace router (always on, `requiresAuth`) rather than inside the
 * CONNECTOR_SPEC_ROUTES gate: reading what already happened must not depend on whether the write tier
 * is currently switched on.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — caller-scoped read of connector_action_audit with connector/status/limit filters, a per-connector rollup, and the absent-table degrade (no rows, not a 500, so a pre-migration deployment reports honestly).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The spec-route READ tier now shares this trail, so entries carry tier ('read'|'write') and credentialSource, and a ?tier= filter separates them. Without the tier a read would be displayed as a write on a surface whose whole point is showing what was done on the caller's behalf. Falls back to the pre-151 column list when those columns are absent, so a box that has not applied the migration keeps seeing its write trail instead of degrading to an empty one.
 *
 * @module routes/connector-action-audit
 */

import type { Router, Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { callerFromRequest } from '@/features/governance';

const logger = createChildLogger({ module: 'connector-action-audit' });

/** The audit statuses the executor writes. Anything else is rejected as a filter value. */
const AUDIT_STATUSES = new Set([
  'attempt', 'success', 'error', 'not_connected', 'confirmation_required', 'invalid_params', 'unknown_action',
]);

/** The two tiers that share this trail: declared write actions, and spec-route resource reads. */
const AUDIT_TIERS = new Set(['read', 'write']);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CONNECTOR_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Minimal pg surface — trivially mockable, same shape the executor uses. */
export interface AuditReadPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/** One audit row as the surface sees it. `paramsHash` is a hash — raw payloads are never stored. */
export interface ConnectorActionAuditEntry {
  connectorId: string;
  action: string;
  paramsHash: string;
  riskLevel: string | null;
  status: string;
  httpStatus: number | null;
  error: string | null;
  ts: string;
  /** 'read' (spec-route resource call) or 'write' (declared action). Null on pre-151 rows. */
  tier: string | null;
  /** Which credential went out: 'broker' is the caller's own; 'operator-env' is a shared key. */
  credentialSource: string | null;
}

/** Filters a caller may apply to their own trail. `userSub` is never one of them. */
export interface AuditReadOptions {
  connectorId?: string;
  status?: string;
  limit?: number;
  tier?: string;
}

/** The columns every deployment has. tier/credential_source arrived with migration 151. */
const BASE_COLUMNS = 'connector_id, action, params_hash, risk_level, status, http_status, error, ts';

/**
 * @description Run the caller-bound trail query, degrading twice rather than once. A box that has
 * not applied migration 151 has the table but not tier/credential_source: retry on the pre-151
 * columns rather than report an empty trail to a user whose writes are sitting right there. A box
 * that has never applied 083 (and never run a write) has no table at all — that is "nothing has
 * happened yet", not a server fault. A tier filter cannot be honoured without the column, so it
 * yields nothing rather than silently returning every row.
 * @param pool - pg pool (or mock)
 * @param userSub - the caller's OIDC sub, for the log line only (it is already bound in `where`)
 * @param opts - the caller's filters, consulted here only for the tier case
 * @param where - the caller-bound predicate, `user_sub = $1` plus any filters
 * @param params - the bound values, ending with the row limit
 * @returns the raw rows, or an empty array when the trail is unreadable
 */
async function fetchAuditRows(
  pool: AuditReadPool, userSub: string, opts: AuditReadOptions, where: string, params: unknown[],
): Promise<Array<Record<string, unknown>>> {
  const select = (columns: string): string => `SELECT ${columns}
                 FROM connector_action_audit
                WHERE ${where}
                ORDER BY ts DESC
                LIMIT $${params.length}`;
  try {
    return (await pool.query(select(`${BASE_COLUMNS}, tier, credential_source`), params)).rows as Array<Record<string, unknown>>;
  } catch (err) {
    logger.warn({ err, userSub }, 'connector action audit read failed — retrying without the read-tier columns');
    if (opts.tier) return [];
    try {
      return (await pool.query(select(BASE_COLUMNS), params)).rows as Array<Record<string, unknown>>;
    } catch (legacyErr) {
      logger.warn({ err: legacyErr, userSub }, 'connector action audit read failed — reporting an empty trail');
      return [];
    }
  }
}

/**
 * @description Read ONE caller's connector write-action trail, newest first, with a per-connector
 * rollup so a surface can show "3 published, 1 refused" without counting client-side. The caller's
 * sub is bound as $1 in every branch — the only ownership check that exists, exactly as in the token
 * broker, so it must never be built from request data.
 * @param pool - pg pool (or mock)
 * @param userSub - the authenticated caller's OIDC sub
 * @param opts - optional connector/status/tier/limit filters
 * @returns the caller's rows plus a per-connector count rollup
 */
export async function readConnectorActionAudit(
  pool: AuditReadPool, userSub: string, opts: AuditReadOptions = {},
): Promise<{ entries: ConnectorActionAuditEntry[]; byConnector: Record<string, number>; limit: number }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const params: unknown[] = [userSub];
  let where = 'user_sub = $1';
  if (opts.connectorId) { params.push(opts.connectorId); where += ` AND connector_id = $${params.length}`; }
  if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
  if (opts.tier) { params.push(opts.tier); where += ` AND tier = $${params.length}`; }
  params.push(limit);
  const rows = await fetchAuditRows(pool, userSub, opts, where, params);
  const entries = rows.map((r) => ({
    connectorId: String(r.connector_id),
    action: String(r.action),
    paramsHash: String(r.params_hash),
    riskLevel: r.risk_level == null ? null : String(r.risk_level),
    status: String(r.status),
    httpStatus: r.http_status == null ? null : Number(r.http_status),
    error: r.error == null ? null : String(r.error),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    tier: r.tier == null ? null : String(r.tier),
    credentialSource: r.credential_source == null ? null : String(r.credential_source),
  }));
  const byConnector = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.connectorId] = (acc[e.connectorId] ?? 0) + 1;
    return acc;
  }, {});
  return { entries, byConnector, limit };
}

/**
 * @description Register GET /actions/audit on an ALREADY auth-gated router (the marketplace router,
 * mounted at /api/connectors behind requiresAuth). Returns 401 when no caller identity is present, so
 * the route cannot serve rows anonymously even if it is ever mounted somewhere ungated.
 * @param router - the marketplace router
 * @param ctx - app context carrying the pg pool
 * @returns nothing
 */
export function registerConnectorActionAuditRoute(router: Router, ctx: { pool: unknown }): void {
  router.get('/actions/audit', async (req: Request, res: Response) => {
    const sub = callerFromRequest(req)?.sub;
    if (!sub) {
      res.status(401).json({ ok: false, error: 'authenticated caller identity required to read the connector action trail' });
      return;
    }
    const connectorId = String(req.query.connector || '').trim();
    const status = String(req.query.status || '').trim();
    const tier = String(req.query.tier || '').trim();
    if (connectorId && !CONNECTOR_SLUG.test(connectorId)) {
      res.status(400).json({ ok: false, error: 'connector must be a lowercase slug' });
      return;
    }
    if (status && !AUDIT_STATUSES.has(status)) {
      res.status(400).json({ ok: false, error: `status must be one of: ${[...AUDIT_STATUSES].join(', ')}` });
      return;
    }
    if (tier && !AUDIT_TIERS.has(tier)) {
      res.status(400).json({ ok: false, error: `tier must be one of: ${[...AUDIT_TIERS].join(', ')}` });
      return;
    }
    const limitRaw = Number(req.query.limit);
    try {
      const result = await readConnectorActionAudit(ctx.pool as AuditReadPool, sub, {
        connectorId: connectorId || undefined,
        status: status || undefined,
        tier: tier || undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      });
      logger.info({ sub, connectorId: connectorId || null, status: status || null, tier: tier || null, returned: result.entries.length }, 'connector action trail read');
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err, stack: err instanceof Error ? err.stack : undefined, sub }, 'connector action trail read failed');
      res.status(500).json({ ok: false, error: 'could not read the connector action trail' });
    }
  });
}
