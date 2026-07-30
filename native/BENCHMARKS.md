# `native/` — measured results

Reproduce everything here with:

```bash
node native/build.js
npx tsx native/bench/profile-ts.ts 200000
npx tsx native/bench/compare.ts 25000 100000 400000
npx tsx native/bench/compare.ts 400000 --copy-out
npx tsx native/bench/parity.ts 20000
```

**Read the measurement caveat before quoting any number below.**

---

## Measurement caveat — this box is not quiet

Every figure here was taken on the operator's dev box **with the docker swarm running and other
agents active**. The variance that causes is large and must not be papered over:

- `profile-ts.ts 200000` reported a **1,245 ms** total on one run and **588 ms** on another — a 2.1×
  swing on identical input, with no code change between them.
- `compare.ts 400000` read **11.1×** speedup once; repeated runs put it at **5–6×**.

Consequences for how these numbers get used:

1. **Quote ranges, never a peak.** `compare.ts` prints min/median/max per size specifically so a
   lucky run cannot become a headline. The 11.1× reading is the cautionary example.
2. **The ratio is more trustworthy than either absolute.** Both implementations are timed in the
   same process within milliseconds of each other, so load affects them together.
3. **A clean-box run would be worth taking** before any of this reaches a doc that faces outward.
   Nothing here has been measured on an idle machine.

## Where the TypeScript time goes

`npx tsx native/bench/profile-ts.ts 200000`, 200,000 bars, the run that totalled 1,245 ms:

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
| `laguerreRsi` | 53.7 | 4.3% | 268 |
| `ehlersInstTrendWave` | 39.7 | 3.2% | 198 |
| `mfi(14)` | 18.6 | 1.5% | 93 |
| `parabolicSar` | 18.1 | 1.5% | 90 |
| `laguerreOscillator` | 12.2 | 1.0% | 61 |
| `wilderAtr(14)` | 11.6 | 0.9% | 58 |
| `laguerreFilter` | 9.8 | 0.8% | 49 |
| **TOTAL** | **1244.8** | | |

Projected to one 5-year ES 1-minute series (~1.7M bars): **10.6 s**. On the faster run: 5.0 s.
Either way, a 500-combination parameter sweep is 45–90 minutes.

The top three are where the design attention went. `superTrendM11` and `adaptiveLaguerreFilter` were
both dominated by per-bar `slice().sort()` allocation, and `movingMedian` — which `superTrendM11`
calls — is the same pattern standing alone at 7.8%.

## TypeScript vs WASM kernel

`npx tsx native/bench/compare.ts 25000 100000 400000` — node 24.11.0, win32-x64, zero-copy read-out,
9 runs at ≤100k bars and 7 above:

| bars | TS median | TS range | WASM median | WASM range | speedup | across runs |
|---|---|---|---|---|---|---|
| 25,000 | 90 ms | 79–108 | 16 ms | 14–22 | 5.6× | 3.7–7.7× |
| 100,000 | 376 ms | 309–495 | 56 ms | 54–63 | 6.7× | 4.9–9.1× |
| 400,000 | 1,474 ms | 1,280–2,013 | 250 ms | 238–290 | 5.9× | 4.4–8.5× |

**Defensible summary: 5–7× on the indicator layer, with run-to-run excursions from ~3.7× to ~9×.**

Note the asymmetry in the ranges: the WASM side is tight (238–290 ms at 400k, a 22% spread) while the
TS side is loose (1,280–2,013 ms, 57%). That is the allocation difference showing up directly — the
TS path allocates ~40 arrays per call and is GC-bound; the kernel reuses one buffer.

### With results copied out of WASM memory

`npx tsx native/bench/compare.ts 400000 --copy-out`:

| bars | TS median | WASM median | speedup | across runs |
|---|---|---|---|---|
| 400,000 | 1,319 ms | 442 ms | 3.0× | 1.6–5.8× |

Copying the 40 result series out of linear memory costs roughly **half the win** (250 ms → 442 ms at
400k). An earlier reading on a quieter moment put this at 5.2×.

**So the zero-copy contract is not a micro-optimization — it is most of the benefit.** A caller that
reads through the views as it walks bars gets 5–7×; one that snapshots every series first gets 2–3×.
Design callers to consume the views in place.

## Parity

`npx tsx native/bench/parity.ts 20000`:

```
bit-exact: 40/40   within 4 ULP: 0   FAILING: 0   VACUOUS: 0
```

All 40 series identical to the last bit, across 20,000 bars. The machine-checked version runs two
different config sets (shipped defaults plus an off-default set to catch hard-coded constants) at
8,000 bars:

```
$ npx vitest run tests/unit/native-indicator-parity.spec.ts
Tests  88 passed (88)
```

`VACUOUS: 0` is doing real work in that line. A constant series would compare "bit-exact" while
proving nothing, so both the report and the spec require every series to actually vary — with an
explicit allowlist for the ones that are legitimately low-cardinality (regime flags, enum pattern
codes). Observed distinct-value counts at 20,000 bars: 19,949–20,000 for the continuous series,
846–2,197 for the wave extremes, 2–4 for the flags.

### One bug this caught

The first run of the parity spec failed on `ADX[0]`: the reference gave 0, the kernel gave a stale
value from a previous call. Several ported functions write only part of their series and rely on the
rest reading 0 (mirroring the TS's `new Array(n).fill(0)`), but the loader reuses its output buffer
across calls. Fixed with `out.fill(0.0)` at the top of `compute()`.

It only reproduces when a **smaller** series follows a larger one, which is exactly what the "buffer
reuse across calls" case does and nothing else in the suite does. Worth remembering as the shape of
bug this whole guard exists for: correct on the first call, wrong afterwards, no error either way.

## Artifact

| | |
|---|---|
| `native/dist/oshal_kernel.wasm` | 40,181 bytes |
| build time (release, cold) | ~25 s |
| build time (incremental) | ~8 s |
| toolchain | rustc 1.97.1, `x86_64-pc-windows-gnu` host, `wasm32-unknown-unknown` target |
| runtime deps | none — `WebAssembly` is built into Node |

## What has not been measured

- **A real backtest end-to-end.** The kernel is not yet called from `futures-backtester.ts`, so the
  4–8× is on the indicator layer in isolation. Total run speedup will be lower by whatever share the
  evaluator, stop engine and fill simulation take — unmeasured, and it should be measured before any
  end-to-end claim.
- **Real market data.** `bench/bars.ts` is a seeded random walk. Throughput should not depend on
  price realism, but this has not been confirmed against a Kibot series.
- **Linux / macOS, or a browser host.** One artifact should behave identically everywhere, and that
  is a stated advantage of the WASM choice — but it is an argument, not a measurement.
- **An idle box.** See the caveat at the top.
