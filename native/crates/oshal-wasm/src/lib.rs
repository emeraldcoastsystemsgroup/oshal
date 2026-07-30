//! Raw WebAssembly ABI over [`oshal_kernel`]. Deliberately dependency-free.
//!
//! WHY WASM AND NOT A `.node` ADDON. A native addon has to match Node's C++ ABI, which on Windows
//! means the MSVC toolchain, and has to be rebuilt per platform per Node major. A `.wasm` module is
//! ONE artifact that runs identically on every platform Node runs on, loads through the built-in
//! `WebAssembly` global with no node-gyp and no npm build dependency, and also runs in the browser
//! — which matters because the cockpit is a browser surface that may eventually want this math.
//! The cost is roughly 1.2–1.5× native speed, which is noise against the ~10× we are chasing.
//!
//! WHY NO wasm-bindgen. wasm-bindgen would add a build-time npm dependency and a generated JS
//! shim, to marshal what is already just `f64` buffers. Three exported functions and direct
//! `Float64Array` views over linear memory are simpler, and the zero-copy read-out is only
//! possible because we control the layout.
//!
//! MEMORY CONTRACT — the one thing a caller can get wrong. [`kernel_alloc`] leaks by design: the
//! returned buffers live for the module instance's lifetime and are reused across calls. The
//! `Float64Array` views JS builds over them are invalidated if linear memory GROWS, which happens
//! when a later call needs a bigger buffer. So: a view is valid until the next [`kernel_compute`]
//! with a larger `n`. The loader enforces this by rebuilding its views whenever it reallocates.
//!
//! CHANGE LOG
//! -----------------------------------------------------------------------------
//! SEQ                 | AUTHOR                      | DESCRIPTION
//! -----------------------------------------------------------------------------
//! 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — kernel_alloc / kernel_compute / layout-constant exports over the raw wasm ABI.

use oshal_kernel::{compute, PARAM_COUNT, SERIES_COUNT};

// No #[panic_handler] here: this crate links std (for Vec), and std already supplies one.
// `panic = "abort"` in the workspace profile is what turns a kernel assert into a wasm trap,
// which surfaces JS-side as a RuntimeError — the loader treats that as "fall back to TS".

/// Allocates a zeroed `len`-element `f64` buffer and returns its byte offset in linear memory.
///
/// The allocation is LEAKED on purpose — see the module's memory contract. The loader allocates
/// once per size class and reuses; a backtest sweep over one bar series allocates exactly once.
///
/// # Safety
/// Returns a pointer into wasm linear memory. Valid until linear memory grows.
#[no_mangle]
pub extern "C" fn kernel_alloc(len: usize) -> *mut f64 {
    let mut v = vec![0.0f64; len];
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

/// Computes every indicator series. See [`oshal_kernel::compute`] for the buffer layouts.
///
/// # Safety
/// All three pointers must come from [`kernel_alloc`] and be at least the required length:
/// `bars` ≥ `5*n`, `params` ≥ [`PARAM_COUNT`], `out` ≥ [`SERIES_COUNT`]`*n`. The caller (the
/// loader) is the only thing that ever constructs these, and it derives all three from `n`.
#[no_mangle]
pub unsafe extern "C" fn kernel_compute(
    bars: *const f64,
    n: usize,
    params: *const f64,
    out: *mut f64,
) {
    let bars = core::slice::from_raw_parts(bars, 5 * n);
    let params = core::slice::from_raw_parts(params, PARAM_COUNT);
    let out = core::slice::from_raw_parts_mut(out, SERIES_COUNT * n);
    compute(bars, n, params, out);
}

/// Number of output series the module writes — the loader cross-checks its own constant against
/// this so an ABI drift fails loudly at load rather than silently misreading columns.
#[no_mangle]
pub extern "C" fn kernel_series_count() -> usize {
    SERIES_COUNT
}

/// Number of params the module expects; cross-checked by the loader for the same reason.
#[no_mangle]
pub extern "C" fn kernel_param_count() -> usize {
    PARAM_COUNT
}

/// ABI revision. BUMP THIS whenever the meaning or order of a param or series slot changes, even if
/// the counts stay the same — the counts alone cannot detect a reordering, and a reordered column
/// read as the old one is a silently wrong backtest.
#[no_mangle]
pub extern "C" fn kernel_abi_version() -> usize {
    1
}
