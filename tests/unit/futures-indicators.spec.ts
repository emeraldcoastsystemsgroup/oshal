/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 indicator ports: Wilder ATR bar-0 seed + recursion, atcDMI warmups (TR passthrough, cumulative-avg DM) + trending behavior, Laguerre RSI zero-denominator rule / saturation / average seed, moving-median odd+even windows. Hand-computed fixtures, NT8Custom parity semantics.
 */
import { describe, it, expect } from 'vitest';
import { wilderAtr, dmiAdx, laguerreRsi, movingMedian } from '../../src/features/trading';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

function bar(h: number, l: number, c: number, o = c): OhlcvBar {
  return { o, h, l, c, v: 1000 };
}

/** A steady uptrend: each bar's high/low/close step up by 1. */
function uptrend(n: number, start = 100): OhlcvBar[] {
  return Array.from({ length: n }, (_, i) => bar(start + i + 0.5, start + i - 0.5, start + i));
}

describe('wilderAtr — atcATRCalc parity', () => {
  it('seeds bar 0 at high−low and applies the EMA(2p−1) ≡ 1/p recursion', () => {
    const bars = [bar(102, 100, 101), bar(104, 101, 103), bar(105, 102, 104)];
    const atr = wilderAtr(bars, 2);
    expect(atr[0]).toBe(2); // h−l
    // TR1 = max(104, 101) − min(101, 101) = 3; ATR1 = 3/2 + 2·(1/2) = 2.5
    expect(atr[1]).toBeCloseTo(2.5, 10);
    // TR2 = max(105, 103) − min(102, 103) = 3; ATR2 = 3/2 + 2.5/2 = 2.75
    expect(atr[2]).toBeCloseTo(2.75, 10);
  });

  it('uses the prior close in the true range (gap handling)', () => {
    const bars = [bar(102, 100, 101), bar(110, 108, 109)]; // gap up: TR = max(110,101) − min(108,101) = 9
    const atr = wilderAtr(bars, 14);
    expect(atr[1]).toBeCloseTo(9 / 14 + 2 * (13 / 14), 10);
  });

  it('returns empty on empty input', () => {
    expect(wilderAtr([], 14)).toEqual([]);
  });
});

describe('dmiAdx — atcDMI parity', () => {
  it('emits zeros at bar 0 (the source returns before computing)', () => {
    const { adx, plusDi, minusDi } = dmiAdx(uptrend(1));
    expect(adx[0]).toBe(0);
    expect(plusDi[0]).toBe(0);
    expect(minusDi[0]).toBe(0);
  });

  it('warms up with TR passthrough and the cumulative DM average (hand-checked at bar 1)', () => {
    const bars = [bar(102, 100, 101), bar(103.5, 100.5, 103)];
    const { plusDi, minusDi } = dmiAdx(bars, 14, 14);
    // up = 1.5, down = −0.5 → +DM = 1.5, −DM = 0. TR = max(1.5·2? ) → h−l = 3, |h−pc| = 2.5, |l−pc| = 0.5 → 3.
    // trur passthrough = 3 (bar 1 < diLength). smP = (0 + 1.5)/2 = 0.75 (cumulative over bars 0..1).
    expect(plusDi[1]).toBeCloseTo((100 * 0.75) / 3, 10);
    expect(minusDi[1]).toBe(0);
  });

  it('identifies a persistent uptrend: +DI leads and ADX rises above 25', () => {
    const { adx, plusDi, minusDi } = dmiAdx(uptrend(60));
    const last = 59;
    expect(plusDi[last]).toBeGreaterThan(minusDi[last]);
    expect(adx[last]).toBeGreaterThan(25);
    // A frictionless one-way trend has −DM = 0 every bar → DX = 100 → ADX saturates at 100
    expect(adx[last]).toBeCloseTo(100, 6);
  });

  it('mirrors for a downtrend: −DI leads', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(200 - i + 0.5, 200 - i - 0.5, 200 - i));
    const { plusDi, minusDi } = dmiAdx(bars);
    expect(minusDi[39]).toBeGreaterThan(plusDi[39]);
  });
});

describe('laguerreRsi — atcLaguerreRSICalc parity', () => {
  it('bar 0 emits laRsi 0 and average 50', () => {
    const { laRsi, average } = laguerreRsi([100]);
    expect(laRsi[0]).toBe(0);
    expect(average[0]).toBe(50);
  });

  it('constant input hits the zero-denominator rule: laRsi stays 0', () => {
    const { laRsi } = laguerreRsi(Array(20).fill(100));
    expect(laRsi.every((v) => v === 0)).toBe(true);
  });

  it('saturates at 100 in a persistent rise and 0 in a persistent fall', () => {
    const rising = laguerreRsi(Array.from({ length: 30 }, (_, i) => 100 + i));
    expect(rising.laRsi[29]).toBeCloseTo(100, 6);
    const falling = laguerreRsi(Array.from({ length: 30 }, (_, i) => 200 - i));
    expect(falling.laRsi[29]).toBeCloseTo(0, 6);
  });

  it('the trader’s 80-threshold scale is native 0–100', () => {
    const { laRsi } = laguerreRsi(Array.from({ length: 30 }, (_, i) => 100 + i));
    expect(Math.max(...laRsi)).toBeLessThanOrEqual(100);
    expect(Math.min(...laRsi)).toBeGreaterThanOrEqual(0);
  });

  it('seeds the average line from 50 with k = 2/(1+smoothingPeriod)', () => {
    const { laRsi, average } = laguerreRsi([100, 110], 0.5, 7);
    const k = 2 / (1 + 7);
    expect(average[1]).toBeCloseTo(k * laRsi[1] + (1 - k) * 50, 10);
  });

  it('clamps alpha into [0, 1]', () => {
    expect(() => laguerreRsi([1, 2, 3], 5)).not.toThrow();
    const { laRsi } = laguerreRsi([1, 2, 3, 4], 5);
    expect(laRsi.every((v) => v >= 0 && v <= 100)).toBe(true);
  });
});

describe('movingMedian — amaMovingMedian parity', () => {
  it('handles the growing warmup window then the fixed period', () => {
    const out = movingMedian([5, 1, 4, 2, 3], 3);
    expect(out[0]).toBe(5); // window [5]
    expect(out[1]).toBe(3); // window [5,1] even → (1+5)/2
    expect(out[2]).toBe(4); // window [5,1,4] → 4
    expect(out[3]).toBe(2); // window [1,4,2] → 2
    expect(out[4]).toBe(3); // window [4,2,3] → 3
  });

  it('averages the middle pair on even periods', () => {
    const out = movingMedian([1, 2, 3, 4], 4);
    expect(out[3]).toBe(2.5);
  });
});
