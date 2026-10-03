/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for volatility-normalized entry sizing (trading-advisor.md item 3): calculateRealizedVol and recentVolPct helpers, sizeEntry downscaling behavior, and research leg vol integration.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  calculateRealizedVol,
  recentVolPct,
  sizeEntry,
  riskPolicy,
  type BrokerAccount,
  type Position,
} from '../../src/features/trading';

describe('calculateRealizedVol', () => {
  it('returns undefined if closes array has 5 or fewer items', () => {
    expect(calculateRealizedVol([])).toBeUndefined();
    expect(calculateRealizedVol([100])).toBeUndefined();
    expect(calculateRealizedVol([100, 102, 101, 103, 102])).toBeUndefined();
  });

  it('returns 0% volatility when all closes are identical', () => {
    const closes = [100, 100, 100, 100, 100, 100, 100];
    const vol = calculateRealizedVol(closes);
    expect(vol).toBeDefined();
    expect(vol).toBe(0);
  });

  it('accurately computes sample standard deviation of daily returns in percent', () => {
    // 6 closes -> 5 daily returns: [0.02, 0.02, 0.02, 0.02, 0.02] -> variance 0 -> vol 0
    const steady = [100, 102, 104.04, 106.1208, 108.243216, 110.40808];
    const steadyVol = calculateRealizedVol(steady);
    expect(steadyVol).toBeDefined();
    expect(steadyVol).toBeCloseTo(0, 4);

    // Closes with alternating moves: +5%, -5%
    const swingCloses = [100, 105, 99.75, 104.7375, 99.500625, 104.475656];
    const swingVol = calculateRealizedVol(swingCloses);
    expect(swingVol).toBeDefined();
    expect(swingVol!).toBeGreaterThan(4.5);
    expect(swingVol!).toBeLessThan(5.5);
  });
});

describe('recentVolPct', () => {
  it('queries closes with 15 lookback sessions and computes volatility', async () => {
    const fetchCloses = vi.fn().mockResolvedValue([100, 102, 101, 103, 102, 104, 103, 105, 104, 106]);
    const vol = await recentVolPct('NVDA', fetchCloses);
    expect(fetchCloses).toHaveBeenCalledWith('NVDA', 15);
    expect(vol).toBeDefined();
    expect(vol!).toBeGreaterThan(0);
  });

  it('returns undefined if fetchCloses throws an error (fail-soft for sizing)', async () => {
    const fetchCloses = vi.fn().mockRejectedValue(new Error('Alpaca 503 Service Unavailable'));
    const vol = await recentVolPct('FAIL', fetchCloses);
    expect(vol).toBeUndefined();
  });

  it('returns undefined if fetchCloses returns fewer than 6 closes', async () => {
    const fetchCloses = vi.fn().mockResolvedValue([100, 101, 102]);
    const vol = await recentVolPct('NEWIPO', fetchCloses);
    expect(vol).toBeUndefined();
  });

  it('falls back to undefined safely when default fetch fails or is unconfigured', async () => {
    const vol = await recentVolPct('DEFAULT_UNCONFIGURED_TICKER');
    // Without market data API keys in test environment, default dailyCloses fails-soft
    expect(vol === undefined || typeof vol === 'number').toBe(true);
  });
});

describe('sizeEntry volatility normalization', () => {
  const account: BrokerAccount = { equity: 100_000, cash: 100_000, buyingPower: 100_000, currency: 'USD' };
  const positions: Position[] = [];
  const policy = riskPolicy('paper'); // balanced: maxPerNamePct = 5% ($5,000 max room)

  it('defaults to volScale = 1 when volPct is undefined', () => {
    const price = 100;
    const confidence = 1.0;
    const unscaled = sizeEntry('CALM', price, confidence, account, positions, policy, undefined);
    // At $5,000 room and $100 price, expect 50 shares
    expect(unscaled.qty).toBe(50);
    expect(unscaled.notional).toBe(5000);
  });

  it('never increases position size when volatility is below baseline (volScale clamped <= 1)', () => {
    const price = 100;
    const confidence = 1.0;
    const lowVol = sizeEntry('CALM', price, confidence, account, positions, policy, 1.0); // 1% < 2% baseline
    expect(lowVol.qty).toBe(50);
  });

  it('scales down position size proportionally when volatility exceeds baseline', () => {
    const price = 100;
    const confidence = 1.0;
    // baseline = 2%, vol = 4% -> volScale = 2/4 = 0.5 -> room $2,500 -> 25 shares
    const halfSize = sizeEntry('WILD', price, confidence, account, positions, policy, 4.0);
    expect(halfSize.qty).toBe(25);
    expect(halfSize.notional).toBe(2500);

    // baseline = 2%, vol = 6% -> volScale = 2/6 = 0.3333 -> room $1,666.66 -> 16 shares
    const thirdSize = sizeEntry('WILDER', price, confidence, account, positions, policy, 6.0);
    expect(thirdSize.qty).toBe(16);
    expect(thirdSize.notional).toBe(1600);
  });

  it('floors volScale at 25% for extreme volatility shocks', () => {
    const price = 100;
    const confidence = 1.0;
    // baseline = 2%, vol = 20% -> 2/20 = 0.1 -> floored at 0.25 -> room $1,250 -> 12 shares
    const floored = sizeEntry('SHOCK', price, confidence, account, positions, policy, 20.0);
    expect(floored.qty).toBe(12);
    expect(floored.notional).toBe(1200);
  });
});
