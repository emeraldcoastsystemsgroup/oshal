/**
 * Futures entry-side indicators — ADR-116 entry port, part 1 of 3.
 *
 * The four remaining indicator engines the entry evaluator consumes, ported faithfully from
 * NT8Custom's Calc-only classes: the Laguerre oscillator (atcLaguerreOscillatorCalc — the source
 * of the entry gate's HARD momentum clause), the Laguerre filter (atcLaguerreFilterCalc — note
 * the deliberate l4f-skip in its output weighting), the volume-weighted MFI (atcMFICalc), and the
 * adaptive Laguerre filter (atcAdaptiveLaguerreFilterCalc — alpha from a 5-bar moving median of
 * the normalized tracking error).
 *
 * NT8 fidelity rule inherited throughout: an unwritten Series slot reads 0.0, NOT NaN. The
 * sources exploit this (the oscillator's first four bars, the unassigned `ratio` slot on
 * flat-range bars), so these ports emit/store 0 where NT8 would — do not "fix" to NaN, and do
 * not skip the zero slots in windowed sums. Consumers gate on the strategy-level warmup anyway.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — laguerreOscillator (2-pole SuperSmoother + 1-stage Laguerre, RMS-normalized, 0-warmup), laguerreFilter (SuperSmoother + 5-stage cascade, binomial output skipping l4f as the source does), mfi (typical×volume, SUM windows, zero-negative→50), adaptiveLaguerreFilter (median-of-ratio alpha incl. the unwritten-ratio-slot trap). Ported from NT8Custom Calc classes for the ADR-116 entry evaluator.
 *
 * @module futures-entry-indicators
 */

import type { OhlcvBar } from './market-data';

/** 2-pole SuperSmoother coefficients for a period (Ehlers; shared by the two Laguerre engines). */
function superSmootherCoeffs(period: number): { c1: number; c2: number; c3: number } {
  const a1 = Math.exp((-1.414 * Math.PI) / period);
  const c2 = 2.0 * a1 * Math.cos((1.414 * Math.PI) / period);
  const c3 = -a1 * a1;
  return { c1: (1.0 + c2 - c3) / 4.0, c2, c3 };
}

/** The shared SuperSmoother pre-stage: us[i] for i ≥ 4, zeros before (unwritten-slot semantics). */
function superSmootherSeries(values: number[], period: number): number[] {
  const { c1, c2, c3 } = superSmootherCoeffs(period);
  const us = new Array<number>(values.length).fill(0);
  for (let i = 4; i < values.length; i++) {
    us[i] = (1.0 - c1) * values[i]
      + (2.0 * c1 - c2) * values[i - 1]
      - (c1 + c3) * values[i - 2]
      + c2 * us[i - 1] + c3 * us[i - 2];
  }
  return us;
}

/** Options for {@link laguerreOscillator}; strategy-effective values in parentheses. */
export interface LaguerreOscillatorOptions {
  /** SuperSmoother period (30). */
  period?: number;
  /** Laguerre gamma (0.5). */
  gamma?: number;
  /** RMS normalization window (strategies pass 30; the wave-stops child passes 100). */
  rmsLength?: number;
}

/**
 * @description Laguerre oscillator exactly as atcLaguerreOscillatorCalc.cs computes it: a 2-pole
 * SuperSmoother over the input, a one-stage Laguerre lag line l1o = us[1] + γ·(l1o[1] − us[0]),
 * osc = (us − l1o) / RMS where RMS = √(SMA(diff², rmsLength)) — and exactly 0 when the RMS is 0.
 * Bars 0–3 emit 0 (the source writes nothing; NT reads 0). The entry gate's hard clause
 * (osc > 0 AND rising for longs) and the re-entry zero-cross filter both read this series.
 * @param values - Ascending input series (the strategies feed closes).
 * @param opts - Period/gamma/rmsLength.
 * @returns Oscillator series, index-aligned with values (0 during warmup).
 */
export function laguerreOscillator(values: number[], opts: LaguerreOscillatorOptions = {}): number[] {
  const period = opts.period ?? 30;
  const gamma = opts.gamma ?? 0.5;
  const rmsLength = Math.max(1, opts.rmsLength ?? 100);
  const us = superSmootherSeries(values, period);
  const out = new Array<number>(values.length).fill(0);
  const l1o = new Array<number>(values.length).fill(0);
  const sqDiff = new Array<number>(values.length).fill(0);
  let sqSum = 0; // rolling SMA(sqDiff, rmsLength) over ALL slots, zeros included
  for (let i = 0; i < values.length; i++) {
    if (i >= 4) {
      l1o[i] = us[i - 1] + gamma * (l1o[i - 1] - us[i]);
      const diff = us[i] - l1o[i];
      sqDiff[i] = diff * diff;
      sqSum += sqDiff[i] - (i >= rmsLength ? sqDiff[i - rmsLength] : 0);
      const window = Math.min(rmsLength, i + 1);
      const rms = Math.sqrt(sqSum / window);
      out[i] = rms !== 0 ? diff / rms : 0;
    } else {
      sqSum += sqDiff[i] - (i >= rmsLength ? sqDiff[i - rmsLength] : 0); // zero slots still occupy the window
    }
  }
  return out;
}

/**
 * @description Laguerre filter exactly as atcLaguerreFilterCalc.cs computes it: the SuperSmoother
 * pre-stage feeds a five-stage Laguerre cascade where each stage reads the PRIOR bar of the stage
 * below (lNf = (1−γ)·l(N−1)f[1] + γ·lNf[1]), and the output is (us + 4·l1 + 6·l2 + 4·l3 + l5)/16 —
 * the source genuinely skips l4 in the weighting (l4 is computed only to feed l5); port the quirk,
 * not the binomial intent. Bars 0–3 emit 0.
 * @param values - Ascending input series (closes).
 * @param period - SuperSmoother period (30).
 * @param gamma - Laguerre gamma (0.5).
 * @returns Filter series, index-aligned with values (0 during warmup).
 */
export function laguerreFilter(values: number[], period = 30, gamma = 0.5): number[] {
  const us = superSmootherSeries(values, period);
  const out = new Array<number>(values.length).fill(0);
  const g1 = 1.0 - gamma;
  const l = [0, 0, 0, 0, 0]; // l1f..l5f current
  const lp = [0, 0, 0, 0, 0]; // prior-bar values
  for (let i = 4; i < values.length; i++) {
    const usPrev = us[i - 1];
    l[0] = g1 * usPrev + gamma * lp[0];
    l[1] = g1 * lp[0] + gamma * lp[1];
    l[2] = g1 * lp[1] + gamma * lp[2];
    l[3] = g1 * lp[2] + gamma * lp[3];
    l[4] = g1 * lp[3] + gamma * lp[4];
    out[i] = (us[i] + 4.0 * l[0] + 6.0 * l[1] + 4.0 * l[2] + l[4]) / 16.0; // l[3] (=l4f) deliberately absent
    for (let s = 0; s < 5; s++) lp[s] = l[s];
  }
  return out;
}

/**
 * @description Money Flow Index exactly as atcMFICalc.cs computes it: typical = (H+L+C)/3;
 * positive/negative flow = typical × volume by typical-price direction (flat typical → neither);
 * MFI = 100 − 100/(1 + ΣP/ΣN) over a `period` window, with the source's rules: bar 0 = 50, and
 * a zero negative-flow sum = 50 (NOT 100 — a non-classic choice that fires on any monotone-up
 * window). Sums include unwritten early slots as zeros, matching NT SUM over the series.
 * @param bars - Ascending OHLCV bars.
 * @param period - Flow window (hard-coded 14 in the strategies).
 * @returns MFI series 0–100, index-aligned with bars.
 */
export function mfi(bars: OhlcvBar[], period = 14): number[] {
  const out: number[] = [];
  const pos = new Array<number>(bars.length).fill(0);
  const neg = new Array<number>(bars.length).fill(0);
  let sumPos = 0; let sumNeg = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      out.push(50);
      continue;
    }
    const t0 = (bars[i].h + bars[i].l + bars[i].c) / 3;
    const t1 = (bars[i - 1].h + bars[i - 1].l + bars[i - 1].c) / 3;
    neg[i] = t0 < t1 ? t0 * bars[i].v : 0;
    pos[i] = t0 > t1 ? t0 * bars[i].v : 0;
    // NT8 SUM associativity: (sum + new) − old — NOT sum + (new − old). The difference matters
    // because the source branches on sumNegative == 0 EXACTLY; the NT ordering leaves float
    // residue where the other ordering cancels to 0, flipping MFI between ~100 and 50.
    sumPos = sumPos + pos[i] - (i >= period ? pos[i - period] : 0);
    sumNeg = sumNeg + neg[i] - (i >= period ? neg[i - period] : 0);
    out.push(sumNeg === 0 ? 50 : 100.0 - 100.0 / (1 + sumPos / sumNeg));
  }
  return out;
}

/**
 * @description Adaptive Laguerre filter exactly as atcAdaptiveLaguerreFilterCalc.cs computes it:
 * per bar, diff = |input − filter[1]|; the tracking-error range comes from the PRIOR bar's
 * MAX/MIN(diff, period−1) extended by today's diff; alpha = movingMedian(ratio, 5) of the
 * normalized error — with the source's trap that a flat range (hh ≤ ll) reuses the prior alpha
 * AND leaves that bar's ratio slot at 0 for future median windows. Bar 0 (or period 1) seeds
 * everything at the input. Output = (ls0 + 2·ls1 + 2·ls2 + ls3)/6 over the 4-stage cascade.
 * @param values - Ascending input series (closes).
 * @param period - Error-range lookback (hard-coded 20 in the strategies).
 * @returns Filter series, index-aligned with values.
 */
export function adaptiveLaguerreFilter(values: number[], period = 20): number[] {
  const out: number[] = [];
  if (!values.length) return out;
  const diff = new Array<number>(values.length).fill(0);
  const ratio = new Array<number>(values.length).fill(0);
  const alphaS = new Array<number>(values.length).fill(0);
  let ls0 = values[0]; let ls1 = values[0]; let ls2 = values[0]; let ls3 = values[0];
  ratio[0] = 0.5; alphaS[0] = 0.5;
  out.push(values[0]);
  const rangeLen = Math.max(1, period - 1);
  for (let i = 1; i < values.length; i++) {
    if (period === 1) { out.push(values[i]); continue; }
    // Prior-bar MAX/MIN(diff, period−1) — windows over the series as written so far.
    const from = Math.max(0, i - 1 - (rangeLen - 1));
    let phh = -Infinity; let pll = Infinity;
    for (let j = from; j <= i - 1; j++) { phh = Math.max(phh, diff[j]); pll = Math.min(pll, diff[j]); }
    diff[i] = Math.abs(values[i] - out[i - 1]);
    const hh = Math.max(phh, diff[i]);
    const ll = Math.min(pll, diff[i]);
    if (hh > ll) {
      ratio[i] = (diff[i] - ll) / (hh - ll);
      // movingMedian(ratio, 5) at bar i = median of the last min(5, i+1) ratio slots
      const win = ratio.slice(Math.max(0, i - 4), i + 1).sort((x, y) => x - y);
      alphaS[i] = win.length % 2 === 0 ? 0.5 * (win[win.length / 2] + win[win.length / 2 - 1]) : win[(win.length - 1) / 2];
    } else {
      alphaS[i] = alphaS[i - 1]; // ratio[i] stays 0 — the source never writes it on this path
    }
    const a = alphaS[i];
    const g = 1 - a;
    const p0 = ls0; const p1 = ls1; const p2 = ls2; const p3 = ls3;
    ls0 = a * values[i] + g * p0;
    ls1 = -g * ls0 + p0 + g * p1;
    ls2 = -g * ls1 + p1 + g * p2;
    ls3 = -g * ls2 + p2 + g * p3;
    out.push((ls0 + 2 * ls1 + 2 * ls2 + ls3) / 6);
  }
  return out;
}
