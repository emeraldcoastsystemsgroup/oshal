/**
 * Futures indicator math — ADR-116 stop-stack port, part 1 of 3.
 *
 * Faithful TypeScript ports of the NT8 indicator math the futures stop engine consumes
 * (source of truth: the trader's NT8Custom repo — atcATRCalc.cs, atcDMI.cs,
 * atcLaguerreRSICalc.cs). "Faithful" includes the NON-classic warmups: the ATR is an
 * EMA(TR, 2p−1) seeded at bar 0's high−low (not an SMA-seeded Wilder RMA), the DMI smooths
 * true range by raw passthrough until bar `diLength`, and the DM lines warm up on a
 * cumulative average before switching to the Wilder carry. Backtest parity with the
 * trader's NinjaTrader results depends on reproducing those exactly — do not "correct"
 * them to textbook forms.
 *
 * Pure series math, no I/O: every function takes ascending bars (oldest first) and returns
 * arrays index-aligned with the input. Consumers: futures-trail-stops.ts (ATR),
 * futures-stop-engine.ts (DMI/ADX gate, Laguerre RSI gate).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Wilder-mode ATR (EMA(TR,2p−1), bar-0 seed), DMI/ADX with the atc warmups (TR passthrough < diLength, cumulative-avg DM warmup, SMA-seeded carry at bar == period, DX passthrough < adxSmoothing), Ehlers Laguerre RSI 0–100 with EMA average line. Ported from NT8Custom atcATRCalc/atcDMI/atcLaguerreRSICalc for the ADR-116 stop engine.
 *
 * @module futures-indicators
 */

import type { OhlcvBar } from './market-data';

/** DMI/ADX output series, index-aligned with the input bars. */
export interface DmiSeries {
  /** Average Directional Index (0–100). */
  adx: number[];
  /** +DI line (0–100). */
  plusDi: number[];
  /** −DI line (0–100). */
  minusDi: number[];
}

/** Laguerre RSI output series, index-aligned with the input values. */
export interface LaguerreRsiSeries {
  /** Laguerre RSI scaled 0–100 (the trader's "above 80" threshold lives on this scale). */
  laRsi: number[];
  /** EMA of laRsi (k = 2/(1+smoothingPeriod)), seeded at 50 — the indicator's "Average" plot. */
  average: number[];
}

/** True range of bar i given the prior close (bar 0 uses high−low, matching atcATRCalc). */
function trueRangeAt(bars: OhlcvBar[], i: number): number {
  if (i === 0) return bars[0].h - bars[0].l;
  const prevClose = bars[i - 1].c;
  return Math.max(bars[i].h, prevClose) - Math.min(bars[i].l, prevClose);
}

/**
 * @description Wilder-mode ATR exactly as atcATRCalc.cs / amaATR.cs (Wilder mode) compute it:
 * TR₀ = high₀ − low₀, then ATR = EMA(TR, 2·period − 1), i.e. ATRᵢ = TRᵢ/p + ATRᵢ₋₁·(p−1)/p seeded
 * ATR₀ = TR₀. This is Wilder's recursion with an EMA-style bar-0 seed rather than an SMA warmup —
 * the atc indicators all consume this variant, so parity requires it.
 * @param bars - Ascending OHLCV bars.
 * @param period - ATR period p (e.g. 22 for the chandelier, 15 for SuperTrend M11).
 * @returns ATR series, index-aligned with bars (empty input → empty output).
 */
export function wilderAtr(bars: OhlcvBar[], period: number): number[] {
  const out: number[] = [];
  if (!bars.length || period < 1) return out;
  let atr = trueRangeAt(bars, 0);
  out.push(atr);
  for (let i = 1; i < bars.length; i++) {
    atr = trueRangeAt(bars, i) / period + (atr * (period - 1)) / period;
    out.push(atr);
  }
  return out;
}

/** The atcDMI smoothed-DM warmup: cumulative average < period, SMA-seeded carry at == period, Wilder carry after. */
function smoothDmAt(raw: number[], smooth: number[], i: number, period: number): number {
  if (i < period) {
    let sum = 0;
    for (let j = 0; j <= i; j++) sum += raw[j];
    return sum / (i + 1);
  }
  if (i === period) {
    let prev = 0;
    for (let j = i - period; j <= i - 1; j++) prev += raw[j];
    prev /= period;
    return (prev * (period - 1) + raw[i]) / period;
  }
  return (smooth[i - 1] * (period - 1) + raw[i]) / period;
}

/**
 * @description DMI/ADX exactly as atcDMI.cs computes it, including its warmups: +DM/−DM from
 * high/low deltas; smoothed TR = raw TR passthrough until bar `diLength` then Wilder RMA;
 * smoothed DM = cumulative average until `diLength`, an SMA(1..period)-seeded carry AT bar
 * `diLength`, then the Wilder carry; DX passthrough into ADX until bar `adxSmoothing`, then RMA.
 * Bar 0 emits zeros (atcDMI returns before computing anything there). The stop engine's Strangle
 * gate reads adx/plusDi/minusDi from this — the "+DI below ADX" arm test in particular.
 * @param bars - Ascending OHLCV bars.
 * @param diLength - DI smoothing length (trader default 14).
 * @param adxSmoothing - ADX smoothing length (trader default 14).
 * @returns adx / plusDi / minusDi series, index-aligned with bars.
 */
export function dmiAdx(bars: OhlcvBar[], diLength = 14, adxSmoothing = 14): DmiSeries {
  diLength = Math.max(1, diLength); // the source's property setters clamp both periods to ≥ 1
  adxSmoothing = Math.max(1, adxSmoothing);
  const adx: number[] = []; const plusDi: number[] = []; const minusDi: number[] = [];
  const plusDm: number[] = []; const minusDm: number[] = [];
  const smP: number[] = []; const smM: number[] = [];
  let trur = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      plusDm.push(0); minusDm.push(0); smP.push(0); smM.push(0);
      adx.push(0); plusDi.push(0); minusDi.push(0);
      continue;
    }
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trur = i < diLength ? tr : (trur * (diLength - 1) + tr) / diLength;
    smP.push(smoothDmAt(plusDm, smP, i, diLength));
    smM.push(smoothDmAt(minusDm, smM, i, diLength));
    const pdi = trur !== 0 ? (100 * smP[i]) / trur : 0;
    const mdi = trur !== 0 ? (100 * smM[i]) / trur : 0;
    plusDi.push(pdi); minusDi.push(mdi);
    const sum = pdi + mdi;
    const dx = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    adx.push(i < adxSmoothing ? dx : (adx[i - 1] * (adxSmoothing - 1) + dx) / adxSmoothing);
  }
  return { adx, plusDi, minusDi };
}

/** ApproxCompare(0) == 0 stand-in — NT8's double comparison epsilon. */
const APPROX_ZERO = 1e-10;

/**
 * @description Ehlers Laguerre RSI exactly as atcLaguerreRSICalc.cs computes it: a 4-stage
 * Laguerre filter cascade (γ = 1 − alpha) over the input, cu/cd summed across the three adjacent
 * stage pairs, LaRSI = 100·cu/(cu+cd) with the PineScript zero-denominator rule (cu+cd ≈ 0 → 0),
 * plus the "Average" EMA line (k = 2/(1+smoothingPeriod)) seeded at 50. Bar 0 initializes all
 * filter stages to the input and emits laRsi 0 / average 50. The 0–100 scale is native — the
 * trader's "RSI at 80 or above" exhaustion threshold is literal on this output.
 * @param values - Ascending input series (the trader feeds closes).
 * @param alpha - Laguerre alpha 0–1, clamped (trader default 0.5 → γ 0.5).
 * @param smoothingPeriod - Average-line EMA period (trader default 7 → k 0.25).
 * @returns laRsi and average series, index-aligned with values.
 */
export function laguerreRsi(values: number[], alpha = 0.5, smoothingPeriod = 7): LaguerreRsiSeries {
  const laRsi: number[] = []; const average: number[] = [];
  if (!values.length) return { laRsi, average };
  const a = Math.max(0, Math.min(1, alpha));
  const gamma = 1 - a;
  const k = 2 / (1 + smoothingPeriod);
  let l0 = values[0]; let l1 = values[0]; let l2 = values[0]; let l3 = values[0];
  laRsi.push(0); average.push(50);
  for (let i = 1; i < values.length; i++) {
    const src = values[i];
    const p0 = l0; const p1 = l1; const p2 = l2; const p3 = l3;
    l0 = (1 - gamma) * src + gamma * p0;
    l1 = -gamma * l0 + p0 + gamma * p1;
    l2 = -gamma * l1 + p1 + gamma * p2;
    l3 = -gamma * l2 + p2 + gamma * p3;
    let cu = 0; let cd = 0;
    if (l0 > l1) cu += l0 - l1; else cd += l1 - l0;
    if (l1 > l2) cu += l1 - l2; else cd += l2 - l1;
    if (l2 > l3) cu += l2 - l3; else cd += l3 - l2;
    const temp = cu + cd;
    const v = Math.abs(temp) < APPROX_ZERO ? 0 : (100 * cu) / temp;
    laRsi.push(v);
    average.push(i === 1 ? k * v + (1 - k) * 50 : k * v + (1 - k) * average[i - 1]);
  }
  return { laRsi, average };
}

/**
 * @description Moving median exactly as amaMovingMedian.cs computes it (SuperTrend M11's
 * baseline): the median of the last min(period, i+1) values, even counts averaging the two
 * middle elements. Exposed for the trail-stop module and tests.
 * @param values - Ascending input series.
 * @param period - Median lookback (SuperTrend M11 default 8).
 * @returns Median series, index-aligned with values.
 */
export function movingMedian(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const lookback = Math.min(period, i + 1);
    const win = values.slice(i - lookback + 1, i + 1).sort((x, y) => x - y);
    out.push(lookback % 2 === 0 ? 0.5 * (win[lookback / 2] + win[lookback / 2 - 1]) : win[(lookback - 1) / 2]);
  }
  return out;
}
