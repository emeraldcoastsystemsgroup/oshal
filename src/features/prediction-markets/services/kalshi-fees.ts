/**
 * Kalshi fee math — the house edge every indicator must clear before a bet is real.
 *
 * Kalshi's standard trading fee is quadratic in price: fee = ceil_cents(0.07 · mult · C · P · (1−P))
 * per fill, charged to the taker (maker fees are 0 on standard series). The per-series fee model
 * (`fee_type`, `fee_multiplier`) comes from the series endpoint, NOT a hardcoded schedule, so new
 * fee experiments by the exchange flow through automatically. P·(1−P) peaks at 50¢ — mid-priced
 * contracts cost ~1.75¢/contract, extreme prices near 0.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — quadratic taker fee (ceil to the cent, per-series multiplier) + effective entry cost helper used by the bet evaluator.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | feePerContract basis 100→10 contracts (adversarial review): thin books fill small clips, and the 100-lot basis understated ceil-to-cent rounding ~3× at extreme prices where the marginal edges live.
 *
 * @module prediction-markets/kalshi-fees
 */

import type { KalshiSeriesMeta } from '../types';

/** Kalshi's standard quadratic fee rate (7% of price variance). */
const QUADRATIC_RATE = 0.07;

/**
 * @description Taker fee in dollars for a fill of `contracts` at `price`, under the series' fee
 * model. Quadratic (the exchange default): ceil-to-the-cent of 0.07·mult·C·P·(1−P). Unknown fee
 * types fall back to quadratic — overestimating a fee is safer than underestimating an edge.
 * @param price - Fill price in dollars (0..1).
 * @param contracts - Number of contracts in the fill.
 * @param series - Series fee metadata (fee_type + fee_multiplier).
 * @returns Fee in dollars for the whole fill.
 */
export function takerFee(price: number, contracts: number, series: Pick<KalshiSeriesMeta, 'feeType' | 'feeMultiplier'>): number {
  const mult = series.feeMultiplier > 0 ? series.feeMultiplier : 1;
  const raw = QUADRATIC_RATE * mult * contracts * price * (1 - price);
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

/**
 * @description Per-contract fee at a price — the marginal cost the edge must beat. Computed on a
 * 10-contract clip then divided: thin Kalshi books frequently fill 1-25 contracts, and the
 * 100-lot basis understated the ceil-to-cent rounding ~3× at extreme prices — exactly where the
 * sub-2¢ "edges" live (adversarial review 2026-07-13). Conservative by construction.
 * @param price - Fill price in dollars.
 * @param series - Series fee metadata.
 * @returns Fee per contract, dollars.
 */
export function feePerContract(price: number, series: Pick<KalshiSeriesMeta, 'feeType' | 'feeMultiplier'>): number {
  return takerFee(price, 10, series) / 10;
}

/**
 * @description Effective cost to enter one contract at `price` including the taker fee — the
 * number a true-probability estimate must exceed for a bet to be +EV.
 * @param price - Ask price in dollars.
 * @param series - Series fee metadata.
 * @returns Price + per-contract fee, dollars.
 */
export function effectiveCost(price: number, series: Pick<KalshiSeriesMeta, 'feeType' | 'feeMultiplier'>): number {
  return price + feePerContract(price, series);
}
