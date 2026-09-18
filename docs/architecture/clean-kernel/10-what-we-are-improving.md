# Clean kernel — what we are actually improving

**Status:** DRAFT, rewritten 2026-09-18 after reading the code. The first version of this document was
written from measurements without reading the designs behind them, and several of its claims were wrong.
They are corrected below, on the record, because a rewrite justified by a misreading is worse than no
rewrite.

The rest of the series describes what the system should be. This document answers the prior question:
**what is right today and must be carried forward, what is genuinely broken, and what the design
changes.** If a problem is not on this list, the rewrite is not justified by it.

Evidence from the tree on 2026-09-18. Regenerate before quoting.

---

## 0. Corrections of record

| My earlier claim | What the code shows |
|---|---|
| "Five dispatch outcomes chosen by conditionals." | Three execution engines selected by the workflow's **declared** `pipeline` field, plus one inference rule for manifests that omit it and one retry sentinel. The routing function is pure, documented as such, and has two test suites. The call site is a switch table. |
| "Bot selection is four competing inputs, one of them a model." | Four mechanisms, **one per pipeline**, each deliberate: a graph pins the bot in the node; the manifest worker runs an ordered cascade where the declared bot is the last resort and a bid auction is deliberately gated to the generic task lane; incident takes the workflow's bot; the seven-phase swarm routes per phase through a documented cascade. The free-text regex pin I implied still exists was deleted when the call-out landed. |
| "Prompt assembly is about ten accretive contributors." | There is a **declared six-type layer model** with integer precedence, a database constraint enforcing the type names, one composition function, and a kernel-owned frame. The count of ten was the number of *producers*, not the number of mechanisms. |
| "An authority rebind exists because the layering diluted authority." | Wrong, and unfair to the design. The rebind is ADR-122's containment mechanism: a server-authored record, JSON-encoded and hashed so injected prose cannot visually replace the binding. It defends against prompt injection, not against the layering. |
| "The workspace is not shared; artifacts are exchanged." | The workspace **is** shared, follows the root ticket, and travels end to end as a field on every dispatch hop. Corrected in [08](./08-workspace-and-assistant.md) before this rewrite. |

The pattern in my errors is worth naming because it is the failure mode of any rewrite: **I read the
shape of the code and inferred intent, instead of reading the decision.** Three of the five things I
called defects are the deliberate answer to a problem I had not noticed.

---

## 1. The law that survived the audit

> **There is exactly one way to do each thing, and the variation is a parameter of that one way, not a
> second code path.**

The audit did not weaken this. It relocated it. The platform already applies it in the places that got
the most attention: one routing function, one composition function, one frame, one invocation
chokepoint, one cost ledger. What the audit found is that **the same idea is applied inconsistently**,
and every genuine defect below sits where a second path, a second producer, or a second copy was allowed.

---

## 2. Ticket assignment and dispatch

### What is right and must be carried forward

- **Pipeline is a declared field on the workflow**, set in YAML, carried into a registry that refuses an
  app trying to override a built-in. Dispatch is a table lookup on a declared property.
- **The routing decision is a pure function** with a stated no-I/O contract and two test suites.
- **The queue manager has one intake query** and a clear set of responsibilities: concurrency limiting,
  a stuck-slot watchdog, a circuit breaker, orphan recovery, child creation, parent assembly, and a
  pre-dispatch budget gate that leaves the ticket approved for re-check rather than failing it.
- **Bid-based assignment for the open lane is a genuinely good design.** Owners self-score, a confidence
  floor applies, cost and latency break ties, and scoped bots are excluded from the broadcast so they
  never see work they may not do.
- **Graph runs checkpoint and resume.** A ticket stays approved during execution precisely so that a
  crash re-dispatches and resumes from the checkpoint instead of restarting.

### What is genuinely broken

| # | Defect | Evidence |
|---|---|---|
| D1 | **A manifest can declare `phases`. Nothing reads it.** The field is in the manifest type, in shipped YAML, and in the ADR's own canonical example. The registry bridge never copies it. | no consumer anywhere in the tree |
| D2 | **Stages are vestigial.** Still typed, still copied into the registry, read by no runtime. The staged executor was retired. A hand-authored staged pipeline silently becomes a single-bot run of stage one. | no staged dispatcher exists |
| D3 | **The workflow shape is declared twice and bridged by hand**, and that bridge has already dropped a field silently: app-declared reviewer bots never got one until it was found. The dropped `phases` field is the same bug, still open. | the bridge carries its own incident note |
| D4 | **A graph published without its process definition degrades to a one-bot run instead of failing**, and a test codifies the degradation. | the routing spec asserts the fallthrough |
| D5 | **`approval_required` means three different things**: a human must act, planning finished, or the planner returned nothing. Per ADR-031's own amendment it no longer blocks children at all. | the parent-ready set includes it |
| D6 | **Workflow position is not in the ticket.** For a graph run the ticket sits at `approved` throughout, while position lives in ticket metadata and run tables, with a legacy key still read for compatibility. There is no phase-to-status mapping function. | three state locations plus a legacy key |

### What the design changes

- **The shape is derived from the definition, so there is no pipeline label to omit, mistype or leave
  vestigial** (F-03). D1, D2 and D4 stop being possible rather than being fixed.
- **One workflow type, not two bridged by hand.** A package's declaration *is* the runtime definition,
  validated at load. D3's whole class disappears.
- **Validation is total before install** (F-02): an unresolved node or a missing definition refuses.
  Silent degradation is not an option the loader has.
- **Workflow position is a first-class field**, not a status overload and not metadata. Approval is a
  distinct suspended state with one meaning (F-09), so D5 and D6 resolve together.
- **Queues become real objects**, per tenant with fair-share limits (Q-09), rather than one poller over
  a single status. That is the amendment sweep's finding, and it is what makes the mental model of
  "every queue has a workflow" true in the implementation rather than only in description.

---

## 3. Fast response versus a ticket

### What is right

One invocation function already resolves transport: a dedicated bot goes over HTTP, an inline one runs
in process. Both paths record cost to the same ledger. The assistant is a client of that function, not a
third execution path. That is the chokepoint working as intended.

### The real gap, stated precisely

**Interactive work produces no task record.** It has no ticket, therefore no status history, no phase
trace, no run record, and no ticket workspace. It passes a workspace folder keyed by route and user
rather than by task, so the folder does not follow the work. And because there is no record, a fast
request that turns out to be long has nowhere to become: it can only succeed or time out.

That is narrower than "three paths" and more fixable.

### What the design changes

One submission function. Every unit of work becomes a task record at admission, with latency as a
parameter rather than a path: interactive executes in the caller's context against a deadline and
streams; deferred dispatches to a worker; both produce the same record, workspace, cost, trace and
audit. **An interactive request that exceeds its deadline converts to deferred and returns a handle.**
That conversion is the point, and it is only possible once both modes share a record.

---

## 4. Persona layers and tools

### What is right and must be carried forward

This is the part I most misread. The model is deliberate and, in its core, close to what I proposed as
the fix.

- **A closed six-type layer union** with integer precedence, and the type names enforced by a database
  constraint rather than by convention.
- **One composition function** producing a **kernel-owned frame** in a fixed order: trust contract,
  trusted policy, trusted configuration, untrusted content, server authority rebind.
- **Trust class is derived by the server, never asserted by the layer.** The default is untrusted. Role
  layers are always untrusted because user-reachable surfaces persist them, and the comment explaining
  that is the load-bearing line in the file.
- **Untrusted content is JSON-escaped and length-capped** so it cannot forge section delimiters.
- **Tool availability is not prompt text.** It is resolved from durable per-agent authorization modes,
  filtered by the catalog's enabled flag, translated through a frozen reviewed name map with no identity
  fallback, and handed to the runtime as an immutable binding. Only an explicit automatic mode is
  unattended-executable; ask still needs a decision. A database fault degrades to completion-only.
- **Authorization tool executors are code-reserved**, persisted shell strings are never executed, and
  protected execution can zero the entire tool set.
- **Capabilities are snapshotted at request start and revalidated at every boundary.** The execution
  layer captures the allowed tools and scopes *before the model is shown any schema*, filters the
  advertised registry by both the allowlist and the operation scope so an unscoped tool is never even
  described, re-resolves every model tool request against that snapshot, and re-asserts the snapshot
  before the provider call and before each operation — so flipping a tool to off mid-run aborts the run
  rather than racing it. The transport seam adds a registry attestation and rejects name aliases,
  because authorizing one spelling while a transport executes another is the attack it exists to stop.

  **This is worth naming explicitly: it is the immutable request-start handler generation with exact
  operation scopes that this repo's own harness posture names as a precondition for ever re-enabling a
  local agent harness. The hard part is already built.** The clean design inherits it as B-10 rather
  than inventing it.

### What is genuinely broken

| # | Defect | Evidence |
|---|---|---|
| D7 | **`extends` in persona YAML is inert.** Eight personas declare it, including one that describes itself as a base for others. The parser never reads the key. The foundation persona's content is silently dropped. | no resolution anywhere in the tree |
| D8 | **The seeded swarm-wide layers never reach trusted policy.** The platform, host and tenant rows carry no server-authored stamp, so they classify as untrusted content and land beside the ticket body. The fail-closed default is correct; nothing stamps the rows. | the swarm-wide policy layer is inert as policy |
| D9 | **The phase override silently demotes itself.** The file persona layer is stamped server-authored and classifies as policy. The layer that replaces it in the same priority slot carries no metadata at all, so review-mode identity is demoted to escaped untrusted content. Almost certainly unintended. | same slot, opposite trust class |
| D10 | **The assembly sequence is duplicated across two handlers** near line for line, and the copies have drifted. A layer added to one will silently not exist on the other. | two implementations of one sequence |
| D11 | **A third, unlayered persona path exists for chat**: same persona file, same identity prose, but a plain join with no trust partition, no trust contract and no authority rebind. | the containment frame is bypassed on that path |
| D12 | **"Layer" means two different things** in the codebase: the persona layer type, and the tools framework's layer one. That collision is itself a source of the confusion this rewrite is meant to end. | two vocabularies, one word |
| D13 | **The classification table is unpinned.** No unit test covers the composition function, the classifier or the rebind by name, so D8 and D9 could not have been caught by the suite. | the guard for the security-bearing function is absent |
| D14 | **Absent means unrestricted.** The tool-allowlist normalizer returns a null set for any non-array, and the allow check returns true for a null set. Scopes behave the same way. Its own docstring says an absent value keeps legacy unrestricted behavior while an empty array denies everything. | the primitive is fail-open by default |
| D15 | **Two persona fields that look interchangeable feed different code paths, and only one has a fallback.** 13 of 103 personas declare allowed tools; 70 declare authorizations, which seeds the database instead. On a database-less bot node the resolver falls back to the persona field, so the other ~90 personas resolve to zero tools — not even the completion tool. Fail-closed, but silently and totally: the bot can neither act nor return a result. | 13 vs 70 vs 3 declaring both |

D8, D9 and D11 are the same defect in three places: **provenance is stamped by hand, so it is missed.**

### What the design changes

- **The frame stays. It was right.** What changes is that **trust class is carried by the constructor,
  not by a metadata flag someone remembers to set.** A policy layer is a different type from a content
  layer, so an unstamped policy layer cannot be constructed, and D8, D9 and D11 become impossible rather
  than fixed.
- **One assembly path.** The sequence exists once, in the kernel, and both transports call it. D10 has no
  surface.
- **Inheritance is resolved at build time or refused at load.** A package that extends another is
  flattened during validation. A declaration nothing reads fails the load rather than being dropped.
  That closes D7 and D1 with one rule.
- **One vocabulary.** Layer means the persona composition layer. The tools framework's concept is named
  separately in the spec. D12 is a naming decision, and naming decisions are cheap only if made once.
- **The guard ships with the mechanism.** The classifier and the frame are security-bearing, so they
  carry compile-fail and behavior tests. D13 is a policy, not a fix.
- **A capability set has no "absent" representation.** It is a set, always, and the empty set denies.
  There is no null to mean unrestricted, so D14 cannot be written. This is the same rule the amendment
  sweep already derived from the skill-import decision (P-13): an empty or absent grant means the
  narrowest set, never unrestricted. D14 is that rule being violated in a different subsystem, which is
  the argument for making it a type rather than a convention.
- **One field, one meaning.** A bot declares its tools once, in its package declaration, and the
  resolver has one source with one fallback. D15's split disappears with the four-place bot definition.

---

## 5. The workspace

Measured findings and their consequences are in
[08 §2a](./08-workspace-and-assistant.md#2a-what-exists-today-measured). In summary: the shared workspace
works and follows the root ticket, per-bot containers are real, **"scalable" is an aspiration no code
implements**, and **"secure" is not true today** — the project's own reverted isolation ADR says a
directory layout on a shared read-write mount is attribution, not enforcement. Three competing handover
naming conventions coexist, a missing handover is flagged and accepted, and two workspace-root resolvers
agree only because configuration makes them.

The design answer is per-claim materialization and kernel-owned versioned commits, which turns isolation
from a convention into a property, and typed artifacts, which removes the filename lottery.

---

## 6. The pattern underneath every defect

Fifteen defects, one shape: **a second copy, a second producer, or a second meaning.**

| Shape | Instances |
|---|---|
| A declaration nothing reads | D1 phases, D2 stages, D7 extends |
| One shape declared twice and bridged by hand | D3 workflow types, D10 assembly paths, D11 third persona path |
| One name meaning several things | D5 approval, D12 layer |
| State in several places | D6 workflow position, two workspace-root resolvers |
| A property stamped by hand rather than carried by type | D8, D9 provenance; D14 absent-means-all |
| Two fields that look interchangeable | D15 tool declaration split |
| A guard that does not guard | D4 codified degradation, D13 unpinned classifier, the flagged-but-accepted handover |

None of these is carelessness. Each is what happens when a system grows correctly under time pressure:
the second path is always cheaper than changing the first. **The rewrite's value is not better ideas —
most of the ideas here are already good — it is a structure where the cheap move and the correct move
are the same move.**

---

## 7. The scoreboard

Revised after the audit. Rows the audit disproved are removed; rows it confirmed carry their evidence.

| Measure | Today | Target | Confidence |
|---|---|---|---|
| Declarations nothing reads | 3 (phases, stages, extends) | 0, refused at load | measured |
| Workflow shapes declared and bridged by hand | 2 | 1 | measured |
| Prompt assembly implementations | 3 (two layered, one bypassing the frame) | 1 | measured |
| Provenance stamped by hand | 3 sites, 2 of them wrong today | 0, carried by type | measured |
| Meanings of `approval_required` | 3 | 1 | measured |
| Places workflow position is stored | 3 plus a legacy key | 1 field | measured |
| Task records for interactive work | none | same record as queued | measured |
| Cross-ticket workspace isolation | none, by the project's own ADR | by construction | measured |
| Capability primitives where absent means unrestricted | 2 (tools, scopes) | 0, no such representation | measured |
| Persona fields declaring a bot's tools | 2, feeding different paths | 1 | measured |
| Bot replicas | 1, fixed, no scale mechanism | nodes scale | measured |
| Route modules that can run a bot | 14 | 1 door | measured |
| Files threading tenancy identity by hand | 113 | 0 | measured |
| Server codebases | 2 | 1 | measured |
| Layering enforcement | lint | build | measured |

**What is not on this list, deliberately:** dispatch path count, bot selection mechanism count and
prompt contributor count. The audit showed those were either already coherent or were me counting
producers and calling them mechanisms.

**How to get there without a rewrite:** [11 — Repair specification](./11-repair-spec.md) turns every defect above into a shippable work item with a guard and a blast radius.

**The honest caveat.** Every target is a design claim. The first three phases of the plan exist to make
the top rows real on a running kernel. If they do not move, the premise is wrong, and the plan says to
stop rather than continue.
