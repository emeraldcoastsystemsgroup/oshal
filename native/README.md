# `native/` — the compiled-kernel track

> **Decision record: [ADR-121](../docs/adr/121-native-compiled-kernel.md).**
> **Status 2026-07-30 —** kernel ✅ shipped · 0-ULP parity guard ✅ 88 tests · single-file executable
> ✅ built and verified standalone · **wired into `futures-backtester.ts` ❌ not yet** ·
> **controller packaged ❌ not, and blocked on Postgres/Redis rather than on compiling.**

A self-contained answer to one question: **would compiling oshal make it faster, and what would it
take to ship it as a real installable application?**

The short version, measured rather than assumed:

- **Compiling the platform buys nothing.** The control plane is I/O-bound. A language rewrite
  targets the ~1% of wall-clock that is not already waiting on an LLM, Postgres, or a subprocess.
- **Compiling the *numeric kernel* buys 5–7×.** There is exactly one CPU-bound cluster in this
  codebase — the ADR-116 futures indicator layer — and this folder ports it to Rust, proves it
  bit-exact against the TypeScript, and measures the win.
- **"Installable application" is a packaging problem, not a language problem**, and Node 24 already
  ships what it needs. Tracked in [ROADMAP.md](ROADMAP.md); not built yet.

Everything here is **additive and optional**. No file under `src/` was modified. If the compiled
artifact is absent — which is the default, since it is a build product and untracked — the loader
returns `null`, callers use the existing TypeScript, and the platform behaves exactly as before.

---

## Why this exists at all

The honest profile of the swarm controller, measured on the running stack:

| path | time |
|---|---|
| `/api/health` (pure JS, no I/O) | 4–5 ms |
| `/api/agents` (JS + one Postgres round-trip) | 6–35 ms |
| any LLM dispatch | 2,000–120,000 ms |

Rewriting the controller in a compiled language optimizes the first row. That is the entire
argument against a rewrite, and it is why this folder does **not** contain one.

Then the indicator layer, same box:

```
$ npx tsx native/bench/profile-ts.ts 200000

superTrendM11                274.2 ms    22.0%
dmiAdx(14,14)                179.6 ms    14.4%
adaptiveLaguerreFilter       134.9 ms    10.8%
dmiWave                      116.2 ms     9.3%
chandelierBands(22)          116.1 ms     9.3%
movingMedian(8)               97.4 ms     7.8%
...
TOTAL                       1244.8 ms
one 5y ES 1-min run (~1.7M bars): 10.6 s
```

Ten seconds for one parameter set. A 500-combination sweep is about an hour. **That** is a real
cost, it is genuinely CPU-bound, and it is 900 lines of pure numeric code with no I/O — the ideal
port target and the only one in the repo.

## What got built

```
native/
├── crates/oshal-kernel/     pure Rust port of the 15 indicators — no FFI, no wasm, `cargo test`-able
├── crates/oshal-wasm/       raw WebAssembly ABI over the kernel (no wasm-bindgen, no npm deps)
├── loader/
│   ├── index.ts             instantiate the .wasm, or return null so callers fall back
│   ├── series.ts            the ABI contract, JS side (40 series, 36 params)
│   └── reference.ts         the TS path projected into the same 40-series shape
├── bench/
│   ├── profile-ts.ts        which passes cost anything (run this before porting more)
│   ├── compare.ts           TS vs WASM, with the run-to-run spread
│   ├── parity.ts            per-series ULP table with first-divergence index
│   └── bars.ts              seeded synthetic bars, shared by bench and guard
├── cli/kernel-cli.ts        standalone CLI: where | bench | parity
├── build.js                 cargo → native/dist/oshal_kernel.wasm
├── build-exe.js             → oshal-kernel.exe, a real single file (Node SEA)
├── ARCHITECTURE.md          why WASM, why this boundary, why bit-exact
├── BENCHMARKS.md            the measured numbers
└── ROADMAP.md               the installable-app track (not built)
```

The machine-checked guard lives with the rest of the suite:
[`tests/unit/native-indicator-parity.spec.ts`](../tests/unit/native-indicator-parity.spec.ts).

## Quickstart

```bash
# 1. Toolchain (once). ~400MB, user-local in ~/.cargo, nothing system-wide.
#    The GNU host is deliberate: it bundles its own linker, so no 2GB MSVC install.
curl -sSL -o rustup-init.exe https://win.rustup.rs/x86_64   # or: https://rustup.rs
./rustup-init.exe -y --default-host x86_64-pc-windows-gnu --profile minimal
rustup target add wasm32-unknown-unknown

# 2. Build the kernel (40KB artifact)
node native/build.js

# 3. Prove it agrees with the TypeScript, bit for bit
npx tsx native/bench/parity.ts 20000
npx vitest run tests/unit/native-indicator-parity.spec.ts

# 4. Measure
npx tsx native/bench/profile-ts.ts 200000     # where TS time goes
npx tsx native/bench/compare.ts               # TS vs WASM
```

`node native/build.js --check` reports toolchain and artifact status without building.

**No toolchain? Nothing breaks.** `build.js` exits 0 with an explanation, the loader returns `null`,
and the parity spec asserts the fallback contract instead of skipping.

## The standalone executable

```bash
node native/build-exe.js          # → native/dist/oshal-kernel.exe  (85.9 MB)

./native/dist/oshal-kernel.exe where          # build provenance
./native/dist/oshal-kernel.exe bench 100000   # TS vs kernel
./native/dist/oshal-kernel.exe parity 20000   # 40/40 bit-exact
```

One file, and **genuinely one file** — verified by copying it alone into an empty directory with no
`node_modules`, no `.wasm` and no repo:

```
kernel origin  : embedded (SEA asset)
packaged       : yes — single executable
bit-exact series : 40/40
```

The compiled kernel rides *inside* the binary as a `node:sea` asset, so there is no sidecar. Built
with Node's built-in SEA — no `pkg`, no `nexe`, no prebuilt-binary download. 86 MB is the Node
runtime; the kernel is 40 KB of it.

This proves the packaging mechanism, **not** that the controller can be packaged — see
[ROADMAP item 4](ROADMAP.md) for why that is blocked on replacing Postgres/Redis rather than on
anything to do with compiling.

## Using it

```ts
import { loadKernel, DEFAULT_CONFIG } from '../native/loader';
import { computeReference } from '../native/loader/reference';

const kernel = loadKernel();               // null when the artifact is absent
const series = kernel
  ? kernel.compute(bars, DEFAULT_CONFIG)   // ~5-7x faster
  : computeReference(bars, DEFAULT_CONFIG); // identical numbers, always available

const atr = series[SERIES.ATR];            // Float64Array, bars.length long
```

Both branches return the same 40 `Float64Array`s in the same order, so callers never branch on
which implementation ran.

⚠ **The kernel's arrays are zero-copy views into WASM memory and are valid only until the next
`compute` call.** That is why it is fast on large series — a 40-series × 1.7M-bar result is ~540MB
that never gets copied — and it is the one sharp edge. `Float64Array.from(v)` to retain.

## Results

Bit parity, all 40 series, two different config sets, 8,000 bars:

```
bit-exact: 40/40   within 4 ULP: 0   FAILING: 0   VACUOUS: 0
```

Not "close" — **0 ULP**, identical doubles. See [ARCHITECTURE.md](ARCHITECTURE.md#bit-parity) for
the one design decision that made exactness reachable.

Throughput, node 24.11 / win32-x64, zero-copy read-out:

| bars | TS median | WASM median | speedup | across runs |
|---|---|---|---|---|
| 25,000 | 90 ms | 16 ms | 5.6× | 3.7–7.7× |
| 100,000 | 376 ms | 56 ms | 6.7× | 4.9–9.1× |
| 400,000 | 1,474 ms | 250 ms | 5.9× | 4.4–8.5× |

**Defensible summary: 5–7×, with run-to-run excursions from ~3.7× to ~9×.**

Two honesty notes, both expanded in [BENCHMARKS.md](BENCHMARKS.md):

- **Quote the range, not the peak.** These were measured on the dev box *with the swarm running*.
  One `compare.ts` run read 11.1×; repeated runs put it near 5×. The `profile-ts.ts` total swung 2.1×
  between runs with no code change. `compare.ts` prints min/median/max so a lucky run cannot become
  a headline, and nothing here has been measured on an idle machine.
- **Copying results out of WASM memory costs about half the win** (5.9× → 3.0× at 400k bars). The
  zero-copy contract is most of the benefit, not a micro-optimization.

## What this does not do

- **It is not a rewrite of oshal.** The controller, cockpit, bot nodes and any-bot layer are
  untouched, and should stay that way — see the first table.
- **It is not the backtester.** Fill simulation, the entry evaluator and the stop engine stay in
  TypeScript: branchy business logic, one pass, no measurable gain, double the parity surface.
- **It is not wired into the trading feature yet.** The loader and the reference path exist and are
  guarded; calling them from `futures-backtester.ts` is a deliberate follow-up so this change is
  purely additive. See [ROADMAP.md](ROADMAP.md).
- **It does not produce strategy results.** `bench/bars.ts` is a seeded random walk for measuring
  throughput and exercising warmup branches. It has no drift, no volatility clustering and no
  session structure. Studies use the real data sources under `src/features/trading/`.
