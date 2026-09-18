# Clean kernel — project plan

**Status:** DRAFT 2026-09-17, for operator review. **See first:** [11 — Repair specification](./11-repair-spec.md) reaches the same target by fixing the current codebase in place, with no freeze and no second kernel. After the code audit in [10](./10-what-we-are-improving.md), repair is the better-supported route; this plan remains the reference for the rewrite option and for anything repair cannot reach. Durations are estimate ranges with their basis
stated; none is a commitment. Spec: [01](./01-high-level-spec.md); types: [02](./02-rust-object-model.md);
pictures: [diagrams/](./diagrams/README.md); what gets imported: [04](./04-documentation-import-map.md).

---

## 0. Decisions the operator owns before Phase 1 starts

| # | Decision | Option A | Option B | Recommendation |
|---|---|---|---|---|
| D1 | **Where the Rust kernel lives** | new public repo `oshal-kernel` (clean trunk, its own publish gate, no history hazard, own CI) | `kernel/` inside this repo (one place, but every kernel PR shares the gate, the one-branch rule and the bind-mounted stack) | **A.** ADR-115 already paid for the clean-trunk lesson; a second codebase in one tree recreates the two-codebase weakness (§3.3 of the spec) |
| D2 | **First package host** | out-of-process host first (runs today's JavaScript packages unchanged behind the SDK; proves the strangler early) | in-process WASM host first (the sandbox story, but no existing package can use it on day one) | **A then B.** Value arrives when an existing package runs on the new kernel; the WASM host follows in Phase 3b |
| D3 | **Single-node relational store** | SQLite (embedded, zero install, RLS emulated by scope-key filtering in `ScopedStore`) | embedded Postgres (true RLS, but a bundled server process and a larger artifact) | **A** for `demo`/`home`, with the T-02 guard asserting the SQLite path refuses the same cross-key reads Postgres RLS refuses |
| D4 | **Migration posture** | strangler beside today's stack, no freeze | freeze today's stack and cut over | **A.** A freeze is what the previous evaluation costed at 18–24 months; the strangler ships value per package |
| D5 | **Who reviews kernel PRs** | operator merges every kernel PR until Phase 3 exits | agent lanes merge their own green PRs (today's maintainer rule) | **A** through Phase 2 because the type guards are the product; relax at Phase 3 exit |

---

## 1. How the work runs

- **Strangler, not big bang.** The Rust kernel runs beside today's api container. Packages migrate in
  waves (§4). Today's stack is retired when §6 exits, not before.
- **No feature freeze on today's platform.** Store packages keep shipping; new ones SHOULD target the
  SDK from Phase 3 on.
- **Spec is authority.** A change to behavior is a change to [01](./01-high-level-spec.md) first, then
  code. Requirements are traced to guards (Phase 0 step 4).
- **Guard per requirement.** Every `MUST` in the spec has a named test before its phase exits. Compile-
  fail tests are first-class deliverables, not nice-to-haves.
- **Same repo discipline.** Branch → PR → merge, one active development branch per repo, commit small,
  push immediately, claims in the coordination thread. The kernel repo inherits the publish gate.
- **Measurement posture.** No performance or footprint number is written down before it is measured on
  an idle box; ranges, not single readings (ADR-121 lesson).

---

## 2. Phases

Basis for durations: this project's observed lane throughput on comparable scoped builds (the ADR-121
kernel track shipped in six PRs across two days for ~900 lines with a 0-ULP guard; the store packages
in §4 took days to weeks each), scaled by the review bottleneck that the type guards impose in Phases
1–2. They are ranges for planning, not commitments.

### Phase 0 — Specification (in progress)

| Deliverable | Done when |
|---|---|
| High-level spec ([01](./01-high-level-spec.md)) | operator review complete; §3 verdicts confirmed or corrected |
| Rust object model ([02](./02-rust-object-model.md)) | every object in spec §4.3 has a type; every type names its rule |
| Diagrams ([diagrams/](./diagrams/README.md)) | each spec section with a process has a diagram; the spec references it |
| Documentation import map ([04](./04-documentation-import-map.md)) | every ADR and architecture doc has a class and a target |
| SDK seed inventory | the 124 kernel modules packages import today, each `promote` or `move to package`, generated from the tree |
| Requirement → guard map | every `MUST` in spec §5, in [05](./05-subsystem-specs.md), [06](./06-deployment-postures.md), [07](./07-subsystem-specs-2.md), [08](./08-workspace-and-assistant.md) and [09](./09-adr-sweep-amendments.md) names the test that will assert it |
| Decisions D1–D5 | recorded as ADR-163 in this repo, pointing at the kernel repo |

Estimate: 2–4 weeks of elapsed review, mostly operator reading time.

### Phase 1 — Foundations: the door and the store

| Deliverable | Done when |
|---|---|
| Workspace: `kernel-types`, `control`, `observe`, `store`, `api`; `oshald` binary | `cargo build` on Windows and Linux; workspace test proves `kernel-types` has zero deps and `api` does not depend on `store` |
| `admit()` for `http` and `cli` entries | refusal tests for every `RefusalCode` reachable from those entries |
| `Ctx<Read | Write | Confirmed>`, `ScopedStore`, `SecretRef` | all five compile-fail guards (diagram 10) red-then-green |
| Postgres store with RLS under the governed role; SQLite store for single-node | T-02 cross-key read refused on both |
| Tickets end to end: create, list, status history, over HTTP with OIDC and local auth | Playwright black-box suite from today's ticket routes passes against `oshald` |
| Embedded kernel migrations; order-independent start | D-02 test: start with stores down, then up, converges |

Estimate: 6–8 weeks. Exit gate: C-01 to C-08, T-01 to T-03, D-02 have named green guards.

### Phase 2 — The swarm: mesh, inference, intents, orchestration

| Deliverable | Done when |
|---|---|
| `mesh` with in-process and Redis Streams transports | the same workflow completes over both (B-06 partial) |
| `inference` with hosted, bring-your-own and local-endpoint providers; `noop` for tests | metered `CostEvent` per completion; ledger equals cockpit totals fixture (O-02) |
| `intents` with two real connectors ported (Gmail read, one write-tier action) | `SecretRef` never crosses the crate boundary; redaction test on all sinks |
| `orchestration`: dispatcher, workflow registry, activations, status history, trace read model | B-01, B-07, C-06, T-04 guards; a manifest-declared workflow runs ticket → envelope → inline bot → artifacts |
| Budgets and kill switch (ADR-104) | over-budget refusal at both chokepoints |

Estimate: 8–10 weeks. Exit gate: an incident-style ticket completes on `oshald` with cost, trace and
audit visible, on a `demo`-mode single artifact.

### Phase 3 — Packages and the SDK

| Deliverable | Done when |
|---|---|
| `sdk` crate + interface definition (WIT) | `hello-oshal` builds against the SDK with no path into kernel modules (P-03) |
| 3a. Out-of-process host (Node) speaking the SDK interface | `calendar` (about 1.8K lines) runs on `oshald` unchanged except for its imports; its declared tests pass in the sandbox (P-05) |
| Loader lifecycle: install → validate → test → grant → load → activate → upgrade → deactivate → unload | P-02 on a running kernel; P-04 failed-migration test; P-06, P-07, P-08 |
| 3b. In-process WASM component host | a new package written for the SDK runs sandboxed; an undeclared capability fails at load (P-01) |
| Registries as rows (ADR-147) | install from an untrusted source refused |

Estimate: 8–12 weeks. Exit gate: two packages active, one per host, on `demo` and `enterprise` modes.

### Phase 4 — Nodes: bring your own harness

| Deliverable | Done when |
|---|---|
| `oshal-node` agent: enroll, heartbeat, claim, complete | B-09 to B-12 guards; a local harness must enroll like a remote one |
| Adapters: `claude-code`, `codex-cli`, `gemini-cli`, `cline`, `custom` | each completes one envelope with pinned generation; generation mismatch fails the run (B-10) |
| Remote transport over device-bound tokens (ADR-114) | a node bound to another person's bot is refused |
| A2A gateway carried forward (ADR-109) | default-off proven; per-agent scoped credential |

Estimate: 6–8 weeks. Exit gate: B-06 complete across all four transports.

### Phase 5 — Surfaces and channels

| Deliverable | Done when |
|---|---|
| Cockpit shell served embedded; `?app=` contract kept; socket.io replaced by plain WebSocket | today's cockpit e2e green set passes against `oshald` |
| Channels: email, Telegram, voice as entry kinds | channel entries admitted with linked-principal identity; unlinked refused |
| Generated inventories page (O-03) and package status rendering (P-07) | documentation check fails on a typed count |

Estimate: 4–6 weeks.

### Phase 6 — Strangler operation and retirement

| Deliverable | Done when |
|---|---|
| Package migration waves (§4) | wave exit criteria met per wave |
| Today's api container serves only unmigrated packages behind a route split | route inventory shows every kernel route on `oshald` |
| Retirement | §6 exit criteria |

Estimate: 12–24+ months of background work; the long tail is the six largest packages.

**Time to first real value:** Phases 1–3a, about 5–7 months, when an existing package runs on a
single-artifact `demo` install with no Docker.

---

## 3. Workstreams that cross phases

| Workstream | Owner | Cadence |
|---|---|---|
| Documentation import ([04](./04-documentation-import-map.md)) | doc lane | each phase imports the ADRs classed to its crates; superseded ADRs get a status line pointing here |
| ADR reconciliation | operator + doc lane | every phase exit records an ADR in the kernel repo; this repo's ADR index links it |
| Test Lab port (ADR-063) | test lane | scenario catalog runs against `oshald` from Phase 2; verdict integrity rules from day one |
| CI | infra lane | `cargo build`, `cargo test`, compile-fail suite, clippy, `cargo deny`, publish gate; local-first per ADR-090 |
| Deploy modes and the single artifact | infra lane | `demo` from Phase 1, `home` at Phase 4, `enterprise` at Phase 5 |
| Security review | reviewer lane | each phase exit: guards executed, refusal codes exercised, redaction proven |
| Counts and honesty | doc lane | inventories generated per release; no typed counts |

---

## 4. Package migration waves

Sizes are code lines measured 2026-09-17 (spec §9). Packages with Python engines use the out-of-process
host. A wave exits when every package in it is active on `oshald`, its declared tests pass in the
sandbox, and its status route renders.

| Wave | Packages | Count | Notes |
|---|---|---|---|
| 0 (proof, Phase 3) | hello-oshal, calendar | 2 | one trivial, one real with routes, schedules and a store |
| 1 (≤ 1.1K lines) | email-summarizer, youtube-kids, movies, home, eats, storage, travel, spotify, identity, camera, daily-trade-recap, payments, feeds, creative-studio, brand-graphics, job-apply, capability-ideator, cloud, system, life, games, marketing-suite | 22 | mostly routes + one bot; 1–3 days each on the out-of-process host |
| 2 (1.1K–5K) | kalshi, animatronics, pumpkin, cad-studio, spaces, lora, bake-off, presentations, video, finance, print-ingest, social, vids, drone, purchasing, sat-ops, world, rides | 18 | connectors and schedules dominate; 1–2 weeks each |
| 3 (5K–15K) | ocean-lab, payroll, scan-to-print, sports-edge, drone-relay, game-show, create, marketing-engine, switchboard, circuit-lab, portrait-studio, aero-lab | 12 | Python engines (aero-lab, circuit-lab, scan-to-print) stay out-of-process; 2–6 weeks each |
| 4 (> 15K) | trading, little-monsters, embodied, dnd, career-hunter, venture-plan | 6 | each is a project; trading also carries the futures numeric kernel (stays WASM per ADR-121) |

Domain code that lives in today's core and must become a package before it can migrate: trading
(`src/app/trading-*`, `src/features/trading`), drone, sat-ops, token-chase, presentation-generation,
video-generation, prediction-markets, world-data, speaker-diarization, spatial-mapping, camera,
visual-response, ambient-listening. These are extracted to the store during Phase 6, not ported into
the kernel.

---

## 4a. Project-level acceptance

The phase gates below prove components work. The *project* is judged by the scoreboard in
[10 — What we are actually improving](./10-what-we-are-improving.md): ways to start bot work, dispatch
outcomes, inputs to bot selection, prompt contributors, places a bot is defined, and modules that can run
a bot. Phases 1 to 3 exist to move the first three rows on a running kernel. If they do not move, the
premise is wrong and the plan stops rather than continuing.

## 5. Risks

| Risk | Signal | Mitigation |
|---|---|---|
| The SDK surface grows to mirror today's 124 modules | SDK seed inventory shows more `promote` than `move to package` | the inventory is reviewed with the spec's object model; anything without a kernel object moves to a package |
| Two kernels drift while both are live | a behavior fixed in one and not the other | Playwright black-box suites run against both from Phase 1; the spec is authority |
| Type guards get weakened under delivery pressure | a `pub` where a `pub(crate)` was; a compile-fail test deleted | the compile-fail suite is a required CI check; D5 keeps operator review through Phase 2 |
| Out-of-process host becomes the permanent answer and the sandbox never ships | no package on the WASM host by Phase 3 exit | 3b is an exit gate, not a stretch goal |
| Ecosystem gaps (socket.io, document generation) pull domain work into the kernel | a kernel crate depends on a document library | generation is a package concern; the cockpit moves to plain WebSocket in Phase 5 |
| Measured numbers get typed into docs | a footprint or latency figure with no benchmark file | P12; benchmark files in the kernel repo; ranges only |
| Review bottleneck | PRs older than a day | small PRs, one active branch, guards that let a reviewer trust the diff |

---

## 6. Exit criteria for retiring today's kernel

1. Every route in today's route inventory is served by `oshald` or has been retired with a recorded
   reason.
2. All 61 packages (or their successors) are active on `oshald` with sandbox-green tests.
3. The cockpit e2e green set and the Test Lab catalog pass against `oshald` alone.
4. `demo` mode installs from one file on a fresh machine and runs a package (D-01).
5. The ledger, budgets and traces reconcile on a full week of live use.
6. The publish gate, redaction guard and compile-fail suite are green on the retirement commit.

---

## 7. What this plan does not do

- No big-bang cutover. No rebase of history. No feature freeze on the store.
- No porting of domain code into the kernel to "save time"; it becomes a package or it waits.
- No performance claim before a benchmark file exists.
- No widening of the kernel object model without a rule for the new type to carry.
