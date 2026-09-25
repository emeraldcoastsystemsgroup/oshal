/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Accountable interactive Futures review with owner-bound admission, durable failure and fenced retries.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Allow explaining insufficient historical samples without treating them as passing evidence.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from './composition-root';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import { getActiveRegistry } from './extensions/swarm/swarm-bot-registry';
import { executeBotOrInline } from './routes/inline-bot-execution';
import { resolveUserLlmConnection } from './routes/free-tier-rotation';
import { ensureFuturesResearchTable, type FuturesResearchRun } from './trading-futures-research-dispatch';
import { futuresReviewPrompt, parseFuturesReview, type FuturesResearchReview } from './trading-futures-research-review-contract';

const logger = createChildLogger({ module: 'trading-futures-research-review' });
const botClient = new BotNodeClient(createRegistryEndpointResolver());
type Reviewer = (ctx: AppContext, owner: string, attemptId: string, prompt: string) => Promise<string>;

async function defaultReviewer(ctx: AppContext, owner: string, attemptId: string, prompt: string): Promise<string> {
  const agentId = getActiveRegistry().find((bot) => bot.name === 'futures-research-analyst')?.agentId;
  if (!agentId) throw new Error('Install or activate the Futures research reviewer in Intelligent Trades');
  const connection = await resolveUserLlmConnection(ctx.pool, owner);
  if (!connection) throw new Error('Connect a hosted research provider in Settings before requesting a Futures review');
  const result = await executeBotOrInline(ctx, botClient, agentId, {
    text: prompt, taskId: `futures-review-${attemptId}`, workspaceFolderId: `futures-review-${attemptId}`,
    agentId, userSub: owner, agenticMode: false, direct: true, byoLlmConnection: connection,
    byoLlmResolutionSource: connection.resolutionSource,
  });
  if (!result.success) throw new Error('Futures reviewer did not complete');
  return String(result.response || '');
}

async function claimReview(ctx: AppContext, owner: string, runId: string): Promise<{ run: FuturesResearchRun; review: FuturesResearchReview }> {
  if (!isOperatorIdentity(owner)) throw Object.assign(new Error('operator_only'), { statusCode: 403 });
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(runId)) throw Object.assign(new Error('invalid_run_id'), { statusCode: 400 });
  await ensureFuturesResearchTable(ctx.pool);
  const row = (await ctx.pool.query(`SELECT * FROM oshal_trading_futures_research_runs WHERE run_id=$1 AND owner_sub=$2`, [runId, owner])).rows[0];
  if (!row) throw Object.assign(new Error('futures_run_not_found'), { statusCode: 404 });
  if (!['completed', 'unchanged', 'insufficient_sample'].includes(row.status) || !row.markets?.length) throw Object.assign(new Error('futures_run_has_no_completed_evidence'), { statusCode: 409 });
  const review: FuturesResearchReview = { status: 'reviewing', attemptId: randomUUID(), requestedAt: new Date().toISOString() };
  const admitted = await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET review=$3::jsonb
    WHERE run_id=$1 AND owner_sub=$2 AND (review IS NULL OR review->>'status'='failed'
      OR (review->>'status'='reviewing' AND (review->>'requestedAt')::timestamptz < now()-interval '1 hour')) RETURNING run_id`,
  [runId, owner, JSON.stringify(review)]);
  if (!admitted.rows.length) {
    // Read again: a concurrent completion may have happened after the first SELECT.
    const current = (await ctx.pool.query(`SELECT review FROM oshal_trading_futures_research_runs WHERE run_id=$1 AND owner_sub=$2`, [runId, owner])).rows[0]?.review;
    if (current?.status === 'completed') return { run: rowToRun(row), review: current };
    throw Object.assign(new Error('futures_review_already_active'), { statusCode: 409 });
  }
  return { run: rowToRun(row), review };
}

function rowToRun(row: Record<string, any>): FuturesResearchRun {
  return { runId: row.run_id, ownerSub: row.owner_sub, scheduleId: row.schedule_id, status: row.status,
    config: row.config, markets: row.markets, error: row.error, createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null };
}

/**
 * @description Review an owned historical study on the accounted bot rail; never invoke an order or mutate its schedule.
 * @param ctx - Application services including the owner-aware pool and bot orchestrator.
 * @param owner - Authenticated operator subject, never taken from a request body.
 * @param runId - Immutable study to review.
 * @param reviewer - Inference seam for isolated tests; production uses the registered bot.
 * @returns Durable review state; a failed review does not falsify successful deterministic evidence.
 */
export async function reviewFuturesResearchRun(ctx: AppContext, owner: string, runId: string, reviewer: Reviewer = defaultReviewer): Promise<FuturesResearchReview> {
  const { run, review } = await claimReview(ctx, owner, runId);
  if (review.status === 'completed') return review;
  logger.info({ runId, attemptId: review.attemptId }, 'Futures review admitted');
  let settled: FuturesResearchReview;
  try {
    const result = parseFuturesReview(await reviewer(ctx, owner, review.attemptId, futuresReviewPrompt(run)), run);
    settled = { ...review, status: 'completed', completedAt: new Date().toISOString(), result };
  } catch (error) {
    logger.error({ err: error, runId, attemptId: review.attemptId }, 'Futures review failed');
    settled = { ...review, status: 'failed', completedAt: new Date().toISOString(), error: 'Review unavailable or invalid. Check the provider, bot activation and review logs, then retry.' };
  }
  const updated = await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET review=$4::jsonb
    WHERE run_id=$1 AND owner_sub=$2 AND review->>'attemptId'=$3 RETURNING run_id`, [runId, owner, review.attemptId, JSON.stringify(settled)]);
  if (!updated.rows.length) throw Object.assign(new Error('futures_review_superseded'), { statusCode: 409 });
  logger.info({ runId, status: settled.status, durationMs: Date.now() - Date.parse(review.requestedAt) }, 'Futures review settled');
  return settled;
}
