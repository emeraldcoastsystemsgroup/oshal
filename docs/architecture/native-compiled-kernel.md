<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the engineering write-up of the native/ compiled-kernel track: the profiling that scoped it, the WASM/boundary/bit-parity decisions, the measured result with its variance, and what remains open.
-->

# Compiling oshal: what actually pays

**Status — 2026-07-29: SHIPPED (PR #39), not yet wired into the backtester.** The kernel and its
guard are on `main`. `futures-backtester.ts` still calls the TypeScript path; switching it over is
tracked in [native/ROADMAP.md](../../native/ROADMAP.md).

This is the engineering record of a question that turned out to have two different answers depending
on which half of the system you asked about. The code and its own docs live in
[native/](../../native/README.md); this document is the reasoning, for readers deciding whether to
do something similar elsewhere.

---

## The question

> "We're running on TypeScript, CSS and JavaScript. If it were converted to a real installable
> application — C++ or something that compiles — what would that take, and would we get a
> performance improvement?"

Two questions wearing one coat:

1. Would **compiling** make it faster?
2. What would a **real installable application** take?

They have different answers, and conflating them is how a team ends up doing a rewrite to solve a
packaging problem.

## Answer 1: measure before you rewrite

The controller was profiled on the running stack, not reasoned about:

| path | time |
|---|---|
| `/api/health` (pure JS, no I/O) | 4–5 ms |
| `/api/agents` (JS + one Postgres round-trip) | 6–35 ms |
| any LLM dispatch | 2,000–120,000 ms |

The architecture is the explanation. Per [CLAUDE.md](../../CLAUDE.md), the swarm controller **never
calls an LLM** — it routes, queues, dispatches to bot nodes, and waits. That is an I/O-bound
workload, and a compiled rewrite optimizes the 4 ms while the 30,000 ms stays exactly where it is.

Two further facts make a platform rewrite worse than merely pointless:

- **The harnesses are Node programs.** The Claude Code, Codex and Gemini CLIs are npm packages that
  `base-cli-harness-adapter.ts` spawns as subprocesses. A C++ oshal would still ship a Node runtime
  to execute its own bot nodes — two runtimes to install instead of one.
- **Half the surface can't be compiled at all.** The cockpit is 107 files of browser JS. Browsers
  run JavaScript.

Scale of the thing being proposed: 249K lines of TypeScript across 1,167 files, 65K lines of
battle-tested JS in `any-bot/server/`, 579 Playwright specs, and 123 ADRs of encoded decisions.
Against a 0.01% improvement in what a user feels.

**This is recorded as a decision, not an omission.** ROADMAP.md lists "port the controller, cockpit,
or any-bot layer" under *explicitly not planned*, with the profile as the reason. If someone
re-proposes it, the burden is a new profile.

## Answer 2: one CPU-bound cluster, found by profiling

`native/bench/profile-ts.ts` exists to keep the port honest — the rule for the folder is that
nothing gets ported until this shows it costs real time. 200,000 bars through the ADR-116 futures
indicator layer:

| pass | ms | share | ns/bar |
|---|---|---|---|
| `superTrendM11` | 274.2 | 22.0% | 1371 |
| `dmiAdx(14,14)` | 179.6 | 14.4% | 898 |
| `adaptiveLaguerreFilter` | 134.9 | 10.8% | 674 |
| `dmiWave` | 116.2 | 9.3% | 581 |
| `chandelierBands(22)` | 116.1 | 9.3% | 580 |
| `movingMedian(8)` | 97.4 | 7.8% | 487 |
| `laguerreWaveStops` | 87.5 | 7.0% | 437 |
| `macdWave` | 75.3 | 6.0% | 376 |
| *(7 more)* | 163.1 | 13.0% | |
| **TOTAL** | **1244.8** | | |

One 5-year ES 1-minute series is ~1.7M bars, so **one parameter set costs ~10 s** and a
500-combination sweep is about an hour. That is a genuine cost, it is genuinely CPU-bound, and it is
~900 lines of pure numeric code with no I/O — the ideal port target, and the only one in the repo.

## What was built

15 indicators across 4 modules, ported to Rust, shipped as a 40KB WebAssembly module with a
TypeScript loader that falls back when the artifact is absent.

Measured, node 24.11 / win32-x64, zero-copy read-out:

| bars | TS median | WASM median | speedup | across runs |
|---|---|---|---|---|
| 25,000 | 90 ms | 16 ms | 5.6× | 3.7–7.7× |
| 100,000 | 376 ms | 56 ms | 6.7× | 4.9–9.1× |
| 400,000 | 1,474 ms | 250 ms | 5.9× | 4.4–8.5× |

**Posture: measured on a busy box, indicator layer in isolation, not end-to-end.** See
[Honest limits](#honest-limits).

## The five decisions

### 1. Port the numeric pass, keep the decision logic

| module | lines | ported? |
|---|---|---|
| `futures-indicators.ts` | 191 | ✅ |
| `futures-trail-stops.ts` | 259 | ✅ |
| `futures-entry-indicators.ts` | 205 | ✅ |
| `futures-wave-tracking.ts` | 251 | ✅ |
| `futures-entry-evaluator.ts` | 537 | ❌ |
| `futures-stop-engine.ts` | 499 | ❌ |
| `futures-backtester.ts` | 678 | ❌ |

The rule: **port what is a numeric pass over N bars; keep what is a decision about a trade.** The
evaluator and stop engine run once per bar inside the existing bar-walk, cost comparatively nothing,
and hold the NT8 semantics that matter to the trader. Porting them would double the surface that has
to stay in parity for no measurable gain — the worst trade available in a two-implementation system.

**Amdahl's law set the scope, not taste.** Porting only the top-6 offenders (87% of profile time) at
10× each would have capped total speedup at 1/(0.13 + 0.87/10) ≈ **4.6×**. The whole layer went over
to remove that ceiling.

### 2. One FFI crossing per run

`compute()` takes the entire bar series and returns all 40 output series. The boundary is crossed
**once per backtest** — not per indicator, and emphatically not per bar. At 1.7M bars × 15
indicators, per-bar boundary overhead alone would have exceeded the compute it was meant to
accelerate. This is why the ABI is "one big buffer in, one big buffer out" rather than a set of
ergonomic per-indicator functions.

### 3. WebAssembly over a native addon

| | WASM (chosen) | native `.node` addon |
|---|---|---|
| Windows toolchain | rustup GNU host, ~400MB, bundled linker | MSVC build tools, ~2GB |
| artifacts to ship | **one** `.wasm`, 40KB | one per OS × arch × Node major |
| build dependencies | none — `WebAssembly` is in Node | node-gyp, napi-rs, a generated shim |
| runs in a browser | yes | no |
| speed | ~1.2–1.5× slower than native | baseline |

Trading 1.2–1.5× to delete the entire per-platform build matrix and ABI-compatibility problem is a
good trade when the target is 5–7×. `wasm-bindgen` was also declined: it adds a build-time npm
dependency and a generated shim to marshal what is already `f64` buffers, and it would break the
zero-copy read-out.

### 4. Bit parity, not "close enough"

The guard asserts **0 ULP** — identical doubles. Two decisions made that reachable rather than
aspirational:

**The SuperSmoother coefficients are computed in JavaScript and passed in.** They need `exp` and
`cos`, where Rust's libm is not bit-identical to V8's `Math`. A one-ULP difference in `c1/c2/c3`
feeds an IIR filter and compounds along the series — parity would have degraded with bar count,
forcing a tolerance that grows, which is exactly the "close enough" that hides a real divergence
later. Moving three transcendental calls to the caller deleted the problem class. `sqrt` stayed in
Rust because IEEE-754 requires it to be exact.

**`jsmath.rs` reproduces ECMAScript NaN semantics.** `Math.max(NaN, 5)` is `NaN` in JavaScript;
`f64::max(NAN, 5.0)` is `5.0` in Rust. Several indicators carry a deliberately-NaN accumulator
through a `Math.max`, and the TS behaviour is load-bearing. Kernel code never calls `f64::max` — a
`.max(` in that crate is a defect on sight.

**Direction of authority matters as much as the tolerance.** The TypeScript is the reference
implementation; when the two disagree, the Rust is wrong. The guard's failure message says so
explicitly, because the tempting fix under time pressure is to widen the tolerance — which would
silently discard the only property that makes a second implementation safe.

### 5. Optional by construction

`native/dist/oshal_kernel.wasm` is a build product and untracked. A checkout without it is a
supported state:

- `loadKernel()` returns `null` → callers use `computeReference()` → identical numbers.
- `build.js` **exits 0** when cargo is absent. Only a toolchain that is *present and failing* exits
  non-zero.
- The parity spec **asserts the fallback contract** when the artifact is absent rather than skipping
  — a spec that silently skips is a guard that does not exist ([CLAUDE.md](../../CLAUDE.md)).
- Nothing under `src/` was modified.

Verified both ways: **88 tests** with the artifact present, **6** with it stashed. This is what let
the track land without putting a Rust toolchain on anyone's critical path — no bot node, no CI job
and no `oshal-up.sh` bring-up can fail because Rust is missing. Reverting the change is deleting a
folder.

## The bug the guard caught

Worth recording, because it is the exact failure mode the guard-per-fix rule exists for.

First run of the parity spec: `ADX[0]` — reference gave `0`, kernel gave a large stale value.

Several ported functions write only *part* of their series and rely on the rest reading 0, mirroring
the TypeScript's `new Array(n).fill(0)`: `dmi_adx` skips bar 0, the SuperSmoother-based filters start
at bar 4, the Ehlers trendline at bar 2, the wave machines' regime flags at `flag_from`. But the
loader **reuses its output buffer** across calls and only reallocates when the bar count grows. So on
the second call those slots held the previous run's values.

Properties that make it nasty:

- **Correct on the first call, wrong on every call after.**
- **No error either way** — just different numbers.
- It only reproduces when a **smaller** series follows a larger one, which nothing else in the suite
  does.

Fixed with `out.fill(0.0)` at the top of `compute()`, with a comment saying why it must not be
removed.

## Where the speedup actually comes from

Being precise about this matters, because "Rust is fast" is not the explanation and would mislead
whoever picks the next port target:

1. **Columnar `&[f64]` instead of an array of `{o,h,l,c,v}` objects.** ~15 passes × 5 fields per bar
   of pointer-chasing and hidden-class lookups, gone. Probably the largest single contributor.
2. **No per-bar allocation.** `movingMedian` allocated a fresh sorted slice per bar (97 ms/200k
   bars); `adaptiveLaguerreFilter` did the same for its median-of-5. Both now sort in a reused
   buffer.
3. **One output buffer reused across calls** instead of ~40 fresh arrays per call. This is visible
   in the measurements: the WASM timings are tight (238–290 ms at 400k, a 22% spread) while the TS
   timings are loose (1,280–2,013 ms, 57%) because the TS path is GC-bound.
4. **Then** the ordinary compiled-code wins: f64 registers, no boxing, inlined helpers.

**Items 1–3 are layout and allocation wins, and all three are reachable in TypeScript** with
`Float64Array` columns and a reused output buffer. ROADMAP item 3 is to try exactly that before
porting anything else — if plain TS recovers most of the 5–7×, it is strictly better than
maintaining two implementations, and that conclusion should be written down either way.

## Honest limits

Stated here rather than buried, per the anti-drift rules in [CLAUDE.md](../../CLAUDE.md):

- **Every number was measured with the swarm running.** `profile-ts` reported 1,245 ms on one run and
  588 ms on another for identical input — a 2.1× swing. One `compare.ts` run read **11.1×** where
  repeated runs put it near 5×. The benchmark now prints min/median/max specifically so a lucky run
  cannot become a headline. **Nothing has been measured on an idle box, or on Linux.**
- **The figure is for the indicator layer in isolation, not a backtest.** The kernel is not yet
  called from `futures-backtester.ts`, so end-to-end speedup will be lower by whatever share the
  evaluator, stop engine and fill simulation take. That share is unmeasured and should be measured
  before any end-to-end claim.
- **Copying results out of WASM memory costs about half the win** (5.9× → 3.0× at 400k bars). The
  zero-copy view contract is most of the benefit, and it is the API's one sharp edge: views are
  invalidated by the next `compute` call.
- **`bench/bars.ts` is not a market simulator.** Seeded random walk, no drift, no volatility
  clustering, no session structure. Fine for throughput and for crossing warmup branches; never for
  a strategy result.

## The installable-application half

Designed, not built — and the answer changed recently in a way worth knowing: **Node 24.11 ships
what it needs in the runtime.**

| item | mechanism | state |
|---|---|---|
| Single executable | Node SEA (built in since 22) — no `pkg` | **mechanism proven** |
| No-Docker single-user install | `node:sqlite` (built in since 22) | designed |
| Desktop shell | Tauri, reusing this folder's Rust toolchain | designed |
| Faster first boot | bundle the ~80MB ONNX embedding model | designed |

**The SEA mechanism is built and verified.** `node native/build-exe.js` produces `oshal-kernel.exe`
(85.9 MB, Node-runtime-dominated) carrying the compiled kernel *inside* it as a `node:sea` asset.
Confirmed self-contained by copying the single file into an empty directory — no `node_modules`, no
`.wasm`, no repo — and getting `kernel origin: embedded (SEA asset)` and `40/40` bit-exact parity.

That proves bundle → blob → inject works here on a target with **zero native dependencies and zero
external services**. It does not prove the controller can be packaged, and the remaining work is not
the SEA step:

- `pg-native`, `better-sqlite3`, `canvas`, `sharp` are compiled `.node` binaries. A packer can carry
  the bytes; the OS loader cannot `dlopen` them from a virtual filesystem.
- **The controller still needs Postgres and Redis running** — the actual barrier to "installable", and
  a database problem rather than a packaging one. A perfect single binary whose install instructions
  open with "first, set up Docker" has not solved anything.

`scripts/build-executable.js` (the older esbuild → `pkg` chain) is worth one correction, because the
obvious reading is wrong: its output is **not** non-self-contained because of its `--external` flags.
`pkg` runs after esbuild and re-resolves pure-JS modules into its own snapshot, so marking express /
pg / ioredis external merely defers the job to a tool that handles it. It needs files beside it
because its own closing output says so (`dist/pages/`, `dist/config-seed/`, `dist/ai-lab/`), because
of the four native modules above, and because of Postgres/Redis.

**None of this requires a compiled language for the platform.** That is the finding that scoped the
whole effort to the numeric kernel: the installable-app problem and the performance problem are
different problems, and only one of them was ever about compilation. The kernel executable is
evidence for that split — it is a real single file precisely *because* it has no servers to talk to.

## See also

- [native/README.md](../../native/README.md) — what it is, quickstart, how to use it
- [native/ARCHITECTURE.md](../../native/ARCHITECTURE.md) — the decisions, with rejected alternatives
- [native/BENCHMARKS.md](../../native/BENCHMARKS.md) — measured numbers, variance caveat first
- [native/ROADMAP.md](../../native/ROADMAP.md) — today/target, including the installable-app track
- [ADR-116](../adr/116-futures-extension-layer.md) — the futures extension the indicator layer belongs to
