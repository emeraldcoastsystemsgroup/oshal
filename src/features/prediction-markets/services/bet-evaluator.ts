/**
 * Bet evaluator — reads every open contract like a poker hand.
 *
 * Hand strength = our calibrated true probability. Pot odds = the side's ask plus Kalshi's taker
 * fee. The hand is only playable when strength beats pot odds by a margin history supports, and
 * the stake is Kelly-sized then discounted for table conditions (wide spread, thin book, thin
 * calibration evidence, long-dated resolution). No-history contracts price to zero edge by
 * construction (calibration shrinks to the market price) — the engine folds them rather than
 * inventing conviction.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — two-sided evaluation off the book mid, net-of-fee edge, fractional Kelly with risk-flag discounts, poker-style strength classes, ranked scan output.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guards from the 4-skeptic adversarial review: hard fold beyond 48h-to-close (no measured calibration horizon covers it — a 3-month market was being priced off 24h evidence), and one-hand-per-event dedup in rankHands (same-event strikes are ONE correlated outcome, not independent stakes).
 *
 * @module prediction-markets/bet-evaluator
 */

import type { BetHand, CalibrationTable, HandStrength, KalshiMarket, KalshiSeriesMeta } from '../types';
import { calibratedProb } from './calibration';
import { feePerContract } from './kalshi-fees';

/** Fraction of full Kelly actually staked (quarter-Kelly default — variance kills bankrolls, not edge). */
const KELLY_FRACTION = Number(process.env.KALSHI_KELLY_FRACTION) || 0.25;
/** Hard cap on any single hand as a fraction of bankroll. */
const MAX_STAKE_FRACTION = Number(process.env.KALSHI_MAX_STAKE_FRACTION) || 0.05;
/** Calibration horizons (hours before close) the study produces. */
export const CALIBRATION_HORIZONS = [24, 6, 1];
/** Hard evaluability ceiling — beyond 2× the longest measured horizon there is NO evidence, so
 *  the engine refuses to price (adversarial review 2026-07-13: a 3-month market must not be
 *  priced off 24h-to-close calibration). */
const MAX_HOURS_TO_CLOSE = Number(process.env.KALSHI_MAX_HOURS_TO_CLOSE) || 48;

function nearestHorizon(hoursToClose: number): number {
  let best = CALIBRATION_HORIZONS[0];
  for (const h of CALIBRATION_HORIZONS) {
    if (Math.abs(Math.log(Math.max(hoursToClose, 0.1) / h)) < Math.abs(Math.log(Math.max(hoursToClose, 0.1) / best))) best = h;
  }
  return best;
}

function kellyFraction(prob: number, effCost: number): number {
  if (effCost <= 0 || effCost >= 1) return 0;
  const b = (1 - effCost) / effCost;
  return Math.max(0, (prob * b - (1 - prob)) / b);
}

function riskFlags(m: KalshiMarket, spread: number, calibN: number, hoursToClose: number): string[] {
  const flags: string[] = [];
  if (spread > 0.05) flags.push('wide-spread');
  if (m.liquidity < 500) flags.push('thin-book');
  if (m.openInterest < 50) flags.push('low-oi');
  if (calibN < 100) flags.push('low-sample');
  if (hoursToClose > 72) flags.push('long-dated');
  return flags;
}

function strengthOf(edgeNet: number, confidence: number, stake: number): HandStrength {
  if (stake <= 0 || edgeNet <= 0) return 'fold';
  if (edgeNet >= 0.06 && confidence >= 0.7) return 'monster';
  if (edgeNet >= 0.03 && confidence >= 0.5) return 'strong';
  if (edgeNet >= 0.012 && confidence >= 0.35) return 'playable';
  return 'fold';
}

function evaluateSide(
  m: KalshiMarket, series: KalshiSeriesMeta, table: CalibrationTable,
  side: 'yes' | 'no', probYes: number, calibN: number, confidence: number, hoursToClose: number,
): BetHand {
  const ask = side === 'yes' ? m.yesAsk : m.noAsk;
  const bid = side === 'yes' ? m.yesBid : m.noBid;
  const spread = ask > 0 && bid > 0 ? ask - bid : 1;
  const trueProb = side === 'yes' ? probYes : 1 - probYes;
  const fee = feePerContract(ask, series);
  const effCost = ask + fee;
  const edgeNet = trueProb - effCost;
  const kelly = kellyFraction(trueProb, effCost);
  const flags = riskFlags(m, spread, calibN, hoursToClose);
  const discounted = kelly * KELLY_FRACTION * Math.pow(0.5, flags.length);
  const usable = ask > 0.01 && ask < 0.99;
  const stakeFraction = usable && edgeNet > 0 ? Math.min(MAX_STAKE_FRACTION, discounted) : 0;
  return {
    ticker: m.ticker, eventTicker: m.eventTicker, title: m.title, category: series.category,
    closeTime: m.closeTime ? m.closeTime.toISOString() : null,
    side, price: ask, marketProb: ask, trueProb, calibrationN: calibN,
    feePerContract: fee, edgeNet, evPerContract: edgeNet,
    kellyFraction: kelly, stakeFraction, confidence, riskFlags: flags,
    strength: strengthOf(edgeNet, confidence, stakeFraction),
    spread, liquidity: m.liquidity, volume: m.volume,
  };
}

/**
 * @description Evaluate one market's two sides against the calibration table and return the
 * better hand. The probability estimate reads the book MID (what calibration was built on);
 * entry economics use the side's ASK plus fee. Multivariate legs and empty books fold outright.
 * @param m - Normalized open market.
 * @param series - Its series metadata (category + fee model).
 * @param table - Calibration table from the settled-market study.
 * @param nowMs - Current epoch ms (injectable for tests).
 * @returns The stronger side's hand, or null when the market isn't evaluable.
 */
export function evaluateMarket(
  m: KalshiMarket, series: KalshiSeriesMeta, table: CalibrationTable, nowMs = Date.now(),
): BetHand | null {
  if (m.isMultivariate || !m.closeTime) return null;
  if (m.yesAsk <= 0 || m.noAsk <= 0 || m.yesBid < 0) return null;
  const hoursToClose = (m.closeTime.getTime() - nowMs) / 3_600_000;
  if (hoursToClose <= 0.05 || hoursToClose > MAX_HOURS_TO_CLOSE) return null;
  const mid = m.yesBid > 0 ? (m.yesBid + m.yesAsk) / 2 : m.yesAsk;
  const horizon = nearestHorizon(hoursToClose);
  const { prob, n, confidence } = calibratedProb(table, horizon, series.category, mid);
  const yesHand = evaluateSide(m, series, table, 'yes', prob, n, confidence, hoursToClose);
  const noHand = evaluateSide(m, series, table, 'no', prob, n, confidence, hoursToClose);
  return yesHand.edgeNet >= noHand.edgeNet ? yesHand : noHand;
}

/**
 * @description Evaluate a batch of markets and rank the playable hands: strength class first,
 * then risk-adjusted edge (edge × confidence). Folds are dropped.
 * @param markets - Open markets.
 * @param seriesByTicker - Series metadata per series ticker.
 * @param table - Calibration table.
 * @param nowMs - Current epoch ms (injectable for tests).
 * @returns Ranked playable hands, best first.
 */
export function rankHands(
  markets: KalshiMarket[], seriesByTicker: Map<string, KalshiSeriesMeta>, table: CalibrationTable, nowMs = Date.now(),
): BetHand[] {
  const order: Record<HandStrength, number> = { monster: 0, strong: 1, playable: 2, fold: 3 };
  const hands: BetHand[] = [];
  for (const m of markets) {
    const series = seriesByTicker.get(m.seriesTicker);
    if (!series) continue;
    const hand = evaluateMarket(m, series, table, nowMs);
    if (hand && hand.strength !== 'fold') hands.push(hand);
  }
  const ranked = hands.sort((a, b) =>
    order[a.strength] - order[b.strength] || b.edgeNet * b.confidence - a.edgeNet * a.confidence);
  // One hand per EVENT (adversarial review 2026-07-13): strikes of the same event are one
  // correlated outcome — a temperature ladder must not stack 3 "independent" stakes.
  const seenEvents = new Set<string>();
  return ranked.filter((h) => {
    const key = h.eventTicker || h.ticker;
    if (seenEvents.has(key)) return false;
    seenEvents.add(key);
    return true;
  });
}
