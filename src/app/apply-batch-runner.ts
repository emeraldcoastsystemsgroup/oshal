/**
 * Autonomous apply-batch runner — the server-side loop that works a user's whole apply queue
 * hands-off, so no external script (and no human) has to babysit it. It repeatedly gathers the
 * next packet-ready job, dispatches the browser submission to the desktop worker, waits for that
 * submission to REPORT BACK (the /api/apply/ingest callback clears the watchdog), then moves to the
 * next — sequentially, one at a time (a single desktop drives one Chrome; concurrent runs corrupt
 * forms). Stops when the queue is empty, a cap is hit, or an operator stops it. Single-flight per
 * user. Never throws out of the loop — a per-job failure just advances to the next job.
 *
 * This is the in-product replacement for the hand-run batch script: POST /api/apply/batch/start,
 * walk away, GET /api/apply/batch/status for the running tally.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial autonomous apply-batch
 *   runner: sequential gather->dispatch->await-ingest loop with per-user single-flight, an operator
 *   stop flag, and a live status snapshot. Waits on the apply-inflight watchdog (cleared by ingest or
 *   the 30-min timeout) so it never races ahead of the single desktop worker.
 *
 * @module app/apply-batch-runner
 */

import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import { gatherAndDispatch } from '@/app/apply-submit';
import { applyInFlight } from '@/app/apply-inflight';

const logger = createChildLogger({ module: 'apply-batch-runner' });

/** How long to wait for one submission to report back before advancing (safety cap above the
 *  apply-inflight watchdog's own 30-min timeout, which normally clears it first). */
const PER_JOB_WAIT_MS = 32 * 60 * 1000;
const POLL_MS = 15 * 1000;

export interface ApplyBatchState {
  userSub: string;
  running: boolean;
  dispatched: number;
  limit: number;
  startedAt: number;
  finishedAt?: number;
  lastCompany?: string;
  lastPostingId?: number;
  stopRequested: boolean;
  stoppedReason?: 'queue_empty' | 'limit_reached' | 'operator_stopped' | 'error';
}

const runners = new Map<string, ApplyBatchState>();

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** @description Live snapshot of a user's batch, or null if they never started one. */
export function getApplyBatchStatus(userSub: string): ApplyBatchState | null {
  return runners.get(userSub) ?? null;
}

/** @description Ask a running batch to stop after the current in-flight job. Returns false if none. */
export function stopApplyBatch(userSub: string): boolean {
  const state = runners.get(userSub);
  if (!state || !state.running) return false;
  state.stopRequested = true;
  logger.info({ userSub }, 'apply batch: operator stop requested');
  return true;
}

/**
 * @description Start (or return the already-running) autonomous batch for a user. Fire-and-forget:
 * returns the initial state immediately and drives the loop in the background.
 * @param ctx - App context (ticketService + engine access via gatherAndDispatch).
 * @param userSub - The OIDC sub whose apply queue to work.
 * @param limit - Max submissions this run (default 200 — effectively "the whole queue").
 */
export function startApplyBatch(ctx: AppContext, userSub: string, limit = 200): ApplyBatchState {
  const existing = runners.get(userSub);
  if (existing?.running) return existing;
  const state: ApplyBatchState = {
    userSub,
    running: true,
    dispatched: 0,
    limit: Math.max(1, limit),
    startedAt: Date.now(),
    stopRequested: false,
  };
  runners.set(userSub, state);
  void runLoop(ctx, state);
  logger.info({ userSub, limit: state.limit }, 'apply batch: started');
  return state;
}

/** @description The sequential loop. Never throws; records a terminal reason and marks not-running. */
async function runLoop(ctx: AppContext, state: ApplyBatchState): Promise<void> {
  try {
    while (state.dispatched < state.limit && !state.stopRequested) {
      const result = await gatherAndDispatch(ctx, state.userSub);
      if (result.status !== 202) {
        // 409 = no submittable job ready (queue drained) or a dispatch already in flight; either
        // way we stop cleanly. 503 = desktop worker offline. Anything non-202 ends the run.
        state.stoppedReason = result.status === 409 ? 'queue_empty' : 'error';
        logger.info({ userSub: state.userSub, status: result.status, body: result.body }, 'apply batch: loop ending (no 202)');
        break;
      }
      const body = result.body as { taskId?: string; postingId?: number; job?: { company?: string } };
      const taskId = String(body.taskId ?? '');
      state.dispatched += 1;
      state.lastPostingId = Number(body.postingId) || undefined;
      state.lastCompany = body.job?.company;
      logger.info({ userSub: state.userSub, dispatched: state.dispatched, postingId: state.lastPostingId, company: state.lastCompany }, 'apply batch: dispatched, awaiting report-back');

      // Wait for this submission to report back: the /api/apply/ingest callback (or the 30-min
      // watchdog) clears the in-flight entry keyed by taskId. Only then dispatch the next — one
      // desktop, one Chrome, strictly sequential.
      const deadline = Date.now() + PER_JOB_WAIT_MS;
      while (taskId && applyInFlight.has(taskId) && Date.now() < deadline && !state.stopRequested) {
        await sleep(POLL_MS);
      }
    }
    if (!state.stoppedReason) {
      state.stoppedReason = state.stopRequested ? 'operator_stopped' : 'limit_reached';
    }
  } catch (err) {
    state.stoppedReason = 'error';
    logger.error({ err, userSub: state.userSub }, 'apply batch: loop errored');
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
    logger.info({ userSub: state.userSub, dispatched: state.dispatched, reason: state.stoppedReason }, 'apply batch: finished');
  }
}
