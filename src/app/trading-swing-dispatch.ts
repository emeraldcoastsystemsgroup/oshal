/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add Change Log header; docs/ path references updated in the 2026-07-04 docs consolidation
 */
/**
 * Trading SWING dispatch — the daily trend-following leg (ADR-052/054), the ETF-proxy bridge.
 *
 * The research proved it: the one edge that survives an honest walk-forward is DAILY trend-following
 * held overnight/multi-day (CL Donchian, +$212k OOS) — and forcing intraday exits throws that edge
 * away (oshal-intraday.js / docs/apps/trading/intraday.md). Alpaca's paper rail can't trade futures, so this
 * runs that exact edge on COMMODITY/TREND ETFs (USO/BNO/UNG/GLD/SLV/DBC) as a diversified swing sleeve:
 *  - Donchian breakout: go LONG when the latest daily close breaks the prior ENTRY_N-day high.
 *  - Donchian exit: SELL the whole position when the close breaks the prior EXIT_N-day low.
 *  - HOLD across days otherwise — no flat-by-close. The exit is a trend SIGNAL, not the clock.
 *
 * It runs once a day shortly after the open so the breakout is read off completed daily closes and the
 * market order fills in regular hours. PAPER-ONLY (live refused, like the autopilot). The ETFs never
 * overlap the autopilot's equity universe, so the two sleeves don't fight over a name. Every order keeps
 * the signal → decision → order provenance chain via placeDecisionOrder.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial — daily Donchian swing sleeve on commodity/trend ETFs (the validated trend edge, executable on the equity rail); breakout entry / channel exit, hold across days, conviction-free fixed allocation, paper-only, provenance-preserving.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — guardrails/placeDecisionOrder/ensureTradingSchema now come from app/trading-engine.ts instead of the carvable route surface. Zero behavior change.
 *
 * @module trading-swing-dispatch
 */

import * as crypto from 'crypto';
import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult } from '@/features/scheduling';
import {
  getBrokerAdapter, marketDataConfigured, tradableSession, dailyCloses, latestPrice,
  type TradingMode, type Position, type BrokerAccount,
} from '@/features/trading';
import { guardrails, placeDecisionOrder, ensureTradingSchema } from './trading-engine';
import { reconcileOpenOrders } from './trading-reconcile';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-swing-dispatch' });

/** Agent id stamped on swing decisions (deterministic Donchian, no LLM). */
const SWING_AGENT = 'swing-donchian';
/** Commodity/trend ETF sleeve — the futures-trend edge in a form the equity rail can trade.
 *  Diversified across energy/metals/broad-commodity so the lumpy single-market edge smooths out. */
const DEFAULT_SWING_UNIVERSE = ['USO', 'BNO', 'UNG', 'GLD', 'SLV', 'DBC'];
const ENTRY_N = Math.max(5, Number(process.env.SWING_ENTRY_N || 20));   // breakout lookback (days)
const EXIT_N = Math.max(3, Number(process.env.SWING_EXIT_N || 10));     // channel-exit lookback (days)
const ALLOC_PCT = Math.max(1, Number(process.env.SWING_ALLOC_PCT || 15)); // equity % per position
const MAX_NAMES = Math.max(1, Number(process.env.SWING_MAX_NAMES || 6));   // max simultaneous swing holds

/** @description True for the swing-leg schedules this module owns. */
export function isSwingSchedule(taskType: string): boolean { return taskType.startsWith('trading-swing'); }
/** @description The swing schedule taskType for a user. */
export function swingTaskType(sub: string): string { return `trading-swing:${sub}`; }

/** A swing decision to persist + place. */
interface SwingDecision { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; rationale: string; indicators: unknown; }

/** Persist the signal→decision chain, then place the (market) order — same provenance as the autopilot. */
async function persistAndPlace(ctx: AppContext, sub: string, mode: TradingMode, d: SwingDecision, orders: Array<Record<string, unknown>>, errors: Array<{ symbol: string; error: string }>): Promise<void> {
  try {
    const bucket = new Date().toISOString().slice(0, 13); // hour-bucketed: one signal per name per run
    const hash = crypto.createHash('sha256').update(JSON.stringify({ s: d.symbol, side: d.side, src: 'swing-donchian', ind: d.indicators, bucket })).digest('hex');
    const sig = (await ctx.pool.query(
      `INSERT INTO oshal_trading_signals (user_sub, mode, source, title, body, symbols, indicators, content_hash)
         VALUES ($1,$2,'swing-donchian',$3,$4,$5,$6,$7)
       ON CONFLICT (user_sub, mode, content_hash) DO UPDATE SET observed_at = oshal_trading_signals.observed_at
       RETURNING signal_id`,
      [sub, mode, `${d.symbol} ${d.side} @ ${d.price}`, d.rationale, [d.symbol], JSON.stringify(d.indicators), hash])).rows[0];
    const g = guardrails();
    const row = (await ctx.pool.query(
      `INSERT INTO oshal_trading_decisions (user_sub, mode, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
         VALUES ($1,$2,$3::uuid[],$4,$5,$6,$7,$8,'market',$9,$10,$11,$12) RETURNING decision_id`,
      [sub, mode, [sig.signal_id], SWING_AGENT, d.side, d.symbol, d.side, d.qty, 1, d.rationale, JSON.stringify(d.indicators), JSON.stringify(g)])).rows[0];
    const requestId = `swing-${new Date().toISOString().slice(0, 13)}-${d.symbol}-${d.side}`;
    const r = await placeDecisionOrder(ctx.pool, sub, mode, row.decision_id, requestId, false);
    orders.push({ symbol: d.symbol, side: d.side, qty: d.qty, status: r.status });
  } catch (e) { errors.push({ symbol: d.symbol, error: (e as Error).message }); }
}

/** Size a fresh swing entry: ALLOC_PCT of equity, capped by available cash, in whole shares. */
function sizeSwing(price: number, account: BrokerAccount): number {
  if (!(price > 0)) return 0;
  const equity = account.equity > 0 ? account.equity : account.cash;
  const target = (ALLOC_PCT / 100) * equity;
  const room = Math.min(target, Math.max(0, account.cash));
  return room > price ? Math.floor(room / price) : 0;
}

/**
 * @description Dispatch a trading-swing schedule: read each ETF's daily closes, apply the Donchian
 * breakout/exit, and place paper orders (entries sized to ALLOC_PCT, exits sell the whole position).
 * @param ctx - App context.
 * @param schedule - The due schedule (taskData carries userSub, mode, universe).
 * @returns Dispatch result.
 */
export async function dispatchTradingSwing(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const sub = String(td.userSub || '');
  const mode: TradingMode = String(td.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
  const universe = Array.isArray(td.universe) && td.universe.length ? (td.universe as unknown[]).map((s) => String(s).toUpperCase()) : DEFAULT_SWING_UNIVERSE;

  if (!sub) return { success: false, scheduleId: schedule.id, error: 'swing schedule missing userSub' };
  if (mode === 'live') return { success: false, scheduleId: schedule.id, error: 'swing leg is paper-only; live requires manual approval' };
  if (!marketDataConfigured() || !getBrokerAdapter('paper').configured()) {
    logger.info({ scheduleId: schedule.id }, 'swing skipped — Alpaca keys not configured');
    return { success: true, scheduleId: schedule.id };
  }
  await ensureTradingSchema(ctx.pool);
  await reconcileOpenOrders(ctx.pool, sub, 'paper').catch((e) => logger.warn({ err: e }, 'swing reconcile failed'));
  // Swing trades MARKET orders that need a live session to fill; run it in regular/ext hours.
  const session = await tradableSession();
  if (!session) { logger.info({ scheduleId: schedule.id }, 'swing skipped — market closed'); return { success: true, scheduleId: schedule.id }; }

  const broker = getBrokerAdapter(mode, sub);
  const [positions, accountRaw] = await Promise.all([broker.getPositions().catch(() => [] as Position[]), broker.getAccount().catch(() => null)]);
  const account: BrokerAccount = accountRaw ?? { cash: 0, buyingPower: 0, equity: 0, currency: 'USD' };
  const held = new Map(positions.filter((p) => p.qty > 0).map((p) => [p.symbol.toUpperCase(), p.qty]));
  const swingHeld = universe.filter((s) => (held.get(s) || 0) > 0).length;
  const orders: Array<Record<string, unknown>> = []; const errors: Array<{ symbol: string; error: string }> = [];

  for (const sym of universe) {
    try {
      const closes = await dailyCloses(sym, ENTRY_N + EXIT_N + 5);
      if (closes.length < ENTRY_N + 2) continue;
      const last = closes.length - 1; const cur = closes[last];
      let hi = -Infinity, lo = Infinity;
      for (let k = last - ENTRY_N; k < last; k++) hi = Math.max(hi, closes[k]);
      for (let k = last - EXIT_N; k < last; k++) lo = Math.min(lo, closes[k]);
      const qtyHeld = held.get(sym) || 0;
      if (qtyHeld > 0) {
        // Channel exit — the trend broke; sell the whole position (this is the "getting out", on signal).
        if (cur < lo) await persistAndPlace(ctx, sub, mode, {
          symbol: sym, side: 'sell', qty: qtyHeld, price: cur,
          rationale: `Donchian exit — close ${cur.toFixed(2)} broke the ${EXIT_N}-day low ${lo.toFixed(2)}. Trend over; closing the swing.`,
          indicators: { signal: 'donchian_exit', cur, exitLow: lo, exitN: EXIT_N },
        }, orders, errors);
      } else if (cur > hi && swingHeld + orders.filter((o) => o.side === 'buy').length < MAX_NAMES) {
        // Breakout entry — new high; go long and HOLD until the channel-exit fires.
        const price = (await latestPrice(sym)) ?? cur;
        const qty = sizeSwing(price, account);
        if (qty > 0) await persistAndPlace(ctx, sub, mode, {
          symbol: sym, side: 'buy', qty, price,
          rationale: `Donchian breakout — close ${cur.toFixed(2)} cleared the ${ENTRY_N}-day high ${hi.toFixed(2)}. Trend long; hold to the channel exit.`,
          indicators: { signal: 'donchian_breakout', cur, entryHigh: hi, entryN: ENTRY_N, allocPct: ALLOC_PCT },
        }, orders, errors);
      }
    } catch (e) { errors.push({ symbol: sym, error: (e as Error).message }); }
  }

  const buys = orders.filter((o) => o.side === 'buy').length, sells = orders.filter((o) => o.side === 'sell').length;
  if (orders.length || errors.length) {
    await ctx.ticketService.createTicket({
      title: `📈 Swing (trend): ${buys} entry · ${sells} exit [${mode}]`,
      ticketType: 'trading-decision', ownerSub: sub, status: 'complete',
      description: `Daily Donchian trend sleeve (${universe.join(', ')}) — ${buys} breakout entr(ies), ${sells} channel exit(s), ${errors.length} error(s).`,
      priority: 'none', labels: [], workspaceId: null, assignedAgentId: null, parentTicketId: null,
      externalProvider: null, externalId: null, externalUrl: null,
      metadata: { source: 'trading-swing', book: mode, firedAt: new Date().toISOString(), orders, errors, entryN: ENTRY_N, exitN: EXIT_N },
    }).catch((e) => logger.warn({ err: e }, 'swing ticket failed'));
  }
  logger.info({ scheduleId: schedule.id, session, buys, sells, errors: errors.length }, 'swing run complete');
  return { success: true, scheduleId: schedule.id, taskId: `swing-${schedule.id}` };
}
