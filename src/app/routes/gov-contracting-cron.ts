/**
 * Gov-Contracting cron — a small, gated app-owned timer.
 *
 * When GOVCON_CRON is truthy, runs the daily SAM.gov capture scan the old Windows "ECSG capture
 * scan" task did, now as OSHAL work: per user with a capture store, refresh the federal feed
 * (sam_intake), re-score it (triage), and sync the curated folders into crm.db. The federal pull
 * needs SAM_API_KEY in the env (else it's a graceful no-op — sync + triage still run). Off by
 * default so heavy scans never fire unexpectedly in dev.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial gated daily SAM capture scan for the gov-contracting app.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | After the scan, queue capture-draft work for the strongest promoted leads as federal-capture tickets on the capture-specialist bot (in-process; GOVCON_DRAFT_MIN gated, GOVCON_DRAFT_AUTOAPPROVE optional).
 *
 * @module gov-contracting-cron
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Capture + unref the cron interval handle (2026-07-05 leak audit)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 capture ingestion: each promoted lead the draft-enqueue seam processes is mirrored into the shared tenant graph (opportunity ↔ agency ↔ NAICS + the tracking ticket edge) via the graph feature's ingestion service. Fire-and-forget and engine-gated — a clean no-op without ARANGO_URL, never blocks or fails the cron.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Ran the gov-contracting cron tick under runWithSystemIdentity — a cross-owner background sweep over per-user opportunity/ticket rows; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { getGraphIngestionService } from '@/features/graph';
import type { AppContext } from '@/app/composition/app-context';

const logger = createChildLogger({ module: 'gov-contracting-cron' });
const ENGINE_DIR = process.env.GOVCON_ENGINE_DIR || path.resolve(process.cwd(), 'workspace-shared', 'deployed-apps', 'gov-contracting', 'engine');
const STORE_ROOT = process.env.GOVCON_STORE_ROOT || path.resolve(process.cwd(), 'apps', 'gov-contracting', 'data');
const TENANT = 'default';
const PYTHON = process.env.GOVCON_PYTHON || 'python3';

let started = false;
const lastRun: Record<string, string> = {}; // job -> YYYY-MM-DD it last ran

/** Users with a capture store (for the cron fan-out). */
function listStoreUsers(): string[] {
  try {
    return fs.readdirSync(path.join(STORE_ROOT, TENANT), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/** Run the engine's daily scan for one user (federal pull + triage + folder sync), scoped to their store. */
function runScan(ctx: AppContext, userSub: string): void {
  const userDir = path.join(STORE_ROOT, TENANT, userSub);
  const proc = spawn(PYTHON, ['scan.py', '--quiet', '--no-econ'], {
    cwd: ENGINE_DIR,
    env: {
      ...process.env,
      OSHAL_USER_SUB: userSub,
      CRM_DB: path.join(userDir, 'crm.db'),
      CRM_CAPTURE_DIR: path.join(userDir, 'capture', 'opportunities'),
      CRM_ECON_FILE: path.join(userDir, '_econ.json'),
    },
    stdio: 'ignore',
    detached: false,
  });
  proc.on('exit', (code) => {
    logger.info({ userSub, code }, 'gov-contracting scan finished');
    // After a clean scan (federal pull + triage + promote), queue capture-draft work for the
    // strongest promoted leads. Off unless GOVCON_DRAFT_MIN is set, so it never fires by surprise.
    if (code === 0) {
      void enqueueDraftsForUser(ctx, userSub)
        .then((n) => { if (n) logger.info({ userSub, queued: n }, 'gov-contracting: capture drafts queued'); })
        .catch((err) => logger.error({ err, userSub }, 'gov-contracting: draft enqueue failed'));
    }
  });
}

/**
 * Queue capture-draft work for a user's strongest promoted leads — the in-process, standard-path
 * draft trigger (no auth wall, proper user/queue association), vs. the engine's CLI draft.
 *
 * For every promoted SAM notice scoring >= GOVCON_DRAFT_MIN that hasn't been ticketed yet, create a
 * `federal-capture` ticket owned by the user; the registered federal-capture pipeline routes it to the
 * capture-specialist bot. Default status `approval_required` lands it in Approvals and spends no LLM
 * until the operator approves; set GOVCON_DRAFT_AUTOAPPROVE=1 to dispatch immediately. Dedup lives in
 * the user's own crm.db (gov_draft_tickets) so a daily run never re-tickets the same notice. Returns
 * the number created; a no-op (0) when GOVCON_DRAFT_MIN is unset — drafting stays off by default.
 *
 * `minOverride` lets the on-demand route trigger a run at an explicit threshold regardless of the
 * GOVCON_DRAFT_MIN env (used by POST /enqueue-drafts); the cron passes nothing and uses the env.
 */
export async function enqueueDraftsForUser(ctx: AppContext, userSub: string, minOverride?: number): Promise<number> {
  const draftMin = Number.isFinite(minOverride as number)
    ? (minOverride as number)
    : Number.parseInt(process.env.GOVCON_DRAFT_MIN || '', 10);
  if (!Number.isFinite(draftMin)) return 0; // drafting off
  const crmDb = path.join(STORE_ROOT, TENANT, userSub, 'crm.db');
  if (!fs.existsSync(crmDb)) return 0;
  const autoApprove = ['1', 'true', 'yes'].includes((process.env.GOVCON_DRAFT_AUTOAPPROVE || '').toLowerCase());

  const db = new Database(crmDb);
  type LeadRow = {
    notice_id: string; title: string; agency: string; naics: string;
    set_aside: string; due: string; url: string; fit_score: number;
  };
  let rows: LeadRow[];
  try {
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS gov_draft_tickets (notice_id TEXT PRIMARY KEY, ticket_id TEXT, created TEXT)');
    rows = db.prepare(
      `SELECT notice_id, title, agency, naics, set_aside, due, url, fit_score
         FROM sam_notices
        WHERE promoted = 1 AND fit_score >= ?
          AND notice_id NOT IN (SELECT notice_id FROM gov_draft_tickets)
        ORDER BY fit_score DESC`,
    ).all(draftMin) as LeadRow[];
  } catch (err) {
    db.close();
    logger.error({ err, userSub }, 'gov-contracting: reading promoted leads failed');
    return 0;
  }

  const record = db.prepare('INSERT OR IGNORE INTO gov_draft_tickets (notice_id, ticket_id, created) VALUES (?, ?, ?)');
  let created = 0;
  try {
    for (const r of rows) {
      const description = [
        'Draft a full federal capture package for this SAM.gov opportunity, then halt for human review.',
        '',
        `- Title: ${r.title}`,
        `- Agency: ${r.agency}`,
        `- NAICS: ${r.naics}`,
        `- Set-aside: ${r.set_aside || '(none listed)'}`,
        `- Response due: ${r.due || '(unknown)'}`,
        `- Notice: ${r.url}`,
        `- Auto-triaged fit score: ${r.fit_score}`,
        '',
        'Produce qualification, research, win themes, a pricing basis, and a proposal draft. Verify every',
        'fact against SAM.gov / the PWS. Do not send outreach or submit — those stay human gates.',
      ].join('\n');
      const ticket = await ctx.ticketService.createTicket({
        title: `Capture: ${r.title}`.slice(0, 180),
        ticketType: 'federal-capture',
        description,
        status: autoApprove ? 'approved' : 'approval_required',
        priority: 'high',
        labels: ['federal', 'auto-capture'],
        workspaceId: null,
        assignedAgentId: null,
        parentTicketId: null,
        externalProvider: null,
        externalId: null,
        externalUrl: r.url || null,
        metadata: { notice_id: r.notice_id, agency: r.agency, fit_score: r.fit_score, tenant: TENANT, source: 'gov-contracting-cron' },
        ownerSub: userSub,
      });
      record.run(r.notice_id, ticket.ticketId, new Date().toISOString());
      created++;
      // ADR-045 capture ingestion: mirror the promoted lead into the shared tenant graph
      // (opportunity ↔ agency ↔ NAICS + the tracking ticket). Fire-and-forget — the method
      // never rejects, no-ops without a graph engine, and never blocks the cron.
      void getGraphIngestionService().ingestCaptureOpportunity({
        noticeId: r.notice_id,
        title: r.title,
        agency: r.agency,
        naics: r.naics || null,
        setAside: r.set_aside || null,
        due: r.due || null,
        url: r.url || null,
        fitScore: r.fit_score,
        ticketId: ticket.ticketId,
        tenant: TENANT,
      });
    }
  } finally {
    db.close();
  }
  return created;
}

/** Local hour:minute + today's date key for the tick check. */
function clock(): { hh: number; mm: number; day: string } {
  const d = new Date();
  return { hh: d.getHours(), mm: d.getMinutes(), day: d.toISOString().slice(0, 10) };
}

function tick(ctx: AppContext): void {
  const { hh, mm, day } = clock();
  // 06:00–06:09 — daily SAM.gov capture scan, once per day per user.
  if (hh === 6 && mm < 10 && lastRun.scan !== day) {
    lastRun.scan = day;
    const users = listStoreUsers();
    for (const userSub of users) {
      try { runScan(ctx, userSub); } catch (err) { logger.error({ err, userSub }, 'gov-contracting scan failed'); }
    }
    if (users.length) logger.info({ users: users.length }, 'gov-contracting cron: daily SAM capture scan dispatched');
  }
}

/** Start the gated daily timer once. No-op unless GOVCON_CRON is truthy. */
export function startGovContractingCron(ctx: AppContext): void {
  if (started) return;
  started = true;
  if (!['1', 'true', 'yes'].includes((process.env.GOVCON_CRON || '').toLowerCase())) {
    logger.info('gov-contracting cron disabled (set GOVCON_CRON=1 to enable)');
    return;
  }
  logger.info('gov-contracting cron enabled (daily SAM capture scan 06:00)');
  const cronTimer = setInterval(() => { try { void runWithSystemIdentity(() => tick(ctx)); } catch (err) { logger.error({ err }, 'gov cron tick failed'); } }, 5 * 60 * 1000);
  cronTimer.unref();
}
