/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind scheduled research to exact durable evidence and fence validated results around the existing signed/accounted worker rail.
 */
import type { Pool } from 'pg';
import type { AppContext } from './composition-root';
import type { BindManifestWorker } from '@/features/swarm-orchestration';
import { futuresReviewPrompt, parseFuturesReview, type FuturesResearchReview } from './trading-futures-research-review-contract';
import { assertFuturesReviewOptIn, FUTURES_REVIEW_WORKFLOW, FUTURES_REVIEW_WORKER, readFuturesQueueRun, settleFuturesQueuedReview } from './trading-futures-research-queue';

/** @description Build the queued evidence contract; unrelated workflows are untouched and forged tickets never reach inference. */
export function bindFuturesResearchWorker(pool: Pool): BindManifestWorker {
  return async (ticket, workflow, agentId) => {
    if (ticket.ticketType !== FUTURES_REVIEW_WORKFLOW) return undefined;
    const meta = ticket.metadata ?? {};
    if (!ticket.ownerSub || workflow.ticketType !== FUTURES_REVIEW_WORKFLOW || workflow.workerBot !== 'futures-research-worker'
      || workflow.pipeline !== 'manifest-worker' || agentId !== FUTURES_REVIEW_WORKER
      || meta.source !== FUTURES_REVIEW_WORKFLOW || typeof meta.runId !== 'string' || typeof meta.reviewAttemptId !== 'string'
      || Object.hasOwn(meta, 'providerIntent') || Object.hasOwn(meta, 'targetAgentId')
      || !/^[0-9a-f-]{36}$/i.test(meta.runId)) throw new Error('Invalid bound Futures review ticket');
    const run = await readFuturesQueueRun(pool as AppContext['pool'], ticket.ownerSub, meta.runId);
    const review = run.review;
    if (!review || review.attemptId !== meta.reviewAttemptId || review.ticketId !== ticket.ticketId) throw new Error('Futures review ticket is unbound or superseded');
    let claimedHere = false;
    const fail = async (): Promise<void> => {
      await settleFuturesQueuedReview(pool as AppContext['pool'], run, { ...review, status: 'failed', completedAt: new Date().toISOString(),
        error: 'Scheduled review failed. Check the dedicated worker, provider, current access and schedule opt-in, then retry; the study is unchanged.' }, claimedHere ? ['reviewing'] : ['queued']);
    };
    const complete = async (response: string): Promise<void> => {
      const result = parseFuturesReview(response, run);
      if (!await settleFuturesQueuedReview(pool as AppContext['pool'], run, { ...review, status: 'completed', completedAt: new Date().toISOString(), result }, ['reviewing'])) {
        throw new Error('Futures review result was superseded');
      }
    };
    if (review.status === 'completed') return { prompt: '', reasonOnly: true, alreadyComplete: true, complete, fail };
    if (review.status !== 'queued') throw new Error('Futures review is not queued; inspect the existing attempt before retrying');
    try {
      await assertFuturesReviewOptIn(run);
      const claimed = await pool.query(`UPDATE oshal_trading_futures_research_runs SET review=$4::jsonb
        WHERE run_id=$1 AND owner_sub=$2 AND review->>'attemptId'=$3 AND review->>'status'='queued' RETURNING run_id`,
      [run.runId, run.ownerSub, review.attemptId, JSON.stringify({ ...review, status: 'reviewing' } satisfies FuturesResearchReview)]);
      if (!claimed.rows.length) throw new Error('Futures review was claimed by another worker');
      claimedHere = true;
    } catch (error) { await fail(); throw error; }
    return { prompt: futuresReviewPrompt(run), reasonOnly: true, complete, fail };
  };
}
