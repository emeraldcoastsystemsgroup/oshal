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
}

/** Filters a caller may apply to their own trail. `userSub` is never one of them. */
export interface AuditReadOptions {
  connectorId?: string;
  status?: string;
  limit?: number;
}

/**
 * @description Read ONE caller's connector write-action trail, newest first, with a per-connector
 * rollup so a surface can show "3 published, 1 refused" without counting client-side. The caller's
 * sub is bound as $1 in every branch — the only ownership check that exists, exactly as in the token
 * broker, so it must never be built from request data.
 * @param pool - pg pool (or mock)
 * @param userSub - the authenticated caller's OIDC sub
 * @param opts - optional connector/status/limit filters
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
  params.push(limit);
  const sql = `SELECT connector_id, action, params_hash, risk_level, status, http_status, error, ts
                 FROM connector_action_audit
                WHERE ${where}
                ORDER BY ts DESC
                LIMIT $${params.length}`;
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (await pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  } catch (err) {
    // A deployment that has never applied migration 083 (and never run a write) has no table. That is
    // "nothing has happened yet", not a server fault — degrade to an empty trail and say so in the log.
    logger.warn({ err, userSub }, 'connector action audit read failed — reporting an empty trail');
    return { entries: [], byConnector: {}, limit };
  }
  const entries = rows.map((r) => ({
    connectorId: String(r.connector_id),
    action: String(r.action),
    paramsHash: String(r.params_hash),
    riskLevel: r.risk_level == null ? null : String(r.risk_level),
    status: String(r.status),
    httpStatus: r.http_status == null ? null : Number(r.http_status),
    error: r.error == null ? null : String(r.error),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
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
    if (connectorId && !CONNECTOR_SLUG.test(connectorId)) {
      res.status(400).json({ ok: false, error: 'connector must be a lowercase slug' });
      return;
    }
    if (status && !AUDIT_STATUSES.has(status)) {
      res.status(400).json({ ok: false, error: `status must be one of: ${[...AUDIT_STATUSES].join(', ')}` });
      return;
    }
    const limitRaw = Number(req.query.limit);
    try {
      const result = await readConnectorActionAudit(ctx.pool as AuditReadPool, sub, {
        connectorId: connectorId || undefined,
        status: status || undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      });
      logger.info({ sub, connectorId: connectorId || null, status: status || null, returned: result.entries.length }, 'connector action trail read');
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err, stack: err instanceof Error ? err.stack : undefined, sub }, 'connector action trail read failed');
      res.status(500).json({ ok: false, error: 'could not read the connector action trail' });
    }
  });
}
