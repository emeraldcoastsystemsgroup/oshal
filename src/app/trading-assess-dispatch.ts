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
async function recordAssessment(pool: AppContext['pool'], sub: string, mode: TradingMode, scan: Map<string, MtfDecision>): Promise<{ buys: PlanItem[]; sells: PlanItem[]; holds: number }> {
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
async function logPlanTicket(ctx: AppContext, sub: string, mode: TradingMode, plan: { buys: PlanItem[]; sells: PlanItem[]; holds: number }): Promise<void> {
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

  try {
    await ensureTradingSchema(ctx.pool);
    const resolved = await resolveMaturedPredictions(ctx.pool, mode).catch(() => 0);
    const scan = await multiTimeframeScan(universe);
    const plan = await recordAssessment(ctx.pool, sub, mode, scan);
    // World snapshots for the Gravity-2 head-to-head (one batched read; null when the world layer is off).
    const worldSvc = createWorldIntelligenceService();
    const worldSnaps = worldSvc ? await readGravityWorldSnapshots(worldSvc, universe, defaultGravity2Config().windowDays).catch(() => undefined) : undefined;
    // Raw per-algo predictions (+ gravity2) so the overnight review can learn each signal's edge → mass.
    await recordPerAlgoPredictions(ctx.pool, sub, mode, universe, worldSnaps).catch((e) => logger.warn({ err: e }, 'per-algo prediction record failed'));
    logger.info({ scheduleId: schedule.id, scanned: scan.size, buys: plan.buys.length, sells: plan.sells.length, resolved }, 'assessment recorded — predictions for next session');
    await logPlanTicket(ctx, sub, mode, plan).catch((e) => logger.warn({ err: e }, 'assessment ticket failed'));
    return { success: true, scheduleId: schedule.id, taskId: `assess-${schedule.id}` };
  } catch (e) {
    logger.error({ err: e, scheduleId: schedule.id }, 'assessment run failed');
    return { success: false, scheduleId: schedule.id, error: (e as Error).message };
  }
}
