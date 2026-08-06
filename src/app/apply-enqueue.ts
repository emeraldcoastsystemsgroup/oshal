/**
 * Durable job-apply enqueuer — turns "auto submit this generated résumé" into a REAL, persisted
 * `task` ticket (one per posting) instead of an in-memory batch-runner step. This is the durable
 * spine of the operator's model: generate a résumé → "auto submit" → a ticket is filed → the queue
 * manager dispatches it to the registered desktop node → the node applies → /api/apply/ingest
 * resolves the ticket. One ticket per résumé, worked strictly one-at-a-time through the queue, and
 * — unlike the in-memory apply-batch-runner — it SURVIVES an api restart because the work lives in
 * Postgres, not process memory.
 *
 * Each ticket is created `approved` (skips the manual backlog gate) with metadata.postingId so the
 * dispatcher applies THAT specific packet, and metadata.applyPostingId (string) so a repeat enqueue
 * is de-duplicated against the already-open ticket for the same posting.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial durable enqueuer: one
 *   `task` apply ticket per posting (enqueueApplyTicket) + a whole-ready-queue bulk mint
 *   (enqueueApplyQueue via `oshal-apply.js queue list`), de-duped by metadata.applyPostingId, RLS-
 *   scoped to the owner. Replaces the fragile in-memory apply-batch-runner with persisted tickets.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Optional targetRemoteClientId on
 *   ApplyPosting → stored in ticket metadata so the dispatcher pins the submission to the operator's
 *   chosen leaf node; enqueueApplyQueue applies one chosen node to the whole bulk mint.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve persisted owner_sub exactly while rehydrating/reaping apply work. Recovery no longer trims case-sensitive identities into another user's scope.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Carry strict final-submit authorization on each
 *   ticket. Authenticated single-job enqueue may authorize one task; shared bulk enqueue reads the
 *   installed Career app's exact-user setting under the existing request identity and mints nothing
 *   on absent/false settings, identity mismatch, app absence, or query failure.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Seal authorized ticket metadata against exact
 *   ticket/owner/posting/source, holding new tickets in backlog until the seal is durable so generic
 *   metadata writes and queue races cannot counterfeit or observe half-authorized work.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Rehydrate exact durable task/worker bindings and recover stale tickets into assist review, never blind auto-resubmission; periodic sweeps also reconcile raw claims and healthy-idle workers.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Rehydrate and reap from the Apply V2 run ledger, including the exact Career claim token, rather than reconstructing authority from callback capability rows.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Sweep durable timeout_at deadlines every thirty seconds so two-minute undispatched claims remain two-minute claims across restarts.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Cast the run-ledger join to text. Migration 118
 *   declares apply_runs.ticket_id TEXT while tickets.ticket_id is UUID, so the LATERAL join raised
 *   `operator does not exist: text = uuid` — the reaper sweep threw on EVERY tick, was caught and
 *   logged, and returned 0, so orphan recovery never ran once. Deploy 2026-08-06 surfaced it
 *   sixty seconds apart in the api log the moment migration 118 first applied. This is the
 *   recovery path for a browser that submitted before its callback was lost (ADR-101), i.e. the
 *   wedged-node case it exists for. Cast rather than re-typing the column: the ledger's TEXT
 *   ticket_id is deliberate and the table was still empty, so a cast is the whole fix.
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | Entry 9 fixed ONE of the two joins. The boot-time
 *   rehydrate carried the identical uncast comparison and threw once per api start — so in-flight
 *   apply work was never restored across a restart, which is the single thing this module's header
 *   promises. Caught only because the post-deploy log still showed one `text = uuid` line, 3ms
 *   BEFORE 'apply reaper started', proving it came from a different caller. Both sweeps now share
 *   the exported-SQL + guard treatment, and the guard asserts the pair so a third copy cannot be
 *   added uncast. The lesson is the fix method: grep every occurrence of the pattern, never patch
 *   the one the stack trace named.
 *
 * @module app/apply-enqueue
 */
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { CreateInternalTicketSchema, type InternalTicket } from '@/entities/ticket';
import {
  reapUserApplyClaims,
  abandonUnacknowledgedApply,
  reconcileApplyInFlight,
  recoverExpiredApplyRuns,
  recoverUnknownApply,
  runApplyCli,
} from '@/app/apply-submit';
import { applyInFlight, findByTicket } from '@/app/apply-inflight';
import {
  getRequestIdentity,
  runWithRequestIdentity,
  runWithSystemIdentity,
} from '@/shared/services/database/request-identity';
import { readCareerAutoSubmitAuthorization } from '@/app/apply-authorization-bridge';
import {
  applySubmitAuthorizationFromMetadata,
  applySubmitAuthorizationMetadata,
  CAREER_AUTO_SUBMIT_SETTING,
  FINAL_SUBMIT_DENIED,
  isApplyFinalSubmitAuthorized,
  requireApplySubmitAuthorizationSealing,
  type ApplySubmitAuthorization,
} from '@/app/apply-submit-authorization';

const logger = createChildLogger({ module: 'apply-enqueue' });

/** A packet-ready posting to file an apply ticket for. */
export interface ApplyPosting {
  postingId: number;
  company?: string;
  title?: string;
  url?: string;
  location?: string;
  /** Optional leaf node (desktop / remote) the operator chose to drive the browser. */
  targetRemoteClientId?: string;
}

export interface EnqueueOneResult { ok: boolean; ticketId?: string; deduped?: boolean; error?: string; }
export type EnqueueQueueDenialReason =
  | 'authenticated-user-required'
  | 'auto-submit-disabled'
  | 'authorization-unavailable';

export interface EnqueueQueueResult {
  ok: boolean;
  created: number;
  deduped: number;
  ticketIds: string[];
  note?: string;
  denialReason?: EnqueueQueueDenialReason;
}

const BULK_IDENTITY_NOTE = 'bulk auto-submit requires the exact authenticated user';
const BULK_DISABLED_NOTE = 'Career auto-submit is disabled for this user';
const BULK_UNAVAILABLE_NOTE = 'Career auto-submit authorization is unavailable';

/** Build the ticket title/description so the manifest-worker apply-intent regex matches (noun+verb)
 *  and the posting is unmistakable to a human reading the queue. */
function applyTicketFields(p: ApplyPosting): { title: string; description: string } {
  const company = (p.company || 'this company').trim();
  const title = (p.title || 'this role').trim();
  return {
    title: `Apply: ${company} — ${title}`.slice(0, 200),
    // Apply NOUN (resume/application/job posting) + action VERB (submit/apply) so applicationRequested
    // routes it to dispatchJobApplicationTask; the postingId in metadata is what selects the packet.
    description:
      `Auto-submit my generated resume application to this job posting and report the outcome.\n` +
      `Company: ${company}\nRole: ${title}\n` +
      (p.location ? `Location: ${p.location}\n` : '') +
      (p.url ? `URL: ${p.url}\n` : '') +
      `Posting ID: ${p.postingId}`,
  };
}

/** @description Upgrade one de-duplicated ticket without ever downgrading valid authorization. */
async function reuseApplyTicket(
  ctx: AppContext,
  existing: InternalTicket,
  userSub: string,
  postingId: number,
  authorization: ApplySubmitAuthorization,
): Promise<EnqueueOneResult> {
  const binding = { ticketId: existing.ticketId, userSub, postingId };
  const current = applySubmitAuthorizationFromMetadata(existing.metadata, binding);
  const requested = isApplyFinalSubmitAuthorized(authorization);
  if (requested && !isApplyFinalSubmitAuthorized(current)) {
    await ctx.ticketService.updateTicket(existing.ticketId, {
      metadata: { ...existing.metadata, ...applySubmitAuthorizationMetadata(authorization, binding) },
    });
  }
  if (existing.status === 'backlog' &&
      (isApplyFinalSubmitAuthorized(current) || requested)) {
    await ctx.ticketService.updateStatus(existing.ticketId, 'approved', {
      source: 'apply-enqueue', reason: 'final-submit authorization sealed',
    });
  }
  logger.info({ userSub, postingId, ticketId: existing.ticketId }, 'apply enqueue: deduped to existing open ticket');
  return { ok: true, ticketId: existing.ticketId, deduped: true };
}

/** @description Seal an authorized new ticket before making it visible to the queue manager. */
async function sealAndApproveApplyTicket(
  ctx: AppContext,
  ticket: Pick<InternalTicket, 'ticketId' | 'metadata'>,
  userSub: string,
  postingId: number,
  authorization: ApplySubmitAuthorization,
): Promise<void> {
  await ctx.ticketService.updateTicket(ticket.ticketId, {
    metadata: {
      ...ticket.metadata,
      ...applySubmitAuthorizationMetadata(authorization, { ticketId: ticket.ticketId, userSub, postingId }),
    },
  });
  await ctx.ticketService.updateStatus(ticket.ticketId, 'approved', {
    source: 'apply-enqueue', reason: 'final-submit authorization sealed',
  });
}

/** @description Create one durable ticket, sealing authorization before queue eligibility. */
async function createApplyTicket(
  ctx: AppContext,
  userSub: string,
  posting: ApplyPosting,
  fields: { title: string; description: string },
  authorization: ApplySubmitAuthorization,
): Promise<EnqueueOneResult> {
  const postingId = Number(posting.postingId);
  const authorized = isApplyFinalSubmitAuthorized(authorization);
  const ticket = await ctx.ticketService.createTicket(CreateInternalTicketSchema.parse({
    ...fields, ticketType: 'task', priority: 'medium', ownerSub: userSub,
    // Authorized tickets remain undispatchable until their ticket-id-bound seal is durable.
    status: authorized ? 'backlog' : 'approved',
    metadata: {
      source: 'apply-enqueue', postingId, applyPostingId: String(postingId),
      company: posting.company || null, jobUrl: posting.url || null,
      ...applySubmitAuthorizationMetadata(FINAL_SUBMIT_DENIED),
      ...(posting.targetRemoteClientId ? { targetRemoteClientId: posting.targetRemoteClientId } : {}),
    },
  }));
  if (authorized) {
    await sealAndApproveApplyTicket(ctx, ticket, userSub, postingId, authorization);
  }
  logger.info({ userSub, postingId, ticketId: ticket.ticketId }, 'apply enqueue: filed durable job-apply ticket');
  return { ok: true, ticketId: ticket.ticketId };
}

/**
 * @description File ONE durable `task` apply ticket for a specific packet-ready posting (the "auto
 * submit" button's action). Idempotent per posting: if a non-cancelled apply ticket already exists
 * for it, returns that one (deduped) instead of filing a duplicate. RLS-scoped to the owner.
 * @param ctx - App context (ticketService).
 * @param userSub - The OIDC sub who owns the ticket + résumé.
 * @param posting - The posting to apply to (postingId required; company/title/url for readability).
 * @returns The created (or existing) ticketId, or an error.
 */
export async function enqueueApplyTicket(
  ctx: AppContext,
  userSub: string,
  posting: ApplyPosting,
  authorization: ApplySubmitAuthorization = FINAL_SUBMIT_DENIED,
): Promise<EnqueueOneResult> {
  const postingId = Number(posting.postingId);
  if (!userSub) return { ok: false, error: 'userSub required' };
  if (!Number.isFinite(postingId) || postingId <= 0) return { ok: false, error: 'a valid postingId is required' };
  const { title, description } = applyTicketFields(posting);
  try {
    if (isApplyFinalSubmitAuthorized(authorization)) requireApplySubmitAuthorizationSealing();
    return await runWithRequestIdentity({ sub: userSub, isOperator: false }, async () => {
      const existing = await ctx.ticketService.findActiveTicketByMetadataKey('applyPostingId', String(postingId));
      if (existing) {
        return reuseApplyTicket(ctx, existing, userSub, postingId, authorization);
      }
      return createApplyTicket(ctx, userSub, posting, { title, description }, authorization);
    });
  } catch (err) {
    logger.error({ err, userSub, postingId }, 'apply enqueue: failed to file ticket');
    return { ok: false, error: err instanceof Error ? err.message : 'enqueue failed' };
  }
}

/**
 * How stale an in-flight apply ticket must be before the reaper touches it. MUST stay above
 * APPLY_SUBMISSION_TIMEOUT (30 min): the desktop node is a SEPARATE process that keeps working across
 * an api restart, so a fresher ticket may still be mid-submission and could yet report to
 * /api/apply/ingest. Reaping one of those would re-apply a job the node is actively submitting.
 */
const ORPHAN_AFTER_MS = 35 * 60 * 1000;
const REAP_EVERY_MS = 10 * 60 * 1000;
const RECONCILE_EVERY_MS = 30 * 1000;

/** A submission dispatched within this window may still be live on the desktop, so it must keep
 *  holding the per-user in-flight slot after a controller restart. Matches APPLY_SUBMISSION_TIMEOUT. */
const REHYDRATE_WITHIN_MS = 30 * 60 * 1000;

/**
 * @description Rebuild the in-flight registry from Postgres at boot. `hasUserInFlight` is what makes
 * the durable queue submit ONE job at a time, but it reads a process-memory Map — so every controller
 * restart forgot the live submission and immediately dispatched a second one onto the same desktop
 * Chrome (observed 2026-07-21: the deploy's own restart put two applies on the node at once). Seeding
 * the Map from tickets still in `in_process_build` keeps the slot held across restarts; the entries
 * are cleared normally by /api/apply/ingest (findByTicket) or age out, after which the reaper recovers
 * anything the node never reported.
 * @param ctx - App context (pool).
 * @returns How many in-flight submissions were restored.
 */
export async function rehydrateApplyInFlight(ctx: AppContext): Promise<number> {
  if (!ctx.pool) return 0;
  try {
    // Cross-owner boot sweep over the owner-RLS'd tickets table: SYSTEM identity, or
    // OSHAL_DB_GUC_STRICT=deny rejects the identity-less query and this silently restores nothing.
    const { rows } = await runWithSystemIdentity(() => ctx.pool!.query(
      REHYDRATE_APPLY_TICKETS_SQL,
      [REHYDRATE_WITHIN_MS],
    ));
    let restored = 0;
    for (const row of rows as Array<{
      ticket_id: string; owner_sub: string | null; posting_id: string | null;
      age_ms: string; run_id: string | null; claim_token: string | null;
      task_id: string | null; client_id: string | null;
    }>) {
      const userSub = typeof row.owner_sub === 'string' ? row.owner_sub : '';
      if (userSub.length === 0) continue;
      const taskId = row.task_id || `rehydrated:${row.ticket_id}`;
      if (applyInFlight.has(taskId)) continue;
      const remaining = Math.max(60 * 1000, REHYDRATE_WITHIN_MS - Number(row.age_ms || 0));
      // Release the slot when the window lapses. Recovery is the reaper's job, not this timer's.
      const timer = setTimeout(() => { applyInFlight.delete(taskId); }, remaining);
      if (typeof timer.unref === 'function') timer.unref();
      applyInFlight.set(taskId, {
        taskId, ticketId: row.ticket_id, postingId: Number(row.posting_id) || 0,
        userSub, clientId: row.client_id || undefined,
        runId: row.run_id || undefined, claimToken: row.claim_token || undefined,
        timer, startedAt: Date.now() - Number(row.age_ms || 0),
      });
      restored += 1;
    }
    if (restored) logger.info({ restored }, 'apply in-flight registry rehydrated after restart (slot held)');
    return restored;
  } catch (err) {
    logger.error({ err }, 'apply in-flight rehydrate failed');
    return 0;
  }
}

interface StaleApplyRow {
  ticket_id: string;
  owner_sub: string | null;
  posting_id: string | null;
  run_id: string | null;
  claim_token: string | null;
  task_id: string | null;
  client_id: string | null;
}

/** Seed one exact stale run so the shared ambiguity-safe recovery path can settle it. */
function seedStaleApplyRun(row: StaleApplyRow): string | null {
  const userSub = typeof row.owner_sub === 'string' ? row.owner_sub : '';
  if (!userSub) return null;
  const current = findByTicket(row.ticket_id);
  if (current) return current.taskId;
  const taskId = row.task_id || `rehydrated:${row.ticket_id}`;
  const timer = setTimeout(() => undefined, ORPHAN_AFTER_MS);
  if (typeof timer.unref === 'function') timer.unref();
  applyInFlight.set(taskId, {
    taskId, ticketId: row.ticket_id, postingId: Number(row.posting_id) || 0,
    userSub, clientId: row.client_id || undefined, timer,
    runId: row.run_id || undefined, claimToken: row.claim_token || undefined,
    startedAt: Date.now() - ORPHAN_AFTER_MS,
  });
  return taskId;
}

/** Release raw legacy/expired claims for every owner known to the durable Apply ticket rail. */
async function reapKnownRawClaims(ctx: AppContext): Promise<number> {
  const result = await runWithSystemIdentity(() => ctx.pool!.query(
    `SELECT DISTINCT owner_sub FROM tickets
      WHERE metadata->>'source'='apply-enqueue' AND owner_sub IS NOT NULL`,
  ));
  let released = 0;
  for (const row of result.rows as Array<{ owner_sub: string }>) {
    const outcome = await reapUserApplyClaims(row.owner_sub);
    released += Number(outcome?.released || 0);
  }
  return released;
}

/**
 * Stale-apply sweep, exported so its regression guard executes THIS string rather than a copy.
 * A guard holding its own transcription of a query proves the transcription works, which is how a
 * broken production query keeps a green test.
 *
 * `t.ticket_id::text` is load-bearing: migration 118 declares `apply_runs.ticket_id` TEXT while
 * `tickets.ticket_id` is UUID, and Postgres has no `text = uuid` operator. Uncast, the sweep throws
 * on every tick, gets caught below, and reports zero reaped — a silent no-op, not a visible failure.
 */
export const REHYDRATE_APPLY_TICKETS_SQL =
  `SELECT t.ticket_id, t.owner_sub, t.metadata->>'applyPostingId' AS posting_id,
          EXTRACT(EPOCH FROM (now() - t.updated_at)) * 1000 AS age_ms,
          run.run_id, run.claim_token, run.task_id, run.worker_client_id AS client_id
     FROM tickets t
     LEFT JOIN LATERAL (
       SELECT run_id, claim_token, task_id, worker_client_id FROM apply_runs
        WHERE ticket_id=t.ticket_id::text
          AND state IN ('claimed','queued_to_worker','acknowledged','running')
        ORDER BY claimed_at DESC LIMIT 1
     ) run ON TRUE
    WHERE t.metadata->>'source' = 'apply-enqueue'
      AND t.status = 'in_process_build'
      AND t.updated_at > now() - ($1::int * interval '1 millisecond')`;

export const STALE_APPLY_TICKETS_SQL =
  `SELECT t.ticket_id, t.owner_sub, t.metadata->>'applyPostingId' AS posting_id,
          run.run_id, run.claim_token, run.task_id, run.worker_client_id AS client_id
     FROM tickets t
     LEFT JOIN LATERAL (
       SELECT run_id, claim_token, task_id, worker_client_id FROM apply_runs
        WHERE ticket_id=t.ticket_id::text ORDER BY claimed_at DESC LIMIT 1
     ) run ON TRUE
    WHERE t.metadata->>'source' = 'apply-enqueue'
      AND t.status = 'in_process_build'
      AND t.updated_at < now() - ($1::int * interval '1 millisecond')`;

/**
 * @description Recover stale Apply tickets into human confirmation, never `approved`. A browser may
 * have clicked Submit before its callback was lost, so blind re-dispatch is forbidden by ADR-101.
 * Also releases legacy/expired raw SQLite claims for every known exact owner.
 */
export async function reapOrphanedApplyTickets(ctx: AppContext): Promise<number> {
  if (!ctx.pool) return 0;
  try {
    // Cross-owner background sweep over the owner-RLS'd tickets table: SYSTEM identity, or
    // OSHAL_DB_GUC_STRICT=deny rejects the identity-less query and nothing is ever reaped.
    const { rows } = await runWithSystemIdentity(() => ctx.pool!.query(
      STALE_APPLY_TICKETS_SQL,
      [ORPHAN_AFTER_MS],
    ));
    let reaped = 0;
    for (const row of rows as StaleApplyRow[]) {
      const taskId = seedStaleApplyRun(row);
      const task = taskId ? applyInFlight.get(taskId) : undefined;
      const settled = task && !row.task_id
        ? await abandonUnacknowledgedApply(ctx, task)
        : taskId
          ? await recoverUnknownApply(ctx, taskId, 'apply_controller_restart_orphan')
          : false;
      if (settled) {
        reaped += 1;
      }
    }
    const rawClaims = await reapKnownRawClaims(ctx);
    if (reaped || rawClaims) logger.info({ reaped, rawClaims }, 'apply reaper: parked orphaned runs and released raw claims');
    return reaped;
  } catch (err) {
    logger.error({ err }, 'apply reaper: sweep failed');
    return 0;
  }
}

let recoverySweepRunning = false;
let deadlineSweepRunning = false;

/** Enforce ledger deadlines and current healthy-worker truth on the fast recovery cadence. */
async function runApplyDeadlineSweep(ctx: AppContext): Promise<void> {
  if (deadlineSweepRunning) return;
  deadlineSweepRunning = true;
  try {
    const expired = await recoverExpiredApplyRuns(ctx);
    const live = await reconcileApplyInFlight(ctx);
    if (expired || live) logger.warn({ expired, live }, 'apply deadline sweep settled stale work');
  } catch (err) {
    logger.error({ err }, 'apply deadline sweep failed');
  } finally { deadlineSweepRunning = false; }
}

/** Reconcile live worker truth before the slower stale-ticket/raw-claim sweep. */
async function runApplyRecoverySweep(ctx: AppContext): Promise<void> {
  if (recoverySweepRunning) return;
  recoverySweepRunning = true;
  try {
    const live = await reconcileApplyInFlight(ctx);
    const stale = await reapOrphanedApplyTickets(ctx);
    if (live || stale) logger.warn({ live, stale }, 'apply recovery sweep settled orphaned work');
  } catch (err) {
    logger.error({ err }, 'apply recovery sweep failed');
  } finally { recoverySweepRunning = false; }
}

/**
 * @description Start the periodic orphan sweep (also runs once shortly after boot, which is when
 * orphans from the previous process are guaranteed to exist). Unref'd so it never holds the process.
 * @param ctx - App context.
 */
export function startApplyReaper(ctx: AppContext): void {
  const kick = setTimeout(() => {
    void runApplyDeadlineSweep(ctx);
    void runApplyRecoverySweep(ctx);
  }, 60 * 1000);
  const timer = setInterval(() => { void runApplyRecoverySweep(ctx); }, REAP_EVERY_MS);
  const reconcile = setInterval(() => { void runApplyDeadlineSweep(ctx); }, RECONCILE_EVERY_MS);
  if (typeof kick.unref === 'function') kick.unref();
  if (typeof timer.unref === 'function') timer.unref();
  if (typeof reconcile.unref === 'function') reconcile.unref();
  logger.info({ orphanAfterMs: ORPHAN_AFTER_MS, everyMs: REAP_EVERY_MS,
    reconcileEveryMs: RECONCILE_EVERY_MS }, 'apply reaper started');
}

/**
 * @description Bulk mint: file one durable apply ticket per packet-ready posting in the user's queue
 * (up to `limit`), de-duping against already-open tickets. This is the durable replacement for the
 * in-memory apply-batch-runner — the whole backlog becomes persisted tickets the queue manager works
 * one-at-a-time, surviving api restarts.
 * @param ctx - App context.
 * @param userSub - The OIDC sub whose ready queue to drain into tickets.
 * @param limit - Max tickets to mint this call (default 200).
 * @param targetRemoteClientId - Optional leaf node to pin every minted ticket to.
 * @returns Count created + deduped + the new ticketIds.
 */
export async function enqueueApplyQueue(ctx: AppContext, userSub: string, limit = 200, targetRemoteClientId?: string): Promise<EnqueueQueueResult> {
  if (!userSub) return { ok: false, created: 0, deduped: 0, ticketIds: [], note: 'userSub required' };
  const identity = getRequestIdentity();
  if (!identity || identity.system === true || identity.sub !== userSub) {
    return {
      ok: false, created: 0, deduped: 0, ticketIds: [],
      denialReason: 'authenticated-user-required', note: BULK_IDENTITY_NOTE,
    };
  }
  const decision = await readCareerAutoSubmitAuthorization(ctx.pool, userSub);
  if (!decision.authorized) {
    const unavailable = decision.reason === 'unavailable';
    return {
      ok: false, created: 0, deduped: 0, ticketIds: [],
      denialReason: unavailable ? 'authorization-unavailable' : 'auto-submit-disabled',
      note: unavailable ? BULK_UNAVAILABLE_NOTE : BULK_DISABLED_NOTE,
    };
  }
  try { requireApplySubmitAuthorizationSealing(); }
  catch {
    return {
      ok: false, created: 0, deduped: 0, ticketIds: [],
      denialReason: 'authorization-unavailable', note: BULK_UNAVAILABLE_NOTE,
    };
  }
  const cap = Math.max(1, Math.min(500, limit));
  // The CLI emits snake_case rows (posting_id) — the sqlite/DB convention. Normalize to the
  // camelCase ApplyPosting shape enqueueApplyTicket expects (postingId), or every row fails the
  // postingId check and nothing is minted.
  const listed = await runApplyCli(userSub, ['queue', 'list', '--limit', String(cap)]) as { items?: Array<Record<string, unknown>>; returned?: number } | null;
  const rawItems = Array.isArray(listed?.items) ? listed!.items : [];
  const items: ApplyPosting[] = rawItems.map((r) => ({
    postingId: Number(r.posting_id ?? r.postingId),
    company: r.company != null ? String(r.company) : undefined,
    title: r.title != null ? String(r.title) : undefined,
    url: r.url != null ? String(r.url) : undefined,
    location: r.location != null ? String(r.location) : undefined,
    ...(targetRemoteClientId ? { targetRemoteClientId } : {}),
  })).filter((p) => Number.isFinite(p.postingId) && p.postingId > 0);
  if (!items.length) return { ok: true, created: 0, deduped: 0, ticketIds: [], note: 'no packet-ready postings in the queue' };
  const ticketIds: string[] = [];
  let deduped = 0;
  for (const item of items) {
    const r = await enqueueApplyTicket(ctx, userSub, item, CAREER_AUTO_SUBMIT_SETTING);
    if (r.ok && r.ticketId) { if (r.deduped) deduped += 1; else ticketIds.push(r.ticketId); }
  }
  logger.info({ userSub, created: ticketIds.length, deduped, listed: items.length }, 'apply enqueue: bulk mint complete');
  return { ok: true, created: ticketIds.length, deduped, ticketIds, note: `minted ${ticketIds.length} apply tickets (${deduped} already queued)` };
}
