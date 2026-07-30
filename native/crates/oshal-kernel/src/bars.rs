//! Columnar bar storage.
//!
//! The TS side holds bars as an array of `{o,h,l,c,v}` objects. That layout costs a pointer
//! dereference and a hidden-class property lookup per field access, and the indicator layer does
//! roughly 15 full passes over every bar — so the object overhead is paid ~75 times per bar per
//! backtest. Columnar `&[f64]` slices are the single largest reason the Rust port is faster; it is
//! a memory-layout win, not a "Rust is fast" win, and the same change in TS would recover part of
//! it (see ARCHITECTURE.md "Where the speedup actually comes from").
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — column-major bar view over a caller-owned f64 buffer.

/// A borrowed, column-major view of `n` OHLCV bars, oldest first.
///
/// All five slices are exactly `n` long. Construct with [`Bars::from_flat`], which splits the
/// single `5 * n` buffer the ABI layer receives — that packing lets the caller hand over one
/// allocation instead of five.
pub struct Bars<'a> {
    pub o: &'a [f64],
    pub h: &'a [f64],
    pub l: &'a [f64],
    pub c: &'a [f64],
    pub v: &'a [f64],
}

impl<'a> Bars<'a> {
    /// Splits a column-major `[o(n) | h(n) | l(n) | c(n) | v(n)]` buffer into a [`Bars`] view.
    ///
    /// # Panics
    /// If `flat.len() != 5 * n`. The ABI layer validates length before calling, so a panic here
    /// means the JS and Rust sides disagree about the packing — a build-integrity bug, not input
    /// data, and it should abort rather than compute on garbage.
    pub fn from_flat(flat: &'a [f64], n: usize) -> Self {
        assert_eq!(flat.len(), 5 * n, "bar buffer must be exactly 5*n f64");
        let (o, rest) = flat.split_at(n);
        let (h, rest) = rest.split_at(n);
        let (l, rest) = rest.split_at(n);
        let (c, v) = rest.split_at(n);
        Bars { o, h, l, c, v }
    }

    /// Number of bars in the view.
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.c.len()
    }

    /// True when the view holds no bars.
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.c.is_empty()
    }

    /// Typical price `(h + l + c) / 3` at bar `i` — the MFI's flow basis.
    #[inline(always)]
    pub fn typical(&self, i: usize) -> f64 {
        (self.h[i] + self.l[i] + self.c[i]) / 3.0
    }

    /// Median price `(h + l) / 2` at bar `i` — the Ehlers trendline's source.
    #[inline(always)]
    pub fn median_price(&self, i: usize) -> f64 {
        (self.h[i] + self.l[i]) / 2.0
    }
}
