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
 *
 * @module app/apply-enqueue
 */
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { runApplyCli } from '@/app/apply-submit';
import { applyInFlight } from '@/app/apply-inflight';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';

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
export interface EnqueueQueueResult { ok: boolean; created: number; deduped: number; ticketIds: string[]; note?: string; }

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

/**
 * @description File ONE durable `task` apply ticket for a specific packet-ready posting (the "auto
 * submit" button's action). Idempotent per posting: if a non-cancelled apply ticket already exists
 * for it, returns that one (deduped) instead of filing a duplicate. RLS-scoped to the owner.
 * @param ctx - App context (ticketService).
 * @param userSub - The OIDC sub who owns the ticket + résumé.
 * @param posting - The posting to apply to (postingId required; company/title/url for readability).
 * @returns The created (or existing) ticketId, or an error.
 */
export async function enqueueApplyTicket(ctx: AppContext, userSub: string, posting: ApplyPosting): Promise<EnqueueOneResult> {
  const postingId = Number(posting.postingId);
  if (!userSub) return { ok: false, error: 'userSub required' };
  if (!Number.isFinite(postingId) || postingId <= 0) return { ok: false, error: 'a valid postingId is required' };
  const { title, description } = applyTicketFields(posting);
  try {
    return await runWithRequestIdentity({ sub: userSub, isOperator: false }, async () => {
      const existing = await ctx.ticketService.findActiveTicketByMetadataKey('applyPostingId', String(postingId));
      if (existing) {
        logger.info({ userSub, postingId, ticketId: existing.ticketId }, 'apply enqueue: deduped to existing open ticket');
        return { ok: true, ticketId: existing.ticketId, deduped: true };
      }
      // .parse() fills the schema defaults (labels/externalId/…) so the object satisfies the
      // post-default CreateInternalTicketInput type — cleaner + validated vs. the `as never` idiom.
      const ticket = await ctx.ticketService.createTicket(CreateInternalTicketSchema.parse({
        title,
        description,
        ticketType: 'task',
        status: 'approved',            // skip the manual backlog gate — the queue works it directly
        priority: 'medium',
        ownerSub: userSub,
        metadata: {
          source: 'apply-enqueue',
          postingId,                   // number — dispatchJobApplicationTask reads this to pick the packet
          applyPostingId: String(postingId),  // string — dedup key (metadata ->> 'applyPostingId')
          company: posting.company || null,
          jobUrl: posting.url || null,
          // Optional pinned leaf node — dispatchJobApplicationTask forwards it so THIS box drives the browser.
          ...(posting.targetRemoteClientId ? { targetRemoteClientId: posting.targetRemoteClientId } : {}),
        },
      }));
      const ticketId = (ticket as { ticketId?: string; id?: string }).ticketId ?? (ticket as { id?: string }).id;
      logger.info({ userSub, postingId, ticketId }, 'apply enqueue: filed durable job-apply ticket');
      return { ok: true, ticketId };
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
      `SELECT ticket_id, owner_sub, metadata->>'applyPostingId' AS posting_id,
              EXTRACT(EPOCH FROM (now() - updated_at)) * 1000 AS age_ms
         FROM tickets
        WHERE metadata->>'source' = 'apply-enqueue'
          AND status = 'in_process_build'
          AND updated_at > now() - ($1::int * interval '1 millisecond')`,
      [REHYDRATE_WITHIN_MS],
    ));
    let restored = 0;
    for (const row of rows as Array<{ ticket_id: string; owner_sub: string | null; posting_id: string | null; age_ms: string }>) {
      const userSub = String(row.owner_sub || '').trim();
      if (!userSub) continue;
      const taskId = `rehydrated:${row.ticket_id}`;
      if (applyInFlight.has(taskId)) continue;
      const remaining = Math.max(60 * 1000, REHYDRATE_WITHIN_MS - Number(row.age_ms || 0));
      // Release the slot when the window lapses. Recovery is the reaper's job, not this timer's.
      const timer = setTimeout(() => { applyInFlight.delete(taskId); }, remaining);
      if (typeof timer.unref === 'function') timer.unref();
      applyInFlight.set(taskId, {
        taskId, ticketId: row.ticket_id, postingId: Number(row.posting_id) || 0,
        userSub, timer, startedAt: Date.now() - Number(row.age_ms || 0),
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

/**
 * @description Recover apply tickets orphaned in `in_process_build`. The in-flight registry + its
 * 30-minute watchdog live in PROCESS MEMORY, so an api restart (deploy, crash, the stack watchdog
 * recreating containers) loses them: the ticket is stuck in_process_build forever because the queue
 * manager only ever dispatches `approved`. This returns sufficiently-stale ones to the queue and
 * rolls their posting's claim back, so an overnight drain genuinely survives restarts.
 *
 * Safety: only tickets older than ORPHAN_AFTER_MS (> the watchdog window) are touched, and the
 * `queue requeue` CLI hard-refuses any posting with applied_at set — a submitted application is never
 * resurrected into a duplicate.
 * @param ctx - App context (ticketService + pool).
 * @returns How many tickets were returned to the queue.
 */
export async function reapOrphanedApplyTickets(ctx: AppContext): Promise<number> {
  if (!ctx.pool) return 0;
  try {
    // Cross-owner background sweep over the owner-RLS'd tickets table: SYSTEM identity, or
    // OSHAL_DB_GUC_STRICT=deny rejects the identity-less query and nothing is ever reaped.
    const { rows } = await runWithSystemIdentity(() => ctx.pool!.query(
      `SELECT ticket_id, owner_sub, metadata->>'applyPostingId' AS posting_id
         FROM tickets
        WHERE metadata->>'source' = 'apply-enqueue'
          AND status = 'in_process_build'
          AND updated_at < now() - ($1::int * interval '1 millisecond')`,
      [ORPHAN_AFTER_MS],
    ));
    let reaped = 0;
    for (const row of rows as Array<{ ticket_id: string; owner_sub: string | null; posting_id: string | null }>) {
      const userSub = String(row.owner_sub || '').trim();
      if (!userSub) continue;
      // Roll the claim back first so the re-queued ticket can actually find its posting again.
      if (row.posting_id) await runApplyCli(userSub, ['queue', 'requeue', String(row.posting_id)]);
      try {
        await runWithRequestIdentity({ sub: userSub, isOperator: false }, () =>
          ctx.ticketService.updateStatus(row.ticket_id, 'approved', {
            source: 'apply-reaper',
            reason: 'orphaned_in_flight_recovered',
            message: 'The submission was in flight when the controller restarted and never reported back; returned to the queue.',
          }));
        reaped += 1;
      } catch (err) { logger.warn({ err, ticketId: row.ticket_id }, 'apply reaper: ticket requeue failed'); }
    }
    if (reaped) logger.info({ reaped }, 'apply reaper: returned orphaned in-flight apply tickets to the queue');
    return reaped;
  } catch (err) {
    logger.error({ err }, 'apply reaper: sweep failed');
    return 0;
  }
}

/**
 * @description Start the periodic orphan sweep (also runs once shortly after boot, which is when
 * orphans from the previous process are guaranteed to exist). Unref'd so it never holds the process.
 * @param ctx - App context.
 */
export function startApplyReaper(ctx: AppContext): void {
  const kick = setTimeout(() => { void reapOrphanedApplyTickets(ctx); }, 60 * 1000);
  const timer = setInterval(() => { void reapOrphanedApplyTickets(ctx); }, REAP_EVERY_MS);
  if (typeof kick.unref === 'function') kick.unref();
  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ orphanAfterMs: ORPHAN_AFTER_MS, everyMs: REAP_EVERY_MS }, 'apply reaper started');
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
    const r = await enqueueApplyTicket(ctx, userSub, item);
    if (r.ok && r.ticketId) { if (r.deduped) deduped += 1; else ticketIds.push(r.ticketId); }
  }
  logger.info({ userSub, created: ticketIds.length, deduped, listed: items.length }, 'apply enqueue: bulk mint complete');
  return { ok: true, created: ticketIds.length, deduped, ticketIds, note: `minted ${ticketIds.length} apply tickets (${deduped} already queued)` };
}
