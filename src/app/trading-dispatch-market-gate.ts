/**
 * Trading autopilot — the per-fire PARITY CONTROLS (ADR-052 addendum): the market-wide gap-down
 * entry filter, evaluated ONCE per fire, and the per-position exit-plan ledger, resolved once per fire.
 *
 * MARKET-WIDE GAP-DOWN. The per-name rotation guard (entry-guards.ts) reads one candidate's own gap;
 * nothing read the whole tape. When SPY trades at or beyond a pre-registered bar below its prior
 * session close, every ENTRY leg holds for the fire — the scan entries, the rotation rebalance (its
 * drop-out sells too: a rebalance is funded by those sells and must not sell into the gap only to
 * buy nothing), the blend rebalance and the pop-catcher — and each leg records the buys it would
 * have made in the counterfactual gate-block ledger under gate 'market-gap'. Protective exits, the
 * breakdown leg, technical sells and benches never hold, and neither does the beta-core rebalance,
 * which tracks its target in both directions and is not an entry decision. A held rotation does NOT
 * consume the day's rotation slot, so the next fire retries. Missing SPY data fails OPEN.
 *
 * Both controls resolve through the one resolver pair the Strategy Lab also reads
 * (marketGapFilterPct / exitPlanSessions): the applied strategy's knob decides, an absent knob
 * inherits the mode-aware env default, and both are OFF unless armed — an unarmed fire makes no
 * market-data read here and hands every leg a null control, so it is byte-identical to before.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ParityControls, resolveParityControls (market-gap bar + plan ledger per fire), evaluateMarketGap (SPY latest print vs its prior SESSION close through the dated daily series, fail-open with a logged reason), marketGapHolds (the one-line hold every entry leg calls: logs, writes the would-be buys as 'market-gap' counterfactuals fire-and-forget, returns true) and freshTargets (a rotation leaderboard's not-yet-held names as counterfactual rows). Logs as module 'trading-schedule-dispatch' — the autopilot's log stream is the watchdog/operator contract.
 *
 * @module trading-dispatch-market-gate
 */

import type { AppContext } from './composition-root';
import {
  barsBatchSince, latestPrice, priorSessionClose, etSessionDate, marketGapBlock, marketGapFilterPct,
  type TradingBook, type RiskPolicy, type Position, type MarketGapVerdict, type DatedClose,
} from '@/features/trading';
import type { ConfigOverrideRow } from './trading-config-overrides';
import { recordGateBlocks, type GateBlock } from './trading-gate-block-store';
import { resolvePlanLedger, type PlanLedger } from './trading-position-plans';
import { createChildLogger } from '@/shared/logger';

// Module name kept as the dispatch's: the log stream is the watchdog/operator contract.
const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

/** The gate name the counterfactual rows carry. */
export const MARKET_GAP_GATE = 'market-gap';
/** The tape the filter reads. */
export const MARKET_GAP_SYMBOL = 'SPY';

/** The parity controls one fire carries into its legs; each is null while its feature is off. */
export interface ParityControls {
  /** The market-wide verdict for this fire, or null when the filter is off for the book. */
  marketGap: MarketGapVerdict | null;
  /** The per-position plan ledger for this fire, or null when plans are off for the book. */
  plans: PlanLedger | null;
}

/** The controls an unarmed fire carries: nothing, so every leg takes its pre-existing path. */
export const NO_PARITY_CONTROLS: ParityControls = Object.freeze({ marketGap: null, plans: null });

/**
 * @description Measure SPY against its prior SESSION close and judge it against the bar. The prior
 * close comes from the DATED daily series (the last bar strictly before today's ET session), never
 * the last element of a plain close series, which mid-session is today's own forming bar. Each read
 * that fails is logged and treated as missing, and missing data fails OPEN.
 * @param thresholdPct - The bar as a positive percent.
 * @param now - Clock (injectable for tests).
 * @returns The verdict with the numbers it judged.
 */
export async function evaluateMarketGap(thresholdPct: number, now: number = Date.now()): Promise<MarketGapVerdict> {
  const since = new Date(now - 20 * 86_400_000).toISOString();
  const [dated, price] = await Promise.all([
    barsBatchSince([MARKET_GAP_SYMBOL], since).catch((err) => {
      logger.warn({ err, symbol: MARKET_GAP_SYMBOL }, 'market-gap filter: daily series read failed — failing OPEN');
      return new Map<string, DatedClose[]>();
    }),
    latestPrice(MARKET_GAP_SYMBOL).catch((err) => {
      logger.warn({ err, symbol: MARKET_GAP_SYMBOL }, 'market-gap filter: latest price read failed — failing OPEN');
      return null;
    }),
  ]);
  const prior = priorSessionClose(dated.get(MARKET_GAP_SYMBOL), etSessionDate(now));
  return marketGapBlock(price != null && price > 0 ? price : null, prior, thresholdPct);
}

/**
 * @description Resolve both parity controls for one fire. The market gap is read only when the
 * filter is armed for this book; the plan ledger is constructed only when plans are armed.
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param override - The applied Strategy Library override, when one is active.
 * @param policy - The risk policy in force for the fire (the dials a plan stamps).
 * @returns The controls — {@link NO_PARITY_CONTROLS}-shaped when both features are off.
 */
export async function resolveParityControls(sub: string, book: TradingBook, override: ConfigOverrideRow | null, policy: RiskPolicy): Promise<ParityControls> {
  const pct = marketGapFilterPct(override?.config.marketGapFilterPct, book.kind);
  const plans = resolvePlanLedger(sub, book, override, policy);
  if (pct <= 0) return plans ? { marketGap: null, plans } : NO_PARITY_CONTROLS;
  const marketGap = await evaluateMarketGap(pct);
  if (marketGap.blocked) {
    logger.warn({ sub, bookRef: book.ref, gapPct: marketGap.gapPct, spy: marketGap.spyPrice, priorClose: marketGap.spyPriorClose, thresholdPct: pct },
      'market-wide gap-down — entry legs hold this fire (protective exits unaffected)');
  } else if (marketGap.gapPct == null) {
    logger.warn({ sub, bookRef: book.ref, thresholdPct: pct }, 'market-gap filter could not measure SPY — failing OPEN (entries proceed)');
  }
  return { marketGap, plans };
}

/**
 * @description The hold every entry leg calls first. When the fire's market-gap verdict is blocked
 * it logs which leg held, writes the would-be buys to the counterfactual ledger (fire-and-forget:
 * recordGateBlocks never throws, and evidence loss must never affect the fire) and returns true so
 * the leg returns before placing anything. Otherwise it returns false and does nothing.
 * @param pool - Postgres pool (the counterfactual ledger).
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param controls - The fire's parity controls (null/absent = unarmed).
 * @param leg - The entry leg asking ('scan' | 'rotation' | 'blend-rotation' | 'pop').
 * @param wouldBuy - The buys this leg would have placed, with their reference prices.
 * @returns True when the leg must hold this fire.
 */
export function marketGapHolds(
  pool: AppContext['pool'], sub: string, book: TradingBook, controls: ParityControls | null | undefined, leg: string, wouldBuy: GateBlock[],
): boolean {
  if (!controls?.marketGap?.blocked) return false;
  logger.info({ sub, bookRef: book.ref, leg, gapPct: controls.marketGap.gapPct, held: wouldBuy.map((b) => b.symbol) },
    'market-gap hold — entry leg skipped; would-be buys recorded as counterfactuals');
  if (wouldBuy.length) void recordGateBlocks(pool, sub, book, MARKET_GAP_GATE, wouldBuy);
  return true;
}

/**
 * @description A rotation leaderboard's would-be FRESH entries — the targets the book does not hold
 * yet — as counterfactual rows priced at the ranker's own last daily close. A held leader's top-up is
 * not recorded: whether it would have bought depends on sizing the hold never reached.
 * @param targets - The leaderboard targets (UPPERCASE).
 * @param positions - The book's positions.
 * @param bars - The ranker's daily closes per symbol.
 * @returns One counterfactual row per unheld target.
 */
export function freshTargets(targets: string[], positions: Position[], bars: Map<string, number[]>): GateBlock[] {
  const held = new Set(positions.filter((p) => p.qty > 0).map((p) => p.symbol.toUpperCase()));
  return targets.filter((s) => !held.has(s.toUpperCase())).map((s) => {
    const closes = bars.get(s) ?? bars.get(s.toUpperCase()) ?? [];
    return { symbol: s, refPrice: closes.length ? closes[closes.length - 1] : null };
  });
}
