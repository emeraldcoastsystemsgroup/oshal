/**
 * Security Center routes — the swarm's self-security app (ADR-055).
 *
 * Split, same as trading / finance / kid-lens:
 *  - **Scanning + reads** (deterministic, no LLM) run here in the controller: the active
 *    scanners (secrets, route-auth gaps, dependency CVEs) and the runtime/ledger/audit
 *    detectors collect findings, which are upserted into oshal_security_findings keyed by
 *    fingerprint (a re-scan refreshes in place and preserves operator triage).
 *  - **Triage** (is this finding a real threat, how bad, what's the fix?) ALWAYS runs on the
 *    accountable security-analyst bot via BotNodeClient.execute, so per-call cost lands in
 *    chat_tasks under the bot's agent_id (ADR-036). The bot is reason-only (no scan, no shell),
 *    so it runs INLINE on the api container — same path as trading-analyst.
 *
 * Escalation: a triaged finding can be opened into the ticketing spine (ticketType
 * 'security-finding'), linking finding_id <-> ticket_id, so remediation is tracked like any
 * other work. Every route is requiresAuth-gated at mount; reads/writes are owner-scoped by sub.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET /status (counts by severity/category/status + last scan + scanner availability), POST /scan (run selected scopes, upsert findings, record scan), GET /findings (+filters) & GET /findings/:id, PATCH /findings/:id (status), POST /findings/:id/assess (security-analyst triage), POST /findings/:id/ticket (escalate into ticketing).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stale-posture reconciliation: after upsert, auto-resolve OPEN posture findings (secret/route_auth/dependency) whose fingerprint a fresh available scan no longer emits — posture describes current state, so a disappeared finding is fixed; without this, corrected false positives sat open forever. Operator triage and event-shaped scopes (runtime/ledger/audit) are never touched.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Trivy ('image' scope) auto-reports to the security queue: after a scan that ran Trivy, open+un-ticketed trivy findings at/above TRIVY_TICKET_SEVERITY_FLOOR (default high) auto-file a 'security-finding' ticket at status BACKLOG, linking finding<->ticket. Factored escalateFindingToTicket() shared with POST /findings/:id/ticket, and fixed that route dropping finding data into a stripped `payload` field (now in metadata).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | createSecurityRoutes gains optional getManifestRoutes — POST /scan resolves the ACTIVE app manifests' routes[] and passes them to runScan, so the route auditor sees dynamically-mounted package routes (ADR-085 carves made the server.ts-only scan decay). Getter failure degrades to the server.ts-only audit with an ERROR log, never a failed scan.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Degraded-scan guard (adversarial review): when the manifest inventory getter throws, the route auditor emits zero manifest fingerprints — so resolveStalePostureFindings would auto-close every open route_auth:manifest:* finding on an infra hiccup (silently clearing a real security finding). Thread manifestInventoryAvailable through; a posture scan without a live inventory no longer resolves manifest findings.
 *
 * @module security-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { runScan, ALL_KINDS, SEVERITY_RANK, type ManifestRouteAuditEntry, type ScanKind, type ScannerReport, type Severity } from '@/features/security';
import { resolveUserLlmConnection } from './free-tier-rotation';
import { executeBotOrInline } from './inline-bot-execution';

const logger = createChildLogger({ module: 'security-routes' });

/** The security-analyst bot — reason-only, runs inline on the api container (claude-code). */
const SECURITY_AGENT_ID = 'a0000000-0000-0000-0000-000000000047';
const botClient = new BotNodeClient(createRegistryEndpointResolver());

/** Signed-in caller's OIDC sub. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  return sub ? String(sub) : null;
}

/** Serve a static surface file from the api dir. */
function servePage(apiDir: string, file: string): RequestHandler {
  return (_req, res) => {
    res.sendFile(path.join(apiDir, file), (err) => {
      if (err) { logger.error({ err, file }, 'serve security surface failed'); res.status(404).send('Not found'); }
    });
  };
}

/* ─── schema (mirrors migration 039; CREATE IF NOT EXISTS so the app self-heals) ─── */

export async function ensureSecuritySchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'security routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_security_scans (
        scan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        kinds TEXT[] NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        finding_count INT NOT NULL DEFAULT 0,
        new_count INT NOT NULL DEFAULT 0,
        summary JSONB,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ)`,
      'CREATE INDEX IF NOT EXISTS idx_sec_scans_user ON oshal_security_scans (user_sub, started_at DESC)',
      `CREATE TABLE IF NOT EXISTS oshal_security_findings (
        finding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        source TEXT,
        evidence JSONB,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        assessment JSONB,
        assessed_at TIMESTAMPTZ,
        ticket_id UUID,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now())`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_sec_findings_dedup ON oshal_security_findings (user_sub, fingerprint)',
      'CREATE INDEX IF NOT EXISTS idx_sec_findings_user ON oshal_security_findings (user_sub, status, severity, last_seen DESC)',
      'CREATE INDEX IF NOT EXISTS idx_sec_findings_cat ON oshal_security_findings (user_sub, category, last_seen DESC)',
    ],
    requirements: [
      {
        table: 'oshal_security_scans',
        columns: [
          'scan_id',
          'user_sub',
          'kinds',
          'status',
          'finding_count',
          'new_count',
          'summary',
          'error',
          'started_at',
          'finished_at',
        ],
      },
      {
        table: 'oshal_security_findings',
        columns: [
          'finding_id',
          'user_sub',
          'category',
          'severity',
          'title',
          'detail',
          'source',
          'evidence',
          'fingerprint',
          'status',
          'assessment',
          'assessed_at',
          'ticket_id',
          'first_seen',
          'last_seen',
        ],
      },
    ],
  });
}

/**
 * Upsert one scan's worth of findings, keyed by (user_sub, fingerprint). Returns how many were
 * newly inserted (the xmax=0 trick distinguishes INSERT from UPDATE). An existing finding's
 * operator-set status (ignored/resolved/triaged) is preserved — a re-scan never reopens it.
 */
async function upsertFindings(pool: AppContext['pool'], sub: string, reports: ScannerReport[]): Promise<{ total: number; created: number }> {
  let created = 0; let total = 0;
  for (const rep of reports) {
    for (const f of rep.findings) {
      total++;
      const r = await pool.query(
        `INSERT INTO oshal_security_findings (user_sub, category, severity, title, detail, source, evidence, fingerprint, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (user_sub, fingerprint) DO UPDATE SET
           severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail,
           source = EXCLUDED.source, evidence = EXCLUDED.evidence, last_seen = now()
         RETURNING (xmax = 0) AS inserted`,
        [sub, f.category, f.severity, f.title, f.detail, f.source ?? null, f.evidence ? JSON.stringify(f.evidence) : null, f.fingerprint]);
      if (r.rows[0]?.inserted) created++;
    }
  }
  return { total, created };
}

/**
 * @description Auto-resolve stale POSTURE findings. Posture scanners describe the CURRENT
 * state of the tree (secrets on disk, the mount table, the dependency list), so an open
 * finding whose fingerprint a fresh, successful scan of the same category no longer emits
 * has been fixed — leaving it open makes the dashboard permanent noise. Only categories a
 * scanner declared AND reported available are reconciled, and only rows still in 'open'
 * (operator triage — ignored/resolved/triaged — is preserved). Event-shaped scopes
 * (runtime/ledger/audit) describe history, not state, never set `categories`, and are
 * never auto-resolved.
 * @param pool - Postgres pool.
 * @param sub - Owner sub the findings are scoped to.
 * @param reports - The scan's scanner reports (fresh fingerprints + owned categories).
 * @returns Number of findings flipped from open to resolved.
 */
async function resolveStalePostureFindings(
  pool: AppContext['pool'],
  sub: string,
  reports: ScannerReport[],
  manifestInventoryAvailable = true,
): Promise<number> {
  const categories = new Set<string>();
  for (const r of reports) {
    if (r.available && r.categories) for (const c of r.categories) categories.add(c);
  }
  if (!categories.size) return 0;
  const freshFingerprints = reports.flatMap((r) => r.findings.map((f) => f.fingerprint));
  // Degraded-scan guard (2026-07-24 adversarial review): when the manifest route inventory
  // was unavailable this scan, the route auditor emits ZERO manifest fingerprints — so
  // auto-resolving on "not re-emitted" would falsely close every open manifest finding,
  // silently clearing a real security finding on an infra hiccup. Exclude the manifest
  // route_auth:manifest:* fingerprints from resolution unless the inventory was actually present.
  const manifestGuard = manifestInventoryAvailable
    ? ''
    : ` AND fingerprint NOT LIKE 'route_auth:manifest:%'`;
  const res = await pool.query(
    `UPDATE oshal_security_findings SET status='resolved'
      WHERE user_sub=$1 AND status='open' AND category = ANY($2)
        AND NOT (fingerprint = ANY($3))${manifestGuard}`,
    [sub, [...categories], freshFingerprints]);
  return res.rowCount ?? 0;
}

/* ─── escalate a finding into the security queue ──────────────────────────────── */

/** A persisted finding row as read for escalation (superset of the triage row). */
interface EscalatableFinding {
  finding_id: string; category: string; severity: string; title: string;
  detail: string; source: string | null; assessment?: unknown; ticket_id?: string | null;
}

/**
 * @description Files one finding into the ticketing spine as a `security-finding` ticket and
 * links finding_id <-> ticket_id. Idempotent: a finding already linked returns its ticket id
 * and creates nothing. Finding data rides in `metadata` (a top-level `payload` is stripped by
 * CreateInternalTicketSchema, so it never persisted before). Shared by the manual escalate
 * route and the Trivy auto-file step.
 * @param ctx - App context (ticketService + pool).
 * @param sub - Owner sub the finding + ticket belong to.
 * @param f - The finding row.
 * @param status - Ticket status to file at ('backlog' to queue for review; 'approved' to dispatch).
 * @returns The linked ticket id (new or pre-existing).
 */
async function escalateFindingToTicket(
  ctx: AppContext, sub: string, f: EscalatableFinding, status: 'backlog' | 'approved',
): Promise<string> {
  if (f.ticket_id) return f.ticket_id;
  const a = (f.assessment || {}) as Partial<Assessment>;
  const input = CreateInternalTicketSchema.parse({
    title: `[security:${f.severity}] ${f.title}`,
    description: `${f.detail}\n\n`
      + (a.recommendation ? `Recommended fix: ${a.recommendation}\n` : '')
      + (a.attackScenario ? `Attack scenario: ${a.attackScenario}\n` : '')
      + (f.source ? `Location: ${f.source}\n` : ''),
    ticketType: 'security-finding',
    status,
    ownerSub: sub,
    metadata: {
      source: 'security-center',
      findingId: f.finding_id, category: f.category, severity: f.severity, findingSource: f.source,
    },
  });
  const ticket = await ctx.ticketService.createTicket(input);
  await ctx.pool.query(
    `UPDATE oshal_security_findings SET ticket_id=$3, status=CASE WHEN status='open' THEN 'triaged' ELSE status END
      WHERE finding_id=$1 AND user_sub=$2`, [f.finding_id, sub, ticket.ticketId]);
  return ticket.ticketId;
}

/** Severity floor (inclusive) at/above which a Trivy finding auto-files a security-queue ticket. */
function trivyTicketFloor(): Severity {
  const raw = String(process.env.TRIVY_TICKET_SEVERITY_FLOOR || 'high').toLowerCase();
  const valid: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  return (valid as string[]).includes(raw) ? (raw as Severity) : 'high';
}

/**
 * @description Auto-reports Trivy findings to the security queue. After a scan, every OPEN,
 * un-ticketed `trivy_*` finding at/above the severity floor is filed as a `security-finding`
 * ticket at status BACKLOG (queued for operator review, never auto-dispatched). ALL Trivy
 * findings still live in oshal_security_findings; only the floor-and-above ones become tickets,
 * mirroring the CI Trivy gate's CRITICAL,HIGH focus. Idempotent via ticket_id (re-scans don't
 * re-file). Lower-severity findings, and non-Trivy scanners, are untouched (they escalate
 * manually via POST /findings/:id/ticket).
 * @param ctx - App context.
 * @param sub - Owner sub.
 * @returns The finding/ticket ids filed this run.
 */
async function autoFileTrivyFindings(ctx: AppContext, sub: string): Promise<Array<{ findingId: string; ticketId: string }>> {
  const floor = SEVERITY_RANK[trivyTicketFloor()];
  const rows = (await ctx.pool.query(
    `SELECT finding_id, category, severity, title, detail, source, assessment, ticket_id
       FROM oshal_security_findings
      WHERE user_sub=$1 AND status='open' AND ticket_id IS NULL AND category LIKE 'trivy\\_%'`, [sub])).rows as EscalatableFinding[];
  const filed: Array<{ findingId: string; ticketId: string }> = [];
  for (const f of rows) {
    if (SEVERITY_RANK[(f.severity as Severity)] < floor) continue;
    try {
      const ticketId = await escalateFindingToTicket(ctx, sub, f, 'backlog');
      filed.push({ findingId: f.finding_id, ticketId });
    } catch (err) {
      logger.warn({ err, findingId: f.finding_id }, 'auto-file trivy finding to security queue failed (non-fatal)');
    }
  }
  if (filed.length) logger.info({ sub, count: filed.length }, 'Trivy findings auto-filed to security-queue backlog');
  return filed;
}

/* ─── security-analyst triage ─────────────────────────────────────────────────── */

interface FindingRow {
  finding_id: string; category: string; severity: string; title: string;
  detail: string; source: string | null; evidence: unknown; status: string;
}

interface Assessment {
  isRealThreat: boolean;
  falsePositive: boolean;
  severity: Severity;
  summary: string;
  attackScenario: string;
  recommendation: string;
  needsHistoryScrub: boolean;
}

function buildAssessmentPrompt(f: FindingRow): string {
  return [
    'Triage this single security finding the platform scanners collected. Decide how real and how',
    'dangerous it is, and what to do. Be honest about false positives.',
    '',
    'Answer with EXACTLY one fenced ```json block, no prose outside it, matching:',
    '```json',
    '{',
    '  "isRealThreat": boolean,',
    '  "falsePositive": boolean,',
    '  "severity": "critical" | "high" | "medium" | "low" | "info",',
    '  "summary": "one-sentence plain-language verdict",',
    '  "attackScenario": "who exploits this and what they get (empty string if false positive)",',
    '  "recommendation": "the smallest effective fix",',
    '  "needsHistoryScrub": boolean   // true only for a leaked secret that must be purged from git history',
    '}',
    '```',
    '',
    'FINDING (JSON):',
    JSON.stringify({
      category: f.category, severity: f.severity, title: f.title,
      detail: f.detail, source: f.source, evidence: f.evidence,
    }),
  ].join('\n');
}

function parseAssessment(text: string, fallbackSev: Severity): Assessment {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/)?.[0] ?? '');
  let obj: Partial<Assessment> = {};
  try { obj = JSON.parse(candidate.trim()) as Partial<Assessment>; } catch { /* fall through to defaults */ }
  const SEVS: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  return {
    isRealThreat: obj.isRealThreat === true,
    falsePositive: obj.falsePositive === true,
    severity: (SEVS as string[]).includes(String(obj.severity)) ? obj.severity as Severity : fallbackSev,
    summary: String(obj.summary || 'No assessment returned.'),
    attackScenario: String(obj.attackScenario || ''),
    recommendation: String(obj.recommendation || ''),
    needsHistoryScrub: obj.needsHistoryScrub === true,
  };
}

/** Run the security-analyst bot over one finding. direct+agenticMode → cost auto-recorded. */
async function assessFinding(ctx: AppContext, sub: string, f: FindingRow): Promise<Assessment> {
  const byoLlmConnection = await resolveUserLlmConnection(ctx.pool, sub);
  const result = await executeBotOrInline(ctx, botClient, SECURITY_AGENT_ID, {
    text: buildAssessmentPrompt(f), taskId: `security-${sub}`, workspaceFolderId: `security-${sub}`,
    agentId: SECURITY_AGENT_ID, agenticMode: true, direct: true, userSub: sub, byoLlmConnection,
  });
  return parseAssessment(String(result.response || '').trim(), (f.severity as Severity) || 'info');
}

/* ─── routes ──────────────────────────────────────────────────────────────────── */

/** Validate + default the requested scan scopes. */
function resolveKinds(raw: unknown): ScanKind[] {
  if (!Array.isArray(raw)) return [...ALL_KINDS];
  const want = raw.map((x) => String(x)) as ScanKind[];
  const valid = want.filter((k) => (ALL_KINDS as string[]).includes(k));
  return valid.length ? valid : [...ALL_KINDS];
}

/**
 * @param ctx - App context (Postgres pool + ticketService for escalation).
 * @param apiDir - Directory holding the HTML surface.
 * @param getManifestRoutes - Resolves the ACTIVE app manifests' route declarations so the route
 *   auditor sees dynamically-mounted package routes (ADR-085 — carved apps never appear in
 *   server.ts). Optional: omitted ⇒ the audit stays server.ts-only; a throwing getter degrades
 *   the same way (logged, never a failed scan).
 */
export function createSecurityRoutes(
  ctx: AppContext,
  apiDir: string,
  getManifestRoutes?: () => Promise<ManifestRouteAuditEntry[]>,
): Router {
  const router = Router();

  router.get('/', servePage(apiDir, 'security.html'));
  router.get('/ui', servePage(apiDir, 'security.html'));

  /** GET /status — finding counts (severity/category/status), last scan, scanner availability. */
  router.get('/status', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      await ensureSecuritySchema(ctx.pool);
      const bySev = (await ctx.pool.query(
        `SELECT severity, COUNT(*)::int n FROM oshal_security_findings
          WHERE user_sub=$1 AND status='open' GROUP BY severity`, [sub])).rows;
      const byCat = (await ctx.pool.query(
        `SELECT category, COUNT(*)::int n FROM oshal_security_findings
          WHERE user_sub=$1 AND status='open' GROUP BY category`, [sub])).rows;
      const byStatus = (await ctx.pool.query(
        `SELECT status, COUNT(*)::int n FROM oshal_security_findings WHERE user_sub=$1 GROUP BY status`, [sub])).rows;
      const lastScan = (await ctx.pool.query(
        `SELECT scan_id, kinds, status, finding_count, new_count, summary, started_at, finished_at
           FROM oshal_security_scans WHERE user_sub=$1 ORDER BY started_at DESC LIMIT 1`, [sub])).rows[0] || null;
      const toMap = (rows: Array<{ [k: string]: unknown; n: number }>, key: string) =>
        Object.fromEntries(rows.map((r) => [String(r[key]), r.n]));
      res.json({
        severity: toMap(bySev, 'severity'),
        category: toMap(byCat, 'category'),
        status: toMap(byStatus, 'status'),
        lastScan,
        scopes: ALL_KINDS,
      });
    } catch (err) {
      logger.error({ err }, 'security status failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** POST /scan { kinds?: ScanKind[] } — run the selected scopes, upsert findings, record the run. */
  router.post('/scan', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const kinds = resolveKinds((req.body || {}).kinds);
    let scanId: string | null = null;
    try {
      await ensureSecuritySchema(ctx.pool);
      scanId = (await ctx.pool.query(
        `INSERT INTO oshal_security_scans (user_sub, kinds, status) VALUES ($1,$2,'running') RETURNING scan_id`,
        [sub, kinds])).rows[0].scan_id;

      // Manifest route inventory for the route auditor (posture scope). Best-effort: a broken
      // getter must not fail the whole scan, but it is logged loudly — a silently-absent
      // inventory is exactly the package-blindness this parameter exists to fix.
      let manifestRoutes: ManifestRouteAuditEntry[] | undefined;
      // Was the manifest inventory actually present this scan? Only true when the getter exists,
      // posture was scoped, AND it returned without throwing — gates manifest-finding auto-resolve.
      let manifestInventoryAvailable = false;
      if (getManifestRoutes && kinds.includes('posture')) {
        try {
          manifestRoutes = await getManifestRoutes();
          manifestInventoryAvailable = true;
        } catch (err) {
          logger.error({ err }, 'manifest route inventory unavailable — route audit runs server.ts-only this scan');
        }
      }
      const reports = await runScan(ctx.pool, sub, kinds, manifestRoutes);
      const { total, created } = await upsertFindings(ctx.pool, sub, reports);
      // Don't let a posture scan whose manifest inventory failed auto-close manifest findings.
      const manifestResolvable = manifestInventoryAvailable || !kinds.includes('posture');
      const autoResolved = await resolveStalePostureFindings(ctx.pool, sub, reports, manifestResolvable);
      if (autoResolved) logger.info({ autoResolved, sub }, 'stale posture findings auto-resolved (no longer emitted by re-scan)');

      // Trivy ('image') findings auto-report to the security-queue backlog (floor: HIGH+).
      const autoFiled = reports.some((r) => r.kind === 'image' && r.available)
        ? await autoFileTrivyFindings(ctx, sub)
        : [];

      const summary = reports.map((r) => ({ kind: r.kind, available: r.available, count: r.findings.length, note: r.note }));

      await ctx.pool.query(
        `UPDATE oshal_security_scans SET status='complete', finding_count=$2, new_count=$3, summary=$4, finished_at=now()
          WHERE scan_id=$1`, [scanId, total, created, JSON.stringify(summary)]);

      res.json({ scanId, kinds, findingCount: total, newCount: created, autoResolved, ticketsFiled: autoFiled.length, reports: summary });
    } catch (err) {
      logger.error({ err }, 'security scan failed');
      if (scanId) {
        await ctx.pool.query(`UPDATE oshal_security_scans SET status='error', error=$2, finished_at=now() WHERE scan_id=$1`,
          [scanId, (err as Error).message]).catch(() => { /* best-effort */ });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /findings?category=&severity=&status=&limit= — owner-scoped, worst-first. */
  router.get('/findings', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      await ensureSecuritySchema(ctx.pool);
      const where: string[] = ['user_sub = $1'];
      const params: unknown[] = [sub];
      const add = (col: string, val: unknown) => { if (val) { params.push(val); where.push(`${col} = $${params.length}`); } };
      add('category', req.query.category);
      add('severity', req.query.severity);
      add('status', req.query.status || 'open'); // default to open
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const rows = (await ctx.pool.query(
        `SELECT finding_id, category, severity, title, detail, source, evidence, status,
                assessment, assessed_at, ticket_id, first_seen, last_seen
           FROM oshal_security_findings WHERE ${where.join(' AND ')}
          ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
                   last_seen DESC
          LIMIT ${limit}`, params)).rows;
      res.json({ findings: rows });
    } catch (err) {
      logger.error({ err }, 'security findings list failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /findings/:id — one finding. */
  router.get('/findings/:id', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const row = (await ctx.pool.query(
        `SELECT * FROM oshal_security_findings WHERE finding_id=$1 AND user_sub=$2`, [req.params.id, sub])).rows[0];
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ finding: row });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** PATCH /findings/:id { status } — operator triage (resolve / ignore / reopen). */
  router.patch('/findings/:id', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const status = String((req.body || {}).status || '');
    if (!['open', 'triaged', 'resolved', 'ignored'].includes(status)) {
      res.status(400).json({ error: 'invalid_status' }); return;
    }
    try {
      const row = (await ctx.pool.query(
        `UPDATE oshal_security_findings SET status=$3 WHERE finding_id=$1 AND user_sub=$2 RETURNING finding_id, status`,
        [req.params.id, sub, status])).rows[0];
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ finding: row });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** POST /findings/:id/assess — run the security-analyst bot to triage this finding. */
  router.post('/findings/:id/assess', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const f = (await ctx.pool.query(
        `SELECT finding_id, category, severity, title, detail, source, evidence, status
           FROM oshal_security_findings WHERE finding_id=$1 AND user_sub=$2`, [req.params.id, sub])).rows[0] as FindingRow | undefined;
      if (!f) { res.status(404).json({ error: 'not_found' }); return; }
      const assessment = await assessFinding(ctx, sub, f);
      await ctx.pool.query(
        `UPDATE oshal_security_findings SET assessment=$3, assessed_at=now(), severity=$4, status=CASE WHEN status='open' THEN 'triaged' ELSE status END
          WHERE finding_id=$1 AND user_sub=$2`,
        [f.finding_id, sub, JSON.stringify(assessment), assessment.severity]);
      res.json({ findingId: f.finding_id, assessment });
    } catch (err) {
      logger.error({ err }, 'security assess failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** POST /findings/:id/ticket — escalate a finding into the ticketing spine. */
  router.post('/findings/:id/ticket', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const f = (await ctx.pool.query(
        `SELECT * FROM oshal_security_findings WHERE finding_id=$1 AND user_sub=$2`, [req.params.id, sub])).rows[0] as EscalatableFinding | undefined;
      if (!f) { res.status(404).json({ error: 'not_found' }); return; }
      if (f.ticket_id) { res.json({ ticketId: f.ticket_id, alreadyLinked: true }); return; }
      // Manual escalation: HIGH+ dispatches (approved), lower queues for review (backlog).
      const status = SEVERITY_RANK[(f.severity as Severity)] >= SEVERITY_RANK.high ? 'approved' : 'backlog';
      const ticketId = await escalateFindingToTicket(ctx, sub, f, status);
      res.json({ findingId: f.finding_id, ticketId });
    } catch (err) {
      logger.error({ err }, 'security ticket escalation failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
