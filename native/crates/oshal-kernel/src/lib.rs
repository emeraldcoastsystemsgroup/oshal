//! oshal native indicator kernel — the compute half of the ADR-116 futures indicator layer.
//!
//! WHAT THIS IS: a faithful Rust port of the ~900 lines of pure numeric code in
//! `src/features/trading/services/futures-{indicators,trail-stops,entry-indicators,wave-tracking}.ts`.
//! One [`compute`] call produces every series the backtester's precompute step needs, so the
//! FFI boundary is crossed ONCE PER RUN rather than once per indicator or (catastrophically) once
//! per bar.
//!
//! WHAT THIS IS NOT: the backtester. Fill simulation, the entry evaluator and the stop engine stay
//! in TypeScript — they are branchy business logic that costs a single pass, and porting them would
//! double the surface that has to stay in parity for no measurable gain. See ARCHITECTURE.md.
//!
//! THE TS IS THE REFERENCE IMPLEMENTATION. This crate is an optimization of it. If the two
//! disagree, this crate is wrong.
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Params/Series layout and the single-call compute entry over the four ported indicator modules.

pub mod bars;
pub mod entry;
pub mod indicators;
pub mod jsmath;
pub mod trail_stops;
pub mod wave;

use bars::Bars;
use entry::SsCoeffs;
use wave::WaveOut;

/// Number of `f64` slots in the params buffer. Indices are given by [`P`].
pub const PARAM_COUNT: usize = 36;

/// Params buffer indices. The JS side writes this buffer; the two definitions must stay in step,
/// which the parity guard enforces by driving both implementations from one config object.
#[allow(non_snake_case)]
pub mod P {
    pub const ATR_PERIOD: usize = 0;
    pub const DMI_DI_LENGTH: usize = 1;
    pub const DMI_ADX_SMOOTHING: usize = 2;
    pub const LARSI_ALPHA: usize = 3;
    pub const LARSI_SMOOTHING: usize = 4;
    pub const MEDIAN_PERIOD: usize = 5;
    pub const CHAND_PERIOD: usize = 6;
    pub const CHAND_MULTIPLIER: usize = 7;
    pub const CHAND_USE_HIGH_LOW: usize = 8;
    pub const TICK_SIZE: usize = 9;
    pub const ST_BASE_PERIOD: usize = 10;
    pub const ST_RANGE_PERIOD: usize = 11;
    pub const ST_MULTIPLIER: usize = 12;
    pub const SAR_ACCEL: usize = 13;
    pub const SAR_STEP: usize = 14;
    pub const SAR_MAX: usize = 15;
    pub const OSC_GAMMA: usize = 16;
    pub const OSC_RMS_LENGTH: usize = 17;
    pub const OSC_C1: usize = 18;
    pub const OSC_C2: usize = 19;
    pub const OSC_C3: usize = 20;
    pub const FILT_GAMMA: usize = 21;
    pub const FILT_C1: usize = 22;
    pub const FILT_C2: usize = 23;
    pub const FILT_C3: usize = 24;
    pub const MFI_PERIOD: usize = 25;
    pub const ADAPTIVE_PERIOD: usize = 26;
    pub const MACD_FAST: usize = 27;
    pub const MACD_SLOW: usize = 28;
    pub const MACD_SMOOTH: usize = 29;
    pub const EHLERS_ALPHA: usize = 30;
    pub const LWS_GAMMA: usize = 31;
    pub const LWS_RMS_LENGTH: usize = 32;
    pub const LWS_C1: usize = 33;
    pub const LWS_C2: usize = 34;
    pub const LWS_C3: usize = 35;
}

/// Number of output series [`compute`] writes. The output buffer is `SERIES_COUNT * n` f64,
/// column-major, so series `s` occupies `out[s*n .. (s+1)*n]`.
pub const SERIES_COUNT: usize = 40;

/// Output series indices. Mirrored on the JS side by `SERIES` in `native/loader/series.ts`.
#[allow(non_snake_case)]
pub mod S {
    pub const ATR: usize = 0;
    pub const ADX: usize = 1;
    pub const PLUS_DI: usize = 2;
    pub const MINUS_DI: usize = 3;
    pub const LARSI: usize = 4;
    pub const LARSI_AVG: usize = 5;
    pub const MEDIAN_CLOSE: usize = 6;
    pub const CHAND_STOP_LONG: usize = 7;
    pub const CHAND_STOP_SHORT: usize = 8;
    pub const CHAND_TREND: usize = 9;
    pub const ST_STOP_DOT: usize = 10;
    pub const ST_TREND: usize = 11;
    pub const PSAR: usize = 12;
    pub const PSAR_IS_LONG: usize = 13;
    pub const LAG_OSC: usize = 14;
    pub const LAG_FILTER: usize = 15;
    pub const MFI: usize = 16;
    pub const ADAPTIVE_LAG: usize = 17;
    // MACD wave
    pub const MACD_LINE: usize = 18;
    pub const MACD_SIGNAL: usize = 19;
    pub const MACD_IS_BULL: usize = 20;
    pub const MACD_IS_BEAR: usize = 21;
    pub const MACD_BEAR_LOW: usize = 22;
    pub const MACD_BULL_HIGH: usize = 23;
    // DMI wave
    pub const DMIW_FAST: usize = 24;
    pub const DMIW_SLOW: usize = 25;
    pub const DMIW_IS_BULL: usize = 26;
    pub const DMIW_IS_BEAR: usize = 27;
    pub const DMIW_BEAR_LOW: usize = 28;
    pub const DMIW_BULL_HIGH: usize = 29;
    pub const DMIW_ADX: usize = 30;
    // Ehlers instantaneous-trendline wave
    pub const EHL_TRIGGER: usize = 31;
    pub const EHL_ITREND: usize = 32;
    pub const EHL_IS_BULL: usize = 33;
    pub const EHL_IS_BEAR: usize = 34;
    pub const EHL_BEAR_LOW: usize = 35;
    pub const EHL_BULL_HIGH: usize = 36;
    // Laguerre wave stops
    pub const LWS_STOP: usize = 37;
    pub const LWS_BULL_PAT: usize = 38;
    pub const LWS_BEAR_PAT: usize = 39;
}

/// Splits the column-major output buffer into `SERIES_COUNT` disjoint `n`-long mutable slices.
///
/// `split_at_mut` in a loop is how we hand several `&mut [f64]` into one call without unsafe and
/// without the borrow checker rejecting overlapping indices.
fn split_series(out: &mut [f64], n: usize) -> Vec<&mut [f64]> {
    let mut rest = out;
    let mut cols = Vec::with_capacity(SERIES_COUNT);
    for _ in 0..SERIES_COUNT {
        let (head, tail) = rest.split_at_mut(n);
        cols.push(head);
        rest = tail;
    }
    cols
}

/// Computes every indicator series for `bars_flat` into `out`.
///
/// `bars_flat` is column-major `[o|h|l|c|v]`, each `n` long. `params` is [`PARAM_COUNT`] f64 laid
/// out per [`P`]. `out` is `SERIES_COUNT * n` f64, column-major per [`S`].
///
/// # Panics
/// If any buffer length disagrees with `n`. That is a build-integrity failure (JS and Rust
/// disagreeing on the ABI), and aborting beats computing on misaligned memory.
pub fn compute(bars_flat: &[f64], n: usize, params: &[f64], out: &mut [f64]) {
    assert_eq!(params.len(), PARAM_COUNT, "params must be exactly PARAM_COUNT f64");
    assert_eq!(out.len(), SERIES_COUNT * n, "out must be exactly SERIES_COUNT*n f64");
    if n == 0 {
        return;
    }

    // ZERO THE OUTPUT FIRST — load-bearing, do not remove.
    //
    // Several ported functions write only part of their series and rely on the rest reading 0,
    // because the TS they mirror allocates `new Array(n).fill(0)` per call: dmi_adx skips bar 0,
    // the SuperSmoother-based filters start at bar 4, the Ehlers trendline at bar 2, and the wave
    // machines' regime flags at `flag_from`. The loader REUSES its output buffer across calls and
    // only reallocates when the bar count grows, so on the second call those slots would otherwise
    // hold the previous run's values — a wrong-but-plausible backtest with no error.
    //
    // Found by `tests/unit/native-indicator-parity.spec.ts` "buffer reuse across calls", which is
    // the only test that exercises a smaller series after a larger one.
    out.fill(0.0);

    let b = Bars::from_flat(bars_flat, n);
    let p = params;
    let mut c = split_series(out, n);

    // ── Layer 1: standalone indicators ───────────────────────────────────────
    indicators::wilder_atr(&b, p[P::ATR_PERIOD] as usize, c[S::ATR]);

    {
        let (adx, plus_di, minus_di) = take3(&mut c, S::ADX, S::PLUS_DI, S::MINUS_DI);
        indicators::dmi_adx(
            &b,
            p[P::DMI_DI_LENGTH] as usize,
            p[P::DMI_ADX_SMOOTHING] as usize,
            adx,
            plus_di,
            minus_di,
        );
    }

    {
        let (la, avg) = take2(&mut c, S::LARSI, S::LARSI_AVG);
        indicators::laguerre_rsi(b.c, p[P::LARSI_ALPHA], p[P::LARSI_SMOOTHING], la, avg);
    }

    indicators::moving_median(b.c, p[P::MEDIAN_PERIOD] as usize, c[S::MEDIAN_CLOSE]);

    // ── Layer 2: trail stops ─────────────────────────────────────────────────
    {
        let (sl, ss, tr) = take3(&mut c, S::CHAND_STOP_LONG, S::CHAND_STOP_SHORT, S::CHAND_TREND);
        trail_stops::chandelier_bands(
            &b,
            p[P::CHAND_PERIOD] as usize,
            p[P::CHAND_MULTIPLIER],
            p[P::CHAND_USE_HIGH_LOW] != 0.0,
            p[P::TICK_SIZE],
            sl,
            ss,
            tr,
        );
    }

    {
        let (sd, tr) = take2(&mut c, S::ST_STOP_DOT, S::ST_TREND);
        trail_stops::super_trend_m11(
            &b,
            p[P::ST_BASE_PERIOD] as usize,
            p[P::ST_RANGE_PERIOD] as usize,
            p[P::ST_MULTIPLIER],
            p[P::TICK_SIZE],
            sd,
            tr,
        );
    }

    {
        let (ps, il) = take2(&mut c, S::PSAR, S::PSAR_IS_LONG);
        trail_stops::parabolic_sar(&b, p[P::SAR_ACCEL], p[P::SAR_STEP], p[P::SAR_MAX], ps, il);
    }

    // ── Layer 3: entry indicators ────────────────────────────────────────────
    let osc_k = SsCoeffs { c1: p[P::OSC_C1], c2: p[P::OSC_C2], c3: p[P::OSC_C3] };
    let filt_k = SsCoeffs { c1: p[P::FILT_C1], c2: p[P::FILT_C2], c3: p[P::FILT_C3] };
    let lws_k = SsCoeffs { c1: p[P::LWS_C1], c2: p[P::LWS_C2], c3: p[P::LWS_C3] };

    entry::laguerre_oscillator(
        b.c,
        p[P::OSC_GAMMA],
        p[P::OSC_RMS_LENGTH] as usize,
        osc_k,
        c[S::LAG_OSC],
    );
    entry::laguerre_filter(b.c, p[P::FILT_GAMMA], filt_k, c[S::LAG_FILTER]);
    entry::mfi(&b, p[P::MFI_PERIOD] as usize, c[S::MFI]);
    entry::adaptive_laguerre_filter(b.c, p[P::ADAPTIVE_PERIOD] as usize, c[S::ADAPTIVE_LAG]);

    // ── Layer 4: wave trackers ───────────────────────────────────────────────
    {
        let [line, signal, bull, bear, blow, bhigh] = take6(
            &mut c,
            [S::MACD_LINE, S::MACD_SIGNAL, S::MACD_IS_BULL, S::MACD_IS_BEAR, S::MACD_BEAR_LOW, S::MACD_BULL_HIGH],
        );
        wave::macd_wave(
            &b,
            p[P::MACD_FAST],
            p[P::MACD_SLOW],
            p[P::MACD_SMOOTH],
            line,
            signal,
            WaveOut { is_bullish: bull, is_bearish: bear, last_bear_wave_low: blow, last_bull_wave_high: bhigh },
        );
    }

    {
        let [fast, slow, bull, bear, blow, bhigh] = take6(
            &mut c,
            [S::DMIW_FAST, S::DMIW_SLOW, S::DMIW_IS_BULL, S::DMIW_IS_BEAR, S::DMIW_BEAR_LOW, S::DMIW_BULL_HIGH],
        );
        let adx = take1(&mut c, S::DMIW_ADX);
        wave::dmi_wave(
            &b,
            p[P::DMI_DI_LENGTH] as usize,
            p[P::DMI_ADX_SMOOTHING] as usize,
            fast,
            slow,
            adx,
            WaveOut { is_bullish: bull, is_bearish: bear, last_bear_wave_low: blow, last_bull_wave_high: bhigh },
        );
    }

    {
        let [trig, itrend, bull, bear, blow, bhigh] = take6(
            &mut c,
            [S::EHL_TRIGGER, S::EHL_ITREND, S::EHL_IS_BULL, S::EHL_IS_BEAR, S::EHL_BEAR_LOW, S::EHL_BULL_HIGH],
        );
        wave::ehlers_inst_trend_wave(
            &b,
            p[P::EHLERS_ALPHA],
            trig,
            itrend,
            WaveOut { is_bullish: bull, is_bearish: bear, last_bear_wave_low: blow, last_bull_wave_high: bhigh },
        );
    }

    {
        let (stop, bull_pat, bear_pat) =
            take3(&mut c, S::LWS_STOP, S::LWS_BULL_PAT, S::LWS_BEAR_PAT);
        wave::laguerre_wave_stops(
            &b,
            p[P::LWS_GAMMA],
            p[P::LWS_RMS_LENGTH] as usize,
            lws_k,
            stop,
            bull_pat,
            bear_pat,
        );
    }
}

/// Borrows one output column mutably out of the split vector.
fn take1<'a>(cols: &mut [&'a mut [f64]], i: usize) -> &'a mut [f64] {
    std::mem::take(&mut cols[i])
}

/// Borrows two distinct output columns mutably. Indices MUST differ.
fn take2<'a>(cols: &mut [&'a mut [f64]], a: usize, b: usize) -> (&'a mut [f64], &'a mut [f64]) {
    debug_assert_ne!(a, b);
    (std::mem::take(&mut cols[a]), std::mem::take(&mut cols[b]))
}

/// Borrows three distinct output columns mutably. Indices MUST differ.
fn take3<'a>(
    cols: &mut [&'a mut [f64]],
    a: usize,
    b: usize,
    c: usize,
) -> (&'a mut [f64], &'a mut [f64], &'a mut [f64]) {
    debug_assert!(a != b && b != c && a != c);
    (
        std::mem::take(&mut cols[a]),
        std::mem::take(&mut cols[b]),
        std::mem::take(&mut cols[c]),
    )
}

/// Borrows six distinct output columns mutably — the wave machine's output set.
fn take6<'a>(cols: &mut [&'a mut [f64]], idx: [usize; 6]) -> [&'a mut [f64]; 6] {
    idx.map(|i| std::mem::take(&mut cols[i]))
}
