# `native/` — architecture and the decisions behind it

Five choices shape this folder. Each had a plausible alternative that was rejected for a stated
reason, so a future reader can tell a decision from an accident.

---

## 1. The boundary: native math, TypeScript orchestration

The ADR-116 futures stack is roughly 1,900 lines across six modules. Only ~900 of them got ported.

| module | lines | ported? | why |
|---|---|---|---|
| `futures-indicators.ts` | 191 | ✅ | pure numeric, 15 full passes per run |
| `futures-trail-stops.ts` | 259 | ✅ | pure numeric, holds the single hottest pass |
| `futures-entry-indicators.ts` | 205 | ✅ | pure numeric, recursive filters |
| `futures-wave-tracking.ts` | 251 | ✅ | pure numeric, state machine over series |
| `futures-entry-evaluator.ts` | 537 | ❌ | branchy business logic, one pass |
| `futures-stop-engine.ts` | 499 | ❌ | branchy business logic, one pass |
| `futures-backtester.ts` | 678 | ❌ | fill simulation + I/O shape |

The rule: **port what is a numeric pass over N bars; keep what is a decision about a trade.** The
indicator layer is called ~15 times over every bar and dominates the profile. The evaluator and stop
engine run once per bar inside the existing bar-walk, cost comparatively nothing, and are where the
NT8 semantics that matter to the trader live. Porting them would double the surface that must stay
in parity for no measurable gain — the worst possible trade in a two-implementation system.

### Amdahl's law set the scope, not taste

Porting the top-6 offenders only (87% of profile time) at 10× each would cap total speedup at
1/(0.13 + 0.87/10) ≈ **4.6×**. Porting the whole layer removes the ceiling. That is why all 15
indicators went over rather than a cherry-picked subset — and why a half-ported layer with the
kernel calling back into TS per indicator was never on the table.

## 2. One FFI crossing per run

The boundary is crossed **once per backtest**, not once per indicator and emphatically not once per
bar. `compute()` takes the whole bar series and returns all 40 output series.

Per-bar FFI would have been catastrophic: at 1.7M bars × 15 indicators, boundary overhead alone
would exceed the compute it was meant to accelerate. This is the single most important shape
decision in the folder, and it is why the ABI is "one big buffer in, one big buffer out" rather than
a set of ergonomic per-indicator functions.

## 3. WebAssembly, not a native `.node` addon

| | WASM (chosen) | native addon |
|---|---|---|
| Windows toolchain | rustup + GNU host, ~400MB, self-contained linker | MSVC build tools, ~2GB |
| artifacts to ship | **one** `.wasm`, 40KB | one per OS × arch × Node major |
| build deps | none — `WebAssembly` is built into Node | node-gyp, napi-rs, a generated shim |
| runs in the browser | yes — the cockpit is a browser surface | no |
| speed | ~1.2–1.5× slower than native | baseline |

Giving up 1.2–1.5× is noise against the 5–7× being chased, and it buys away the entire per-platform
build matrix and ABI-compatibility problem. A native addon becomes worth revisiting only if the
kernel ever needs SIMD or threads that WASM cannot reach.

**No `wasm-bindgen`**, either: it would add a build-time npm dependency and a generated JS shim to
marshal what is already just `f64` buffers. Three exported functions over raw linear memory is
smaller, has no supply chain, and is what makes the zero-copy read-out possible.

## 4. Bit parity

The parity guard asserts **0 ULP** — identical doubles, not "within epsilon". Two decisions made
that reachable:

**The SuperSmoother coefficients are computed in JavaScript and passed in.** They need `exp` and
`cos`, and Rust's libm is not bit-identical to V8's `Math`. A one-ULP difference in `c1/c2/c3` feeds
an IIR filter, compounds along the series, and would force a tolerance that grows with bar count —
exactly the kind of "close enough" that hides a real divergence later. Moving three
transcendental calls to the caller removed the whole problem class. `sqrt` stays in Rust because
IEEE-754 requires it to be exact.

**`jsmath.rs` reproduces ECMAScript `Math.max`/`Math.min` NaN semantics.** `Math.max(NaN, 5)` is
`NaN` in JavaScript; `f64::max(NAN, 5.0)` is `5.0` in Rust. Several indicators carry a
deliberately-NaN accumulator through a `Math.max` and the TS behaviour is load-bearing. Kernel code
never calls `f64::max` — a `.max(` in this crate should be treated as a defect on sight.

**Direction of authority: the TypeScript is the reference implementation.** When the two disagree,
the Rust is wrong. The guard's failure message says so, because the tempting fix under time pressure
is to widen the tolerance, and that would silently discard the property the whole folder exists to
provide.

## 5. Optional by construction

`native/dist/oshal_kernel.wasm` is a build product and **untracked**. A checkout without it is a
supported state:

- `loadKernel()` returns `null` → callers use `computeReference()` → identical numbers.
- `build.js` exits **0** with an explanation when cargo is absent. A missing toolchain is not an
  error anywhere in this repo; only a toolchain that is *present and failing* exits non-zero.
- The parity spec asserts the fallback contract in the absent case rather than skipping — a spec
  that silently skips is a guard that does not exist (CLAUDE.md).

This is what lets the track land without putting Rust on anyone's critical path. No bot node, no CI
job, and no `oshal-up.sh` bring-up can fail because Rust is missing. It is also why nothing under
`src/` was modified: the change is purely additive, and reverting it is deleting a folder.

### Fail loud on drift, fail soft on absence

Absence is fine. A `.wasm` whose ABI version or buffer counts disagree with `series.ts` is **not** —
that is a stale artifact beside newer JS, and reading the old column layout would produce a
plausible, wrong backtest. The loader refuses such a module and names the fix. `kernel_abi_version()`
exists for the case where the counts match but a slot's *meaning* moved, which counts alone cannot
detect.

---

## Where the speedup actually comes from

Worth being precise, because "Rust is fast" is not the explanation and would mislead the next
person deciding what to port:

1. **Columnar `&[f64]` instead of an array of `{o,h,l,c,v}` objects.** ~15 passes × 5 fields per bar
   of pointer-chasing and hidden-class lookups, gone. Probably the largest single contributor — and
   recoverable in TypeScript with `Float64Array` columns, without any of this folder.
2. **No per-bar allocation.** `movingMedian` allocated a fresh sorted slice per bar (97ms/200k
   bars); `adaptiveLaguerreFilter` did the same for its median-of-5. Both now sort in a reused
   buffer.
3. **One output buffer reused across calls** instead of ~40 fresh arrays per call. This is why the
   TS side is GC-bound and its timings drift while the kernel's do not.
4. **Then** the usual compiled-code wins: real f64 registers, no boxing, inlined helpers.

Items 1–3 are *layout and allocation* wins. That is the transferable lesson: before porting anything
else here, check whether the same change in TypeScript gets most of it.

## Known sharp edges

- **Zero-copy views expire.** `compute()`'s arrays are windows into WASM linear memory, invalidated
  by the next call (memory growth detaches them). `Float64Array.from(v)` to retain. Costs ~0.5× of
  the speedup at 400k bars — still 5.2× measured.
- **The output buffer must be zeroed each call.** Several ports write only part of their series and
  rely on the rest reading 0, mirroring the TS's `new Array(n).fill(0)`. Because the loader reuses
  buffers, `compute()` starts with `out.fill(0.0)`. Removing it produces correct results on the
  first call and wrong ones after — caught by the "buffer reuse across calls" case, which is the only
  test that runs a smaller series after a larger one.
- **`bench/bars.ts` is not a market simulator.** Seeded random walk, no drift, no volatility
  clustering, no session structure. Fine for throughput and for crossing warmup branches; never for
  a strategy result.
