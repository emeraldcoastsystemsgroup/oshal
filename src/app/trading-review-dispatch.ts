/**
 * Overnight signal review — score whether each signal meant anything, and give it mass + proximity.
 *
 * The gravity model treats each signal (algo) as a mass pulling price. This nightly job closes the
 * learning loop: it resolves matured predictions, scores each algo's hit-rate from the predictions
 * ledger, and writes a learned MASS (overall predictive edge, sample-shrunk toward neutral) and
 * PROXIMITY (recent edge — how reliable it's been LATELY) per algo. The live multi-timeframe ensemble
 * loads the masses so a proven signal pulls harder in every vote and a useless one fades. Self-tuning,
 * additive (no data → mass 1 → raw engine), and market-hours independent (runs overnight).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — resolve predictions, per-algo hit-rate → learned mass + proximity, persist for the ensemble, log a review ticket.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — ensureTradingSchema/resolveMaturedPredictions now come from app/trading-engine.ts instead of the carvable route surface. Zero behavior change.
 *
 * @module trading-review-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult } from '@/features/scheduling';
import { marketDataConfigured, type TradingMode } from '@/features/trading';
import { ensureTradingSchema, resolveMaturedPredictions } from './trading-engine';
import { upsertSignalWeight, loadSignalWeights, learnExpectancyEnabled } from './trading-signal-weights';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-review-dispatch' });

/** Below this many resolved predictions an algo stays neutral (mass 1) — don't learn from noise. */
const MIN_SAMPLES = 10;
/** Recency window for proximity (recent edge). */
const RECENT_DAYS = 30;

/** @description True for the overnight review schedule. */
export function isReviewSchedule(taskType: string): boolean { return taskType.startsWith('trading-review'); }
/** @description The per-user review schedule taskType. */
export function reviewTaskType(sub: string): string { return `trading-review:${sub}`; }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * @description Learned MASS from an algo's hit-rate, shrunk toward 1 (neutral) by sample size so a
 * lucky handful of calls can't over-tilt it. >50% hit → mass >1 (pull harder); <50% → mass <1.
 */
function massFromEdge(hitRate: number, samples: number): number {
  const shrink = Math.min(1, samples / 30);
  return clamp(1 + (hitRate - 0.5) * 2 * shrink, 0.3, 2.5);
}

/** Learned PROXIMITY from recent hit-rate — how reliable the signal has been LATELY (1 = on fire). */
function proximityFromRecent(recentHitRate: number): number {
  return clamp(0.3 + (recentHitRate - 0.5) * 1.4, 0.2, 1);
}

/** The avg signed-return % that maps to a FULL weight tilt (env-tunable; depends on horizon + vol). */
const EXPECTANCY_REF_PCT = Math.max(0.1, Number(process.env.TRADING_EXPECTANCY_REF_PCT || 1));

/**
 * @description Learned MASS from an algo's realized P&L EXPECTANCY (avg signed return %), shrunk by
 * sample size. +ref% expectancy → tilt up, −ref% → tilt down. Unlike hit-rate this PUNISHES a signal
 * whose wrong calls are big losers even if it's "right" more often — the fat-tail trap.
 */
function massFromExpectancy(expectancyPct: number, samples: number): number {
  const shrink = Math.min(1, samples / 30);
  const tilt = clamp(expectancyPct / EXPECTANCY_REF_PCT, -1, 1);
  return clamp(1 + tilt * shrink, 0.3, 2.5);
}

/** Learned PROXIMITY from RECENT expectancy — how PROFITABLE the signal has been lately (1 = on fire). */
function proximityFromRecentExpectancy(recentExpectancyPct: number): number {
  const tilt = clamp(recentExpectancyPct / EXPECTANCY_REF_PCT, -1, 1);
  return clamp(0.6 + tilt * 0.4, 0.2, 1);
}

/**
 * @description Dispatch the overnight signal review (resolve → score → learn mass/proximity → persist).
 * @param ctx - App context (pool, ticketService).
 * @param schedule - The due schedule (taskData carries userSub, mode).
 * @returns Dispatch result for scheduler accounting.
 */
export async function dispatchTradingReview(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const sub = String(td.userSub || '');
  const mode: TradingMode = String(td.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  if (!sub) return { success: false, scheduleId: schedule.id, error: 'review schedule missing userSub' };
  if (!marketDataConfigured()) { logger.info({ scheduleId: schedule.id }, 'review skipped — keys not configured'); return { success: true, scheduleId: schedule.id }; }

  try {
    await ensureTradingSchema(ctx.pool);
    const resolved = await resolveMaturedPredictions(ctx.pool, mode).catch(() => 0);
    // Per-algo hit-rate AND realized P&L expectancy (overall + recent) from the resolved predictions
    // ledger. Expectancy = avg signed return when the algo fired: a correct call earns its move, a wrong
    // one loses its move — so magnitude (fat-tail losers) counts, not just direction.
    const ret = `(CASE WHEN pred_dir='up' THEN (actual_price - price) ELSE (price - actual_price) END) / NULLIF(price,0) * 100`;
    const rows = (await ctx.pool.query(
      `SELECT algo,
              COUNT(*) FILTER (WHERE resolved)::int AS samples,
              COUNT(*) FILTER (WHERE resolved AND hit)::int AS hits,
              COUNT(*) FILTER (WHERE resolved AND created_at > now() - ($1 || ' days')::interval)::int AS recent_samples,
              COUNT(*) FILTER (WHERE resolved AND hit AND created_at > now() - ($1 || ' days')::interval)::int AS recent_hits,
              AVG(${ret}) FILTER (WHERE resolved AND price > 0 AND actual_price IS NOT NULL) AS avg_ret,
              AVG(${ret}) FILTER (WHERE resolved AND price > 0 AND actual_price IS NOT NULL AND created_at > now() - ($1 || ' days')::interval) AS recent_avg_ret
         FROM oshal_trading_predictions WHERE mode=$2 GROUP BY algo`, [String(RECENT_DAYS), mode])).rows;

    const useExp = learnExpectancyEnabled();
    let learned = 0;
    for (const r of rows) {
      const samples = Number(r.samples);
      if (samples < MIN_SAMPLES) continue; // too little signal to learn from
      const hitRate = samples ? Number(r.hits) / samples : 0.5;
      const recentHitRate = Number(r.recent_samples) ? Number(r.recent_hits) / Number(r.recent_samples) : hitRate;
      const haveRet = r.avg_ret != null;
      const expectancy = haveRet ? Number(r.avg_ret) : 0;
      const recentExpectancy = r.recent_avg_ret != null ? Number(r.recent_avg_ret) : expectancy;
      // P&L-aware learning (TRADING_LEARN_EXPECTANCY) when we have realized returns; else hit-rate.
      const mass = (useExp && haveRet) ? massFromExpectancy(expectancy, samples) : massFromEdge(hitRate, samples);
      const proximity = (useExp && haveRet) ? proximityFromRecentExpectancy(recentExpectancy) : proximityFromRecent(recentHitRate);
      await upsertSignalWeight(ctx.pool, { algo: String(r.algo), mass, proximity, hitRate, samples, expectancy });
      learned += 1;
    }

    const weights = await loadSignalWeights(ctx.pool);
    logger.info({ scheduleId: schedule.id, resolved, learnedAlgos: learned }, 'overnight signal review complete');
    if (learned) await logReviewTicket(ctx, sub, mode, weights).catch((e) => logger.warn({ err: e }, 'review ticket failed'));
    return { success: true, scheduleId: schedule.id, taskId: `review-${schedule.id}` };
  } catch (e) {
    logger.error({ err: e, scheduleId: schedule.id }, 'overnight review failed');
    return { success: false, scheduleId: schedule.id, error: (e as Error).message };
  }
}

/** Log the learned mass/proximity table (the "what meant anything" report). */
async function logReviewTicket(ctx: AppContext, sub: string, mode: TradingMode, weights: Awaited<ReturnType<typeof loadSignalWeights>>): Promise<void> {
  const line = weights.map((w) => `${w.algo}: mass ${w.mass.toFixed(2)} · prox ${w.proximity.toFixed(2)} (${(w.hitRate * 100).toFixed(0)}% hit, exp ${w.expectancy >= 0 ? '+' : ''}${w.expectancy.toFixed(2)}% / ${w.samples})`).join('\n');
  await ctx.ticketService.createTicket({
    title: `🧠 Overnight signal review — ${weights.length} signal(s) re-weighted [${mode}]`,
    ticketType: 'trading-decision', ownerSub: sub, status: 'complete',
    description: `Learned MASS (predictive edge) + PROXIMITY (recent reliability) per signal:\n${line}`,
    priority: 'none', labels: [], workspaceId: null, assignedAgentId: null, parentTicketId: null,
    externalProvider: null, externalId: null, externalUrl: null,
    metadata: { source: 'trading-review', book: mode, firedAt: new Date().toISOString(), weights },
  });
}
