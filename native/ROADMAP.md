# `native/` — roadmap

Today / target per item, per the anti-drift rule in CLAUDE.md. Nothing below is described as shipped
unless it is.

---

## Shipped

| item | state |
|---|---|
| Rust port of the 15 ADR-116 indicators | ✅ `crates/oshal-kernel`, 40/40 bit-exact |
| Raw-ABI WASM wrapper, no npm build deps | ✅ `crates/oshal-wasm`, 40KB artifact |
| Loader with null-on-absent fallback | ✅ `loader/index.ts` |
| TS reference in the same output shape | ✅ `loader/reference.ts` |
| Parity guard, 0 ULP, 2 config sets | ✅ `tests/unit/native-indicator-parity.spec.ts`, 88 tests |
| Profile / compare / parity benchmarks | ✅ `bench/` |
| ABI drift detection (version + counts) | ✅ loader refuses a stale artifact |

## Next — the obvious follow-up

**1. Call the kernel from `futures-backtester.ts`.**
Deliberately not done in the landing change, so this track is purely additive and reverting it means
deleting a folder. The backtester's `precomputeIndicators` step is the single call site.
*Done when:* the backtester uses `loadKernel() ?? computeReference`, an existing futures backtest
spec passes unchanged with the artifact both present and absent, and `bench/` reports an
**end-to-end** run speedup (not just the indicator layer — see BENCHMARKS.md "what has not been
measured").

**2. Measure on an idle box, and on Linux.**
Every number in BENCHMARKS.md was taken with the swarm running; the TS side swung 2.1× between runs.
*Done when:* `compare.ts --json` output from a quiet box and from a Linux container is committed
alongside the Windows numbers, and README's quoted range is reconciled to them.

**3. Try the columnar-TypeScript alternative first.**
ARCHITECTURE.md argues items 1–3 of the speedup are layout and allocation wins, not compilation
wins. If `Float64Array` columns plus a reused output buffer recover most of the 5–7× in plain TS,
that is strictly better than maintaining two implementations.
*Done when:* a `bench/compare-columnar-ts.ts` exists and either (a) closes most of the gap — in which
case this whole folder should be reconsidered and that conclusion written down, or (b) does not, which
retires the question with evidence.

## The installable-application track — designed, not built

The original question was two questions, and the packaging half is the one with real user-facing
value. **Node 24.11 already ships what it needs**, which changes the answer from what it would have
been a year ago:

**4. Single executable via Node SEA.**
Node 22+ has Single Executable Applications built into the runtime — no `pkg`, no `nexe`.
`scripts/build-executable.js` already exists in this repo and uses the older esbuild → `pkg` chain.
*Done when:* one `oshal.exe` boots the controller on a box with no Node installed, the SEA path
replaces the `pkg` dependency in `scripts/build-executable.js`, and a smoke test asserts the binary
serves `/api/health`.

**5. `node:sqlite` for single-user installs.**
Also built into Node 22+. Postgres in Docker is the actual install friction, not the language. A
single-user install could run against SQLite with no container at all.
*Done when:* the schema has a SQLite dialect, `DATABASE_URL=sqlite:...` boots the controller, and the
human-testability gate (CLAUDE.md) passes against it without Docker.

**6. Desktop shell — Tauri over the existing cockpit.**
Tauri is Rust-hosted (the toolchain this folder already installs), ~10MB, and wraps the existing
cockpit HTML/JS unchanged. Electron would work and cost ~150MB.
*Done when:* a window opens on the cockpit, the app has an icon and a tray entry, and the shell adds
no second copy of any UI file.

**7. Bundle the ONNX embedding model.**
The chroma container downloads ~80MB of `all-MiniLM-L6-v2` at startup. That is startup latency and a
network dependency in the install path.
*Done when:* first-boot needs no model download and `scripts/rag-enable-embeddings.sh` still passes.

Items 4–7 are what "a real installable application" actually means here. **None of them requires a
compiled language for the platform**, which was the finding that scoped this folder to the numeric
kernel in the first place.

## Explicitly not planned

- **Porting the controller, cockpit, or any-bot layer.** The measured profile says no: 4–5 ms of JS
  against LLM dispatches of 2–120 s. See README's first table.
- **Porting `futures-entry-evaluator.ts` / `futures-stop-engine.ts`.** Branchy business logic, one
  pass per bar, no measurable gain, double the parity surface. ARCHITECTURE.md §1.
- **A native `.node` addon.** ARCHITECTURE.md §3. Revisit only if the kernel needs SIMD or threads
  that WASM cannot reach.
- **`wasm-bindgen`.** Adds a build-time npm dependency and a generated shim to marshal what is
  already `f64` buffers, and would break the zero-copy read-out.
- **Tracking the `.wasm` artifact in git.** It is a build product. Optional-by-construction is the
  property that keeps Rust off everyone else's critical path.
