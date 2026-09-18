# Clean kernel — design series

A language-neutral specification of what oshal should be if it were designed again from what this
project has learned, followed by the Rust object model, the project plan and the documentation import
map. Phase 0 of the evaluation that followed [ADR-121](../../adr/121-native-compiled-kernel.md); this
series is the "new profile" that ADR's scope guard asks for and does not reopen its numeric-kernel decision.

| # | Document | Status |
|---|---|---|
| 10 | [What we are actually improving](./10-what-we-are-improving.md) — **read this first**: the eight problems in today’s codebase with measured evidence, the one law behind them, what each design change fixes, and the project scoreboard | DRAFT 2026-09-18 |
| 11 | [Repair specification](./11-repair-spec.md) — how to reach the target architecture **in place**: the fifteen defects as shippable work items with guards and blast radius, the task record, the package boundary, and the three properties repair cannot reach | DRAFT 2026-09-18 |
| 01 | [High-level technical and functional specification](./01-high-level-spec.md) — goals, principles, keep / copy / re-architect / drop triage, target architecture, requirements with acceptance criteria, dated evidence | DRAFT 2026-09-17 |
| 02 | [Rust object model and processes](./02-rust-object-model.md) — the streamlined types per crate, each naming the rule it carries; the seven kernel processes | DRAFT 2026-09-17 |
| 03 | [Project plan](./03-project-plan.md) — decisions D1–D5, phases with done-when gates, cross-phase workstreams, package migration waves, risks, retirement criteria | DRAFT 2026-09-17 |
| 04 | [Documentation import map](./04-documentation-import-map.md) — every ADR and architecture document classed kernel / package / node / governance / superseded, with its target | DRAFT 2026-09-17 |
| 05 | [Subsystem specifications](./05-subsystem-specs.md) — identity and SSO, user management, settings precedence, application management, dynamic loading, queue and mesh, connector framework, knowledge/RAG, time series, monitoring and self-healing, code packing | DRAFT 2026-09-18 |
| 06 | [Deployment postures](./06-deployment-postures.md) — single/multi user, single/multi tenant, bare artifact vs container vs compose vs Kubernetes with Helm and Terraform, hot-load vs restart vs blue-green vs rolling | DRAFT 2026-09-18 |
| 07 | [Subsystem specifications, part 2](./07-subsystem-specs-2.md) — workflow authoring and execution, token optimization, tracing, ambient capture, person model and learning, bot composition, external agents and A2A, node network and overlay | DRAFT 2026-09-18 |
| 08 | [The task workspace, any-harness collaboration, and the assistant](./08-workspace-and-assistant.md) — the task is the common thread and the workspace is shared; claims, commits, provenance, merge policies; the harness contract; the three kernel rails under the assistant; why it scales from a laptop to an enterprise | DRAFT 2026-09-18 |
| 09 | [Amendments from the ADR sweep](./09-adr-sweep-amendments.md) — 79 requirements the first drafts missed, found by auditing all 164 ADRs and the core architecture documents; the recurring theme is fail-closed behavior at the edges | DRAFT 2026-09-18 |
| — | [diagrams/](./diagrams/README.md) — ten Mermaid pages: crate graph, the door, object model, package lifecycle, ticket flow, harness-as-node, tenancy, deployment, self-writing loop, type guards, data planes, identity and settings, monitoring and self-healing, workflow, trace and token economy, node network, person model, task workspace, assistant, one-way-to-do-things | DRAFT 2026-09-17 |

Reading order: **10 first** (what is wrong, with the corrections of record), then **11** (how to fix it in place), then 01 → diagrams → 02 → 05 → 07 → 08 → 09 → 06 → 03 → 04. Document 09 is an amendment ledger: read it after the subsystem documents it amends.

**Two routes, one target.** Document 11 reaches the architecture by repairing the current codebase; document 03 reaches it by building a new kernel beside it. The audit behind document 10 favours repair: the defects are local, several things first called defects turned out to be deliberate and correct, and the hardest security property in the target design is already built. Documents 01, 02 and 05 to 09 describe the target either way.
disagrees with it, the spec wins and the other is fixed.
