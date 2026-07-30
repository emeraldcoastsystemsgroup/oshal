//! Port of `src/features/trading/services/futures-trail-stops.ts`.
//!
//! `super_trend_m11` is the single most expensive pass in the layer (22% of TS profile time), and
//! most of that was `movingMedian`'s per-bar allocate-slice-sort. Its NaN handling is subtle:
//! bars 0–1 emit NaN stops, and the flip-continuity carry reads a possibly-NaN slot and
//! substitutes ±Infinity. That is reproduced literally here — see the `carry` bindings.
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — chandelier_bands, super_trend_m11, parabolic_sar ported from futures-trail-stops.ts.

use crate::bars::Bars;
use crate::indicators::{moving_median, wilder_atr};
use crate::jsmath::{jmax, jmax3, jmin, jmin3};

/// Dual chandelier bands as `atcChandelierBands.cs` (trailing mode) computes them.
///
/// Warmup below `period` emits the close on both sides with trend 0; the seed bar sets both
/// extremes; afterwards each side ratchets and RESETS on a violation of the prior bar's stop.
pub fn chandelier_bands(
    b: &Bars,
    period: usize,
    multiplier: f64,
    use_high_low: bool,
    tick_size: f64,
    stop_long: &mut [f64],
    stop_short: &mut [f64],
    trend: &mut [f64],
) {
    let n = b.len();
    let mut atr = vec![0.0f64; n];
    wilder_atr(b, period, &mut atr);

    let mut long_extreme = 0.0f64;
    let mut short_extreme = 0.0f64;

    for i in 0..n {
        if i < period {
            stop_long[i] = b.c[i];
            stop_short[i] = b.c[i];
            trend[i] = 0.0;
            continue;
        }
        let trail_amount = multiplier * jmax(tick_size, atr[i]);
        let high_anchor = if use_high_low { b.h[i] } else { b.c[i] };
        let low_anchor = if use_high_low { b.l[i] } else { b.c[i] };

        if i == period {
            long_extreme = high_anchor;
            short_extreme = low_anchor;
            stop_long[i] = long_extreme - trail_amount;
            stop_short[i] = short_extreme + trail_amount;
        } else {
            if b.l[i] <= stop_long[i - 1] {
                stop_long[i] = b.l[i] - trail_amount;
                long_extreme = high_anchor;
            } else {
                long_extreme = jmax(long_extreme, high_anchor);
                stop_long[i] = jmax(stop_long[i - 1], long_extreme - trail_amount);
            }
            if b.h[i] >= stop_short[i - 1] {
                stop_short[i] = b.h[i] + trail_amount;
                short_extreme = low_anchor;
            } else {
                short_extreme = jmin(short_extreme, low_anchor);
                stop_short[i] = jmin(stop_short[i - 1], short_extreme + trail_amount);
            }
        }

        trend[i] = if b.c[i] > stop_short[i] {
            1.0
        } else if b.c[i] < stop_long[i] {
            -1.0
        } else {
            trend[i - 1]
        };
    }
}

/// Median-anchored SuperTrend as `atcSuperTrendM11.cs` (OnBarClose, no intrabar reverse).
///
/// Bar-`t` trail uses bar `t-1`'s median and ATR. The active side ratchets; on a flip the ratchet
/// CONTINUES from the prior bar's opposite-side value (the source's `Values[2]` continuity).
pub fn super_trend_m11(
    b: &Bars,
    base_period: usize,
    range_period: usize,
    multiplier: f64,
    tick_size: f64,
    stop_dot: &mut [f64],
    trend: &mut [f64],
) {
    let n = b.len();
    let mut baseline = vec![0.0f64; n];
    moving_median(b.c, base_period, &mut baseline);
    let mut atr = vec![0.0f64; n];
    wilder_atr(b, range_period, &mut atr);

    let mut cur_long = vec![0.0f64; n];
    let mut cur_short = vec![0.0f64; n];
    let mut other_side = vec![0.0f64; n];

    for i in 0..n {
        if i < 2 {
            trend[i] = 1.0;
            if i == 0 {
                cur_long[i] = f64::NAN;
                cur_short[i] = f64::NAN;
            } else {
                let trail = multiplier * jmax(tick_size, atr[0]);
                cur_long[i] = baseline[0] - trail;
                cur_short[i] = baseline[0] + trail;
            }
            stop_dot[i] = f64::NAN;
            other_side[i] = f64::NAN;
            continue;
        }

        let median = baseline[i - 1];
        let trail = multiplier * jmax(tick_size, atr[i - 1]);
        let long_v: f64;
        let short_v: f64;

        if trend[i - 1] > 0.5 {
            short_v = median + trail;
            let carry = if trend[i - 2] > 0.5 { cur_long[i - 1] } else { other_side[i - 1] };
            let carry = if carry.is_nan() { f64::NEG_INFINITY } else { carry };
            long_v = jmax(carry, median - trail);
            stop_dot[i] = long_v;
            other_side[i] = short_v;
        } else {
            long_v = median - trail;
            let carry = if trend[i - 2] < -0.5 { cur_short[i - 1] } else { other_side[i - 1] };
            let carry = if carry.is_nan() { f64::INFINITY } else { carry };
            short_v = jmin(carry, median + trail);
            stop_dot[i] = short_v;
            other_side[i] = long_v;
        }

        cur_long[i] = long_v;
        cur_short[i] = short_v;

        trend[i] = if trend[i - 1] > 0.5 && b.c[i] < long_v {
            -1.0
        } else if trend[i - 1] < -0.5 && b.c[i] > short_v {
            1.0
        } else {
            trend[i - 1]
        };
    }
}

/// Parabolic SAR as `atcParabolicSARCalc.cs` computes it on completed bars.
///
/// `is_long` is emitted as 1.0/0.0 rather than a bool so the whole output block stays a single
/// `f64` buffer the ABI can hand back as one `Float64Array` view.
pub fn parabolic_sar(
    b: &Bars,
    accel: f64,
    step: f64,
    cap: f64,
    psar: &mut [f64],
    is_long: &mut [f64],
) {
    let n = b.len();
    let mut long = true;
    let mut xp = 0.0f64;
    let mut af = accel;
    let mut prev_sar = f64::NAN;

    for i in 0..n {
        if i < 3 {
            psar[i] = f64::NAN;
            is_long[i] = 1.0;
            continue;
        }
        if i == 3 {
            long = b.h[3] > b.h[2];
            let hi = jmax3(b.h[1], b.h[2], b.h[3]);
            let lo = jmin3(b.l[1], b.l[2], b.l[3]);
            xp = if long { hi } else { lo };
            af = accel;
            prev_sar = xp + (if long { -1.0 } else { 1.0 }) * (hi - lo) * af;
            psar[i] = prev_sar;
            // The seed bar emits the DIRECTION IT JUST COMPUTED, not `true` — bars 0-2 emit true
            // only because the source has no direction yet.
            is_long[i] = if long { 1.0 } else { 0.0 };
            continue;
        }

        // First clamp: today's SAR may not sit inside the current-and-prior bar's range.
        let raw = prev_sar + af * (xp - prev_sar);
        let mut today = if long {
            let lowest = jmin3(raw, b.l[i], b.l[i - 1]);
            if b.l[i] > lowest { lowest } else { raw }
        } else {
            let highest = jmax3(raw, b.h[i], b.h[i - 1]);
            if b.h[i] < highest { highest } else { raw }
        };

        // Second clamp: the source's x = 1..2 loop over the PRIOR TWO bars.
        for x in 1..=2usize {
            if long {
                if today > b.l[i - x] {
                    today = b.l[i - x];
                }
            } else if today < b.h[i - x] {
                today = b.h[i - x];
            }
        }

        let mut out = today;
        prev_sar = today;

        if long {
            if b.h[i] > xp {
                xp = b.h[i];
                af = jmin(cap, af + step);
            }
        } else if b.l[i] < xp {
            xp = b.l[i];
            af = jmin(cap, af + step);
        }

        let penetrated = if long {
            b.l[i] < today || b.l[i - 1] < today
        } else {
            b.h[i] > today || b.h[i - 1] > today
        };

        if penetrated {
            // Source Reverse(): flip, AF reset, xp re-anchors to this bar's extreme.
            out = xp;
            long = !long;
            af = accel;
            xp = if long { b.h[i] } else { b.l[i] };
            prev_sar = out;
        }

        psar[i] = out;
        is_long[i] = if long { 1.0 } else { 0.0 };
    }
}
