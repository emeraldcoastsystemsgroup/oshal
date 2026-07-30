# ADR-121 — Compile the numeric kernel, not the platform

**Status:** Accepted (shipped 2026-07-29/30 — PRs #39, #42, #45, #48). Kernel + guard + single-file
executable are on `main`; the kernel is **not yet called from the backtester**, and the controller is
**not** packaged. Open items are tracked in [native/ROADMAP.md](../../native/ROADMAP.md).

## Context

The operator asked whether oshal — TypeScript, JavaScript and CSS — should be "converted to a real
installable application, C++ or something that compiles", and whether that would improve performance.

That is two questions wearing one coat, and conflating them is how a team ends up doing a rewrite to
solve a packaging problem. Both were answered by measurement rather than argument.

**The control plane is I/O-bound.** Measured on the running stack:

| path | time |
|---|---|
| `/api/health` (pure JS, no I/O) | 4–5 ms |
| `/api/agents` (JS + one Postgres round-trip) | 6–35 ms |
| any LLM dispatch | 2,000–120,000 ms |

This is the architecture working as designed: per [CLAUDE.md](../../CLAUDE.md) the swarm controller
**never calls an LLM** — it routes, queues, dispatches to bot nodes and waits. A compiled rewrite
optimizes the 4 ms while the 30-second wait is untouched. Two further facts make it worse than
pointless: the Claude/Codex/Gemini harness CLIs are **npm packages** the bot nodes spawn, so a
compiled oshal would still ship a Node runtime to execute its own workers; and the cockpit is 107
files of browser JavaScript, which cannot be compiled at all. The scope being proposed was ~249K
lines of TypeScript, ~65K lines of JS in `any-bot/server/`, 579 Playwright specs and 120 ADRs of
encoded decisions.

**One subsystem is genuinely CPU-bound.** Profiling the ADR-116 futures indicator layer at 200,000
bars: 1,245 ms total, dominated by `superTrendM11` (22%), `dmiAdx` (14%) and `adaptiveLaguerreFilter`
(11%). That projects to ~10 s for one five-year ES 1-minute series and ~1 hour for a 500-combination
parameter sweep. It is ~900 lines of pure arithmetic with no I/O across four modules — the ideal port
target, and the only one in the repo.

## Decision

**Port the numeric kernel to Rust → WebAssembly. Do not port the platform.** Six choices define it,
each with a rejected alternative:

1. **Port the pass, keep the decision.** The four indicator modules (~900 lines) went over;
   `futures-entry-evaluator.ts` (537), `futures-stop-engine.ts` (499) and `futures-backtester.ts`
   (678) did not — branchy business logic, one pass per bar, no measurable gain, and porting them
   would double the surface that must stay in parity. *Amdahl's law set the scope:* porting only the
   top-6 offenders (87% of profile time) at 10× each would have capped total speedup at ≈4.6×, so the
   whole layer went over to remove the ceiling.

2. **Cross the FFI boundary once per run.** One `compute()` call takes the whole bar series and
   returns all 40 output series. Rejected: per-indicator or per-bar calls — at 1.7M bars × 15
   indicators, boundary overhead alone would exceed the compute it was meant to accelerate.

3. **WebAssembly, not a native `.node` addon.** One 40KB artifact for every platform, loaded by the
   `WebAssembly` global built into Node, no node-gyp and no npm build dependency; it also runs in a
   browser, which matters because the cockpit is a browser surface. Rejected: a native addon (MSVC
   toolchain on Windows, one artifact per OS × arch × Node major) and `wasm-bindgen` (a build-time
   npm dependency and generated shim to marshal what is already `f64` buffers, and it would break the
   zero-copy read-out). Cost: ~1.2–1.5× slower than native, noise against the 5–7× being chased.

4. **Bit parity at 0 ULP, with a named authority.** The guard asserts identical IEEE-754 doubles
   across all 40 series, not an epsilon. Reachable because the three SuperSmoother coefficients
   (`exp`/`cos`) are computed JS-side and passed in — Rust's libm is not bit-identical to V8's, and
   the error would compound through an IIR filter, forcing a tolerance that grows with series length.
   `jsmath.rs` reproduces ECMAScript `Math.max`/`Math.min` NaN propagation (`Math.max(NaN,5)` is
   `NaN` in JS, `5.0` in Rust) because several indicators carry a deliberately-NaN accumulator
   through it. **The TypeScript is the reference implementation; when the two disagree the Rust is
   wrong**, and the failure message says so — because the tempting fix under pressure is to widen the
   tolerance, which discards the property that makes a second implementation safe.

5. **Optional by construction.** The `.wasm` is a build product and untracked. `loadKernel()` returns
   `null` when absent → callers use `computeReference()` → identical numbers. `build.js` exits **0**
   when cargo is absent; only a toolchain that is *present and failing* exits non-zero. The parity
   spec asserts the fallback contract rather than skipping. Nothing under `src/` was modified.

6. **Prove the packaging mechanism on the small thing first.** `native/build-exe.js` produces a
   single-file executable via Node's built-in SEA, with the kernel embedded as a `node:sea` asset.

## Executable status — as-built

**What exists and is verified.** `node native/build-exe.js` → `native/dist/oshal-kernel.exe`,
**85.9 MB**, built with Node 24's **built-in SEA** (no `pkg`, no `nexe`, no prebuilt-binary
download). The compiled 40KB WASM kernel travels **inside** the binary as a `node:sea` asset, so
there is no sidecar file. Subcommands: `where` (build provenance), `bench`, `parity`.

Verified genuinely self-contained by copying the single file into an empty directory — no
`node_modules`, no `.wasm`, no repo — and running it there:

```
kernel origin  : embedded (SEA asset)
packaged       : yes — single executable
bit-exact series : 40/40
```

From the binary at 100k bars: **5.1× median (range 2.9–6.5×)**, 40/40 series bit-exact.

**What it does NOT establish.** It proves bundle → blob → inject works in this repo *on a target with
zero native dependencies and zero external services*. It does **not** show the controller can be
packaged, and the remaining work there is not the SEA step:

- `pg-native`, `better-sqlite3`, `canvas` and `sharp` are compiled `.node` binaries. A packer can
  carry the bytes, but the OS loader cannot `dlopen` them from a virtual filesystem.
- **The controller still needs Postgres and Redis running.** That is the actual barrier to
  "installable" — a dependency-architecture problem, not a compilation one. A flawless single binary
  whose install instructions begin "first, set up Docker" has not made anything installable.

The kernel executable is *evidence for that split*: it is a real single file precisely because it has
nothing to talk to.

**Correction of record.** `scripts/build-executable.js` (the older esbuild → `pkg` chain) is **not**
non-self-contained because of its `--external` flags, as was first asserted here. `pkg` runs after
esbuild and re-resolves pure-JS modules into its own snapshot. It needs files beside it because its
own closing output says so (`dist/pages/`, `dist/config-seed/`, `dist/ai-lab/`), because of the four
native modules above, and because of Postgres/Redis.

**Artifact handling.** Both the `.wasm` and the `.exe` are build products and stay untracked
(`native/.gitignore` → `dist/`). Nothing in the platform depends on either existing. ⚠ On Windows
without `signtool` (Windows SDK, not bundled with Node), postject warns "The signature seems
corrupted!" — expected, not a failure; the copied node binary keeps a now-invalid Authenticode
signature and still runs. Strip or re-sign before distributing.

## Consequences

**Good.**

- 5–7× on the indicator layer, 40/40 series bit-exact, from a 40KB artifact.
- The rewrite question is now answered with data and recorded, so re-proposing it carries the burden
  of a new profile rather than an argument.
- The optional-by-construction property means no CI job, bot node, deployment or customer box can
  fail because Rust is missing — a `git pull` on a box with no toolchain silently gets the TypeScript
  path and identical numbers.
- A verified single-file executable exists as a reference for the packaging track.

**Costs and risks accepted.**

- **Two implementations of ~900 lines of numeric code.** Mitigated by the 0-ULP guard (88 tests, two
  config sets) and by naming the TypeScript authoritative — but it is real ongoing surface.
- **The speedup is mostly memory layout, not compilation** — columnar `&[f64]` instead of
  `{o,h,l,c,v}` objects, no per-bar `slice().sort()`, one reused output buffer. Items 1–3 of 4 are
  reachable in plain TypeScript. **ROADMAP item 3 is to try that first before porting anything
  else**; if it closes most of the gap, one implementation beats two and this ADR should be revisited.
- **The zero-copy contract is sharp.** Result views are invalidated by the next `compute()` call, and
  copying them out costs about half the win (5.9× → 3.0× at 400k bars).
- **Measurement posture is weak.** Every figure was taken on a dev box with the swarm running; the
  baseline profile swung 2.1× between identical runs and one benchmark read 11.1× where repeats say
  ~5×. No idle-host or Linux measurement exists. The benchmark reports min/median/max for this reason.
- **The 5–7× is the indicator layer in isolation, not end-to-end.** The kernel is not yet called from
  `futures-backtester.ts`.

**A bug the guard caught, recorded because it is the shape to watch for.** The kernel relied on
"unwritten output slots read 0" — true of the TypeScript, which allocates fresh arrays per call —
while the loader *reuses* its output buffer. The defect was correct on the first call and wrong on
every call after, raised no error either way, and only reproduced when a smaller series followed a
larger one. An approximate-tolerance test would have passed it. Fixed with `out.fill(0.0)`.

## Scope guard

This ADR authorizes a compiled kernel for **numeric passes over bar series**. It does not authorize:
porting the controller, cockpit or `any-bot/` layer (the profile says no); porting the entry
evaluator or stop engine; a native `.node` addon; `wasm-bindgen`; or tracking build artifacts in git.
Each is listed under "explicitly not planned" in [native/ROADMAP.md](../../native/ROADMAP.md) with
its reason.

## See also

- [native/README.md](../../native/README.md) — what it is, quickstart, the executable
- [native/ARCHITECTURE.md](../../native/ARCHITECTURE.md) — the decisions with rejected alternatives
- [native/BENCHMARKS.md](../../native/BENCHMARKS.md) — measured numbers, variance caveat first
- [native/ROADMAP.md](../../native/ROADMAP.md) — today/target, including the installable-app track
- [docs/architecture/native-compiled-kernel.md](../architecture/native-compiled-kernel.md) — the
  narrative engineering record
- [docs/business/native-kernel-publication.md](../business/native-kernel-publication.md) —
  publication-ready summary with posture labels
- [ADR-116](./116-futures-extension-layer.md) — the futures extension the indicator layer belongs to
