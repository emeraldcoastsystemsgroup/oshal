/**
 * Nightly strategy optimizer — backtest candidate parameter tweaks, RECOMMEND the better ones.
 *
 * What the operator asked for: every night, tweak the strategy parameters, backtest whether the tweak would
 * have improved results, and produce metrics + recommendations to REVIEW AND APPROVE before they go
 * live. This module is that job. It never changes how the bot trades on its own — it only writes
 * recommendations to oshal_trading_param_recommendations (status 'pending'); the operator approves on
 * the Tuning page, which writes the approved value to the param store the live (paper) engine reads.
 *
 * Backtest: walk-forward over recent DAILY closes for the ~100-name universe. For each candidate value
 * of each tunable param (holding the others at their current/approved values), replay the deterministic
 * signal at each historical day t from closes ≤ t and score it by the forward return t→t+H. No
 * look-ahead. Metric = expectancy (avg signed return %) with win-rate + sample size. A change is only
 * recommended when a candidate beats the current value's expectancy by a margin with enough signals.
 * Direction-vs-forward-move is a ranking proxy (not a fills/slippage sim) — honest v1, surfaced in the UI.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — walk-forward backtest, per-param grid search, recommendations store + approve/reject, nightly dispatch + on-demand run.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — ensureTradingSchema now comes from app/trading-engine.ts instead of the carvable route surface. Zero behavior change.
 *
 * @module trading-optimize-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult } from '@/features/scheduling';
import { marketDataConfigured, barsBatch, scoreSymbol, ensemble, DEFAULT_UNIVERSE, type StrategyParams, type TradingMode } from '@/features/trading';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { ensureTradingSchema } from './trading-engine';
import { loadStrategyParams, upsertStrategyParam, clampParam, isTunableParam, TUNABLE_PARAMS, PARAM_LABELS } from './trading-strategy-params';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-optimize-dispatch' });

/** Forward sessions used to score a signal (does the call pay off over the next week?). */
const HORIZON = 5;
/** Bars of history needed before the first eval (covers SMA50/gravity + the widest candidate window). */
const WARMUP = 55;
/** Bounded tail handed to the pure algos each step (they only read the tail) — keeps the walk O(n)·O(window). */
const LOOKBACK = 150;
/** Don't recommend a change off fewer signals than this (avoid noise). */
const MIN_SIGNALS = 30;
/** A candidate must beat the current value's expectancy by at least this (percentage points of return). */
const EXPECTANCY_MARGIN = 0.05;

/** Candidate grids per tunable param (the current/approved value is always included automatically). */
const GRID: Record<keyof StrategyParams, number[]> = {
  momentumSma: [10, 15, 20, 30, 50],
  rsiLow: [25, 30, 35, 40],
  rsiHigh: [60, 65, 70, 75],
  donchianWindow: [10, 15, 20, 30, 40],
  ensembleThreshold: [0.10, 0.15, 0.20, 0.25],
};

/** @description True for the nightly optimize schedule. */
export function isOptimizeSchedule(taskType: string): boolean { return taskType.startsWith('trading-optimize'); }
/** @description The per-user optimize schedule taskType. */
export function optimizeTaskType(sub: string): string { return `trading-optimize:${sub}`; }
/** Nightly cron — 05:30, before the 06:30 signal review. */
export const OPTIMIZE_CRON = '30 5 * * *';
/** @description Kill switch for the nightly run (default ON — it only recommends, never auto-applies). */
export function optimizeEnabled(): boolean { return String(process.env.TRADING_OPTIMIZE_ENABLED ?? 'true').toLowerCase() !== 'false'; }

interface BacktestResult { expectancy: number; winRate: number; signals: number; }

/** Walk-forward backtest of one full param set over the universe's daily closes. Pure + deterministic. */
function backtest(closesBySym: Map<string, number[]>, params: StrategyParams): BacktestResult {
  let sum = 0, wins = 0, n = 0;
  for (const closes of closesBySym.values()) {
    const L = closes.length;
    if (L < WARMUP + HORIZON + 1) continue;
    for (let t = WARMUP; t + HORIZON < L; t++) {
      const slice = closes.slice(Math.max(0, t + 1 - LOOKBACK), t + 1); // tail is all the algos read
      const ens = ensemble(scoreSymbol('BT', slice, undefined, 'SPY', params), {}, params.ensembleThreshold);
      if (ens.action === 'hold') continue;
      const fwd = ((closes[t + HORIZON] - closes[t]) / closes[t]) * 100;
      const signed = ens.action === 'buy' ? fwd : -fwd;
      sum += signed; if (signed > 0) wins += 1; n += 1;
    }
  }
  return { expectancy: n ? sum / n : 0, winRate: n ? wins / n : 0, signals: n };
}

/** Ensure the recommendations store exists (self-healing). */
export async function ensureRecommendationsTable(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading param recommendations',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_param_recommendations (
        rec_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mode TEXT NOT NULL DEFAULT 'paper',
        param TEXT NOT NULL,
        current_value NUMERIC NOT NULL,
        proposed_value NUMERIC NOT NULL,
        baseline_expectancy NUMERIC, proposed_expectancy NUMERIC,
        baseline_winrate NUMERIC, proposed_winrate NUMERIC,
        baseline_signals INTEGER, proposed_signals INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ
      )`,
    ],
    requirements: [{ table: 'oshal_trading_param_recommendations', columns: ['rec_id', 'param', 'current_value', 'proposed_value', 'status', 'created_at'] }],
  });
}

/**
 * @description Run the optimizer for one user/book: backtest the grid, write recommendations. Returns
 * a summary. Used by both the nightly dispatch and the on-demand "Run optimization now" button.
 */
export async function runOptimize(ctx: AppContext, sub: string, mode: TradingMode): Promise<{ recommendations: number; assessed: number; skipped?: string }> {
  await ensureTradingSchema(ctx.pool);
  await ensureRecommendationsTable(ctx.pool);
  if (!marketDataConfigured()) return { recommendations: 0, assessed: 0, skipped: 'market data not configured' };

  const current = await loadStrategyParams(ctx.pool);
  const batch = await barsBatch(DEFAULT_UNIVERSE, '1Day', 400); // one batched daily-bars fetch
  const usable = new Map<string, number[]>();
  for (const [s, c] of batch) if (c.length >= WARMUP + HORIZON + 1) usable.set(s, c);
  if (usable.size < 5) return { recommendations: 0, assessed: usable.size, skipped: 'not enough history' };

  // Fresh run: retire any stale pending recommendations for this book.
  await ctx.pool.query(
    `UPDATE oshal_trading_param_recommendations SET status='superseded', resolved_at=now() WHERE mode=$1 AND status='pending'`, [mode]);

  const baseline = backtest(usable, current);
  let recs = 0;
  for (const param of TUNABLE_PARAMS) {
    const candidates = [...new Set(GRID[param].map((v) => clampParam(param, v)))].filter((v) => v !== current[param]);
    let best: { val: number; r: BacktestResult } | null = null;
    for (const val of candidates) {
      const r = backtest(usable, { ...current, [param]: val });
      if (r.signals < MIN_SIGNALS) continue;
      if (!best || r.expectancy > best.r.expectancy) best = { val, r };
    }
    if (best && best.r.expectancy - baseline.expectancy >= EXPECTANCY_MARGIN) {
      await ctx.pool.query(
        `INSERT INTO oshal_trading_param_recommendations
           (mode, param, current_value, proposed_value, baseline_expectancy, proposed_expectancy, baseline_winrate, proposed_winrate, baseline_signals, proposed_signals, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
        [mode, param, current[param], best.val, baseline.expectancy, best.r.expectancy, baseline.winRate, best.r.winRate, baseline.signals, best.r.signals]);
      recs += 1;
    }
  }

  logger.info({ sub, mode, assessed: usable.size, recommendations: recs }, 'nightly optimization complete');
  if (recs > 0) await logOptimizeTicket(ctx, sub, mode, recs).catch((e) => logger.warn({ err: e }, 'optimize ticket failed'));
  return { recommendations: recs, assessed: usable.size };
}

/** FYI ticket so the run is visible in the queue; the actual approve/reject happens on the Tuning page. */
async function logOptimizeTicket(ctx: AppContext, sub: string, mode: TradingMode, recs: number): Promise<void> {
  await ctx.ticketService.createTicket({
    title: `🔧 Nightly optimization — ${recs} parameter recommendation(s) to review [${mode}]`,
    ticketType: 'trading-decision', ownerSub: sub, status: 'complete',
    description: `The optimizer backtested parameter tweaks and found ${recs} that would have improved expectancy. Review and approve them on the trading app's Tuning tab — nothing is applied until you approve.`,
    priority: 'none', labels: [], workspaceId: null, assignedAgentId: null, parentTicketId: null,
    externalProvider: null, externalId: null, externalUrl: null,
    metadata: { source: 'trading-optimize', book: mode, firedAt: new Date().toISOString(), recommendations: recs },
  });
}

/**
 * @description Dispatch the nightly optimize schedule (gated by TRADING_OPTIMIZE_ENABLED, default on).
 */
export async function dispatchTradingOptimize(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const sub = String(td.userSub || '');
  const mode: TradingMode = String(td.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  if (!sub) return { success: false, scheduleId: schedule.id, error: 'optimize schedule missing userSub' };
  if (!optimizeEnabled()) { logger.info({ scheduleId: schedule.id }, 'optimize skipped — TRADING_OPTIMIZE_ENABLED=false'); return { success: true, scheduleId: schedule.id }; }
  try {
    const out = await runOptimize(ctx, sub, mode);
    return { success: true, scheduleId: schedule.id, taskId: `optimize-${schedule.id}`, ...(out.skipped ? { error: out.skipped } : {}) };
  } catch (e) {
    logger.error({ err: e, scheduleId: schedule.id }, 'nightly optimization failed');
    return { success: false, scheduleId: schedule.id, error: (e as Error).message };
  }
}

/** A recommendation row shaped for the UI. */
export interface ParamRecommendation {
  recId: string; mode: string; param: string; label: string;
  currentValue: number; proposedValue: number;
  baselineExpectancy: number | null; proposedExpectancy: number | null;
  baselineWinrate: number | null; proposedWinrate: number | null;
  baselineSignals: number | null; proposedSignals: number | null;
  status: string; createdAt: string; resolvedAt: string | null;
}

function mapRec(r: Record<string, unknown>): ParamRecommendation {
  const param = String(r.param);
  return {
    recId: String(r.rec_id), mode: String(r.mode), param,
    label: isTunableParam(param) ? PARAM_LABELS[param] : param,
    currentValue: Number(r.current_value), proposedValue: Number(r.proposed_value),
    baselineExpectancy: r.baseline_expectancy != null ? Number(r.baseline_expectancy) : null,
    proposedExpectancy: r.proposed_expectancy != null ? Number(r.proposed_expectancy) : null,
    baselineWinrate: r.baseline_winrate != null ? Number(r.baseline_winrate) : null,
    proposedWinrate: r.proposed_winrate != null ? Number(r.proposed_winrate) : null,
    baselineSignals: r.baseline_signals != null ? Number(r.baseline_signals) : null,
    proposedSignals: r.proposed_signals != null ? Number(r.proposed_signals) : null,
    status: String(r.status), createdAt: String(r.created_at), resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
  };
}

/** @description Pending recommendations + recent resolved ones (for the Tuning page). */
export async function loadRecommendations(pool: AppContext['pool'], mode: TradingMode): Promise<{ pending: ParamRecommendation[]; history: ParamRecommendation[] }> {
  await ensureRecommendationsTable(pool);
  const pending = (await pool.query(
    `SELECT * FROM oshal_trading_param_recommendations WHERE mode=$1 AND status='pending' ORDER BY created_at DESC`, [mode])).rows.map(mapRec);
  const history = (await pool.query(
    `SELECT * FROM oshal_trading_param_recommendations WHERE mode=$1 AND status IN ('applied','rejected') AND resolved_at > now() - interval '30 days' ORDER BY resolved_at DESC LIMIT 30`, [mode])).rows.map(mapRec);
  return { pending, history };
}

/** @description Approve a pending recommendation → write the proposed value to the param store. */
export async function approveRecommendation(pool: AppContext['pool'], recId: string): Promise<{ applied: boolean; param?: string; value?: number; reason?: string }> {
  await ensureRecommendationsTable(pool);
  const rec = (await pool.query(`SELECT param, proposed_value, status FROM oshal_trading_param_recommendations WHERE rec_id=$1`, [recId])).rows[0];
  if (!rec) return { applied: false, reason: 'not_found' };
  if (rec.status !== 'pending') return { applied: false, reason: 'not_pending' };
  const param = String(rec.param);
  if (!isTunableParam(param)) return { applied: false, reason: 'unknown_param' };
  const value = Number(rec.proposed_value);
  await upsertStrategyParam(pool, param, value);
  await pool.query(`UPDATE oshal_trading_param_recommendations SET status='applied', resolved_at=now() WHERE rec_id=$1`, [recId]);
  // Retire any other pending rec for the same param/book (the live value just changed under them).
  await pool.query(`UPDATE oshal_trading_param_recommendations SET status='superseded', resolved_at=now() WHERE param=$1 AND status='pending'`, [param]);
  return { applied: true, param, value: clampParam(param, value) };
}

/** @description Reject a pending recommendation. */
export async function rejectRecommendation(pool: AppContext['pool'], recId: string): Promise<{ rejected: boolean; reason?: string }> {
  await ensureRecommendationsTable(pool);
  const r = await pool.query(`UPDATE oshal_trading_param_recommendations SET status='rejected', resolved_at=now() WHERE rec_id=$1 AND status='pending'`, [recId]);
  return { rejected: (r.rowCount ?? 0) > 0, reason: (r.rowCount ?? 0) > 0 ? undefined : 'not_pending' };
}
