/**
 * Futures trail-stop indicators — ADR-116 stop-stack port, part 2 of 3.
 *
 * The three Layer-1 base-trail candidates the trader's system selects between, ported faithfully
 * from NT8Custom: the dual chandelier bands (atcChandelierBands.cs — the reset-on-violation trail
 * the CURRENT strategy generation consumes), the median-anchored SuperTrend (atcSuperTrendM11.cs —
 * the initial-stop candidate + older-generation trail), and the Parabolic SAR
 * (atcParabolicSARCalc.cs — the other initial-stop candidate). All three are strategy-agnostic
 * level generators; breakeven gating, multiplier switching, and the Strangle latch live in
 * futures-stop-engine.ts, exactly as they live at strategy level (not indicator level) in the
 * NT8 original.
 *
 * Indexing fidelity note (backtest parity): SuperTrend M11 computes bar-t stops from bar-(t−1)
 * baseline/ATR (NT8 IsFirstTickOfBar semantics), while the chandelier bands use bar-t OnBarClose
 * values. That [1]-vs-[0] split is deliberate in the source — preserved here, do not normalize.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — chandelierBands (dual reset-on-violation trail, ATR floored at tick, seed at bar==period), superTrendM11 (moving-median ± mult·ATR(range) from prior-bar values, close-flip, cross-side ratchet continuity), parabolicSar (bar-3 seed, one-AF-increase-per-bar, two-bar clamp, penetration reversal). Ported from NT8Custom for the ADR-116 stop engine.
 *
 * @module futures-trail-stops
 */

import type { OhlcvBar } from './market-data';
import { wilderAtr, movingMedian } from './futures-indicators';

/** Chandelier bands output, index-aligned with bars. */
export interface ChandelierBandsSeries {
  /** Long-side trail (stop for a long position). NaN-free: pre-warmup bars emit the close. */
  stopLong: number[];
  /** Short-side trail (stop for a short position). */
  stopShort: number[];
  /** +1 above the short band, −1 below the long band, else the prior value (0 during warmup). */
  trend: number[];
}

/** Options for {@link chandelierBands}; defaults match atcChandelierBands.cs SetDefaults. */
export interface ChandelierBandsOptions {
  /** Extreme/ATR lookback (default 22). */
  period?: number;
  /** ATR multiplier (default 3.0; the strategy's TsAtrMultiplier=2.0 overrides per instance). */
  multiplier?: number;
  /** Ratchet anchors use high/low when true, close when false (default true). */
  useHighLow?: boolean;
  /** Instrument tick size — the ATR floor (default 0.25, the ES tick). */
  tickSize?: number;
}

/**
 * @description Dual chandelier bands exactly as atcChandelierBands.cs (trailing mode) computes
 * them. Warmup (< period bars): both stops emit the close, trend 0. Seed at bar == period:
 * extremes = the bar's anchors, stops = extreme ∓ mult·ATR. After: the long stop ratchets up from
 * the high-extreme-since-reset and, when the bar's LOW violates the prior stop, RESETS to
 * violated-low − mult·ATR (mirrored short side). ATR is the Wilder-mode ATR floored at one tick.
 * This is the band the current strategy generation trails on — the stop engine's breakeven gate
 * reads stopLong/stopShort from here.
 * @param bars - Ascending OHLCV bars.
 * @param opts - Period/multiplier/anchor/tick options.
 * @returns stopLong / stopShort / trend series, index-aligned with bars.
 */
export function chandelierBands(bars: OhlcvBar[], opts: ChandelierBandsOptions = {}): ChandelierBandsSeries {
  const period = opts.period ?? 22;
  const multiplier = opts.multiplier ?? 3.0;
  const useHighLow = opts.useHighLow ?? true;
  const tickSize = opts.tickSize ?? 0.25;
  const atrSeries = wilderAtr(bars, period);
  const stopLong: number[] = []; const stopShort: number[] = []; const trend: number[] = [];
  let longExtreme = 0; let shortExtreme = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i < period) {
      stopLong.push(b.c); stopShort.push(b.c); trend.push(0);
      continue;
    }
    const trailAmount = multiplier * Math.max(tickSize, atrSeries[i]);
    const highAnchor = useHighLow ? b.h : b.c;
    const lowAnchor = useHighLow ? b.l : b.c;
    if (i === period) {
      longExtreme = highAnchor; shortExtreme = lowAnchor;
      stopLong.push(longExtreme - trailAmount);
      stopShort.push(shortExtreme + trailAmount);
    } else {
      if (b.l <= stopLong[i - 1]) {
        stopLong.push(b.l - trailAmount);
        longExtreme = highAnchor;
      } else {
        longExtreme = Math.max(longExtreme, highAnchor);
        stopLong.push(Math.max(stopLong[i - 1], longExtreme - trailAmount));
      }
      if (b.h >= stopShort[i - 1]) {
        stopShort.push(b.h + trailAmount);
        shortExtreme = lowAnchor;
      } else {
        shortExtreme = Math.min(shortExtreme, lowAnchor);
        stopShort.push(Math.min(stopShort[i - 1], shortExtreme + trailAmount));
      }
    }
    trend.push(b.c > stopShort[i] ? 1 : b.c < stopLong[i] ? -1 : trend[i - 1]);
  }
  return { stopLong, stopShort, trend };
}

/** SuperTrend M11 output, index-aligned with bars. */
export interface SuperTrendM11Series {
  /** The active-side stop (long stop in an uptrend, short stop in a downtrend) — the "StopDot". */
  stopDot: number[];
  /** +1 uptrend / −1 downtrend (OnBarClose confirmed trend). Bars 0–1 emit +1 per the source. */
  trend: number[];
}

/** Options for {@link superTrendM11}; defaults match atcSuperTrendM11.cs SetDefaults. */
export interface SuperTrendM11Options {
  /** Moving-median baseline period (default 8). */
  basePeriod?: number;
  /** ATR period for the offset (default 15). */
  rangePeriod?: number;
  /** ATR multiplier (default 2.5). */
  multiplier?: number;
  /** Instrument tick size — the offset floor (default 0.25). */
  tickSize?: number;
}

/**
 * @description Median-anchored SuperTrend exactly as atcSuperTrendM11.cs (OnBarClose,
 * reverseIntraBar=false) computes it: bar-t trail = movingMedian(close, base)[t−1] ± mult ·
 * max(tick, wilderAtr(range)[t−1]); the active side ratchets (long stop never falls in a
 * continuing uptrend), the opposite side re-anchors every bar; on a flip the ratchet CONTINUES
 * from the prior bar's opposite-side value (the Values[2] continuity in the source); the trend
 * flips when the CLOSE crosses the active stop. Bars 0–1 seed trend +1 with the bar-1 stops from
 * bar-0 values. The stop engine's initial-stop resolver reads stopDot + trend from here.
 * @param bars - Ascending OHLCV bars.
 * @param opts - Base/range/multiplier/tick options.
 * @returns stopDot / trend series, index-aligned with bars.
 */
export function superTrendM11(bars: OhlcvBar[], opts: SuperTrendM11Options = {}): SuperTrendM11Series {
  const basePeriod = opts.basePeriod ?? 8;
  const rangePeriod = opts.rangePeriod ?? 15;
  const multiplier = opts.multiplier ?? 2.5;
  const tickSize = opts.tickSize ?? 0.25;
  const baseline = movingMedian(bars.map((b) => b.c), basePeriod);
  const atrSeries = wilderAtr(bars, rangePeriod);
  const stopDot: number[] = []; const trend: number[] = [];
  const curLong: number[] = []; const curShort: number[] = []; const otherSide: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 2) {
      trend.push(1);
      if (i === 0) { curLong.push(NaN); curShort.push(NaN); }
      else {
        const trail = multiplier * Math.max(tickSize, atrSeries[0]);
        curLong.push(baseline[0] - trail); curShort.push(baseline[0] + trail);
      }
      stopDot.push(NaN); otherSide.push(NaN);
      continue;
    }
    const median = baseline[i - 1];
    const trail = multiplier * Math.max(tickSize, atrSeries[i - 1]);
    let long: number; let short: number;
    if (trend[i - 1] > 0.5) {
      short = median + trail;
      const carry = trend[i - 2] > 0.5 ? curLong[i - 1] : otherSide[i - 1];
      long = Math.max(Number.isNaN(carry) ? -Infinity : carry, median - trail);
      stopDot.push(long); otherSide.push(short);
    } else {
      long = median - trail;
      const carry = trend[i - 2] < -0.5 ? curShort[i - 1] : otherSide[i - 1];
      short = Math.min(Number.isNaN(carry) ? Infinity : carry, median + trail);
      stopDot.push(short); otherSide.push(long);
    }
    curLong.push(long); curShort.push(short);
    if (trend[i - 1] > 0.5 && bars[i].c < long) trend.push(-1);
    else if (trend[i - 1] < -0.5 && bars[i].c > short) trend.push(1);
    else trend.push(trend[i - 1]);
  }
  return { stopDot, trend };
}

/** Parabolic SAR output, index-aligned with bars. */
export interface ParabolicSarSeries {
  /** SAR level per bar (NaN before bar 3, matching the source's warmup). */
  psar: number[];
  /** True while the SAR regime is bullish (SAR below price). */
  isLong: boolean[];
}

/** Options for {@link parabolicSar}; defaults match the NT8 SAR trio. */
export interface ParabolicSarOptions {
  /** Initial acceleration factor (default 0.02). */
  acceleration?: number;
  /** AF increment per new extreme (default 0.02). */
  accelerationStep?: number;
  /** AF cap (default 0.2). */
  accelerationMax?: number;
}

/** Clamp today's SAR outside the prior two bars' range (the source's TodaySAR rule). */
function clampSar(sar: number, bars: OhlcvBar[], i: number, long: boolean): number {
  if (long) {
    const lowest = Math.min(sar, bars[i].l, bars[i - 1].l);
    return bars[i].l > lowest ? lowest : sar;
  }
  const highest = Math.max(sar, bars[i].h, bars[i - 1].h);
  return bars[i].h < highest ? highest : sar;
}

/**
 * @description Parabolic SAR exactly as atcParabolicSARCalc.cs computes it on completed bars:
 * seeded at bar 3 (direction from h₃>h₂, extreme over bars 1–3), SAR stepped by
 * SAR + AF·(xp − SAR) with the two-prior-bars clamp, AF raised once per bar on a new extreme,
 * and a reversal to xp when the current or prior bar penetrates today's SAR. The initial-stop
 * resolver reads psar + isLong from here ("PSAR bullish below the entry bar's low").
 * @param bars - Ascending OHLCV bars.
 * @param opts - Acceleration options.
 * @returns psar / isLong series, index-aligned with bars (NaN / prevailing direction before bar 3).
 */
export function parabolicSar(bars: OhlcvBar[], opts: ParabolicSarOptions = {}): ParabolicSarSeries {
  const accel = opts.acceleration ?? 0.02;
  const step = opts.accelerationStep ?? 0.02;
  const cap = opts.accelerationMax ?? 0.2;
  const psar: number[] = []; const isLong: boolean[] = [];
  let long = true; let xp = 0; let af = accel; let prevSar = NaN;
  for (let i = 0; i < bars.length; i++) {
    if (i < 3) { psar.push(NaN); isLong.push(true); continue; }
    if (i === 3) {
      long = bars[3].h > bars[2].h;
      const hi = Math.max(bars[1].h, bars[2].h, bars[3].h);
      const lo = Math.min(bars[1].l, bars[2].l, bars[3].l);
      xp = long ? hi : lo;
      af = accel;
      prevSar = xp + (long ? -1 : 1) * (hi - lo) * af;
      psar.push(prevSar); isLong.push(long);
      continue;
    }
    let today = clampSar(prevSar + af * (xp - prevSar), bars, i, long);
    // The source's second clamp: SAR may not sit inside the PRIOR TWO bars' ranges (the x=1..2 loop).
    for (let x = 1; x <= 2; x++) {
      if (long) { if (today > bars[i - x].l) today = bars[i - x].l; }
      else if (today < bars[i - x].h) today = bars[i - x].h;
    }
    let out = today; prevSar = today;
    if (long) {
      if (bars[i].h > xp) { xp = bars[i].h; af = Math.min(cap, af + step); }
    } else if (bars[i].l < xp) { xp = bars[i].l; af = Math.min(cap, af + step); }
    const penetrated = long
      ? bars[i].l < today || bars[i - 1].l < today
      : bars[i].h > today || bars[i - 1].h > today;
    if (penetrated) {
      // Reverse to the extreme (source Reverse(): flip, AF reset, xp re-anchors to the bar's extreme).
      out = xp;
      long = !long;
      af = accel;
      xp = long ? bars[i].h : bars[i].l;
      prevSar = out;
    }
    psar.push(out); isLong.push(long);
  }
  return { psar, isLong };
}
