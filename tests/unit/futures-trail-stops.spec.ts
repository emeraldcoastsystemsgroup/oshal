/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 trail-stop ports: chandelier bands warmup/seed/ratchet/reset-on-violation, SuperTrend M11 prior-bar anchoring + close-flip + ratchet, Parabolic SAR seed/acceleration/reversal. NT8Custom parity semantics.
 */
import { describe, it, expect } from 'vitest';
import { chandelierBands, superTrendM11, parabolicSar, wilderAtr, movingMedian } from '../../src/features/trading';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

function bar(h: number, l: number, c: number, o = c): OhlcvBar {
  return { o, h, l, c, v: 1000 };
}

function uptrend(n: number, start = 100, step = 1): OhlcvBar[] {
  return Array.from({ length: n }, (_, i) => bar(start + i * step + 0.5, start + i * step - 0.5, start + i * step));
}

describe('chandelierBands — atcChandelierBands parity', () => {
  const opts = { period: 5, multiplier: 2, tickSize: 0.25 };

  it('emits the close during warmup and seeds extreme ∓ mult·ATR at bar == period', () => {
    const bars = uptrend(8);
    const { stopLong, stopShort, trend } = chandelierBands(bars, opts);
    for (let i = 0; i < 5; i++) {
      expect(stopLong[i]).toBe(bars[i].c);
      expect(stopShort[i]).toBe(bars[i].c);
      expect(trend[i]).toBe(0);
    }
    const atr = wilderAtr(bars, 5)[5];
    expect(stopLong[5]).toBeCloseTo(bars[5].h - 2 * Math.max(0.25, atr), 10);
    expect(stopShort[5]).toBeCloseTo(bars[5].l + 2 * Math.max(0.25, atr), 10);
  });

  it('ratchets the long stop up through a clean rise (never loosens)', () => {
    const { stopLong } = chandelierBands(uptrend(30), opts);
    for (let i = 7; i < 30; i++) expect(stopLong[i]).toBeGreaterThanOrEqual(stopLong[i - 1]);
  });

  it('RESETS the long stop below the violated low when the bar low breaches the prior stop', () => {
    const bars = uptrend(20);
    // A crash bar that trades through the prior long stop:
    const pre = chandelierBands(bars, opts);
    const priorStop = pre.stopLong[19];
    const crash = bar(119, priorStop - 5, priorStop - 4);
    const { stopLong } = chandelierBands([...bars, crash], opts);
    const atr = wilderAtr([...bars, crash], 5)[20];
    expect(stopLong[20]).toBeCloseTo(crash.l - 2 * Math.max(0.25, atr), 10);
    expect(stopLong[20]).toBeLessThan(priorStop);
  });

  it('trend flips −1 only when the close crosses the re-anchored long band (two-phase move)', () => {
    // Flat range → violent crash (resets the long band low, re-anchors the extreme to the crash
    // bar's high) → moderate follow-through that closes BELOW the re-anchored band without
    // violating it. A steady climb never crosses the short band, so trend carries 0 throughout it.
    const flat = Array.from({ length: 10 }, () => bar(100.5, 99.5, 100));
    const crash = bar(100.2, 95, 95.2);
    const follow = bar(95.5, 94.5, 94.6);
    const { trend } = chandelierBands([...flat, crash, follow], opts);
    expect(trend[9]).toBe(0); // flat range: neither band crossed
    expect(trend[10]).toBe(0); // crash bar violates → band resets BELOW the close → still carries
    expect(trend[11]).toBe(-1); // follow-through closes under the extreme-re-anchored band
  });
});

describe('superTrendM11 — atcSuperTrendM11 parity', () => {
  const opts = { basePeriod: 3, rangePeriod: 4, multiplier: 1.5, tickSize: 0.25 };

  it('computes bar-t stops from bar-(t−1) baseline and ATR (the [1]-anchoring)', () => {
    const bars = uptrend(10);
    const { stopDot, trend } = superTrendM11(bars, opts);
    const baseline = movingMedian(bars.map((b) => b.c), 3);
    const atr = wilderAtr(bars, 4);
    // Bar 9 in a persistent uptrend: stop = max over the ratchet, but the fresh proposal is
    // baseline[8] − 1.5·max(tick, atr[8]); the ratchet means stopDot[9] ≥ that proposal.
    const proposal = baseline[8] - 1.5 * Math.max(0.25, atr[8]);
    expect(trend[9]).toBe(1);
    expect(stopDot[9]).toBeGreaterThanOrEqual(proposal - 1e-9);
  });

  it('ratchets the active stop in a persistent trend', () => {
    const { stopDot, trend } = superTrendM11(uptrend(25), opts);
    for (let i = 6; i < 25; i++) {
      if (trend[i] === 1 && trend[i - 1] === 1 && !Number.isNaN(stopDot[i - 1])) {
        expect(stopDot[i]).toBeGreaterThanOrEqual(stopDot[i - 1] - 1e-9);
      }
    }
  });

  it('flips on a CLOSE through the active stop and re-anchors the other side', () => {
    const bars = uptrend(15);
    const pre = superTrendM11(bars, opts);
    const stop = pre.stopDot[14];
    const crash = bar(114.6, stop - 3, stop - 2.5);
    const { trend, stopDot } = superTrendM11([...bars, crash], opts);
    expect(pre.trend[14]).toBe(1);
    expect(trend[15]).toBe(-1);
    // After the flip the NEXT bar's active stop is the short side, above price.
    const next = bar(stop - 2, stop - 4, stop - 3);
    const post = superTrendM11([...bars, crash, next], opts);
    expect(post.trend[16]).toBe(-1);
    expect(post.stopDot[16]).toBeGreaterThan(next.c);
  });
});

describe('parabolicSar — atcParabolicSARCalc parity', () => {
  it('is NaN before bar 3 and seeds from the bar-1..3 extremes', () => {
    const bars = uptrend(4);
    const { psar, isLong } = parabolicSar(bars);
    expect(Number.isNaN(psar[0])).toBe(true);
    expect(Number.isNaN(psar[2])).toBe(true);
    // h3 > h2 → long. xp = max(h1..h3); seed = xp − (max(h1..h3) − min(l1..l3))·0.02
    const hi = Math.max(bars[1].h, bars[2].h, bars[3].h);
    const lo = Math.min(bars[1].l, bars[2].l, bars[3].l);
    expect(isLong[3]).toBe(true);
    expect(psar[3]).toBeCloseTo(hi - (hi - lo) * 0.02, 10);
  });

  it('trails below a rising market and accelerates toward price', () => {
    const bars = uptrend(30);
    const { psar, isLong } = parabolicSar(bars);
    // The source's seed parks SAR just under the HIGH extreme; the two-bar clamp pulls it to the
    // real trail on the next bar — monotonicity holds from bar 4 on, price-side from bar 4 too.
    for (let i = 4; i < 30; i++) {
      expect(isLong[i]).toBe(true);
      expect(psar[i]).toBeLessThan(bars[i].l);
      if (i > 4) expect(psar[i]).toBeGreaterThanOrEqual(psar[i - 1] - 1e-9); // monotone while long
    }
    // Acceleration: the per-bar SAR increment grows as AF ramps 0.02 → 0.2 (a constant-slope
    // trend converges to a FIXED step/AF gap, so the gap itself is not the acceleration signal)
    expect(psar[15] - psar[14]).toBeGreaterThan(psar[7] - psar[6]);
  });

  it('pins the SAR to the prior two bars’ lows (the x=1..2 clamp the first port dropped)', () => {
    // Accelerating trend: a raw SAR step that lands above the two-bars-ago low must be clamped
    // down to it — the source's second clamp loop, distinct from the TodaySAR helper.
    const bars = [
      bar(101, 99, 100), bar(102, 100, 101), bar(103, 101, 102), bar(104, 102, 103),
      bar(110, 104, 109), bar(118, 111, 117), bar(127, 119, 126), // fast expansion
    ];
    const { psar, isLong } = parabolicSar(bars);
    for (let i = 4; i < bars.length; i++) {
      expect(isLong[i]).toBe(true);
      expect(psar[i]).toBeLessThanOrEqual(bars[i - 1].l + 1e-9);
      expect(psar[i]).toBeLessThanOrEqual(bars[i - 2].l + 1e-9);
    }
  });

  it('reverses to the extreme when the low penetrates the SAR', () => {
    const bars = uptrend(20);
    const pre = parabolicSar(bars);
    const sar = pre.psar[19];
    const xpBefore = Math.max(...bars.map((b) => b.h));
    const crash = bar(119.4, sar - 2, sar - 1.5);
    const { psar, isLong } = parabolicSar([...bars, crash]);
    expect(isLong[20]).toBe(false);
    expect(psar[20]).toBeCloseTo(xpBefore, 10); // reversal emits the prior extreme
  });
});
