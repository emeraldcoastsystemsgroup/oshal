//! Port of `src/features/trading/services/futures-wave-tracking.ts`.
//!
//! The wave machine tracks bull/bear cycles off a fast/slow line crossover and publishes the last
//! COMPLETED cycle's extreme. `laguerre_wave_stops` additionally reproduces two deliberate source
//! artifacts that a "clean" implementation would lose:
//!  - the spurious NHH throughout the first bull trend, which comes from `currLagHH`'s bar-0 slot
//!    being 0.0 rather than NaN;
//!  - the output-only stop carry that is never written back, and is therefore dead after the first
//!    two trends.
//!
//! Booleans are emitted as 1.0/0.0 so the entire output block is one `f64` buffer.
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — nt8_ema, wave machine, macd_wave, dmi_wave, ehlers_inst_trend_wave, laguerre_wave_stops ported from futures-wave-tracking.ts.

use crate::bars::Bars;
use crate::entry::{laguerre_oscillator, SsCoeffs};
use crate::indicators::dmi_adx;
use crate::jsmath::{jmax, jmin};

/// Wave-pattern codes as `atcLaguerreWaveStopsCalc.cs` defines them. NHL/NLH exist in the source's
/// enum but are never produced; they are kept so the numeric codes line up with the TS enum.
pub mod pattern {
    pub const NONE: f64 = 0.0;
    pub const LL: f64 = 1.0;
    pub const HL: f64 = 2.0;
    pub const HH: f64 = 3.0;
    pub const LH: f64 = 4.0;
    pub const NHH: f64 = 5.0;
    pub const NLL: f64 = 6.0;
}

/// The six series the wave machine produces, as mutable output slices.
pub struct WaveOut<'a> {
    pub is_bullish: &'a mut [f64],
    pub is_bearish: &'a mut [f64],
    pub last_bear_wave_low: &'a mut [f64],
    pub last_bull_wave_high: &'a mut [f64],
}

/// NT8 EMA over a raw array: seeded at `values[0]`, `k = 2/(1+n)`.
pub fn nt8_ema(values: &[f64], n_period: f64, out: &mut [f64]) {
    let k = 2.0 / (1.0 + n_period);
    for i in 0..values.len() {
        out[i] = if i == 0 {
            values[i]
        } else {
            k * values[i] + (1.0 - k) * out[i - 1]
        };
    }
}

/// The shared wave machine: given fast/slow lines, produce regime flags and last-completed-cycle
/// extremes. `flag_from` is the first bar the flags publish; `cross_from` the first bar a cross may
/// fire (its `[i-1]` reads must be meaningful for the specific source).
pub fn run_wave_machine(
    b: &Bars,
    fast: &[f64],
    slow: &[f64],
    flag_from: usize,
    cross_from: usize,
    out: WaveOut,
) {
    let n = b.len();
    let mut in_bull = false;
    let mut in_bear = false;
    let mut cur_bull_high = f64::NAN;
    let mut cur_bear_low = f64::NAN;
    let mut last_bear_low = f64::NAN;
    let mut last_bull_high = f64::NAN;

    for i in 0..n {
        if i >= flag_from {
            out.is_bullish[i] = if fast[i] > slow[i] { 1.0 } else { 0.0 };
            out.is_bearish[i] = if fast[i] < slow[i] { 1.0 } else { 0.0 };
        }
        if i >= cross_from && i >= 1 {
            let bullish_cross = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
            let bearish_cross = !bullish_cross && fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
            if bullish_cross {
                if in_bear {
                    last_bear_low = cur_bear_low;
                    in_bear = false;
                    cur_bear_low = f64::NAN;
                }
                if !in_bull {
                    in_bull = true;
                    cur_bull_high = b.h[i];
                }
            } else if bearish_cross {
                if in_bull {
                    last_bull_high = cur_bull_high;
                    in_bull = false;
                    cur_bull_high = f64::NAN;
                }
                if !in_bear {
                    in_bear = true;
                    cur_bear_low = b.l[i];
                }
            }
            if in_bull {
                cur_bull_high = jmax(cur_bull_high, b.h[i]);
            }
            if in_bear {
                cur_bear_low = jmin(cur_bear_low, b.l[i]);
            }
        }
        out.last_bear_wave_low[i] = last_bear_low;
        out.last_bull_wave_high[i] = last_bull_high;
    }
}

/// MACD wave tracker as `atcMACDCalc.cs` computes it. The MACD series is 0 below `slow`, and the
/// signal EMA runs over THAT series from bar 0 — so the zero contamination decays rather than
/// being skipped. `fast_out`/`slow_out` receive the MACD line and the signal.
#[allow(clippy::too_many_arguments)]
pub fn macd_wave(
    b: &Bars,
    fast_p: f64,
    slow_p: f64,
    smooth_p: f64,
    fast_out: &mut [f64],
    slow_out: &mut [f64],
    out: WaveOut,
) {
    let n = b.len();
    let mut fast_ema = vec![0.0f64; n];
    let mut slow_ema = vec![0.0f64; n];
    nt8_ema(b.c, fast_p, &mut fast_ema);
    nt8_ema(b.c, slow_p, &mut slow_ema);

    let slow_idx = slow_p as usize;
    for i in 0..n {
        fast_out[i] = if i < slow_idx { 0.0 } else { fast_ema[i] - slow_ema[i] };
    }
    // Signal EMA over the MACD series, seeded at macd[0] = 0 — the unwritten-slot artifact.
    let macd_copy = fast_out.to_vec();
    nt8_ema(&macd_copy, smooth_p, slow_out);

    run_wave_machine(b, fast_out, slow_out, slow_idx, slow_idx + 1, out);
}

/// DMI wave tracker as `atcDMCalc.cs` computes it: the wave machine over the +DI/-DI pair, with
/// flags and crosses both starting at `di_length + 1`.
#[allow(clippy::too_many_arguments)]
pub fn dmi_wave(
    b: &Bars,
    di_length: usize,
    adx_period: usize,
    fast_out: &mut [f64],
    slow_out: &mut [f64],
    adx_out: &mut [f64],
    out: WaveOut,
) {
    dmi_adx(b, di_length, adx_period, adx_out, fast_out, slow_out);
    run_wave_machine(b, fast_out, slow_out, di_length + 1, di_length + 1, out);
}

/// Ehlers Instantaneous Trendline wave tracker as `atcEhlersInstTrendCalc.cs` computes it.
///
/// Bars 2–6 use the WMA-ish seed, bar 7+ the IIR. Prior plot slots read 0 at bar 2, so a bullish
/// cross fires there for any positive-priced series — the tracker ALWAYS opens in a bull wave.
pub fn ehlers_inst_trend_wave(
    b: &Bars,
    alpha: f64,
    fast_out: &mut [f64],
    slow_out: &mut [f64],
    out: WaveOut,
) {
    let n = b.len();
    let a = alpha;
    for i in 2..n {
        let src = b.median_price(i);
        let src1 = b.median_price(i - 1);
        let src2 = b.median_price(i - 2);
        slow_out[i] = if i < 7 {
            (src + 2.0 * src1 + src2) / 4.0
        } else {
            (a - (a * a) / 4.0) * src + 0.5 * a * a * src1 - (a - 0.75 * a * a) * src2
                + 2.0 * (1.0 - a) * slow_out[i - 1]
                - (1.0 - a) * (1.0 - a) * slow_out[i - 2]
        };
        fast_out[i] = 2.0 * slow_out[i] - slow_out[i - 2];
    }
    run_wave_machine(b, fast_out, slow_out, 2, 2, out);
}

/// Laguerre wave stops as `atcLaguerreWaveStopsCalc.cs` computes them.
///
/// The child oscillator's zero-crosses segment time into cycles; the stop for a bull trend is the
/// just-completed bear cycle's lowest low, constant within a trend and re-based (never ratcheted).
/// NaN through the entire first trend.
#[allow(clippy::too_many_arguments)]
pub fn laguerre_wave_stops(
    b: &Bars,
    gamma: f64,
    rms_length: usize,
    k: SsCoeffs,
    stop: &mut [f64],
    bull_pat: &mut [f64],
    bear_pat: &mut [f64],
) {
    let n = b.len();
    if n == 0 {
        return;
    }
    let mut osc = vec![0.0f64; n];
    laguerre_oscillator(b.c, gamma, rms_length, k, &mut osc);

    let mut stop_s = vec![f64::NAN; n];
    // currLagHH/LL start at 0.0, NOT NaN — this is what produces the source's spurious NHH
    // throughout the first bull trend. Do not "fix" to NaN.
    let mut curr_lag_hh = vec![0.0f64; n];
    let mut curr_lag_ll = vec![0.0f64; n];

    for v in stop.iter_mut() {
        *v = f64::NAN;
    }

    let mut in_bull = false;
    let mut in_bear = false;
    let mut cur_bull_high = f64::NAN;
    let mut cur_bear_low = f64::NAN;
    let mut prev_bear_low = f64::NAN;
    let mut prev_bull_high = f64::NAN;
    let mut prior_bear_low = f64::NAN;
    let mut prior_bull_high = f64::NAN;
    let mut cur_bull_pat = pattern::NONE;
    let mut cur_bear_pat = pattern::NONE;
    let mut pat_just = false;

    for i in 1..n {
        let o = osc[i];
        let o_prev = osc[i - 1];

        if !in_bull && o > 0.0 && o_prev <= 0.0 {
            // The TS also maintains prior2BearLow / prior2BullHigh here. Both are write-only in the
            // source AND in the TS port — nothing downstream reads them — so they are omitted
            // rather than carried as dead state. Their absence cannot change any output series.
            if !prev_bear_low.is_nan() {
                prior_bear_low = prev_bear_low;
            }
            prev_bear_low = cur_bear_low;
            if !cur_bear_low.is_nan() && !prior_bear_low.is_nan() {
                if cur_bear_low < prior_bear_low {
                    cur_bull_pat = pattern::LL;
                    pat_just = true;
                } else if cur_bear_low > prior_bear_low {
                    cur_bull_pat = pattern::HL;
                    pat_just = true;
                }
            }
            in_bull = true;
            in_bear = false;
            cur_bull_high = b.h[i];
            cur_bear_low = f64::NAN;
        } else if !in_bear && o < 0.0 && o_prev >= 0.0 {
            if !prev_bull_high.is_nan() {
                prior_bull_high = prev_bull_high;
            }
            prev_bull_high = cur_bull_high;
            if !cur_bull_high.is_nan() && !prior_bull_high.is_nan() {
                if cur_bull_high > prior_bull_high {
                    cur_bear_pat = pattern::HH;
                    pat_just = true;
                } else if cur_bull_high < prior_bull_high {
                    cur_bear_pat = pattern::LH;
                    pat_just = true;
                }
            }
            in_bear = true;
            in_bull = false;
            cur_bear_low = b.l[i];
            cur_bull_high = f64::NAN;
        }

        if in_bull {
            cur_bull_high = jmax(cur_bull_high, b.h[i]);
        }
        if in_bear {
            cur_bear_low = jmin(cur_bear_low, b.l[i]);
        }

        let mut s = f64::NAN;
        if in_bull {
            s = prev_bear_low;
        } else if in_bear {
            s = prev_bull_high;
        }
        stop_s[i] = s;
        if s.is_nan()
            && !stop_s[i - 1].is_nan()
            && ((in_bull && o > 0.0) || (in_bear && o < 0.0))
        {
            // Output-only carry; never written back to stop_s (dead after the first two trends).
            s = stop_s[i - 1];
        }
        stop[i] = s;

        bull_pat[i] = if pat_just && in_bull && cur_bull_pat != pattern::NONE {
            cur_bull_pat
        } else {
            bull_pat[i - 1]
        };
        bear_pat[i] = if pat_just && in_bear && cur_bear_pat != pattern::NONE {
            cur_bear_pat
        } else {
            bear_pat[i - 1]
        };
        pat_just = false;

        curr_lag_hh[i] = if in_bear && !stop_s[i].is_nan() { stop_s[i] } else { curr_lag_hh[i - 1] };
        curr_lag_ll[i] = if in_bull && !stop_s[i].is_nan() { stop_s[i] } else { curr_lag_ll[i - 1] };

        // Pending-breakout overwrite AFTER the pattern write, same bar.
        if in_bull && !curr_lag_hh[i].is_nan() && b.h[i] > curr_lag_hh[i] {
            bear_pat[i] = pattern::NHH;
        }
        if in_bear && !curr_lag_ll[i].is_nan() && b.l[i] < curr_lag_ll[i] {
            bull_pat[i] = pattern::NLL;
        }
    }
}
