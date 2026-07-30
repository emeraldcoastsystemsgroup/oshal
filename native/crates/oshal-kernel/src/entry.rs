//! Port of `src/features/trading/services/futures-entry-indicators.ts`.
//!
//! Two things here are quirks-as-specified, not bugs to fix:
//!  - `laguerre_filter`'s output weights `l1,l2,l3,l5` and SKIPS `l4` (which is computed only to
//!    feed `l5`). The source genuinely does this; the binomial intent is a red herring.
//!  - `mfi` must preserve NT8's SUM associativity — `sum + new - old`, never `sum + (new - old)`.
//!    The source branches on `sumNegative == 0` EXACTLY, and the two orderings differ in float
//!    residue, which flips MFI between ~100 and 50. Do not "simplify" that expression.
//!
//! The SuperSmoother coefficients are passed IN rather than computed here: they need `exp` and
//! `cos`, and Rust's libm is not bit-identical to V8's. Computing them JS-side is what makes the
//! parity guard exact instead of approximate. See ARCHITECTURE.md "Bit parity".
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — super_smoother, laguerre_oscillator, laguerre_filter, mfi, adaptive_laguerre_filter ported from futures-entry-indicators.ts.

use crate::bars::Bars;
use crate::jsmath::{jmax, jmin, median_in_place};

/// Pre-computed 2-pole SuperSmoother coefficients, supplied by the caller.
#[derive(Clone, Copy)]
pub struct SsCoeffs {
    pub c1: f64,
    pub c2: f64,
    pub c3: f64,
}

/// The shared SuperSmoother pre-stage: writes `us[i]` for `i >= 4`, leaving earlier slots at 0
/// (the source's unwritten-slot semantics, which the downstream RMS window depends on).
pub fn super_smoother(values: &[f64], k: SsCoeffs, us: &mut [f64]) {
    for i in 4..values.len() {
        us[i] = (1.0 - k.c1) * values[i]
            + (2.0 * k.c1 - k.c2) * values[i - 1]
            - (k.c1 + k.c3) * values[i - 2]
            + k.c2 * us[i - 1]
            + k.c3 * us[i - 2];
    }
}

/// Laguerre oscillator as `atcLaguerreOscillatorCalc.cs` computes it.
///
/// The RMS window spans ALL slots including the zeroed warmup ones — bars 0–3 still advance the
/// rolling sum, which is why the `else` branch is not a no-op.
pub fn laguerre_oscillator(
    values: &[f64],
    gamma: f64,
    rms_length: usize,
    k: SsCoeffs,
    out: &mut [f64],
) {
    let n = values.len();
    let rms_length = rms_length.max(1);
    let mut us = vec![0.0f64; n];
    super_smoother(values, k, &mut us);

    let mut l1o = vec![0.0f64; n];
    let mut sq_diff = vec![0.0f64; n];
    let mut sq_sum = 0.0f64;

    for i in 0..n {
        if i >= 4 {
            l1o[i] = us[i - 1] + gamma * (l1o[i - 1] - us[i]);
            let diff = us[i] - l1o[i];
            sq_diff[i] = diff * diff;
            sq_sum += sq_diff[i] - if i >= rms_length { sq_diff[i - rms_length] } else { 0.0 };
            let window = rms_length.min(i + 1) as f64;
            let rms = (sq_sum / window).sqrt();
            out[i] = if rms != 0.0 { diff / rms } else { 0.0 };
        } else {
            // Zero slots still occupy the window — the sum must advance.
            sq_sum += sq_diff[i] - if i >= rms_length { sq_diff[i - rms_length] } else { 0.0 };
        }
    }
}

/// Laguerre filter as `atcLaguerreFilterCalc.cs` computes it: SuperSmoother into a 5-stage
/// cascade, output `(us + 4·l1 + 6·l2 + 4·l3 + l5)/16` — `l4` deliberately absent.
pub fn laguerre_filter(values: &[f64], gamma: f64, k: SsCoeffs, out: &mut [f64]) {
    let n = values.len();
    let mut us = vec![0.0f64; n];
    super_smoother(values, k, &mut us);

    let g1 = 1.0 - gamma;
    let mut l = [0.0f64; 5];
    let mut lp = [0.0f64; 5];

    for i in 4..n {
        let us_prev = us[i - 1];
        l[0] = g1 * us_prev + gamma * lp[0];
        l[1] = g1 * lp[0] + gamma * lp[1];
        l[2] = g1 * lp[1] + gamma * lp[2];
        l[3] = g1 * lp[2] + gamma * lp[3];
        l[4] = g1 * lp[3] + gamma * lp[4];
        // l[3] (= l4f) is intentionally NOT in the weighting; it exists only to feed l[4].
        out[i] = (us[i] + 4.0 * l[0] + 6.0 * l[1] + 4.0 * l[2] + l[4]) / 16.0;
        lp = l;
    }
}

/// Money Flow Index as `atcMFICalc.cs` computes it: bar 0 = 50, and a zero negative-flow sum
/// yields 50 (not 100 — a non-classic source choice).
pub fn mfi(b: &Bars, period: usize, out: &mut [f64]) {
    let n = b.len();
    if n == 0 {
        return;
    }
    let mut pos = vec![0.0f64; n];
    let mut neg = vec![0.0f64; n];
    let mut sum_pos = 0.0f64;
    let mut sum_neg = 0.0f64;

    out[0] = 50.0;
    for i in 1..n {
        let t0 = b.typical(i);
        let t1 = b.typical(i - 1);
        neg[i] = if t0 < t1 { t0 * b.v[i] } else { 0.0 };
        pos[i] = if t0 > t1 { t0 * b.v[i] } else { 0.0 };

        // NT8 SUM associativity: (sum + new) - old. NOT sum + (new - old). See module header.
        sum_pos = sum_pos + pos[i] - if i >= period { pos[i - period] } else { 0.0 };
        sum_neg = sum_neg + neg[i] - if i >= period { neg[i - period] } else { 0.0 };

        out[i] = if sum_neg == 0.0 {
            50.0
        } else {
            100.0 - 100.0 / (1.0 + sum_pos / sum_neg)
        };
    }
}

/// Adaptive Laguerre filter as `atcAdaptiveLaguerreFilterCalc.cs` computes it.
///
/// The flat-range trap is reproduced exactly: when `hh <= ll` the bar reuses the PRIOR alpha and
/// leaves its own `ratio` slot at 0, which then participates in later median-of-5 windows.
pub fn adaptive_laguerre_filter(values: &[f64], period: usize, out: &mut [f64]) {
    let n = values.len();
    if n == 0 {
        return;
    }
    let mut diff = vec![0.0f64; n];
    let mut ratio = vec![0.0f64; n];
    let mut alpha_s = vec![0.0f64; n];

    let (mut ls0, mut ls1, mut ls2, mut ls3) = (values[0], values[0], values[0], values[0]);
    ratio[0] = 0.5;
    alpha_s[0] = 0.5;
    out[0] = values[0];

    let range_len = period.max(2) - 1; // period >= 2 on this path; period == 1 short-circuits below
    let mut med_buf = [0.0f64; 5];

    for i in 1..n {
        if period == 1 {
            out[i] = values[i];
            continue;
        }
        // Prior-bar MAX/MIN(diff, period-1) over the series as written so far.
        let from = i.saturating_sub(range_len);
        let mut phh = f64::NEG_INFINITY;
        let mut pll = f64::INFINITY;
        for j in from..=(i - 1) {
            phh = jmax(phh, diff[j]);
            pll = jmin(pll, diff[j]);
        }

        diff[i] = (values[i] - out[i - 1]).abs();
        let hh = jmax(phh, diff[i]);
        let ll = jmin(pll, diff[i]);

        if hh > ll {
            ratio[i] = (diff[i] - ll) / (hh - ll);
            // movingMedian(ratio, 5) at bar i = median of the last min(5, i+1) ratio slots.
            let lookback = 5usize.min(i + 1);
            med_buf[..lookback].copy_from_slice(&ratio[i + 1 - lookback..i + 1]);
            alpha_s[i] = median_in_place(&mut med_buf, lookback);
        } else {
            // ratio[i] stays 0 — the source never writes it on this path.
            alpha_s[i] = alpha_s[i - 1];
        }

        let a = alpha_s[i];
        let g = 1.0 - a;
        let (p0, p1, p2, p3) = (ls0, ls1, ls2, ls3);
        ls0 = a * values[i] + g * p0;
        ls1 = -g * ls0 + p0 + g * p1;
        ls2 = -g * ls1 + p1 + g * p2;
        ls3 = -g * ls2 + p2 + g * p3;
        out[i] = (ls0 + 2.0 * ls1 + 2.0 * ls2 + ls3) / 6.0;
    }
}
