/**
 * Kalshi edge engine — unit tests for the money math (ADR-094).
 *
 * The evaluator sizes real stakes, so its arithmetic is pinned here without any network:
 * quadratic fee ceiling, calibration beta-shrinkage (no history ⇒ market price ⇒ fold by
 * construction), two-sided evaluation, Kelly sizing, and risk-flag stake discounts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — fee/calibration/evaluator invariants for the prediction-markets slice.
 */

import { describe, expect, it } from 'vitest';
import type { CalibrationSample, KalshiMarket, KalshiSeriesMeta } from '../../src/features/prediction-markets';
import {
  buildCalibrationTable, calibratedProb, effectiveCost, evaluateMarket, feePerContract, takerFee,
} from '../../src/features/prediction-markets';

const SERIES: KalshiSeriesMeta = { ticker: 'KXTEST', category: 'Sports', feeType: 'quadratic', feeMultiplier: 1, frequency: 'daily' };

function market(overrides: Partial<KalshiMarket>): KalshiMarket {
  return {
    ticker: 'KXTEST-26JUL13-X', eventTicker: 'KXTEST-26JUL13', seriesTicker: 'KXTEST',
    title: 'test market', status: 'open', result: '', yesBid: 0.55, yesAsk: 0.58,
    noBid: 0.42, noAsk: 0.45, lastPrice: 0.56, volume: 5000, liquidity: 20000, openInterest: 800,
    openTime: new Date('2026-07-01T00:00:00Z'), closeTime: new Date('2026-07-14T00:00:00Z'),
    isMultivariate: false, ...overrides,
  };
}

function samples(price: number, n: number, yesCount: number, horizon = 24, category = 'Sports'): CalibrationSample[] {
  return Array.from({ length: n }, (_, i) => ({
    ticker: `T${i}`, category, horizonHours: horizon, price, settledYes: i < yesCount,
  }));
}

describe('kalshi fee math', () => {
  it('charges the quadratic taker fee, ceiled to the cent on the fill', () => {
    // 100 contracts at 50¢: 0.07·100·0.25 = $1.75 exactly — no rounding needed.
    expect(takerFee(0.5, 100, SERIES)).toBeCloseTo(1.75, 10);
    // 1 contract at 50¢: $0.0175 → ceil to $0.02.
    expect(takerFee(0.5, 1, SERIES)).toBeCloseTo(0.02, 10);
    // Fee vanishes toward the extremes — the P·(1−P) term, not a flat rate.
    expect(feePerContract(0.02, SERIES)).toBeLessThan(feePerContract(0.5, SERIES));
  });

  it('applies the per-series fee multiplier and folds it into effective cost', () => {
    const doubled = { ...SERIES, feeMultiplier: 2 };
    expect(takerFee(0.5, 100, doubled)).toBeCloseTo(3.5, 10);
    // Per-contract basis is a conservative 10-lot clip: 0.07·10·0.25 = 17.5¢ → ceil 18¢ → 1.8¢/contract.
    expect(effectiveCost(0.5, SERIES)).toBeCloseTo(0.5 + 0.018, 10);
  });
});

describe('calibration shrinkage', () => {
  it('returns the market price itself when there is no history (zero edge by construction)', () => {
    const table = buildCalibrationTable([]);
    const { prob, n, confidence } = calibratedProb(table, 24, 'Sports', 0.62);
    expect(prob).toBe(0.62);
    expect(n).toBe(0);
    expect(confidence).toBe(0);
  });

  it('moves toward the empirical rate as evidence accumulates, but never fully ignores price', () => {
    // 200 observations at ~92¢ that ALL settled yes (a favorite-longshot pocket).
    const table = buildCalibrationTable(samples(0.92, 200, 200));
    const thick = calibratedProb(table, 24, 'Sports', 0.92);
    expect(thick.prob).toBeGreaterThan(0.92);           // pulled above price by the evidence
    expect(thick.prob).toBeLessThan(1.0);               // shrinkage keeps it honest
    // 10 observations, same rate: much weaker pull.
    const thin = calibratedProb(buildCalibrationTable(samples(0.92, 10, 10)), 24, 'Sports', 0.92);
    expect(thin.prob).toBeLessThan(thick.prob);
    expect(thin.confidence).toBeLessThan(thick.confidence);
  });

  it('falls back to the pooled bucket when the category bucket is thin', () => {
    const pooled = [...samples(0.3, 300, 30, 24, 'Economics'), ...samples(0.3, 5, 5, 24, 'Sports')];
    const table = buildCalibrationTable(pooled);
    // Sports has only 5 obs (< minCategoryN 40) → the pooled '*' bucket (305 obs) drives the estimate.
    const { n } = calibratedProb(table, 24, 'Sports', 0.3);
    expect(n).toBeGreaterThan(100);
  });
});

describe('bet evaluator', () => {
  it('folds a market whose price matches history (no edge after fees)', () => {
    // History says 56.5¢ mids settle YES ~56.5% — matches the book; fees make both sides -EV.
    const table = buildCalibrationTable(samples(0.565, 200, 113));
    const hand = evaluateMarket(market({}), SERIES, table, Date.parse('2026-07-13T06:00:00Z'));
    expect(hand).not.toBeNull();
    expect(hand!.strength).toBe('fold');
    expect(hand!.stakeFraction).toBe(0);
  });

  it('bets the side history favors, sized by Kelly and capped', () => {
    // 92¢ favorites settled 100% in 400 obs → strong YES edge on a 92¢ ask.
    const table = buildCalibrationTable(samples(0.925, 400, 400));
    const m = market({ yesBid: 0.92, yesAsk: 0.93, noBid: 0.07, noAsk: 0.08, lastPrice: 0.92 });
    const hand = evaluateMarket(m, SERIES, table, Date.parse('2026-07-13T06:00:00Z'));
    expect(hand).not.toBeNull();
    expect(hand!.side).toBe('yes');
    expect(hand!.edgeNet).toBeGreaterThan(0);
    expect(hand!.stakeFraction).toBeGreaterThan(0);
    expect(hand!.stakeFraction).toBeLessThanOrEqual(0.05);   // bankroll cap
    expect(hand!.strength).not.toBe('fold');
  });

  it('discounts the stake for risk flags rather than ignoring them', () => {
    // 97% settle rate (not 100%): a real but moderate edge, so the flagged hand's halvings
    // land BELOW the 5% cap instead of both hands clamping to it.
    const table = buildCalibrationTable(samples(0.925, 400, 388));
    const clean = evaluateMarket(
      market({ yesBid: 0.92, yesAsk: 0.93, noBid: 0.07, noAsk: 0.08 }), SERIES, table,
      Date.parse('2026-07-13T06:00:00Z'))!;
    const thin = evaluateMarket(
      market({ yesBid: 0.92, yesAsk: 0.93, noBid: 0.07, noAsk: 0.08, liquidity: 50, openInterest: 3 }),
      SERIES, table, Date.parse('2026-07-13T06:00:00Z'))!;
    expect(thin.riskFlags).toContain('thin-book');
    expect(thin.stakeFraction).toBeLessThan(clean.stakeFraction);
  });

  it('refuses multivariate legs and dead books', () => {
    const table = buildCalibrationTable(samples(0.5, 100, 50));
    expect(evaluateMarket(market({ isMultivariate: true }), SERIES, table)).toBeNull();
    expect(evaluateMarket(market({ yesAsk: 0, noAsk: 0 }), SERIES, table)).toBeNull();
  });
});
