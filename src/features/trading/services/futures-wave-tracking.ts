/**
 * Futures wave tracking — ADR-116 entry port, part 2 of 3.
 *
 * The wave-cycle family from NT8Custom: a shared two-line cross machine (verbatim-identical in
 * atcMACDCalc.cs, atcDMCalc.cs, atcEhlersInstTrendCalc.cs) that freezes each completed opposite
 * wave's extreme — the LastBearWaveLow / LastBullWaveHigh candidates the newest-generation
 * initial stop consumes — plus the Laguerre wave stops (atcLaguerreWaveStopsCalc.cs), whose
 * zero-cross cycle segmentation yields the non-monotone stop and the HL/HH-style wave patterns
 * the older generation grades as an entry state.
 *
 * Fidelity notes carried from the sources (do not "fix"):
 *  - Unwritten NT series slots read 0.0 — the MACD signal EMA is genuinely seeded at 0 over a
 *    series that is 0 until bar `slow`, and the Ehlers tracker fires a guaranteed bullish cross
 *    at bar 2 (prior plot slots read 0) so it ALWAYS opens in a bull wave on positive prices.
 *  - The cross bar belongs to the NEW wave only: excluded from the ending wave's extreme, seeds
 *    the new wave's extreme.
 *  - Laguerre wave stops RE-BASE at each transition — deliberately not monotone — and the first
 *    trend's stop is NaN for its entire duration. The spurious NHH flag during the first bull
 *    trend (currLagHH inherits bar-0's 0.0) is real source behavior, ported as-is.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — shared wave-cycle machine, macdWave (0-seeded signal EMA, waves from bar slow+1), dmiWave (DI-line crosses from bar diLength+1 over the atc DMI warmups), ehlersInstTrendWave (median-price WMA seed → Ehlers IIR, bar-2 spurious bull cross), laguerreWaveStops (zero-cross cycles, re-basing stop, LL/HL/HH/LH patterns + NHH/NLL overwrites). Ported from NT8Custom for the ADR-116 entry evaluator + wave initial-stop candidates.
 *
 * @module futures-wave-tracking
 */

import type { OhlcvBar } from './market-data';
import { dmiAdx } from './futures-indicators';
import { laguerreOscillator } from './futures-entry-indicators';

/** Per-bar wave-tracker output: regime flags + the frozen opposite-wave extremes. */
export interface WaveSeries {
  /** fast > slow at this bar (strict; both flags false on equality and during warmup). */
  isBullish: boolean[];
  /** fast < slow at this bar. */
  isBearish: boolean[];
  /** Lowest low of the most recently COMPLETED bear wave (NaN until the first completes). */
  lastBearWaveLow: number[];
  /** Highest high of the most recently COMPLETED bull wave. */
  lastBullWaveHigh: number[];
  /** The fast line (MACD line / +DI / Trigger) for consumers that need it. */
  fast: number[];
  /** The slow line (signal / −DI / ITrend). */
  slow: number[];
}

/**
 * The shared machine: given fast/slow lines and a first bar where crosses may fire, produce the
 * wave series. `crossFrom` = the first bar index allowed to evaluate crosses (its [i−1] reads
 * must be meaningful per each source's gate); `flagFrom` = first bar the regime flags publish.
 */
function runWaveMachine(bars: OhlcvBar[], fast: number[], slow: number[], flagFrom: number, crossFrom: number): WaveSeries {
  const n = bars.length;
  const isBullish = new Array<boolean>(n).fill(false);
  const isBearish = new Array<boolean>(n).fill(false);
  const lastBearWaveLow = new Array<number>(n).fill(NaN);
  const lastBullWaveHigh = new Array<number>(n).fill(NaN);
  let inBull = false; let inBear = false;
  let curBullHigh = NaN; let curBearLow = NaN;
  let lastBearLow = NaN; let lastBullHigh = NaN;
  for (let i = 0; i < n; i++) {
    if (i >= flagFrom) {
      isBullish[i] = fast[i] > slow[i];
      isBearish[i] = fast[i] < slow[i];
    }
    if (i >= crossFrom) {
      const bullishCross = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
      const bearishCross = !bullishCross && fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
      if (bullishCross) {
        if (inBear) { lastBearLow = curBearLow; inBear = false; curBearLow = NaN; }
        if (!inBull) { inBull = true; curBullHigh = bars[i].h; }
      } else if (bearishCross) {
        if (inBull) { lastBullHigh = curBullHigh; inBull = false; curBullHigh = NaN; }
        if (!inBear) { inBear = true; curBearLow = bars[i].l; }
      }
      if (inBull) curBullHigh = Math.max(curBullHigh, bars[i].h);
      if (inBear) curBearLow = Math.min(curBearLow, bars[i].l);
    }
    lastBearWaveLow[i] = lastBearLow;
    lastBullWaveHigh[i] = lastBullHigh;
  }
  return { isBullish, isBearish, lastBearWaveLow, lastBullWaveHigh, fast, slow };
}

/** NT8 EMA over a raw array: seeded at value[0], k = 2/(1+n). */
function nt8Ema(values: number[], n: number): number[] {
  const k = 2 / (1 + n);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) out.push(i === 0 ? values[i] : k * values[i] + (1 - k) * out[i - 1]);
  return out;
}

/**
 * @description MACD wave tracker exactly as atcMACDCalc.cs computes it: NT8-seeded EMAs on the
 * closes from bar 0; the MACD series is 0 for bars < slow (unwritten slots), and the signal EMA
 * runs over THAT series from bar 0 seeded at 0 — so signal[slow] = k·macd[slow], decaying the
 * zero contamination over the following bars. Regime flags publish from bar `slow`; crosses and
 * waves run from bar `slow`+1. Wave extremes use the bars' high/low.
 * @param bars - Ascending OHLCV bars.
 * @param fast - Fast EMA period (12). @param slow - Slow EMA period (26). @param smooth - Signal period (9).
 * @returns Wave series (fast = MACD line, slow = signal).
 */
export function macdWave(bars: OhlcvBar[], fast = 12, slow = 26, smooth = 9): WaveSeries {
  const closes = bars.map((b) => b.c);
  const fastEma = nt8Ema(closes, fast);
  const slowEma = nt8Ema(closes, slow);
  const macdSeries = closes.map((_, i) => (i < slow ? 0 : fastEma[i] - slowEma[i]));
  // Signal EMA over macdSeries seeded at 0 (macdSeries[0] = 0) — the source's unwritten-slot artifact.
  const signal = nt8Ema(macdSeries, smooth);
  return runWaveMachine(bars, macdSeries, signal, slow, slow + 1);
}

/**
 * @description DMI wave tracker exactly as atcDMCalc.cs computes it. The DI/ADX math is the same
 * three-phase-warmup engine as atcDMI (shared here via dmiAdx — TR passthrough below diLength,
 * cumulative-average DM warmup, SMA-seeded carry at the boundary), with the wave machine on the
 * DI pair: fast = +DI, slow = −DI, flags and crosses from bar diLength+1 (the source publishes
 * false/false through bar `diLength` inclusive).
 * @param bars - Ascending OHLCV bars.
 * @param diLength - DI smoothing (14). @param adxPeriod - ADX smoothing (14, exposed not wave-relevant).
 * @returns Wave series plus the adx array on the side.
 */
export function dmiWave(bars: OhlcvBar[], diLength = 14, adxPeriod = 14): WaveSeries & { adx: number[] } {
  const { adx, plusDi, minusDi } = dmiAdx(bars, diLength, adxPeriod);
  const wave = runWaveMachine(bars, plusDi, minusDi, diLength + 1, diLength + 1);
  return { ...wave, adx };
}

/**
 * @description Ehlers Instantaneous Trendline wave tracker exactly as atcEhlersInstTrendCalc.cs
 * computes it: source = median price (H+L)/2; itrend = WMA-ish seed (src + 2·src1 + src2)/4 for
 * bars 2–6, the Ehlers IIR from bar 7; trigger = 2·itrend − itrend[2 bars ago]. Prior plot slots
 * read 0 at bar 2, so a bullish cross fires there for any positive-priced series — the tracker
 * ALWAYS opens in a bull wave seeded at bar 2's high. Flags and waves run from bar 2.
 * @param bars - Ascending OHLCV bars.
 * @param alpha - Ehlers alpha (0.07).
 * @returns Wave series (fast = Trigger, slow = ITrend).
 */
export function ehlersInstTrendWave(bars: OhlcvBar[], alpha = 0.07): WaveSeries {
  const n = bars.length;
  const itrend = new Array<number>(n).fill(0);
  const trigger = new Array<number>(n).fill(0);
  const a = alpha;
  for (let i = 2; i < n; i++) {
    const src = (bars[i].h + bars[i].l) / 2;
    const src1 = (bars[i - 1].h + bars[i - 1].l) / 2;
    const src2 = (bars[i - 2].h + bars[i - 2].l) / 2;
    itrend[i] = i < 7
      ? (src + 2 * src1 + src2) / 4
      : (a - (a * a) / 4) * src + 0.5 * a * a * src1 - (a - 0.75 * a * a) * src2
        + 2 * (1 - a) * itrend[i - 1] - (1 - a) * (1 - a) * itrend[i - 2];
    trigger[i] = 2 * itrend[i] - itrend[i - 2];
  }
  return runWaveMachine(bars, trigger, itrend, 2, 2);
}

/** Wave-pattern codes as atcLaguerreWaveStopsCalc.cs defines them (NHL/NLH exist but are never produced). */
export enum WavePattern { None = 0, LL = 1, HL = 2, HH = 3, LH = 4, NHH = 5, NLL = 6, NHL = 7, NLH = 8 }

/** Laguerre wave stops output, index-aligned with bars. */
export interface LaguerreWaveStopsSeries {
  /** The re-basing cycle stop (NaN through the entire first trend). */
  stop: number[];
  /** Bull-side pattern series (LL/HL + the spurious-by-design NLL overwrite). */
  bullWavePat: WavePattern[];
  /** Bear-side pattern series (HH/LH + NHH). */
  bearWavePat: WavePattern[];
}

/** Options for {@link laguerreWaveStops}; strategy-effective 30 / 0.5 / 100. */
export interface LaguerreWaveStopsOptions { period?: number; gamma?: number; rmsLength?: number }

/**
 * @description Laguerre wave stops exactly as atcLaguerreWaveStopsCalc.cs computes them. The
 * child Laguerre oscillator's zero-crosses segment time into bull/bear cycles; the stop for a
 * bull trend = the just-completed bear cycle's lowest low (mirror for bear trends), constant
 * within a trend, re-based (never ratcheted) at each transition, NaN through the first trend.
 * Patterns compare the completed extreme against the immediately preceding same-side cycle
 * (LL/HL on bull transitions, HH/LH on bear transitions; equality = no pattern), carried forward
 * per bar, then overwritten by NHH/NLL when price breaks the prior cycle extreme — including the
 * source's spurious NHH throughout the first bull trend (the 0.0 unwritten-slot inheritance).
 * @param bars - Ascending OHLCV bars.
 * @param opts - period/gamma/rmsLength (strategy passes 30/0.5/100 for the Export wave state).
 * @returns stop + pattern series.
 */
export function laguerreWaveStops(bars: OhlcvBar[], opts: LaguerreWaveStopsOptions = {}): LaguerreWaveStopsSeries {
  const n = bars.length;
  const osc = laguerreOscillator(bars.map((b) => b.c), {
    period: opts.period ?? 30, gamma: opts.gamma ?? 0.5, rmsLength: opts.rmsLength ?? 100,
  });
  const stopS = new Array<number>(n).fill(NaN);
  const stop = new Array<number>(n).fill(NaN);
  const bullPat = new Array<WavePattern>(n).fill(WavePattern.None);
  const bearPat = new Array<WavePattern>(n).fill(WavePattern.None);
  const currLagHH = new Array<number>(n).fill(0); // bar-0 slot 0.0 — the NHH quirk's source
  const currLagLL = new Array<number>(n).fill(0);
  let inBull = false; let inBear = false;
  let curBullHigh = NaN; let curBearLow = NaN;
  let prevBearLow = NaN; let prevBullHigh = NaN;
  let priorBearLow = NaN; let priorBullHigh = NaN;
  let prior2BearLow = NaN; let prior2BullHigh = NaN;
  let curBullPat = WavePattern.None; let curBearPat = WavePattern.None;
  let patJust = false;
  for (let i = 1; i < n; i++) {
    const o = osc[i];
    const oPrev = osc[i - 1];
    if (!inBull && o > 0 && oPrev <= 0) {
      if (!Number.isNaN(priorBearLow)) prior2BearLow = priorBearLow;
      if (!Number.isNaN(prevBearLow)) priorBearLow = prevBearLow;
      prevBearLow = curBearLow;
      if (!Number.isNaN(curBearLow) && !Number.isNaN(priorBearLow)) {
        if (curBearLow < priorBearLow) { curBullPat = WavePattern.LL; patJust = true; }
        else if (curBearLow > priorBearLow) { curBullPat = WavePattern.HL; patJust = true; }
      }
      inBull = true; inBear = false;
      curBullHigh = bars[i].h; curBearLow = NaN;
    } else if (!inBear && o < 0 && oPrev >= 0) {
      if (!Number.isNaN(priorBullHigh)) prior2BullHigh = priorBullHigh;
      if (!Number.isNaN(prevBullHigh)) priorBullHigh = prevBullHigh;
      prevBullHigh = curBullHigh;
      if (!Number.isNaN(curBullHigh) && !Number.isNaN(priorBullHigh)) {
        if (curBullHigh > priorBullHigh) { curBearPat = WavePattern.HH; patJust = true; }
        else if (curBullHigh < priorBullHigh) { curBearPat = WavePattern.LH; patJust = true; }
      }
      inBear = true; inBull = false;
      curBearLow = bars[i].l; curBullHigh = NaN;
    }
    if (inBull) curBullHigh = Math.max(curBullHigh, bars[i].h);
    if (inBear) curBearLow = Math.min(curBearLow, bars[i].l);
    let s = NaN;
    if (inBull) s = prevBearLow;
    else if (inBear) s = prevBullHigh;
    stopS[i] = s;
    if (Number.isNaN(s) && !Number.isNaN(stopS[i - 1]) && ((inBull && o > 0) || (inBear && o < 0))) {
      s = stopS[i - 1]; // output-only carry; never written back (dead after the first two trends)
    }
    stop[i] = s;
    bullPat[i] = patJust && inBull && curBullPat !== WavePattern.None ? curBullPat : bullPat[i - 1];
    bearPat[i] = patJust && inBear && curBearPat !== WavePattern.None ? curBearPat : bearPat[i - 1];
    patJust = false;
    currLagHH[i] = inBear && !Number.isNaN(stopS[i]) ? stopS[i] : currLagHH[i - 1];
    currLagLL[i] = inBull && !Number.isNaN(stopS[i]) ? stopS[i] : currLagLL[i - 1];
    // Pending-breakout overwrite AFTER the pattern write, same bar (the NHH first-trend quirk lives here).
    if (inBull && !Number.isNaN(currLagHH[i]) && bars[i].h > currLagHH[i]) bearPat[i] = WavePattern.NHH;
    if (inBear && !Number.isNaN(currLagLL[i]) && bars[i].l < currLagLL[i]) bullPat[i] = WavePattern.NLL;
  }
  return { stop, bullWavePat: bullPat, bearWavePat: bearPat };
}
