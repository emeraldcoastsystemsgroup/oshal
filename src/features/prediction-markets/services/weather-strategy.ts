/**
 * Weather strategy — turn the NWS forecast + measured error distribution into ranked bets.
 *
 * The claim, stated so it can be killed: the market prices the NWS forecast correctly (proven), so
 * any edge must come from the market mispricing the forecast's UNCERTAINTY. This module produces
 * P(bucket) from Normal(µ = forecast + measured bias, σ = measured error), compares it to the ask
 * net of fees, and sizes with the same Kelly/risk machinery every other strategy here uses.
 *
 * THE REFUSAL RULE (the thing that makes this honest): while the error model is still the untested
 * PRIOR (isPrior), the strategy produces ZERO stake. It will happily report what it thinks, and it
 * will not bet a cent, because a σ it has not measured is exactly how the calibration strategy
 * fooled itself. The forward test grows the model; only a measured σ can size a bet.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — bucket parsing from Kalshi's strike fields, Gaussian bucket probabilities, net-of-fee edge, quarter-Kelly sizing gated on a MEASURED error model.
 *
 * @module prediction-markets/weather-strategy
 */

import { createChildLogger } from '@/shared/logger';
import type { EnsoState } from './enso';
import { feePerContract } from './kalshi-fees';
import type { ErrorModel } from './weather-model';
import { bucketProbability } from './weather-model';

const log = createChildLogger({ module: 'weather-strategy' });

const KELLY_FRACTION = Number(process.env.KALSHI_KELLY_FRACTION) || 0.25;
const MAX_STAKE_FRACTION = Number(process.env.KALSHI_MAX_STAKE_FRACTION) || 0.05;
/** Minimum net edge to bother with — below this, spread + slippage eat it. */
const MIN_EDGE = Number(process.env.KALSHI_WEATHER_MIN_EDGE) || 0.05;

/** A weather market with its parsed bucket bounds. */
export interface WeatherMarket {
  ticker: string;
  seriesTicker: string;
  eventTicker: string;
  title: string;
  /** Bucket bounds in °F; null = open-ended ("97° or above" → hi = null). */
  loF: number | null;
  hiF: number | null;
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  volume: number;
  closeTime: string | null;
}

/** A ranked weather bet, with everything needed to grade it later. */
export interface WeatherPick {
  ticker: string;
  seriesTicker: string;
  eventTicker: string;
  title: string;
  side: 'yes' | 'no';
  /** Our model's probability for the SIDE we're taking. */
  modelProb: number;
  /** The market's implied probability for that side (its ask). */
  marketProb: number;
  price: number;
  fee: number;
  edgeNet: number;
  stakeFraction: number;
  /** Everything the model used — recorded so a graded loss is diagnosable, not mysterious. */
  rationale: {
    forecastF: number;
    leadDays: number;
    sigma: number;
    bias: number;
    ensoPhase: string;
    oni: number;
    errorModelN: number;
    errorModelIsPrior: boolean;
  };
  closeTime: string | null;
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/**
 * @description The calendar date a weather market SETTLES ON, parsed from its ticker
 * (`KXHIGHNY-26JUL14-B94.5` → `2026-07-14`).
 *
 * CRITICAL (bug caught live 2026-07-13): do NOT infer this from `close_time`. A daily temperature
 * market closes at ~05:00 UTC the FOLLOWING day, so close_time's date is the day AFTER the one the
 * market measures. Matching forecasts to markets by close_time priced Jul-14 markets against the
 * Jul-15 forecast and manufactured a +55¢ "edge" out of a correctly-priced book. The ticker is the
 * only unambiguous source of the target date.
 * @param ticker - Kalshi market ticker.
 * @returns 'YYYY-MM-DD', or null when the ticker carries no parseable date.
 */
export function parseMarketDate(ticker: string): string | null {
  const m = /-(\d{2})([A-Z]{3})(\d{2})-/.exec(ticker);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (!month) return null;
  return `20${m[1]}-${month}-${m[3]}`;
}

/**
 * @description Parse a Kalshi temperature market's bucket bounds from its strike fields.
 * `between` → [floor, cap]; `greater(_or_equal)` → [floor, ∞); `less(_or_equal)` → (−∞, cap].
 * @param m - Raw market fields.
 * @returns Bounds in °F, or null when the market isn't a temperature bucket.
 */
export function parseBucket(m: { strikeType?: string; floorStrike?: number; capStrike?: number }): { loF: number | null; hiF: number | null } | null {
  const t = m.strikeType;
  const f = typeof m.floorStrike === 'number' ? m.floorStrike : null;
  const c = typeof m.capStrike === 'number' ? m.capStrike : null;
  if (t === 'between' && f !== null && c !== null) return { loF: f, hiF: c };
  if ((t === 'greater' || t === 'greater_or_equal') && f !== null) {
    // 'greater' means strictly above the strike; Kalshi's sub-title reads "98° or above" for
    // floor 97 with strike_type 'greater'. Normalize to the inclusive integer bucket.
    return { loF: t === 'greater' ? f + 1 : f, hiF: null };
  }
  if ((t === 'less' || t === 'less_or_equal') && c !== null) {
    return { loF: null, hiF: t === 'less' ? c - 1 : c };
  }
  return null;
}

/**
 * @description Evaluate one city's bucket ladder against the model and return the playable picks.
 * Both sides of every bucket are considered (a bucket the model thinks is far too EXPENSIVE is a
 * NO bet, which is often where the real edge sits — the market overpays for the modal outcome).
 * @param markets - The city's open buckets for one target date.
 * @param forecastF - NWS forecast high.
 * @param leadDays - Days to the target date.
 * @param model - The (city, lead, ENSO) error model.
 * @param enso - Current ENSO state (recorded into the rationale).
 * @returns Picks worth taking, best edge first. EMPTY while the error model is an untested prior.
 */
/**
 * Max °F the NWS forecast may sit outside the market's own implied range before the whole city is
 * REFUSED as a suspected data error rather than traded as an edge.
 *
 * Rationale (earned the hard way, 2026-07-13): every large model-vs-market disagreement tonight
 * was MY bug — a hand-guessed grid cell pointing inland of LAX, a forecast matched to the wrong
 * day. A liquid market with thousands of contracts of volume is not off by 10°F; my data pipeline
 * is. So a violent disagreement is treated as evidence against the MODEL, not against the market.
 * This guard makes the failure loud instead of profitable-looking.
 */
const SANITY_MAX_DEVIATION_F = Number(process.env.KALSHI_WEATHER_SANITY_F) || 8;

/** The market's own implied high, from the volume-weighted midpoint of its bucket mids. */
function marketImpliedHigh(markets: WeatherMarket[]): number | null {
  let num = 0, den = 0;
  for (const m of markets) {
    if (m.loF === null || m.hiF === null) continue;   // skip open-ended tails
    const mid = (m.loF + m.hiF) / 2;
    const p = (m.yesBid + m.yesAsk) / 2;              // implied probability of that bucket
    if (p <= 0) continue;
    num += mid * p;
    den += p;
  }
  return den > 0.3 ? num / den : null;                // need a real distribution, not one lonely bucket
}

/**
 * @description Refuse a city when the forecast is wildly inconsistent with the market's own
 * implied distribution — which, on this project's track record, means the data pipeline is broken.
 * @param markets - The city's buckets.
 * @param forecastF - NWS forecast high.
 * @returns A refusal reason, or null when the forecast is plausible.
 */
export function sanityCheck(markets: WeatherMarket[], forecastF: number): string | null {
  const implied = marketImpliedHigh(markets);
  if (implied === null) return null;
  const dev = Math.abs(forecastF - implied);
  if (dev > SANITY_MAX_DEVIATION_F) {
    return `forecast ${forecastF}°F deviates ${dev.toFixed(1)}°F from the market's implied ${implied.toFixed(1)}°F — refusing as a suspected data error (wrong station/grid/date), NOT trading it as edge`;
  }
  return null;
}

export function evaluateWeatherMarkets(
  markets: WeatherMarket[], forecastF: number, leadDays: number, model: ErrorModel, enso: EnsoState,
): WeatherPick[] {
  const insane = sanityCheck(markets, forecastF);
  if (insane) {
    log.error({ forecastF, seriesTicker: markets[0]?.seriesTicker, reason: insane }, 'weather sanity check FAILED — city refused');
    return [];
  }
  const rationale = {
    forecastF, leadDays, sigma: model.sigma, bias: model.bias,
    ensoPhase: enso.phase, oni: enso.oni,
    errorModelN: model.n, errorModelIsPrior: model.isPrior,
  };
  const picks: WeatherPick[] = [];
  for (const m of markets) {
    if (m.yesAsk <= 0 || m.noAsk <= 0) continue;
    const pYes = bucketProbability(m.loF, m.hiF, forecastF, model);
    for (const side of ['yes', 'no'] as const) {
      const price = side === 'yes' ? m.yesAsk : m.noAsk;
      if (price <= 0.01 || price >= 0.99) continue;
      const modelProb = side === 'yes' ? pYes : 1 - pYes;
      const fee = feePerContract(price, { feeType: 'quadratic', feeMultiplier: 1 });
      const edgeNet = modelProb - (price + fee);
      if (edgeNet < MIN_EDGE) continue;
      // THE REFUSAL RULE: an unmeasured σ may not size a bet, however good the edge looks.
      const effCost = price + fee;
      const b = (1 - effCost) / effCost;
      const kelly = b > 0 ? Math.max(0, (modelProb * b - (1 - modelProb)) / b) : 0;
      const stakeFraction = model.isPrior ? 0 : Math.min(MAX_STAKE_FRACTION, kelly * KELLY_FRACTION);
      picks.push({
        ticker: m.ticker, seriesTicker: m.seriesTicker, eventTicker: m.eventTicker, title: m.title,
        side, modelProb, marketProb: price, price, fee, edgeNet, stakeFraction,
        rationale, closeTime: m.closeTime,
      });
    }
  }
  picks.sort((a, b) => b.edgeNet - a.edgeNet);
  if (picks.length && model.isPrior) {
    log.warn({ n: model.n, sigma: model.sigma }, 'weather picks found but error model is still the PRIOR — reporting with ZERO stake until sigma is measured');
  }
  return picks;
}
