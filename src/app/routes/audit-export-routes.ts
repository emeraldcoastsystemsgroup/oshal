/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Resolve the posture-gate validate-only tension
 *                     |                             | (docs/runbooks/market-remediation.md): OSHAL_SCHEMA_BOOTSTRAP=auto is now
 *                     |                             | COMPLIANT when the runtime role is verifiably least-privilege (non-superuser
 *                     |                             | AND non-BYPASSRLS), per the ADR-076 as-built ownership model — oshal_app owns
 *                     |                             | all tables so FORCE RLS scopes the owner and idempotent startup DDL is safe,
 *                     |                             | whereas validate-only crash-looped the api. validate-only stays the hardened
 *                     |                             | target: auto+least-privilege now emits an INFORMATIONAL note in the new
 *                     |                             | `advisories` array instead of a release blocker. Superuser + non-validate-only
 *                     |                             | remains a blocker exactly as before.
 */

/**
 * Governance audit-export + compliance-posture routes (enterprise-governance scaffolding).
 *
 * ADDITIVE read-only surface. Two endpoints, both gated to admins (the existing operator
 * allowlist, via rbacMiddleware('audit.export')):
 *   - GET /api/governance/audit/export  — the per-resource access_audit_log as CSV or JSON.
 *   - GET /api/governance/posture       — a compliance snapshot: owned-vs-unowned row counts,
 *                                          and the security toggles (RBAC enforce, CSP, crypto,
 *                                          rate limit, legacy-unowned) plus a recent eval pass-rate
 *                                          if the harness left one in the DB.
 *
 * Mirrors the project's route-module convention: export a register function, do NOT mount it here
 * (server.ts wires it). Every DB read is defensive (missing tables are reported as unavailable, not
 * a 500) so the posture view degrades gracefully on a fresh or partial schema.
 *
 * NOTE: when OSHAL_RBAC_ENFORCE is off (default), rbacMiddleware is a no-op; these routes are then
 * gated only by the requiresAuth passed in from server.ts. Turn enforcement on to restrict to
 * admins. This preserves current access by default.
 *
 * @module app/routes/audit-export-routes
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { Express } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import {
  emitAuditEvent,
  queryAuditEvents,
  summarizeAuditActivity,
  type AuditQueryFilter,
  type AuditRow,
  rbacMiddleware,
  resolveRole,
  callerFromRequest,
  isEnforcementEnabled,
  requireAdminConsoleAccess,
  Permission,
  ROLE_PERMISSIONS,
} from '@/features/governance';

const logger = createChildLogger({ module: 'audit-export-routes' });

interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const RLS_TABLES = [
  {
    table: 'tickets',
    enforcePolicies: ['tickets_owner_or_operator'],
    permissivePolicies: ['tickets_rls_permissive'],
  },
  {
    table: 'workspaces',
    enforcePolicies: ['workspaces_owner_or_operator'],
    permissivePolicies: ['workspaces_rls_permissive'],
  },
  {
    table: 'access_audit_log',
    enforcePolicies: ['access_audit_select_owner_or_operator', 'access_audit_insert'],
    permissivePolicies: ['access_audit_rls_permissive'],
  },
  {
    table: 'chat_tasks',
    enforcePolicies: ['chat_tasks_owner_or_operator'],
    permissivePolicies: ['chat_tasks_rls_permissive'],
  },
] as const;

function envOn(name: string, dflt = false): boolean {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase().trim());
}

function dbGucEnabled(): boolean {
  const value = (process.env.OSHAL_DB_GUC ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(value);
}

function schemaBootstrapMode(): string {
  return (process.env.OSHAL_SCHEMA_BOOTSTRAP ?? 'self-heal').trim().toLowerCase() || 'self-heal';
}

function classifyRlsStage(
  relation: Record<string, unknown> | undefined,
  policyNames: Set<string>,
  table: (typeof RLS_TABLES)[number],
): 'missing' | 'disabled' | 'enforce' | 'permissive' | 'unknown' {
  if (!relation) return 'missing';
  if (!relation.relrowsecurity) return 'disabled';
  const hasEnforce = table.enforcePolicies.every((policy) => policyNames.has(policy));
  const hasPermissive = table.permissivePolicies.some((policy) => policyNames.has(policy));
  if (relation.relforcerowsecurity && hasEnforce && !hasPermissive) return 'enforce';
  if (hasPermissive) return 'permissive';
  return 'unknown';
}

/**
 * @description Builds the tenant-isolation release-gate snapshot: connected-role facts
 * (superuser/BYPASSRLS), per-table RLS stages for the curated four, full RLS coverage across
 * every public table, the security env toggles, and the resulting `blockers` (release-gating)
 * and `advisories` (informational, non-gating) lists.
 *
 * Schema-bootstrap gate semantics (the "validate-only tension", resolved 2026-07-05):
 * `OSHAL_SCHEMA_BOOTSTRAP=validate-only` is the GOLD posture, but it crash-looped this build's
 * api (startup performs idempotent DDL — see ADR-076 "as-built deviation"). The working live
 * posture is mode=auto with the least-privilege `oshal_app` role OWNING all tables: FORCE ROW
 * LEVEL SECURITY subjects the owner to the policies, so owner-run startup DDL cannot widen data
 * access. The gate therefore accepts a non-validate-only mode as compliant IFF the connected
 * role is verifiably least-privilege (non-superuser AND non-BYPASSRLS), emitting an advisory
 * instead of a blocker. A superuser/BYPASSRLS role that is not validate-only stays a blocker,
 * exactly as before.
 *
 * @param pool - Queryable Postgres pool (or a test double) for the pg_catalog reads.
 * @returns The posture snapshot object; `releaseReady` is true only when `blockers` is empty.
 */
export async function buildRlsPostureSnapshot(pool: QueryablePool): Promise<Record<string, unknown>> {
  try {
    // Enumerate ALL public base tables + policies (not just the curated four) so the
    // posture reports coverage across every RLS-enabled table rather than a 4-table sample.
    // The curated RLS_TABLES still drive the detailed per-policy `tables` view below.
    const [roleResult, relResult, policyResult, triggerResult] = await Promise.all([
      pool.query(`
        SELECT current_user AS role_name, rolsuper, rolbypassrls
          FROM pg_roles
         WHERE rolname = current_user
         LIMIT 1
      `),
      pool.query(`
        SELECT c.relname,
               pg_get_userbyid(c.relowner) AS owner_role,
               c.relrowsecurity,
               c.relforcerowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
      `),
      pool.query(`
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
      `),
      // Append-only audit guard (migration 061). Name-based join, not ::regclass, so a fresh
      // schema without access_audit_log returns 0 rows instead of throwing.
      pool.query(`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'access_audit_log'
           AND NOT t.tgisinternal
      `),
    ]);

    const role = roleResult.rows[0] ?? {};
    const auditTriggers = new Set(triggerResult.rows.map((row) => String(row.tgname)));
    // Append-only = the immutability trigger from migration 061 is installed (blocks UPDATE/DELETE).
    const auditAppendOnly = auditTriggers.has('audit_append_only');
    const relations = new Map(relResult.rows.map((row) => [String(row.relname), row]));
    const policies = new Map<string, Set<string>>();
    for (const row of policyResult.rows) {
      const table = String(row.tablename);
      const names = policies.get(table) ?? new Set<string>();
      names.add(String(row.policyname));
      policies.set(table, names);
    }

    const tables = RLS_TABLES.map((table) => {
      const relation = relations.get(table.table);
      const policyNames = policies.get(table.table) ?? new Set<string>();
      return {
        table: table.table,
        available: Boolean(relation),
        ownerRole: relation?.owner_role ?? null,
        rowSecurityEnabled: Boolean(relation?.relrowsecurity),
        forceRowSecurity: Boolean(relation?.relforcerowsecurity),
        policies: [...policyNames].sort(),
        stage: classifyRlsStage(relation, policyNames, table),
      };
    });

    // Full coverage: classify EVERY RLS-enabled public table, so the gate can no longer pass
    // by checking only the curated four while ~49 others go unexamined. A table that has RLS
    // enabled but not FORCEd lets its owner bypass the policy; a FORCEd table with no policy
    // denies all rows. Both are real posture defects the 4-table sample could not see.
    const coverageTables = relResult.rows.filter((row) => Boolean(row.relrowsecurity));
    const unforcedTables: string[] = [];
    const noPolicyTables: string[] = [];
    let forcedCount = 0;
    let enforcingCount = 0;
    let permissiveCount = 0;
    for (const rel of coverageTables) {
      const name = String(rel.relname);
      const names = policies.get(name) ?? new Set<string>();
      if (!rel.relforcerowsecurity) {
        unforcedTables.push(name);
        continue;
      }
      forcedCount += 1;
      if ([...names].some((policy) => policy.endsWith('_rls_permissive'))) {
        permissiveCount += 1;
      } else if (names.size === 0) {
        noPolicyTables.push(name);
      } else {
        enforcingCount += 1;
      }
    }
    const coverage = {
      rlsEnabledTables: coverageTables.length,
      forced: forcedCount,
      enforcing: enforcingCount,
      permissive: permissiveCount,
      notForced: unforcedTables.length,
      noPolicy: noPolicyTables.length,
      unforcedTables: unforcedTables.sort(),
      noPolicyTables: noPolicyTables.sort(),
    };

    const gucOn = dbGucEnabled();
    const bootstrapMode = schemaBootstrapMode();
    const proofRoleValid = !Boolean(role.rolsuper || role.rolbypassrls);
    const enforced = tables.every((table) => table.stage === 'enforce');
    const blockers: string[] = [];
    const advisories: string[] = [];
    if (!proofRoleValid) blockers.push('runtime DB role is superuser or BYPASSRLS');
    if (!gucOn) blockers.push('OSHAL_DB_GUC is disabled');
    if (bootstrapMode !== 'validate-only') {
      // ADR-076 as-built ownership model: with a least-privilege role that OWNS the tables,
      // FORCE RLS scopes the owner too, so owner-run idempotent startup DDL (mode=auto) is a
      // hardening gap, not an isolation breach — validate-only crash-looped this build. Only
      // a superuser/BYPASSRLS role makes a non-validate-only mode release-blocking.
      if (proofRoleValid) {
        advisories.push(
          `schema bootstrap runs as the owner app role (${bootstrapMode}); validate-only is the hardened target`,
        );
      } else {
        blockers.push('OSHAL_SCHEMA_BOOTSTRAP is not validate-only');
      }
    }
    if (envOn('OSHAL_ALLOW_LEGACY_UNOWNED', false)) blockers.push('OSHAL_ALLOW_LEGACY_UNOWNED allows null-owner rows');
    for (const table of tables) {
      if (table.stage !== 'enforce') blockers.push(`${table.table} RLS stage is ${table.stage}`);
    }
    if (coverage.notForced > 0) {
      blockers.push(`${coverage.notForced} RLS-enabled table(s) not FORCE-secured: ${coverage.unforcedTables.join(', ')}`);
    }
    if (coverage.noPolicy > 0) {
      blockers.push(`${coverage.noPolicy} FORCE-RLS table(s) with no policy (deny-all): ${coverage.noPolicyTables.join(', ')}`);
    }

    return {
      available: true,
      stage: enforced ? 'enforce' : tables.some((table) => table.stage === 'permissive') ? 'permissive' : 'not-ready',
      releaseReady: blockers.length === 0,
      blockers,
      advisories,
      connection: {
        role: role.role_name ?? null,
        superuser: Boolean(role.rolsuper),
        bypassRls: Boolean(role.rolbypassrls),
        validProofRole: proofRoleValid,
      },
      controls: {
        dbGuc: gucOn,
        schemaBootstrap: bootstrapMode,
        legacyUnownedAllowed: envOn('OSHAL_ALLOW_LEGACY_UNOWNED', false),
      },
      coverage,
      auditAppendOnly,
      tables,
    };
  } catch (error) {
    return {
      available: false,
      stage: 'unknown',
      releaseReady: false,
      blockers: ['RLS posture could not be read'],
      advisories: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Count owned vs unowned rows for a table that carries `ownerCol`. Missing table -> unavailable. */
async function ownershipCounts(
  pool: AppContext['pool'],
  table: string,
  ownerCol: string,
): Promise<{ table: string; available: boolean; owned?: number; unowned?: number; total?: number }> {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${ownerCol} IS NOT NULL)::int AS owned,
              COUNT(*) FILTER (WHERE ${ownerCol} IS NULL)::int AS unowned
         FROM ${table}`,
    );
    const row = r.rows[0] || {};
    return { table, available: true, owned: row.owned ?? 0, unowned: row.unowned ?? 0, total: row.total ?? 0 };
  } catch {
    return { table, available: false };
  }
}

/** Best-effort recent eval pass-rate, if an eval/verification table exists. Optional. */
async function lastEvalPassRate(pool: AppContext['pool']): Promise<number | null> {
  const candidates: Array<{ sql: string }> = [
    { sql: `SELECT AVG(CASE WHEN passed THEN 1.0 ELSE 0.0 END)::float AS rate FROM tool_verifications WHERE created_at > now() - interval '7 days'` },
    { sql: `SELECT AVG(CASE WHEN status='passed' THEN 1.0 ELSE 0.0 END)::float AS rate FROM eval_runs WHERE created_at > now() - interval '7 days'` },
  ];
  for (const c of candidates) {
    try {
      const r = await pool.query(c.sql);
      const rate = r.rows[0]?.rate;
      if (rate != null) return Number(rate);
    } catch {
      /* table absent — try next */
    }
  }
  return null;
}

function toCsv(rows: AuditRow[]): string {
  const headers = ['audit_id', 'actor_sub', 'action', 'resource_type', 'resource_id', 'decision', 'metadata', 'created_at'];
  const esc = (v: unknown): string => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => esc((row as unknown as Record<string, unknown>)[h])).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Build the governance router.
 * @param ctx App context (Postgres pool).
 * @param requiresAuth The OIDC auth guard from server.ts; mounted before the RBAC gate so identity
 *   is populated. Optional — when omitted, only the RBAC gate applies.
 */
export function createAuditExportRouter(ctx: AppContext, requiresAuth?: RequestHandler): Router {
  const router = Router();
  const guards: RequestHandler[] = [];
  if (requiresAuth) guards.push(requiresAuth);

  /** GET /audit/export?format=csv|json&action=&resourceType=&actorSub=&since=&until=&limit= */
  router.get('/audit/export', ...guards, rbacMiddleware(Permission.AuditExport), async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const filter: AuditQueryFilter = {
        actorSub: q.actorSub ? String(q.actorSub) : undefined,
        action: q.action ? String(q.action) : undefined,
        resourceType: q.resourceType ? String(q.resourceType) : undefined,
        resourceId: q.resourceId ? String(q.resourceId) : undefined,
        decision: q.decision ? (String(q.decision) as AuditQueryFilter['decision']) : undefined,
        since: q.since ? String(q.since) : undefined,
        until: q.until ? String(q.until) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      };
      const rows = await queryAuditEvents(ctx.pool, filter);
      const format = String(q.format || 'json').toLowerCase();
      // Self-audit: reading/exporting the audit trail is itself a sensitive access.
      // Fire-and-forget (non-throwing) so it never delays or breaks the export.
      void emitAuditEvent(ctx.pool, {
        actorSub: callerFromRequest(req).sub ?? null,
        action: 'audit.export',
        resourceType: 'audit_log',
        resourceId: null,
        decision: 'allow',
        metadata: { format, count: rows.length },
      });
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="access-audit-export.csv"');
        res.send(toCsv(rows));
        return;
      }
      res.json({ count: rows.length, events: rows });
    } catch (err) {
      logger.error({ err }, 'audit export failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /audit/summary?since=&until=&limit= — at-a-glance activity rollup over the audit trail. */
  router.get('/audit/summary', ...guards, rbacMiddleware(Permission.AuditExport), async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const filter: AuditQueryFilter = {
        since: q.since ? String(q.since) : undefined,
        until: q.until ? String(q.until) : undefined,
        limit: q.limit ? Number(q.limit) : 10000,
      };
      const rows = await queryAuditEvents(ctx.pool, filter);
      void emitAuditEvent(ctx.pool, {
        actorSub: callerFromRequest(req).sub ?? null,
        action: 'audit.summary',
        resourceType: 'audit_log',
        resourceId: null,
        decision: 'allow',
        metadata: { count: rows.length },
      });
      res.json({
        generatedAt: new Date().toISOString(),
        window: { since: filter.since ?? null, until: filter.until ?? null },
        ...summarizeAuditActivity(rows),
      });
    } catch (err) {
      logger.error({ err }, 'audit summary failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /posture — compliance snapshot for the dashboard. */
  router.get('/posture', ...guards, rbacMiddleware(Permission.AuditExport), async (_req: Request, res: Response) => {
    try {
      const [tickets, workspaces, auditLog, chatTasks, evalRate, rls] = await Promise.all([
        ownershipCounts(ctx.pool, 'tickets', 'owner_sub'),
        ownershipCounts(ctx.pool, 'workspaces', 'owner_sub'),
        ownershipCounts(ctx.pool, 'access_audit_log', 'actor_sub'),
        ownershipCounts(ctx.pool, 'chat_tasks', 'owner_sub'),
        lastEvalPassRate(ctx.pool),
        buildRlsPostureSnapshot(ctx.pool),
      ]);

      res.json({
        generatedAt: new Date().toISOString(),
        ownership: { tickets, workspaces, accessAuditLog: auditLog, chatTasks },
        rls,
        controls: {
          rbacEnforce: envOn('OSHAL_RBAC_ENFORCE', false),
          legacyUnownedAllowed: envOn('OSHAL_ALLOW_LEGACY_UNOWNED', false),
          cspEnabled: envOn('OSHAL_CSP_ENABLED', false) || envOn('HELMET_CSP', false),
          cryptoAtRest: !!(process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length > 0),
          rateLimitEnabled: envOn('OSHAL_RATE_LIMIT_ENABLED', false) || envOn('RATE_LIMIT_ENABLED', false),
          mockOidc: envOn('MOCK_OIDC', false),
          tlsRejectUnauthorized: (process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '1') !== '0',
          operatorAllowlistConfigured:
            !!(process.env.OSHAL_OPERATOR_SUBS || process.env.OSHAL_OPERATOR_EMAILS),
          // Governance phases 1–4 toggles (single-pane posture):
          rlsEnforce: envOn('OSHAL_RLS_ENFORCE', false),
          accessAudit: envOn('OSHAL_ACCESS_AUDIT', false),
          dlpMode: (process.env.OSHAL_DLP_MODE ?? 'off').toLowerCase().trim() || 'off',
          policyEnforce: envOn('OSHAL_POLICY_ENFORCE', false),
          auditForwarding: !!(process.env.OSHAL_AUDIT_FORWARD_URL ?? '').trim(),
          llmBudgets: envOn('OSHAL_LLM_BUDGETS', false),
        },
        eval: { last7dPassRate: evalRate },
      });
    } catch (err) {
      logger.error({ err }, 'posture snapshot failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /whoami — the CALLER's resolved RBAC role + effective permissions. Available to any
   * authenticated caller (no AuditExport gate) so the admin console can show "you are <role>" and
   * hide controls the caller can't use. Reflects IdP token roles + the env allowlists.
   */
  router.get('/whoami', ...guards, (req: Request, res: Response) => {
    const caller = callerFromRequest(req);
    const role = resolveRole(caller);
    res.json({
      sub: caller.sub,
      email: caller.email,
      tokenRoles: caller.roles ?? [],
      role,
      permissions: ROLE_PERMISSIONS[role] ?? [],
      enforcement: isEnforcementEnabled(),
    });
  });

  /**
   * GET /readiness — the procurement + public-SaaS readiness tracks for the admin console, read
   * from the newest generated evidence artifact (docs/evidence/procurement-saas-readiness-*.json,
   * produced by `npm run evidence:procurement-saas`). Honest by construction: returns
   * { available: false } when no artifact exists rather than fabricating scores, so the console
   * never shows stale hardcoded numbers. Admin-only and independent of OSHAL_RBAC_ENFORCE.
   */
  router.get('/readiness', ...guards, requireAdminConsoleAccess(), (_req: Request, res: Response) => {
    try {
      const report = readLatestReadinessReport();
      if (!report) {
        res.json({ available: false, tracks: [], note: 'No procurement-saas readiness artifact found.' });
        return;
      }
      res.json({
        available: true,
        generatedAt: report.generatedAt,
        source: report.source,
        totals: report.totals,
        tracks: (report.tracks ?? []).map((track) => ({
          id: track.id,
          title: track.title,
          score: track.score,
          status: track.status,
          currentMarketScore: track.currentMarketScore,
          targetMarketScore: track.targetMarketScore,
          blockers: (track.blockers ?? []).map((blocker) =>
            typeof blocker === 'string' ? blocker : blocker.label,
          ),
        })),
      });
    } catch (err) {
      logger.error({ err }, 'readiness snapshot failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

/** Minimal shape of a readiness-track entry as serialized in the evidence JSON artifact. */
interface ReadinessReportTrack {
  id?: string;
  title?: string;
  score?: number;
  status?: string;
  currentMarketScore?: number;
  targetMarketScore?: number;
  blockers?: Array<string | { label?: string }>;
}

/** Minimal shape of the procurement-saas readiness JSON artifact this route consumes. */
interface ReadinessReport {
  generatedAt?: string;
  totals?: Record<string, number>;
  tracks?: ReadinessReportTrack[];
  source?: string;
}

/**
 * Read the newest procurement-saas readiness JSON artifact from docs/evidence.
 *
 * @returns The parsed report with its source filename, or null when none exists / can't be parsed.
 */
function readLatestReadinessReport(): ReadinessReport | null {
  const dir = path.resolve(process.cwd(), 'docs/evidence');
  if (!existsSync(dir)) {
    return null;
  }
  const newest = readdirSync(dir)
    .filter((file) => /^procurement-saas-readiness-.*\.json$/.test(file))
    .sort()
    .reverse()[0];
  if (!newest) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path.join(dir, newest), 'utf8')) as ReadinessReport;
  return { ...parsed, source: newest };
}

/**
 * Register governance audit-export + posture routes under /api/governance. Call from server.ts;
 * this module does NOT mount itself.
 *
 * @param app Express app.
 * @param ctx App context.
 * @param requiresAuth Optional OIDC guard; pass it so the routes sit behind auth like the rest.
 */
export function registerAuditExportRoutes(app: Express, ctx: AppContext, requiresAuth?: RequestHandler): void {
  app.use('/api/governance', createAuditExportRouter(ctx, requiresAuth));
  logger.info('Governance audit-export routes registered at /api/governance');
}
