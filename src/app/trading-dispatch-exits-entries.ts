/**
 * Trading autopilot — protective EXITS, the scan-sleeve ENTRIES and the pop-catcher (a leg of the dispatch loop).
 *
 * Carved VERBATIM out of trading-schedule-dispatch.ts (its CHANGE LOG SEQ 1-19 hold the history of
 * every function here: SEQ 3 computeExits/placeEntries, SEQ 9 the operator blocklist at every entry
 * point, SEQ 16 the counterfactual gate-block ledger, SEQ 4 the in-flight exclusion). Zero behavior
 * change: the pop-catcher block is the monolith's 2a-pop statement sequence moved into a function
 * with nothing reordered. The logger keeps module 'trading-schedule-dispatch' on purpose — the log
 * stream is the watchdog/operator contract, and the file split must be invisible to it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — decomposition of trading-schedule-dispatch.ts (890 code lines) along its section seams: MAX_ORDERS_PER_RUN, computeExits, popCatcherConfig and placeEntries move here unchanged; the runAutopilot 2a-pop block becomes placePopCatches (same statements, same order, `book.enabled` read through `book`). Env names unchanged: TRADING_MAX_ORDERS_PER_RUN, TRADING_EXT_DIP_SELL_PCT, TRADING_EXT_SIZE_MULT, TRADING_POP_CATCHER, TRADING_POP_TRANCHE_PCT, TRADING_POP_MAX, TRADING_POP_THRESHOLD. Golden-plan guard: tests/unit/trading-dispatch-golden-plan.spec.ts.
 *
 * @module trading-dispatch-exits-entries
 */

import type { AppContext } from './composition-root';
import {
  dailyCloses, latestPrice, exitsToRun, trailingExits, nextPeaks, isShortTermBreakdown, isShortTermPop, sizeEntry, rebalanceTrims, dipExits, symbolBlocklist, barsBatch,
  type MtfDecision, type Position, type TradingMode, type TradingBook, type BrokerAccount, type RiskPolicy, type ExitOrder,
} from '@/features/trading';
import { legacyBook } from './trading-books-store';
import { ensurePeaksTable, loadPeaks, savePeaks } from './trading-peaks-store';
import { recordGateBlocks } from './trading-gate-block-store';
import type { WorldIntelligenceService } from '@/features/world-data';
import { readWorldSignalsBatch, worldRankEnabled } from './trading-world-signals';
import { WORLD_SENT_VETO, WORLD_SENT_MIN_POINTS, WORLD_SENT_DAYS, WORLD_RANK_WEIGHT, clamp, worldSentiment } from './trading-dispatch-world-gate';
import { placeManaged, scanDecision, type RunOrder } from './trading-dispatch-rail';
import { createChildLogger } from '@/shared/logger';

// Module name kept as the monolith's: the log stream is the watchdog/operator contract.
const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

/** Cap on orders placed per fire — bounds risk + API calls regardless of how many names signal. */
const MAX_ORDERS_PER_RUN = Number(process.env.TRADING_MAX_ORDERS_PER_RUN) || 8;

/* ── Intraday pop-catcher (TRADING_POP_CATCHER, default OFF) ────────────────────────────────────────
 * The "watch it at $0, grab it when it actually pops" layer. The daily rotation funds the proven leaders;
 * a name that is NOT funded stays on the bench — and this pulls it IN the moment it surges on the 5-minute
 * bar (isShortTermPop), from the idle cash reserve, in a small tranche, capped in count. It is the mirror
 * of the 2a breakdown exit (fast 5-min protection) but for entries, and it runs independent of the
 * rotation. Every pop position is a normal position — the step-1 protective stops/trailing exit it like
 * any other. Off by default → nothing changes. */
function popCatcherConfig(): { enabled: boolean; tranchePct: number; maxPositions: number; threshold: number } {
  return {
    enabled: String(process.env.TRADING_POP_CATCHER || 'false').toLowerCase() === 'true',
    tranchePct: Math.max(0.1, Math.min(5, Number(process.env.TRADING_POP_TRANCHE_PCT) || 1)),
    maxPositions: Math.max(1, Math.min(20, Number(process.env.TRADING_POP_MAX) || 5)),
    threshold: Math.max(0, Math.min(1, Number(process.env.TRADING_POP_THRESHOLD) || 0.34)),
  };
}

/**
 * @description Hard stop / take-profit (exitsToRun) + trailing-stop exits for the book, deduped by symbol with
 *  the trailing peak rolled forward + persisted. Stop/TP win over trailing when both fire on a name.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param bookOrMode - The book (or legacy mode).
 * @param positions - Current positions (already overlaid by the pinned-lot subtraction).
 * @param policy - Active risk policy.
 * @param equity - Account equity (cap-trim base).
 * @param extHours - True in pre/post-market: only the close-anchored dip rule runs.
 * @returns The exits to place this fire, one per symbol.
 */
export async function computeExits(ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, positions: Position[], policy: RiskPolicy, equity: number, extHours: boolean): Promise<ExitOrder[]> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  await ensurePeaksTable(ctx.pool);
  const peaks = nextPeaks(positions, await loadPeaks(ctx.pool, sub, book));
  await savePeaks(ctx.pool, sub, book, peaks);
  // EXTENDED HOURS = DEFENSE ONLY (operator doctrine 2026-07-07): the ONLY off-hours exit is the
  // close-anchored dip rule — sell a name outright when it prints TRADING_EXT_DIP_SELL_PCT (default
  // 0.5%) below its last regular close. No take-profits, no trailing, no cap trims off-hours (the
  // 4 AM cap-trim liquidation was an off-hours trim). Backtested +$461 over all 6 session nights,
  // zero negative windows (trading-exthours-rule-backtest.js).
  if (extHours) {
    const dipPct = Number(process.env.TRADING_EXT_DIP_SELL_PCT || 0.5);
    const held = positions.filter((p) => p.qty > 0).map((p) => p.symbol.toUpperCase());
    if (!held.length) return [];
    const dailyBars = await barsBatch(held, '1Day').catch(() => new Map<string, number[]>());
    const priorClose = new Map<string, number>();
    for (const sym of held) {
      const closes = dailyBars.get(sym) || [];
      if (closes.length) priorClose.set(sym, closes[closes.length - 1]);
    }
    return dipExits(positions, priorClose, dipPct);
  }
  const stopMult = 1;
  const bySym = new Map<string, ExitOrder>();
  // Order = priority: a full stop/TP wins over trailing, and any full exit wins over a partial cap trim
  // (no point trimming a name we're about to flatten this fire).
  for (const e of [...exitsToRun(positions, policy, stopMult), ...trailingExits(positions, peaks, policy, stopMult), ...rebalanceTrims(positions, equity, policy)]) {
    const k = e.symbol.toUpperCase();
    if (!bySym.has(k)) bySym.set(k, e);
  }
  return [...bySym.values()];
}

/**
 * @description Place new conviction-sized entries from the scan, portfolio-gated, capped per fire. The world
 *  influence gate vetoes names the press/influencers are actively souring on and tilts size with the
 *  mood (both no-ops when coverage is thin). It never creates a buy the technicals didn't already pick.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param bookOrMode - The book (or legacy mode).
 * @param scan - The multi-timeframe scan for this fire.
 * @param held - UPPERCASE symbol → held qty.
 * @param account - Account snapshot with in-flight + core cash already reserved.
 * @param policy - Active risk policy.
 * @param positions - Positions remaining after this fire's exits.
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @param worldSvc - World-intelligence service (null → neutral gate).
 * @param inFlight - UPPERCASE symbols with a working order (never re-entered).
 * @param extHours - True in pre/post-market (size-down applies).
 * @param noBuy - The earnings blackout set (empty unless armed).
 * @returns Resolves when every eligible entry has been placed or skipped.
 */
export async function placeEntries(
  ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, scan: Map<string, MtfDecision>,
  held: Map<string, number>, account: BrokerAccount, policy: RiskPolicy, positions: Position[],
  orders: RunOrder[], errors: Array<{ symbol: string; error: string }>, worldSvc: WorldIntelligenceService | null,
  inFlight: Set<string>, extHours: boolean, noBuy: Set<string> = new Set(),
): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  // Trade SMALLER in thin pre/post sessions — gaps + wide spreads make ext-hours the high-variance
  // window (where money is made AND lost). Halve the size by default so a gap can't hurt the book as much.
  const extSizeMult = extHours ? Number(process.env.TRADING_EXT_SIZE_MULT || 0.5) : 1;
  // A candidate that clears every buy predicate below EXCEPT the gates: the entry the engine WOULD
  // have made. Shared by the buys filter and the counterfactual capture so they cannot drift apart.
  const wouldBuy = (d: MtfDecision): boolean =>
    d.action === 'buy' && (held.get(d.symbol) || 0) <= 0 && !inFlight.has(d.symbol.toUpperCase())
    && !!d.price && !isShortTermBreakdown(d)
    && !symbolBlocklist().has(d.symbol.toUpperCase());    // operator blocklist — the engine never buys these
  const buys = [...scan.values()]
    // Don't catch a falling knife: skip names breaking down on the short timeframes even when the
    // regime-weighted call is "buy the dip" — this also stops the sell→rebuy→sell churn on a crash.
    // Exclude names with a WORKING order (a pending pre/post-market limit getPositions() can't see) so
    // we don't pyramid the same ticker across fires until they all fill at the open.
    .filter((d) => wouldBuy(d)
      && !noBuy.has(d.symbol.toUpperCase()));             // earnings blackout (when armed) — never initiate into a print
  // Counterfactual ledger: entries the blackout suppressed, persisted so the gate accumulates
  // scoreable evidence (fire-and-forget — evidence loss must never affect the fire).
  if (noBuy.size) {
    const blocked = [...scan.values()].filter((d) => wouldBuy(d) && noBuy.has(d.symbol.toUpperCase()));
    if (blocked.length) void recordGateBlocks(ctx.pool, sub, book, 'earnings', blocked.map((d) => ({ symbol: d.symbol, refPrice: d.price ?? null })));
  }

  // World-intelligence RANK + sizing tilt (TRADING_WORLD_RANK, default off). Prefetch a blended
  // smart-money/sentiment score per candidate so the world layer becomes a POSITIVE conviction input —
  // it reorders the buy queue and tilts size — instead of only the existing negative veto. The veto on
  // raw sentiment below is unchanged. Off (or no world svc) → identical to the confidence-only baseline.
  const rankWorld = worldRankEnabled() && worldSvc != null;
  const worldBlend = new Map<string, number>();
  if (rankWorld) {
    // ONE batched query for the whole candidate set (not 8×N single reads) — see readWorldSignalsBatch.
    const basket = await readWorldSignalsBatch(worldSvc as WorldIntelligenceService, buys.map((d) => d.symbol), WORLD_SENT_DAYS);
    for (const [sym, w] of basket) if (w.score != null) worldBlend.set(sym, w.score);
  }
  const rankScore = (d: MtfDecision): number => d.confidence + (rankWorld ? WORLD_RANK_WEIGHT * (worldBlend.get(d.symbol.toUpperCase()) ?? 0) : 0);
  buys.sort((a, b) => rankScore(b) - rankScore(a));
  let entries = 0;
  for (const d of buys) {
    if (entries >= MAX_ORDERS_PER_RUN) break;
    const world = await worldSentiment(worldSvc, d.symbol);
    const acts = world.score != null && world.points >= WORLD_SENT_MIN_POINTS;
    // VETO: the influence layer is strongly negative on this name — stand aside even if technicals like it.
    if (acts && (world.score as number) <= WORLD_SENT_VETO) {
      logger.info({ sub, symbol: d.symbol, sentiment: world.score, points: world.points }, 'autopilot entry vetoed by world sentiment');
      continue;
    }
    // Recent daily volatility (14-day return stdev %) → volatility-normalized sizing so a high-vol name
    // gets a smaller position and can't dominate the loss side (fixes the win/loss size skew).
    let volPct: number | undefined;
    try {
      const closes = await dailyCloses(d.symbol, 15);
      if (closes.length > 5) {
        const rets: number[] = []; for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        volPct = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * 100;
      }
    } catch { /* vol optional — fall back to flat sizing */ }
    const sized = sizeEntry(d.symbol, d.price as number, d.confidence, account, positions, policy, volPct);
    if (sized.qty <= 0) continue; // blocked by a cap — skip quietly
    // TILT: scale size with the mood (±40%, floored at 1 share) when coverage is real. Under
    // TRADING_WORLD_RANK the tilt uses the BLENDED score (insider+congress+sentiment momentum), else
    // the raw news sentiment as before.
    const tiltScore = (rankWorld && worldBlend.has(d.symbol.toUpperCase())) ? (worldBlend.get(d.symbol.toUpperCase()) as number) : (world.score ?? 0);
    let qty = (acts || (rankWorld && worldBlend.has(d.symbol.toUpperCase())))
      ? Math.max(1, Math.round(sized.qty * clamp(1 + 0.4 * tiltScore, 0.6, 1.4)))
      : sized.qty;
    // Extended-hours size-down (thin/gappy session).
    qty = Math.floor(qty * extSizeMult);
    if (qty < 1) continue; // too small after the ext-hours haircut — skip rather than place a token share
    await placeManaged(ctx, sub, book, scanDecision(d, 'buy', qty, world), orders, errors);
    entries += 1;
  }
}

/**
 * @description 2a-pop) POP-CATCHER (opt-in, off by default) — pull an UNFUNDED name IN when it surges on the 5-minute
 *   bar. The daily rotation funds the proven leaders; this catches a fast intraday move they missed, from
 *   the idle cash reserve, in a small tranche, capped in count. Reuses the scan already computed above (no
 *   extra fetch); runs regardless of who owns the sleeve; step-1 protective stops exit it like any name.
 *   The monolith's runAutopilot block, moved as-is: reads TRADING_POP_CATCHER each fire and no-ops
 *   unless armed AND the book is enabled AND equity is positive.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param book - The book firing (its `enabled` flag gates new risk).
 * @param scan - The multi-timeframe scan for this fire.
 * @param positions - Current positions.
 * @param account - Account snapshot (equity/cash).
 * @param coreSet - Beta-core symbols (never a pop target).
 * @param exiting - UPPERCASE symbols already exiting this fire (never a pop target).
 * @param coreSpent - Cash the core top-up already claimed this fire.
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @returns Resolves when every surge has been placed or skipped.
 */
export async function placePopCatches(
  ctx: AppContext, sub: string, book: TradingBook, scan: Map<string, MtfDecision>, positions: Position[], account: BrokerAccount,
  coreSet: Set<string>, exiting: Set<string>, coreSpent: number, orders: RunOrder[], errors: Array<{ symbol: string; error: string }>,
): Promise<void> {
  const pop = popCatcherConfig();
  if (pop.enabled && book.enabled && account.equity > 0) {
    const heldNow = new Set(positions.filter((p) => p.qty > 0).map((p) => p.symbol.toUpperCase()));
    const tranche = (pop.tranchePct / 100) * account.equity;
    let popCash = Math.max(0, account.cash - coreSpent); // don't double-spend what the core top-up claimed
    let placed = 0;
    const surges = [...scan.values()]
      .filter((d) => {
        const s = d.symbol.toUpperCase();
        return !heldNow.has(s) && !coreSet.has(s) && !exiting.has(s) && !symbolBlocklist().has(s) && d.score > 0 && isShortTermPop(d, pop.threshold);
      })
      .sort((a, b) => b.score - a.score); // strongest surge first
    for (const d of surges) {
      if (placed >= pop.maxPositions) break;
      const notional = Math.min(tranche, popCash);
      if (notional < account.equity * 0.005) break; // cash reserve exhausted
      const px = d.price ?? await latestPrice(d.symbol).catch(() => null);
      if (!px || px <= 0) continue;
      const qty = Math.floor(notional / px);
      if (qty < 1) continue;
      const fiveScore = d.perTimeframe.find((v) => v.timeframe === '5Min')?.score ?? 0;
      await placeManaged(ctx, sub, book, {
        symbol: d.symbol, action: 'buy', side: 'buy', qty, confidence: d.confidence,
        rationale: `Pop-catcher — 5-min momentum surge (5m ${fiveScore.toFixed(2)}, overall ${d.score.toFixed(2)}); intraday pull-in from cash.`,
        indicators: { reason: 'pop-catcher', mtfScore: d.score, fiveMin: fiveScore }, price: px, source: 'pop-catcher',
      }, orders, errors, 'pop');
      popCash -= qty * px; placed += 1;
    }
  }
}
