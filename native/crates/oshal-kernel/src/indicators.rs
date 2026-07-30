//! Port of `src/features/trading/services/futures-indicators.ts`.
//!
//! Every function here is a line-for-line translation of its TS counterpart, INCLUDING the
//! non-classic NT8 warmups the TS header warns about (EMA-seeded Wilder ATR, the DMI's
//! three-phase DM warmup, the Laguerre RSI's bar-0 zero). Do not "correct" any of it to the
//! textbook form: parity with the trader's NinjaTrader results is the whole point, and the
//! parity guard will fail if you do.
//!
//! When the TS and this file disagree, THE TS IS RIGHT — it is the reference implementation and
//! the fallback path. Fix the Rust.
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — wilder_atr, dmi_adx, laguerre_rsi, moving_median ported from futures-indicators.ts.

use crate::bars::Bars;
use crate::jsmath::{jmax, jmax3, jmin, median_in_place};

/// NT8's double-comparison epsilon, mirroring `APPROX_ZERO` in the TS.
const APPROX_ZERO: f64 = 1e-10;

/// True range at bar `i`; bar 0 uses `high - low`, matching `atcATRCalc`.
#[inline]
fn true_range_at(b: &Bars, i: usize) -> f64 {
    if i == 0 {
        return b.h[0] - b.l[0];
    }
    let prev_close = b.c[i - 1];
    jmax(b.h[i], prev_close) - jmin(b.l[i], prev_close)
}

/// Wilder-mode ATR: `TR₀ = h₀ - l₀`, then `ATRᵢ = TRᵢ/p + ATRᵢ₋₁·(p-1)/p`.
///
/// Writes into `out`, which must be `b.len()` long. A `period < 1` yields an untouched `out`,
/// matching the TS early return on the same guard.
pub fn wilder_atr(b: &Bars, period: usize, out: &mut [f64]) {
    let n = b.len();
    if n == 0 || period < 1 {
        return;
    }
    let p = period as f64;
    let mut atr = true_range_at(b, 0);
    out[0] = atr;
    for i in 1..n {
        atr = true_range_at(b, i) / p + (atr * (p - 1.0)) / p;
        out[i] = atr;
    }
}

/// The `atcDMI` smoothed-DM warmup: cumulative average below `period`, an SMA-seeded carry
/// exactly at `period`, then the Wilder carry.
#[inline]
fn smooth_dm_at(raw: &[f64], smooth: &[f64], i: usize, period: usize) -> f64 {
    let p = period as f64;
    if i < period {
        let mut sum = 0.0;
        for j in 0..=i {
            sum += raw[j];
        }
        return sum / (i as f64 + 1.0);
    }
    if i == period {
        let mut prev = 0.0;
        for j in (i - period)..=(i - 1) {
            prev += raw[j];
        }
        prev /= p;
        return (prev * (p - 1.0) + raw[i]) / p;
    }
    (smooth[i - 1] * (p - 1.0) + raw[i]) / p
}

/// DMI/ADX as `atcDMI.cs` computes it, warmups included. Fills `adx`, `plus_di`, `minus_di`
/// (each `b.len()` long); bar 0 emits zeros.
pub fn dmi_adx(
    b: &Bars,
    di_length: usize,
    adx_smoothing: usize,
    adx: &mut [f64],
    plus_di: &mut [f64],
    minus_di: &mut [f64],
) {
    // The source's property setters clamp both periods to >= 1.
    let di_length = di_length.max(1);
    let adx_smoothing = adx_smoothing.max(1);
    let n = b.len();
    let dil = di_length as f64;
    let adxs = adx_smoothing as f64;

    let mut plus_dm = vec![0.0f64; n];
    let mut minus_dm = vec![0.0f64; n];
    let mut sm_p = vec![0.0f64; n];
    let mut sm_m = vec![0.0f64; n];
    let mut trur = 0.0f64;

    for i in 0..n {
        if i == 0 {
            // All series already zero-initialized — matches atcDMI returning before it computes.
            continue;
        }
        let up = b.h[i] - b.h[i - 1];
        let down = b.l[i - 1] - b.l[i];
        plus_dm[i] = if up > down && up > 0.0 { up } else { 0.0 };
        minus_dm[i] = if down > up && down > 0.0 { down } else { 0.0 };

        let tr = jmax3(
            b.h[i] - b.l[i],
            (b.h[i] - b.c[i - 1]).abs(),
            (b.l[i] - b.c[i - 1]).abs(),
        );
        trur = if i < di_length {
            tr
        } else {
            (trur * (dil - 1.0) + tr) / dil
        };

        sm_p[i] = smooth_dm_at(&plus_dm, &sm_p, i, di_length);
        sm_m[i] = smooth_dm_at(&minus_dm, &sm_m, i, di_length);

        let pdi = if trur != 0.0 { (100.0 * sm_p[i]) / trur } else { 0.0 };
        let mdi = if trur != 0.0 { (100.0 * sm_m[i]) / trur } else { 0.0 };
        plus_di[i] = pdi;
        minus_di[i] = mdi;

        let sum = pdi + mdi;
        let dx = if sum == 0.0 {
            0.0
        } else {
            (100.0 * (pdi - mdi).abs()) / sum
        };
        adx[i] = if i < adx_smoothing {
            dx
        } else {
            (adx[i - 1] * (adxs - 1.0) + dx) / adxs
        };
    }
}

/// Ehlers Laguerre RSI (0–100) plus its EMA "Average" line, as `atcLaguerreRSICalc.cs`.
///
/// Bar 0 emits `laRsi = 0` / `average = 50`; the average's bar-1 term is seeded from 50 rather
/// than from `average[0]`, which the TS does explicitly and which this reproduces.
pub fn laguerre_rsi(
    values: &[f64],
    alpha: f64,
    smoothing_period: f64,
    la_rsi: &mut [f64],
    average: &mut [f64],
) {
    let n = values.len();
    if n == 0 {
        return;
    }
    let a = alpha.clamp(0.0, 1.0);
    let gamma = 1.0 - a;
    let k = 2.0 / (1.0 + smoothing_period);

    let (mut l0, mut l1, mut l2, mut l3) = (values[0], values[0], values[0], values[0]);
    la_rsi[0] = 0.0;
    average[0] = 50.0;

    for i in 1..n {
        let src = values[i];
        let (p0, p1, p2, p3) = (l0, l1, l2, l3);
        l0 = (1.0 - gamma) * src + gamma * p0;
        l1 = -gamma * l0 + p0 + gamma * p1;
        l2 = -gamma * l1 + p1 + gamma * p2;
        l3 = -gamma * l2 + p2 + gamma * p3;

        let mut cu = 0.0;
        let mut cd = 0.0;
        if l0 > l1 { cu += l0 - l1 } else { cd += l1 - l0 }
        if l1 > l2 { cu += l1 - l2 } else { cd += l2 - l1 }
        if l2 > l3 { cu += l2 - l3 } else { cd += l3 - l2 }

        let temp = cu + cd;
        let v = if temp.abs() < APPROX_ZERO { 0.0 } else { (100.0 * cu) / temp };
        la_rsi[i] = v;
        average[i] = if i == 1 {
            k * v + (1.0 - k) * 50.0
        } else {
            k * v + (1.0 - k) * average[i - 1]
        };
    }
}

/// Moving median as `amaMovingMedian.cs` computes it: median of the last `min(period, i+1)`
/// values, even counts averaging the two middle elements.
///
/// The TS allocates a fresh sorted slice per bar; this allocates ONE scratch buffer for the whole
/// pass. There is deliberately no cap on `period`: an earlier revision used a fixed stack buffer
/// and clamped, which would have silently returned a median-of-8 for a caller that configured a
/// longer baseline — a wrong number with no error. Sizing the buffer to `period` removes that
/// failure mode entirely.
pub fn moving_median(values: &[f64], period: usize, out: &mut [f64]) {
    let n = values.len();
    let period = period.max(1);
    let mut buf = vec![0.0f64; period];
    for i in 0..n {
        let lookback = period.min(i + 1);
        buf[..lookback].copy_from_slice(&values[i + 1 - lookback..i + 1]);
        out[i] = median_in_place(&mut buf, lookback);
    }
}
