<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — publication-ready summary of the native/ compiled-kernel work: the headline, the method, the numbers with posture labels, and the reusable lesson. Written to the anti-drift rules (no competitive absolutes, ranges not midpoints, stated limits).
-->

# "Should we rewrite it in a compiled language?" — a measured answer

**Audience:** engineering leaders and platform teams weighing a rewrite.
**Posture: measured, single machine, one subsystem.** Numbers below were taken on a developer
workstation with the full agent stack running; the variance that causes is stated inline rather than
smoothed away. Nothing here is a vendor benchmark and nothing has been measured on an idle host.
**Full data:** [native/BENCHMARKS.md](../../native/BENCHMARKS.md) ·
**Engineering detail:** [native-compiled-kernel.md](../architecture/native-compiled-kernel.md)

---

## The one-paragraph version

We asked whether converting a TypeScript/JavaScript agent-orchestration platform to a compiled
language would make it faster. We profiled first. The control plane turned out to be I/O-bound — 4–5
milliseconds of JavaScript against LLM calls of 2 to 120 **seconds** — so compiling it would optimize
about 1% of the wall clock. But the same profiling found one genuinely CPU-bound subsystem, a
900-line numeric layer, and porting *that* to Rust produced a **5–7× speedup with bit-identical
results**. The finding worth sharing is not "Rust is fast." It is that the profile decided the scope,
and the profile said *rewrite 900 lines, not 300,000*.

## The mistake this avoids

The instinct when a system feels slow is to blame the language. It is a satisfying diagnosis: it
explains everything, and the fix is heroic.

We measured instead:

| what | time |
|---|---|
| a pure-JavaScript API route, no I/O | 4–5 ms |
| an API route doing one database round-trip | 6–35 ms |
| dispatching work to a language model | 2,000–120,000 ms |

The controller's job is to route requests, queue work, hand it to worker nodes, and wait. That is an
I/O-bound workload by design. A compiled rewrite might turn 4 ms into 0.4 ms while the 30-second wait
sits untouched — a rounding error on the thing a user actually experiences.

Two further details made the rewrite worse than merely pointless:

- **The worker CLIs we orchestrate are themselves Node programs.** A compiled control plane would
  still have to ship a JavaScript runtime to execute its own workers — two runtimes to install
  instead of one.
- **The entire browser UI cannot be compiled.** Browsers run JavaScript.

Scope of what was being proposed: ~250,000 lines of TypeScript, ~65,000 lines of hardened JavaScript,
579 end-to-end tests, and years of encoded architectural decisions — to chase 4 ms.

## Where compiling did pay

The same profiling run that killed the rewrite found the exception. One subsystem — a financial
indicator layer that walks bar series and runs fifteen numeric passes over every bar — was doing real
CPU work:

- **1.24 seconds** for 200,000 bars
- **~10 seconds** for one five-year 1-minute series
- **~1 hour** for a 500-combination parameter sweep

That is 900 lines of pure arithmetic with no I/O: the ideal port target, and the only one in the
codebase.

Ported to Rust, compiled to a 40KB WebAssembly module:

| bars | before | after | speedup |
|---|---|---|---|
| 25,000 | 90 ms | 16 ms | 5.6× |
| 100,000 | 376 ms | 56 ms | 6.7× |
| 400,000 | 1,474 ms | 250 ms | 5.9× |

**Defensible summary: 5–7×, with run-to-run excursions from roughly 3.7× to 9×.**

## Four decisions that made it safe

A second implementation of numeric code is a liability unless it is provably interchangeable with the
first. Four choices carried that weight.

**1. Cross the language boundary once per run, not once per calculation.**
One call takes the whole series and returns every output series. At 1.7M bars × 15 indicators,
per-bar boundary overhead alone would have exceeded the compute it was meant to accelerate. This is
the decision most often gotten wrong, and it is usually fatal to the result.

**2. Verify bit-exactness, not approximate agreement.**
The guard asserts **zero ULP** — identical IEEE-754 doubles across all 40 output series. That was
only reachable because of a deliberate design move: three transcendental constants (`exp`, `cos`) are
computed on the JavaScript side and passed in, because standard-library math is not bit-identical
across runtimes and the error would have compounded through a recursive filter. Without that, parity
would have degraded with series length and forced a tolerance that grows — the kind of "close enough"
that hides a real divergence until someone makes a decision on it.

**3. Name the reference implementation, and say which one loses.**
The TypeScript is authoritative. When the two disagree, the port is wrong. The test failure message
says so, because the tempting fix under deadline pressure is to widen the tolerance — which discards
the only property that made the second implementation safe to have.

**4. Make it optional, so nobody else inherits the toolchain.**
The compiled artifact is not committed. If it is absent, the loader reports that and callers use the
original TypeScript, producing identical numbers. The build script exits *successfully* when no
compiler is installed. The test suite asserts the fallback path rather than skipping — a test that
silently skips is not a guard.

The practical consequence: no continuous-integration job, no worker node and no deployment can fail
because a compiler is missing. The change is additive; reverting it means deleting a directory.

## The bug this caught, and why it matters

The parity test failed on its first run. The compiled kernel relied on "unwritten output slots read
zero" — true in the original, because it allocated fresh arrays each call — while the new loader
*reused* its output buffer for speed.

The result was a defect with three unpleasant properties: **correct on the first call and wrong on
every call afterward**, **no error raised in either case**, and **only reproducible when a smaller
input follows a larger one**.

That is precisely the class of bug an approximate-tolerance test would have passed. It is the whole
argument for verifying exactness, and for writing the one test case nobody thinks to write.

## The transferable lesson

The speedup was **not mostly about compilation**:

1. **Data layout.** Replacing an array of objects with columnar arrays of doubles removed a pointer
   dereference and a property lookup per field, per pass, per bar.
2. **Allocation.** Two hot functions were allocating and sorting a fresh array *per bar*. Both now
   reuse one buffer.
3. **Output reuse.** One reused output buffer instead of ~40 fresh arrays per call — visible in the
   measurements, where the compiled path's timings are tight and the original's swing 57% because it
   is garbage-collection-bound.
4. *Then* the ordinary compiled-code wins.

**The first three are achievable in TypeScript.** Typed arrays and buffer reuse are not exotic. Our
own roadmap's next item is to try exactly that before porting anything else — because if plain
TypeScript recovers most of the gain, one implementation beats two, and that result deserves writing
down either way.

So the honest generalization is narrower and more useful than "compile it":

> Profile first. Most systems are waiting, not computing. When you do find compute, check whether
> it's the language or the memory layout — and if you port, make interchangeability provable and the
> port optional.

## Stated limits

Published limits, not footnotes:

- **Measured on a busy machine.** The baseline profile swung 2.1× between runs on identical input.
  One benchmark run showed 11.1× where repeated runs put the figure near 5× — which is exactly why
  the harness reports min/median/max and why the summary above is a range. **No idle-host or Linux
  measurement exists yet.**
- **This is one subsystem in isolation, not an end-to-end result.** The kernel is not yet called from
  the production backtester, so a full-run speedup will be lower by whatever share the surrounding
  logic takes. That share is unmeasured, and we are not claiming it.
- **Reading results out of the compiled module's memory costs about half the gain** (5.9× → 3.0×).
  The zero-copy path is most of the benefit and carries a real constraint: result views expire on the
  next call.
- **Benchmark inputs are synthetic** — a seeded random walk, used to measure throughput and exercise
  edge cases. It is not a market simulation and produces no strategy result.

## About the platform

oshal is an open-source multi-agent orchestration platform (AGPL-3.0 with a commercial exception): a
controller accepts work, dispatches phases to worker nodes, and each node runs a different agent
harness against a different model provider. The design keeps the controller free of model calls, so
cost and routing stay accountable per bot — which is also why its profile looks the way it does.

- Source: <https://github.com/emeraldcoastsystemsgroup/oshal>
- The kernel: [native/](../../native/README.md)
- Reproduce these numbers: `node native/build.js && npx tsx native/bench/compare.ts`
