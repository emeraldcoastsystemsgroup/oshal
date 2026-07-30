//! JavaScript `Math.max` / `Math.min` semantics.
//!
//! THIS MODULE EXISTS BECAUSE OF ONE BUG CLASS. `Math.max(NaN, 5)` is `NaN` in JavaScript, but
//! `f64::max(f64::NAN, 5.0)` is `5.0` in Rust — IEEE-754 `maxNum` ignores a NaN operand while
//! ECMAScript propagates it. Several of the ported indicators carry a deliberately-NaN
//! accumulator through a `Math.max` (the wave trackers' `curBullHigh` before a wave opens,
//! `longExtreme` before the chandelier seeds), and the TS behaviour there is load-bearing for
//! parity with the trader's NinjaTrader output.
//!
//! So: never call `f64::max`/`f64::min` in this crate. Call [`jmax`]/[`jmin`]. The parity guard
//! in `tests/unit/native-indicator-parity.spec.ts` is what actually proves this, but a reviewer
//! reading a `.max(` in kernel code should treat it as a defect on sight.
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — NaN-propagating max/min matching ECMAScript, plus the running-extreme helpers.

/// Returns the larger of `a` and `b`, propagating NaN like ECMAScript `Math.max`.
#[inline(always)]
pub fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// Returns the smaller of `a` and `b`, propagating NaN like ECMAScript `Math.min`.
#[inline(always)]
pub fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// Three-argument `Math.max`, NaN-propagating.
#[inline(always)]
pub fn jmax3(a: f64, b: f64, c: f64) -> f64 {
    jmax(jmax(a, b), c)
}

/// Three-argument `Math.min`, NaN-propagating.
#[inline(always)]
pub fn jmin3(a: f64, b: f64, c: f64) -> f64 {
    jmin(jmin(a, b), c)
}

/// Ascending median of `buf[..len]`, matching the TS `slice().sort((a,b)=>a-b)` then
/// even-count-averages-the-two-middle rule. Sorts `buf` in place; `len` must be ≥ 1.
///
/// Uses insertion sort: every caller in this crate passes `len <= 8`, where insertion sort beats
/// a comparison sort and — unlike the TS original — allocates nothing.
#[inline]
pub fn median_in_place(buf: &mut [f64], len: usize) -> f64 {
    let s = &mut buf[..len];
    for i in 1..len {
        let v = s[i];
        let mut j = i;
        while j > 0 && s[j - 1] > v {
            s[j] = s[j - 1];
            j -= 1;
        }
        s[j] = v;
    }
    if len % 2 == 0 {
        0.5 * (s[len / 2] + s[len / 2 - 1])
    } else {
        s[(len - 1) / 2]
    }
}
