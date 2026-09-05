/**
 * Kalshi contrarian forward test — bet AGAINST our own weather picks where we disagree most with the market.
 *
 * Operator, 2026-09-04: "we don't have to change our algorithm, we can just bet against ourselves — if it is
 * extremely wrong then it is extremely right on the other side. Right?" The graded record says: not extremely.
 * Over 1,619 settled weather predictions our side lost to the market in every confidence bucket; flipping the
 * 153 picks that disagreed with the market by 30+ points would have made ~8¢ a contract after a 3¢ spread.
 * That is one in-sample survivor out of fourteen variants tried on the data that produced it, so it is NOT a
 * strategy — it is a hypothesis, and this module pre-registers it as one:
 *
 *   RULE (fixed 2026-09-04, before any further data): for every weather-enso pick whose model probability
 *   differs from the market's ask by >= WEATHER_DISAGREEMENT_MIN, register the OPPOSITE side at that side's
 *   own ask, with the claim that the market is CLAIMED_OVERPRICING too generous to our side (the in-sample
 *   gap: flipped picks hit 77.8% against a 65.3% price). Stake is ZERO. The daily grader scores it like any
 *   other strategy — Brier vs the market's Brier, realized P&L — and the Scorecard tab shows it beside the
 *   others. Nothing here places an order.
 *
 * Pure: no I/O, so tests/unit/kalshi-contrarian-forward.spec.ts pins the rule exactly as the forward script
 * applies it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the pre-registered contrarian-weather-disagree rule: threshold, flip side + flip ask from the market's OTHER side, the claimed-overpricing probability, zero stake, and the diagnosable rationale.
 */

import { feePerContract, type WeatherMarket, type WeatherPick } from '../src/features/prediction-markets';

/** Strategy name as it appears in kalshi_predictions and on the Scorecard tab. */
export const CONTRARIAN_WEATHER_STRATEGY = 'contrarian-weather-disagree';

/** |our probability − market ask| at or above this = "we disagree most" (90th percentile of the record). */
export const WEATHER_DISAGREEMENT_MIN = 0.30;

/**
 * The pre-registered claim: the market is this much too generous to OUR side, so the other side is worth
 * its ask plus this. In-sample the flipped picks hit 77.8% against a 65.3% price (12 points, ~10 after the
 * spread). Fixed here so the forward test can falsify it.
 */
export const CLAIMED_OVERPRICING = 0.10;

/** One pre-registered contrarian prediction, ready for the kalshi_predictions insert. */
export interface ContrarianRow {
  strategy: string;
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  side: 'yes' | 'no';
  /** Our (contrarian) probability for the flipped side. */
  predictedProb: number;
  /** The flipped side's own ask — what the grader treats as the price paid. */
  marketProb: number;
  edgeNet: number;
  /** Always 0: a pre-registered hypothesis stakes nothing. */
  stakeFraction: 0;
  rationale: {
    flippedFrom: string;
    rule: string;
    ourSide: 'yes' | 'no';
    ourProb: number;
    ourAsk: number;
    disagreement: number;
    claimedOverpricing: number;
    forecastF: number;
    leadDays: number;
  };
  closeTime: string | null;
}

/**
 * @description Build the contrarian sibling of one weather pick, or null when the pick is not a
 * strong-enough disagreement or the other side has no usable ask. The flip is priced at the OTHER
 * side's ask from the same market object the pick came from — never at one-minus-our-ask, which
 * would pretend the spread away.
 * @param pick - A weather-enso pick as evaluateWeatherMarkets emits it.
 * @param market - The market the pick was made on (for the other side's ask).
 * @returns The row to pre-register, or null.
 */
export function contrarianWeatherRow(pick: WeatherPick, market: WeatherMarket | undefined): ContrarianRow | null {
  if (!market || market.ticker !== pick.ticker) return null;
  const disagreement = Math.abs(pick.modelProb - pick.marketProb);
  if (!(disagreement >= WEATHER_DISAGREEMENT_MIN)) return null;
  const side: 'yes' | 'no' = pick.side === 'yes' ? 'no' : 'yes';
  const flipAsk = side === 'yes' ? market.yesAsk : market.noAsk;
  if (!(flipAsk > 0.01 && flipAsk < 0.99)) return null;
  const predictedProb = Math.min(0.99, flipAsk + CLAIMED_OVERPRICING);
  const fee = feePerContract(flipAsk, { feeType: 'quadratic', feeMultiplier: 1 });
  return {
    strategy: CONTRARIAN_WEATHER_STRATEGY,
    ticker: pick.ticker,
    eventTicker: pick.eventTicker,
    seriesTicker: pick.seriesTicker,
    side,
    predictedProb,
    marketProb: flipAsk,
    edgeNet: predictedProb - (flipAsk + fee),
    stakeFraction: 0,
    rationale: {
      flippedFrom: 'weather-enso',
      rule: `|modelProb - marketProb| >= ${WEATHER_DISAGREEMENT_MIN}`,
      ourSide: pick.side,
      ourProb: pick.modelProb,
      ourAsk: pick.marketProb,
      disagreement,
      claimedOverpricing: CLAIMED_OVERPRICING,
      forecastF: pick.rationale.forecastF,
      leadDays: pick.rationale.leadDays,
    },
    closeTime: pick.closeTime,
  };
}
