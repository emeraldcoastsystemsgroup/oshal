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
| Standalone CLI + single-executable build | ✅ `native/cli/` + `build-exe.js` → `oshal-kernel.exe` |

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

**4. Single executable via Node SEA — MECHANISM PROVEN, controller not done.**

The SEA pipeline is built and works: `node native/build-exe.js` produces `oshal-kernel.exe`
(85.9 MB — the Node runtime dominates), and it is **genuinely self-contained**. Verified by copying
the single file into an empty directory with no `node_modules`, no `.wasm` and no repo, and running
it there:

```
kernel origin  : embedded (SEA asset)
packaged       : yes — single executable
bit-exact series : 40/40
```

The compiled kernel travels *inside* the binary as an SEA asset (`node:sea` `getAsset`), so there is
no sidecar file. `oshal-kernel where | bench | parity` all work with nothing beside them.

**What this proves and what it does not.** It proves bundle → blob → inject works in this repo on a
target with zero native dependencies and zero external services. It does **not** prove the controller
can be packaged, and the remaining work there is not the SEA step:

- `pg-native`, `better-sqlite3`, `canvas` and `sharp` are compiled `.node` binaries. A packer can
  carry the bytes, but the OS loader cannot `dlopen` them from a virtual filesystem — they extract at
  runtime or fail.
- **The controller still needs Postgres and Redis running.** That is the actual barrier to
  "installable", and it is item 5's problem, not item 4's. A perfect single binary whose install
  instructions begin "first, set up Docker" has not solved anything.

Note for anyone reading the older script: `scripts/build-executable.js` (esbuild → `pkg`) is *not*
non-self-contained because of its `--external` flags — `pkg` re-resolves pure-JS modules into its own
snapshot. It needs files beside it because its own closing output says so (`dist/pages/`,
`dist/config-seed/`, `dist/ai-lab/`), because of the four native modules above, and because of
Postgres/Redis.

*Done when:* one `oshal.exe` boots the controller on a box with no Node installed, and a smoke test
asserts the binary serves `/api/health`. **Blocked on item 5**, realistically.

⚠ On Windows without `signtool` (Windows SDK, not bundled with Node) postject warns
"The signature seems corrupted!" — expected, not a failure; the copied node binary keeps a
now-invalid Authenticode signature. Strip or re-sign before distributing to anyone else.

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
