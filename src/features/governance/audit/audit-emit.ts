/**
 * Generic, opt-in per-resource audit emitter (enterprise-governance scaffolding).
 *
 * Today's only access trail is routing_audit_log (dispatch anomalies — see
 * src/features/security/audit-trail.ts), which honestly notes that per-resource access-control
 * auditing requires the owning apps to emit rows. THIS is that emitter. An app opts in by calling
 * emitAuditEvent() at a sensitive read/write/decision; nothing is logged for apps that do not.
 *
 * Safety contract: emitAuditEvent NEVER throws into a request path. It self-heals the schema
 * (CREATE TABLE IF NOT EXISTS, idempotent like the project's other self-healing schemas, e.g.
 * security-routes.ts ensureSchema) and swallows-and-logs any error. Audit must not be able to take
 * down the action it is recording.
 *
 * @module features/governance/audit/audit-emit
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { forwardAuditEvent } from './forwarder';

const logger = createChildLogger({ module: 'governance:audit-emit' });

/** An access decision outcome recorded with the event. */
export type AuditDecision = 'allow' | 'deny' | 'info';

export interface AuditEvent {
  /** OIDC sub of the actor; null when unauthenticated/system. */
  actorSub: string | null;
  /** Verb-ish action, e.g. 'ticket.read', 'audit.export', 'vault.read'. */
  action: string;
  /** Resource class, e.g. 'ticket', 'workspace', 'audit_log'. */
  resourceType: string;
  /** Specific resource id (free text/uuid), or null for collection-level actions. */
  resourceId?: string | null;
  /** Outcome of any authorization decision tied to this event. Defaults to 'info'. */
  decision?: AuditDecision;
  /** Arbitrary JSON detail (redact PII before passing). */
  metadata?: Record<string, unknown> | null;
}

export interface AuditQueryFilter {
  actorSub?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  decision?: AuditDecision;
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** ISO timestamp upper bound (exclusive). */
  until?: string;
  limit?: number;
}

export interface AuditRow {
  audit_id: string;
  actor_sub: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  decision: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Per-pool memo so the self-healing DDL runs once per process, not on every emit. This matters now
 * that automatic capture (audit-capture-middleware) calls emitAuditEvent on every mutating request:
 * without the memo each request would re-run CREATE TABLE/INDEX IF NOT EXISTS. A failed first ensure
 * is not memoized, so it retries on the next call.
 */
const schemaEnsured = new WeakSet<Pool>();

/**
 * Idempotent schema for the per-resource audit log. Mirrors the project convention of inline
 * CREATE TABLE IF NOT EXISTS so the table self-heals on first use; safe to call repeatedly (the
 * DDL is skipped after the first successful ensure per pool).
 */
export async function ensureAuditSchema(pool: Pool): Promise<void> {
  if (schemaEnsured.has(pool)) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS access_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_sub TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    decision TEXT NOT NULL DEFAULT 'info',
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_access_audit_actor ON access_audit_log (actor_sub, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_access_audit_resource ON access_audit_log (resource_type, resource_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_access_audit_created ON access_audit_log (created_at DESC)');
  schemaEnsured.add(pool);
}

/**
 * Write one audit event. Best-effort and non-throwing: validates inputs defensively, self-heals
 * the schema, and on ANY failure logs and returns false rather than propagating. Returns true when
 * the row was written.
 */
export async function emitAuditEvent(pool: Pool, event: AuditEvent): Promise<boolean> {
  try {
    if (!event || typeof event.action !== 'string' || typeof event.resourceType !== 'string') {
      logger.warn({ event }, 'emitAuditEvent: invalid event shape, skipping');
      return false;
    }
    const action = event.action.trim();
    const resourceType = event.resourceType.trim();
    if (!action || !resourceType) {
      logger.warn({ event }, 'emitAuditEvent: empty action/resourceType, skipping');
      return false;
    }
    const decision: AuditDecision = event.decision === 'allow' || event.decision === 'deny' ? event.decision : 'info';
    const metadata = event.metadata == null ? null : JSON.stringify(event.metadata);

    await ensureAuditSchema(pool);
    await pool.query(
      `INSERT INTO access_audit_log (actor_sub, action, resource_type, resource_id, decision, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [event.actorSub ?? null, action, resourceType, event.resourceId ?? null, decision, metadata],
    );
    // Best-effort SIEM forward (no-op unless OSHAL_AUDIT_FORWARD_URL is set). Fire-and-forget so
    // collector latency/outage never slows or breaks the request; the forwarder swallows errors.
    void forwardAuditEvent({
      actorSub: event.actorSub ?? null,
      action,
      resourceType,
      resourceId: event.resourceId ?? null,
      decision,
      metadata: event.metadata ?? null,
      timestamp: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    logger.error({ err }, 'emitAuditEvent failed (swallowed; never throws into request path)');
    return false;
  }
}

/** Query audit events for review/export. Owner/operator gating is the caller's responsibility. */
export async function queryAuditEvents(pool: Pool, filter: AuditQueryFilter = {}): Promise<AuditRow[]> {
  await ensureAuditSchema(pool);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    if (val !== undefined && val !== null && val !== '') {
      params.push(val);
      where.push(`${col} = $${params.length}`);
    }
  };
  add('actor_sub', filter.actorSub);
  add('action', filter.action);
  add('resource_type', filter.resourceType);
  add('resource_id', filter.resourceId);
  add('decision', filter.decision);
  if (filter.since) { params.push(filter.since); where.push(`created_at >= $${params.length}`); }
  if (filter.until) { params.push(filter.until); where.push(`created_at < $${params.length}`); }

  const limit = Math.min(Math.max(Number(filter.limit) || 1000, 1), 10000);
  const sql = `SELECT audit_id, actor_sub, action, resource_type, resource_id, decision, metadata, created_at
                 FROM access_audit_log
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY created_at DESC
                LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  return rows as AuditRow[];
}

export interface AuditActivitySummary {
  total: number;
  byAction: Array<{ action: string; count: number; allow: number; deny: number; lastAt: string | null }>;
  byActor: Array<{ actorSub: string | null; count: number }>;
  byResourceType: Array<{ resourceType: string; count: number }>;
}

/**
 * Roll a set of audit rows into an at-a-glance activity summary: counts per action (with
 * allow/deny split and last-seen), per actor, and per resource type. Pure and side-effect-free
 * so it is trivially unit-tested and reusable by any audit-review surface.
 */
export function summarizeAuditActivity(rows: AuditRow[]): AuditActivitySummary {
  const actions = new Map<string, { action: string; count: number; allow: number; deny: number; lastAt: string | null }>();
  const actors = new Map<string, number>();
  const resources = new Map<string, number>();
  for (const row of rows) {
    const a = actions.get(row.action) ?? { action: row.action, count: 0, allow: 0, deny: 0, lastAt: null };
    a.count += 1;
    if (row.decision === 'allow') a.allow += 1;
    if (row.decision === 'deny') a.deny += 1;
    const at = row.created_at == null ? null : String(row.created_at);
    if (at && (!a.lastAt || at > a.lastAt)) a.lastAt = at;
    actions.set(row.action, a);

    const actorKey = row.actor_sub ?? ' anon';
    actors.set(actorKey, (actors.get(actorKey) ?? 0) + 1);
    resources.set(row.resource_type, (resources.get(row.resource_type) ?? 0) + 1);
  }
  const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;
  return {
    total: rows.length,
    byAction: [...actions.values()].sort(byCount),
    byActor: [...actors.entries()]
      .map(([actorSub, count]) => ({ actorSub: actorSub === ' anon' ? null : actorSub, count }))
      .sort(byCount),
    byResourceType: [...resources.entries()]
      .map(([resourceType, count]) => ({ resourceType, count }))
      .sort(byCount),
  };
}
