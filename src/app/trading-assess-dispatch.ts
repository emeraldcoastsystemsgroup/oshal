/**
 * Trading assessment batch — the scheduled "predictions for the next session" pass.
 *
 * This is the same multi-timeframe assessment the advisor makes intraday, run as a standalone batch
 * that is NOT gated on market hours — so it produces a forward view overnight and pre-market, when the
 * trading legs are dormant. Each run scans the universe, resolves any matured prior predictions against
 * realised price (building the per-algo hit-rate track record), and writes one ensemble prediction per
 * actionable symbol to oshal_trading_predictions with a next-session horizon. It places NO orders — it
 * is pure forecast/plan. The result is queryable via GET /api/trading/recommendations + /algo-stats and
 * surfaced as a compact plan ticket.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — scheduled, market-hours-independent multi-timeframe assessment: resolve matured predictions, write next-session predictions per symbol, post a ranked buy/sell plan. No orders.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-096: record the SHADOW indicators (macd/bollinger/atr-channel/adx/stochastic/volsurge, scoreSymbolShadow on OHLCV dailies) beside the live algos + gravity2, so the overnight review builds their hit-rate/expectancy track record. Live votes untouched — shadow algos are not in ALGORITHMS.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — ensureTradingSchema/resolveMaturedPredictions now come from app/trading-engine.ts instead of the carvable route surface. Zero behavior change.
 *
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Every stage of the run is a NAMED step (createStepRunner): a failure logs ERROR 'assessment step failed' with the step name and the run carries on with the steps that do not depend on it, instead of one catch logging 'assessment run failed' for the whole batch. The 2026-09-15 00:01Z run lost its entire per-algo record to a market-data 429 raised inside multiTimeframeScan, and the log named the run rather than the step. The per-algo record no longer depends on the scan, and the result reports the failed step names.
 *
 * @module trading-assess-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult } from '@/features/scheduling';
import { multiTimeframeScan, marketDataConfigured, DEFAULT_UNIVERSE, barsBatch, barsBatchOhlcv, scoreSymbol, scoreSymbolShadow, deriveWorldMasses, gravity2Signal, defaultGravity2Config, type WorldSnapshot, type MtfDecision, type TradingMode } from '@/features/trading';
import { ensureTradingSchema, resolveMaturedPredictions } from './trading-engine';
import { createWorldIntelligenceService } from '@/features/world-data';
import { readGravityWorldSnapshots } from './trading-world-masses';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-assess-dispatch' });

/** Forecast horizon — roughly one session ahead. */
const HORIZON_HRS = 18;

/** @description True for the scheduled assessment batch. */
export function isAssessSchedule(taskType: string): boolean { return taskType.startsWith('trading-assess'); }
/** @description The per-user assessment schedule taskType. */
export function assessTaskType(sub: string): string { return `trading-assess:${sub}`; }

/** One ranked name in the plan. */
interface PlanItem { symbol: string; score: number; confidence: number; regime: number; }

/** The ranked buy/sell plan one assessment produces. */
interface AssessPlan { buys: PlanItem[]; sells: PlanItem[]; holds: number; }

/**
 * The named steps of one assessment run. A step is the unit a failure is reported against: the
 * 2026-09-15 run lost its per-algo record to a market-data 429 and the ERROR line said only
 * `assessment run failed`, which named the whole run for the failure of one step.
 */
export type AssessStep =
  | 'ensure-schema' | 'resolve-matured' | 'multi-timeframe-scan' | 'record-assessment'
  | 'world-snapshots' | 'per-algo-predictions' | 'plan-ticket';

/** A step's outcome — its value, or the message it failed with (already logged against the step). */
type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * @description Build the runner every assessment step goes through: it catches the step's failure,
 * logs it at ERROR **named by step**, records the name, and hands back a result the caller can skip
 * on. One step failing therefore never aborts the steps that do not depend on it.
 * @param scheduleId - The schedule being dispatched (carried on every log line).
 * @param failed - Accumulator the runner appends each failed step name to.
 * @returns A `run(step, fn)` that resolves to the step's `StepResult`.
 */
function createStepRunner(scheduleId: string, failed: AssessStep[]) {
  return async function run<T>(step: AssessStep, fn: () => Promise<T>): Promise<StepResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      failed.push(step);
      logger.error({ err: e, scheduleId, step }, 'assessment step failed');
      return { ok: false, error: (e as Error).message };
    }
  };
}

/**
 * @description Record RAW per-algo daily predictions (momentum/gravity/donchian/meanrev) so the
 * overnight review can learn each algo's hit-rate → mass. Unweighted on purpose: we learn each
 * signal's true edge, not the weighted blend. Best-effort; failure never blocks the assessment.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - Book.
 * @param universe - Symbols to score.
 */
async function recordPerAlgoPredictions(pool: AppContext['pool'], sub: string, mode: TradingMode, universe: string[], worldSnaps?: Map<string, WorldSnapshot>): Promise<void> {
  const daily = await barsBatch(universe, '1Day', 220);
  // Full OHLCV for the SHADOW indicators (ATR/ADX/stochastic/volume need more than closes).
  // SIP first — IEX daily VOLUME is venue-only (~2% of tape) and volsurge needs the real thing;
  // the assess batch runs post-close so SIP's 16-min end lag is free. Best-effort with IEX
  // fallback: a failed fetch skips the shadow pass, never the live-algo recording.
  const ohlcv = await barsBatchOhlcv(universe, '1Day', 220, 'sip')
    .catch(() => barsBatchOhlcv(universe, '1Day', 220, 'iex'))
    .catch(() => new Map<string, never>());
  const cfg = defaultGravity2Config();
  const record = (sym: string, algo: string, dir: string, conf: number, price: number, basis: string) =>
    pool.query(
      `INSERT INTO oshal_trading_predictions (user_sub, mode, symbol, algo, pred_dir, confidence, price, basis, horizon_hrs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sub, mode, sym, algo, dir, conf, price, basis, HORIZON_HRS]).catch(() => { /* skip dupes/errs */ });
  for (const [sym, closes] of daily) {
    if (closes.length < 30) continue;
    const price = closes[closes.length - 1];
    for (const s of scoreSymbol(sym, closes)) await record(sym, s.algo, s.dir, s.confidence, price, s.basis);
    // SHADOW indicators (ADR-096): recorded like any algo so the overnight review scores their
    // hit-rate/expectancy — but NEVER consulted by the live ensemble until promoted.
    const bars = ohlcv.get(sym);
    if (bars && bars.length >= 60) {
      for (const s of scoreSymbolShadow(sym, bars)) await record(sym, s.algo, s.dir, s.confidence, price, s.basis);
    }
    // Gravity 2 head-to-head: price masses + world-intelligence masses → one gravity2 prediction next to
    // `gravity`, so the overnight review scores them side by side. No world data → equals gravity → skip.
    if (worldSnaps) {
      const wm = deriveWorldMasses(sym, worldSnaps.get(sym) ?? {}, cfg);
      if (wm.length) {
        const g2 = gravity2Signal(sym, closes, wm);
        if (g2) await record(sym, g2.algo, g2.dir, g2.confidence, price, g2.basis);
      }
    }
  }
}

/** Write one ensemble prediction per actionable symbol; return the ranked buy/sell plan. */
async function recordAssessment(pool: AppContext['pool'], sub: string, mode: TradingMode, scan: Map<string, MtfDecision>): Promise<AssessPlan> {
  const buys: PlanItem[] = []; const sells: PlanItem[] = []; let holds = 0;
  for (const [sym, d] of scan) {
    if (d.action === 'hold' || !d.price) { holds += 1; continue; }
    const dir = d.action === 'buy' ? 'up' : 'down';
    await pool.query(
      `INSERT INTO oshal_trading_predictions (user_sub, mode, symbol, algo, pred_dir, confidence, price, basis, horizon_hrs)
         VALUES ($1,$2,$3,'mtf-assess',$4,$5,$6,$7,$8)`,
      [sub, mode, sym, dir, d.confidence, d.price, `MTF score ${d.score} regime ${d.regime}`, HORIZON_HRS]);
    (dir === 'up' ? buys : sells).push({ symbol: sym, score: d.score, confidence: d.confidence, regime: d.regime });
  }
  buys.sort((a, b) => b.score - a.score);
  sells.sort((a, b) => a.score - b.score);
  return { buys, sells, holds };
}

/** Post a compact ranked plan ticket (the visible "next-session assessment"). */
async function logPlanTicket(ctx: AppContext, sub: string, mode: TradingMode, plan: AssessPlan): Promise<void> {
  const fmt = (xs: PlanItem[]) => xs.slice(0, 8).map((x) => `${x.symbol}(${x.score.toFixed(2)})`).join(', ') || '—';
  await ctx.ticketService.createTicket({
    title: `📊 Assessment: ${plan.buys.length} buy / ${plan.sells.length} sell [${mode}]`,
    ticketType: 'trading-decision', ownerSub: sub, status: 'complete',
    description: `Next-session multi-timeframe forecast.\nBUY watch: ${fmt(plan.buys)}\nSELL/avoid: ${fmt(plan.sells)}\n${plan.holds} holds.`,
    priority: 'none', labels: [], workspaceId: null, assignedAgentId: null, parentTicketId: null,
    externalProvider: null, externalId: null, externalUrl: null,
    metadata: { source: 'trading-assess', book: mode, firedAt: new Date().toISOString(), buys: plan.buys, sells: plan.sells, holds: plan.holds },
  });
}

/**
 * @description Dispatch one assessment batch (predictions for the next session). Market-hours independent.
 * @param ctx - App context (pool, ticketService).
 * @param schedule - The due schedule (taskData carries userSub, mode, universe).
 * @returns Dispatch result for scheduler accounting.
 */
export async function dispatchTradingAssess(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const sub = String(td.userSub || '');
  const mode: TradingMode = String(td.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  const universe = Array.isArray(td.universe) && td.universe.length ? (td.universe as unknown[]).map((s) => String(s).toUpperCase()) : DEFAULT_UNIVERSE;

  if (!sub) return { success: false, scheduleId: schedule.id, error: 'assess schedule missing userSub' };
  if (!marketDataConfigured()) { logger.info({ scheduleId: schedule.id }, 'assessment skipped — market-data keys not configured'); return { success: true, scheduleId: schedule.id }; }

  const failed: AssessStep[] = [];
  const run = createStepRunner(schedule.id, failed);

  // The schema is the one hard prerequisite — with no tables there is no step left to attempt.
  const schema = await run('ensure-schema', () => ensureTradingSchema(ctx.pool));
  if (!schema.ok) return { success: false, scheduleId: schedule.id, error: `assessment step failed: ensure-schema — ${schema.error}` };

  const resolved = await run('resolve-matured', () => resolveMaturedPredictions(ctx.pool, mode));
  const scan = await run('multi-timeframe-scan', () => multiTimeframeScan(universe));
  const plan: StepResult<AssessPlan> = scan.ok
    ? await run('record-assessment', () => recordAssessment(ctx.pool, sub, mode, scan.value))
    : { ok: false, error: 'not attempted — multi-timeframe-scan failed' };
  // World snapshots for the Gravity-2 head-to-head (one batched read; absent when the world layer is off).
  const worldSvc = createWorldIntelligenceService();
  const snaps = worldSvc
    ? await run('world-snapshots', () => readGravityWorldSnapshots(worldSvc, universe, defaultGravity2Config().windowDays))
    : { ok: true as const, value: undefined };
  // Raw per-algo predictions (+ gravity2) so the overnight review can learn each signal's edge → mass.
  // Independent of the scan: a scan that died on a rate limit must not take this record with it.
  await run('per-algo-predictions', () => recordPerAlgoPredictions(ctx.pool, sub, mode, universe, snaps.ok ? snaps.value : undefined));
  if (plan.ok) await run('plan-ticket', () => logPlanTicket(ctx, sub, mode, plan.value));

  logger.info({
    scheduleId: schedule.id, scanned: scan.ok ? scan.value.size : 0,
    buys: plan.ok ? plan.value.buys.length : 0, sells: plan.ok ? plan.value.sells.length : 0,
    resolved: resolved.ok ? resolved.value : 0, failedSteps: failed,
  }, failed.length ? 'assessment recorded with failed steps — predictions for next session' : 'assessment recorded — predictions for next session');

  return {
    success: true, scheduleId: schedule.id, taskId: `assess-${schedule.id}`,
    ...(failed.length ? { error: `assessment steps failed: ${failed.join(', ')}` } : {}),
  };
}
