/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit explicitly opted-in Futures reviews to their own durable workflow without performing inference in the study worker.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from './composition-root';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';
import { getActiveRegistry } from './extensions/swarm/swarm-bot-registry';
import { getTradingScheduleService } from './trading-schedule-dispatch';
import { ensureFuturesResearchTable, futuresResearchTaskType, type FuturesResearchRun } from './trading-futures-research-dispatch';
import type { FuturesResearchReview } from './trading-futures-research-review-contract';

const logger = createChildLogger({ module: 'futures-research-queue' });

/** @description Dedicated companion workflow and worker; never the equity decision queue. */
export const FUTURES_REVIEW_WORKFLOW = 'futures-research';
/** @description Stable identity owned by the Futures Research companion package. */
export const FUTURES_REVIEW_WORKER = '7c51c6e6-cc8a-4de9-8695-40584737789d';
/** @description Services needed for durable admission, with no model execution capability. */
export type FuturesQueueContext = Pick<AppContext, 'pool' | 'ticketService'>;

/** @description Fail before opting in if the separate package or exact worker is unavailable. */
export function assertFuturesReviewWorkflow(): void {
  const workflow = WorkflowPipelineRegistry.getInstance().resolve(FUTURES_REVIEW_WORKFLOW);
  const worker = getActiveRegistry().find(bot => bot.agentId === FUTURES_REVIEW_WORKER);
  if (workflow?.workerBot !== 'futures-research-worker' || workflow.pipeline !== 'manifest-worker' || !workflow.autoStart
    || worker?.name !== 'futures-research-worker' || worker.container !== 'futures-research-worker') {
    throw new Error('Install and activate the Futures Research package and its dedicated bot endpoint before enabling nightly review');
  }
}

/** @description Recheck the current owner, schedule and explicit opt-in, including at queued execution time. */
export async function assertFuturesReviewOptIn(run: FuturesResearchRun): Promise<void> {
  if (!isOperatorIdentity(run.ownerSub)) throw new Error('Futures review owner no longer has operator access');
  const schedule = await getTradingScheduleService()?.getSchedule(run.scheduleId);
  const config = schedule?.taskData?.futures as { nightlyReview?: boolean } | undefined;
  if (!schedule || schedule.ownerSub !== run.ownerSub || schedule.taskType !== futuresResearchTaskType(run.ownerSub)
    || schedule.status !== 'active' || config?.nightlyReview !== true) {
    throw new Error('Futures review requires the owner\'s active schedule and explicit nightly-review opt-in');
  }
  assertFuturesReviewWorkflow();
}

/** @description Load exact owner-qualified evidence; IDs and metadata alone never authorize a review. */
export async function readFuturesQueueRun(pool: AppContext['pool'], owner: string, runId: string): Promise<FuturesResearchRun> {
  const row = (await pool.query('SELECT * FROM oshal_trading_futures_research_runs WHERE run_id=$1 AND owner_sub=$2', [runId, owner])).rows[0];
  if (!row || !['completed', 'insufficient_sample', 'unchanged'].includes(row.status) || !row.markets?.length) throw new Error('Futures review has no owned completed evidence');
  return { runId: row.run_id, ownerSub: row.owner_sub, scheduleId: row.schedule_id, status: row.status,
    config: row.config, markets: row.markets, review: row.review, error: row.error,
    createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null };
}

/** @description Fence every review write by its admitted attempt and never downgrade a completed result. */
export async function settleFuturesQueuedReview(pool: AppContext['pool'], run: FuturesResearchRun, review: FuturesResearchReview, states = ['queued', 'reviewing']): Promise<boolean> {
  const saved = await pool.query(`UPDATE oshal_trading_futures_research_runs SET review=$4::jsonb
    WHERE run_id=$1 AND owner_sub=$2 AND review->>'attemptId'=$3 AND review->>'status'=ANY($5::text[]) RETURNING run_id`,
  [run.runId, run.ownerSub, review.attemptId, JSON.stringify(review), states]);
  return saved.rows.length > 0;
}

/** @description Stage the ticket paused, bind it durably, then make it dispatchable. No inference here. */
async function publishReviewTicket(ctx: FuturesQueueContext, run: FuturesResearchRun, review: FuturesResearchReview): Promise<void> {
  const ticket = await ctx.ticketService.createTicket({ title: `Futures study review — ${run.config.roots.join(', ')}`,
    ticketType: FUTURES_REVIEW_WORKFLOW, status: 'paused', ownerSub: run.ownerSub,
    description: 'Review the bound historical study. Evidence is resolved from the owner-scoped ledger at execution; no order or schedule-edit authority.',
    priority: 'none', labels: ['futures-research'], workspaceId: null, assignedAgentId: null, parentTicketId: null,
    externalProvider: null, externalId: null, externalUrl: null,
    metadata: { source: FUTURES_REVIEW_WORKFLOW, runId: run.runId, reviewAttemptId: review.attemptId } });
  review.ticketId = ticket.ticketId;
  if (!await settleFuturesQueuedReview(ctx.pool, run, review)) {
    await ctx.ticketService.updateStatus(ticket.ticketId, 'cancelled', { source: FUTURES_REVIEW_WORKFLOW, reason: 'review_attempt_superseded' });
    throw new Error('Futures review admission was superseded');
  }
  await ctx.ticketService.updateStatus(ticket.ticketId, 'backlog', { source: FUTURES_REVIEW_WORKFLOW });
}

/** @description Queue a new opted-in review or return its existing state; failed publication stays visible and retryable. */
export async function queueFuturesResearchReview(ctx: FuturesQueueContext, owner: string, runId: string): Promise<FuturesResearchReview> {
  await ensureFuturesResearchTable(ctx.pool);
  const run = await readFuturesQueueRun(ctx.pool, owner, runId);
  await assertFuturesReviewOptIn(run);
  const review: FuturesResearchReview = { status: 'queued', attemptId: randomUUID(), requestedAt: new Date().toISOString() };
  const admitted = await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET review=$3::jsonb
    WHERE run_id=$1 AND owner_sub=$2 AND (review IS NULL OR review->>'status'='failed') RETURNING run_id`, [runId, owner, JSON.stringify(review)]);
  if (!admitted.rows.length) return (await readFuturesQueueRun(ctx.pool, owner, runId)).review!;
  try { await publishReviewTicket(ctx, run, review); }
  catch (error) {
    logger.error({ err: error, runId, ticketId: review.ticketId }, 'Futures review ticket publication failed');
    const failed: FuturesResearchReview = { ...review, status: 'failed', completedAt: new Date().toISOString(),
      error: 'Nightly review could not enter its workflow. Check the review ticket and package, then retry; the study is unchanged.' };
    await settleFuturesQueuedReview(ctx.pool, run, failed);
    return failed;
  }
  return review;
}
