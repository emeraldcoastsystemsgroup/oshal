/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial gated daily SAM capture scan for the gov-contracting app.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | After the scan, queue capture-draft work for the strongest promoted leads as federal-capture tickets on the capture-specialist bot (in-process; GOVCON_DRAFT_MIN gated, GOVCON_DRAFT_AUTOAPPROVE optional).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Capture + unref the cron interval handle (2026-07-05 leak audit)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 capture ingestion: each promoted lead the draft-enqueue seam processes is mirrored into the shared tenant graph (opportunity ↔ agency ↔ NAICS + the tracking ticket edge) via the graph feature's ingestion service. Fire-and-forget and engine-gated — a clean no-op without ARANGO_URL, never blocks or fails the cron.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Ran the gov-contracting cron tick under runWithSystemIdentity — a cross-owner background sweep over per-user opportunity/ticket rows; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Resolve exact OIDC subjects through bound digest directories, enumerate canonical markers or unambiguous legacy entries, and reject linked/escaped CRM databases, SQLite sidecars, capture folders, and economy files before use.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: run the app-owned Python scan with an explicit runtime/SAM environment and owner-bound paths instead of inheriting controller, database, connector, and provider credentials.
 */

/**
 * Gov-Contracting cron — a small, gated app-owned timer.
 *
 * When GOVCON_CRON is truthy, this runs the daily SAM.gov capture scan the old Windows "ECSG
 * capture scan" task did, now as oshal work: per exact user store, refresh the federal feed
 * (sam_intake), re-score it (triage), sync curated folders into crm.db, and optionally queue the
 * strongest promoted leads. The federal pull needs SAM_API_KEY in the environment; without it,
 * sync and triage still run. It remains disabled by default so heavy scans never surprise dev.
 *
 * @module gov-contracting-cron
 */
import { spawn } from 'child_process';
import path from 'path';
import Database from 'better-sqlite3';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  assertLinkFreeSqliteDatabase,
  assertLinkFreeStoreFile,
  ensureLinkFreeStoreSubdirectory,
  listExactSubjectStoreDirectories,
  resolveExactSubjectStoreDirectory,
  UnsafeExactSubjectStoreError,
  type ExactSubjectStoreDirectory,
} from '@/shared/security/exact-subject-store';
import { getGraphIngestionService } from '@/features/graph';
import type { AppContext } from '@/app/composition/app-context';

const logger = createChildLogger({ module: 'gov-contracting-cron' });
const ENGINE_DIR = process.env.GOVCON_ENGINE_DIR
  || path.resolve(process.cwd(), 'workspace-shared', 'deployed-apps', 'gov-contracting', 'engine');
const STORE_ROOT = process.env.GOVCON_STORE_ROOT
  || path.resolve(process.cwd(), 'apps', 'gov-contracting', 'data');
const TENANT = 'default';
const PYTHON = process.env.GOVCON_PYTHON || 'python3';

let started = false;
const lastRun: Record<string, string> = {};

interface LeadRow {
  notice_id: string;
  title: string;
  agency: string;
  naics: string;
  set_aside: string;
  due: string;
  url: string;
  fit_score: number;
}

interface GovContractingUserStore extends ExactSubjectStoreDirectory {
  subject: string;
}

type SqliteDatabase = InstanceType<typeof Database>;
export interface GovContractingScanPaths {
  CRM_DB: string;
  CRM_CAPTURE_DIR: string;
  CRM_ECON_FILE: string;
}

const GOVCON_PROCESS_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
  'SAM_API_KEY', 'GOVCON_PROMOTE_MIN',
] as const;

/** Build the scan child's least-privilege environment for one already validated owner store. */
export function buildGovContractingProcessEnv(
  userSub: string,
  paths: GovContractingScanPaths,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GOVCON_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    PYTHONNOUSERSITE: '1',
    OSHAL_USER_SUB: userSub,
    CRM_DB: paths.CRM_DB,
    CRM_CAPTURE_DIR: paths.CRM_CAPTURE_DIR,
    CRM_ECON_FILE: paths.CRM_ECON_FILE,
  };
}

/** Return every exact owner store with a verified existing CRM database. */
function listStoreUsers(): GovContractingUserStore[] {
  return listExactSubjectStoreDirectories(STORE_ROOT, TENANT)
    .filter((store) => assertLinkFreeSqliteDatabase(store.subjectDir, 'crm.db'));
}

/** Resolve one exact owner and return null when no ordinary CRM database exists. */
function resolveUserStore(userSub: string): GovContractingUserStore | null {
  const store = resolveExactSubjectStoreDirectory(STORE_ROOT, TENANT, userSub);
  if (!store.exists || !assertLinkFreeSqliteDatabase(store.subjectDir, 'crm.db')) return null;
  return { ...store, subject: userSub };
}

/** Prepare link-free writable scan paths beneath one already verified owner directory. */
function scanPaths(store: GovContractingUserStore): GovContractingScanPaths {
  const capture = ensureLinkFreeStoreSubdirectory(store.subjectDir, 'capture');
  const opportunities = ensureLinkFreeStoreSubdirectory(capture, 'opportunities');
  assertLinkFreeSqliteDatabase(store.subjectDir, 'crm.db');
  assertLinkFreeStoreFile(store.subjectDir, '_econ.json');
  return {
    CRM_DB: path.join(store.subjectDir, 'crm.db'),
    CRM_CAPTURE_DIR: opportunities,
    CRM_ECON_FILE: path.join(store.subjectDir, '_econ.json'),
  };
}

/** Queue post-scan drafting only after the child exits cleanly. */
function handleScanExit(ctx: AppContext, store: GovContractingUserStore, code: number | null): void {
  logger.info({ userSub: store.subject, code }, 'gov-contracting scan finished');
  if (code !== 0) return;
  void enqueueDraftsForUser(ctx, store.subject)
    .then((queued) => {
      if (queued) logger.info({ userSub: store.subject, queued }, 'gov-contracting: capture drafts queued');
    })
    .catch((err) => logger.error({ err, userSub: store.subject }, 'gov-contracting: draft enqueue failed'));
}

/** Run the engine's daily scan for one exact owner against only verified contained paths. */
function runScan(ctx: AppContext, store: GovContractingUserStore): void {
  const rebound = resolveUserStore(store.subject);
  if (!rebound || rebound.subjectDir !== store.subjectDir) {
    throw new UnsafeExactSubjectStoreError('owner store changed before scan dispatch');
  }
  const proc = spawn(PYTHON, ['scan.py', '--quiet', '--no-econ'], {
    cwd: ENGINE_DIR,
    env: buildGovContractingProcessEnv(store.subject, scanPaths(rebound)),
    stdio: 'ignore',
    detached: false,
  });
  proc.on('error', (err) => logger.error({ err, userSub: store.subject }, 'gov-contracting scan process failed'));
  proc.on('exit', (code) => handleScanExit(ctx, store, code));
}

/** Resolve the enabled draft threshold or null while drafting is off. */
function draftMinimum(minOverride?: number): number | null {
  const value = Number.isFinite(minOverride as number)
    ? (minOverride as number)
    : Number.parseInt(process.env.GOVCON_DRAFT_MIN || '', 10);
  return Number.isFinite(value) ? value : null;
}

/** Read unticketed promoted leads after initializing the per-owner dedup table. */
function promotedLeads(db: SqliteDatabase, minimum: number): LeadRow[] {
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS gov_draft_tickets (notice_id TEXT PRIMARY KEY, ticket_id TEXT, created TEXT)');
  return db.prepare(
    `SELECT notice_id, title, agency, naics, set_aside, due, url, fit_score
       FROM sam_notices
      WHERE promoted = 1 AND fit_score >= ?
        AND notice_id NOT IN (SELECT notice_id FROM gov_draft_tickets)
      ORDER BY fit_score DESC`,
  ).all(minimum) as LeadRow[];
}

/** Build the bounded capture request shown to the capture-specialist worker. */
function leadDescription(lead: LeadRow): string {
  return [
    'Draft a full federal capture package for this SAM.gov opportunity, then halt for human review.',
    '',
    `- Title: ${lead.title}`,
    `- Agency: ${lead.agency}`,
    `- NAICS: ${lead.naics}`,
    `- Set-aside: ${lead.set_aside || '(none listed)'}`,
    `- Response due: ${lead.due || '(unknown)'}`,
    `- Notice: ${lead.url}`,
    `- Auto-triaged fit score: ${lead.fit_score}`,
    '',
    'Produce qualification, research, win themes, a pricing basis, and a proposal draft. Verify every',
    'fact against SAM.gov / the PWS. Do not send outreach or submit — those stay human gates.',
  ].join('\n');
}

/** Create one owner-scoped ticket and mirror its opportunity into the optional graph tier. */
async function createDraftTicket(
  ctx: AppContext,
  userSub: string,
  lead: LeadRow,
  autoApprove: boolean,
): Promise<string> {
  const ticket = await ctx.ticketService.createTicket({
    title: `Capture: ${lead.title}`.slice(0, 180),
    ticketType: 'federal-capture',
    description: leadDescription(lead),
    status: autoApprove ? 'approved' : 'approval_required',
    priority: 'high',
    labels: ['federal', 'auto-capture'],
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: null,
    externalId: null,
    externalUrl: lead.url || null,
    metadata: {
      notice_id: lead.notice_id,
      agency: lead.agency,
      fit_score: lead.fit_score,
      tenant: TENANT,
      source: 'gov-contracting-cron',
    },
    ownerSub: userSub,
  });
  mirrorOpportunity(lead, ticket.ticketId);
  return ticket.ticketId;
}

/** Mirror a promoted lead into the optional tenant graph without blocking ticket creation. */
function mirrorOpportunity(lead: LeadRow, ticketId: string): void {
  void getGraphIngestionService().ingestCaptureOpportunity({
    noticeId: lead.notice_id,
    title: lead.title,
    agency: lead.agency,
    naics: lead.naics || null,
    setAside: lead.set_aside || null,
    due: lead.due || null,
    url: lead.url || null,
    fitScore: lead.fit_score,
    ticketId,
    tenant: TENANT,
  });
}

/** Create tickets sequentially and persist each successful notice-to-ticket binding. */
async function enqueueLeads(
  ctx: AppContext,
  userSub: string,
  db: SqliteDatabase,
  rows: LeadRow[],
): Promise<number> {
  const autoApprove = ['1', 'true', 'yes'].includes((process.env.GOVCON_DRAFT_AUTOAPPROVE || '').toLowerCase());
  const record = db.prepare('INSERT OR IGNORE INTO gov_draft_tickets (notice_id, ticket_id, created) VALUES (?, ?, ?)');
  let created = 0;
  for (const lead of rows) {
    const ticketId = await createDraftTicket(ctx, userSub, lead, autoApprove);
    const result = record.run(lead.notice_id, ticketId, new Date().toISOString());
    if (result.changes === 1) created += 1;
  }
  return created;
}

/** Close one CRM handle while preserving the primary result or error. */
function closeDatabase(db: SqliteDatabase, userSub: string): void {
  try {
    db.close();
  } catch (err) {
    logger.error({ err, userSub }, 'gov-contracting: closing CRM database failed');
  }
}

/**
 * @description Queues capture-draft work for one exact owner's strongest promoted leads. Drafting
 * remains off unless an explicit threshold is supplied or GOVCON_DRAFT_MIN is configured.
 * @param ctx - Composed application services used to create owner-scoped tickets.
 * @param userSub - Exact authenticated OIDC subject.
 * @param minOverride - Optional on-demand score threshold.
 * @returns Number of successfully recorded draft tickets.
 */
export async function enqueueDraftsForUser(
  ctx: AppContext,
  userSub: string,
  minOverride?: number,
): Promise<number> {
  const minimum = draftMinimum(minOverride);
  if (minimum === null) return 0;
  const store = resolveUserStore(userSub);
  if (!store) return 0;
  let db: SqliteDatabase | undefined;
  let rows: LeadRow[] | undefined;
  try {
    assertLinkFreeSqliteDatabase(store.subjectDir, 'crm.db');
    db = new Database(path.join(store.subjectDir, 'crm.db'));
    assertLinkFreeSqliteDatabase(store.subjectDir, 'crm.db');
    rows = promotedLeads(db, minimum);
  } catch (err) {
    logger.error({ err, userSub }, 'gov-contracting: reading promoted leads failed');
    if (db) closeDatabase(db, userSub);
    if (err instanceof UnsafeExactSubjectStoreError) throw err;
    return 0;
  }
  if (!db || !rows) return 0;
  try {
    return await enqueueLeads(ctx, userSub, db, rows);
  } finally {
    closeDatabase(db, userSub);
  }
}

/** Local time plus today's stable UTC date key for the tick check. */
function clock(): { hh: number; mm: number; day: string } {
  const now = new Date();
  return { hh: now.getHours(), mm: now.getMinutes(), day: now.toISOString().slice(0, 10) };
}

/** Dispatch the once-per-day scan window while one cross-owner system identity is active. */
function tick(ctx: AppContext): void {
  const { hh, mm, day } = clock();
  if (hh !== 6 || mm >= 10 || lastRun.scan === day) return;
  lastRun.scan = day;
  let users: GovContractingUserStore[];
  try {
    users = listStoreUsers();
  } catch (err) {
    logger.error({ err }, 'gov-contracting cron: exact-owner store enumeration failed');
    return;
  }
  for (const store of users) {
    try { runScan(ctx, store); }
    catch (err) { logger.error({ err, userSub: store.subject }, 'gov-contracting scan failed'); }
  }
  if (users.length) logger.info({ users: users.length }, 'gov-contracting cron: daily SAM capture scan dispatched');
}

/**
 * @description Starts the gated daily timer once; it is a no-op unless GOVCON_CRON is truthy.
 * @param ctx - Composed application services used by scan completion and ticket creation.
 * @returns Nothing; the unref'd timer does not keep the process alive.
 */
export function startGovContractingCron(ctx: AppContext): void {
  if (started) return;
  started = true;
  if (!['1', 'true', 'yes'].includes((process.env.GOVCON_CRON || '').toLowerCase())) {
    logger.info('gov-contracting cron disabled (set GOVCON_CRON=1 to enable)');
    return;
  }
  logger.info('gov-contracting cron enabled (daily SAM capture scan 06:00)');
  const cronTimer = setInterval(() => {
    try { void runWithSystemIdentity(() => tick(ctx)); }
    catch (err) { logger.error({ err }, 'gov cron tick failed'); }
  }, 5 * 60 * 1000);
  cronTimer.unref();
}
