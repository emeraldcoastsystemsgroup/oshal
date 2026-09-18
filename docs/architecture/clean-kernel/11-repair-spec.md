# Repair specification — fixing the existing codebase in place

**Status:** DRAFT 2026-09-18, for operator review. This is the alternative to the rewrite: how to reach
the target architecture in [01](./01-high-level-spec.md) **without replacing the platform**, using the
defects measured in [10](./10-what-we-are-improving.md) and the requirements in
[05](./05-subsystem-specs.md), [07](./07-subsystem-specs-2.md), [08](./08-workspace-and-assistant.md)
and [09](./09-adr-sweep-amendments.md).

**The premise.** The audit found fifteen defects, and every one is local, nameable and fixable. It also
found that several things I had called defects were deliberate and correct, and that the hardest
security property in the target design is already built. That is a repairable codebase, so the series'
value is as a **target architecture for repair**, not as a rewrite plan.

**What this document is not.** Not a rewrite, not a migration, not a refactor of anything that works.
Every item names its blast radius, and the default answer to "should this touch core" is no.

---

## How to use this document

Each item has the same shape: **evidence** (what is measurably wrong), **fix** (the smallest change that
removes it), **guard** (the regression test that ships in the same change), **blast radius**, and
**done when**. Items are grouped into waves by dependency, not by priority.

This repository's existing rules apply and are not restated per item:

- Branch, pull request, merge. One active development branch. Land it the same day.
- **Every fix ships its regression guard in the same change**, and the guard must cross the boundary
  whose failure it prevents. A mock-only test is not closure evidence for a mocked boundary.
- Tests accompany new functionality, registered in the Test Lab with the scenario and the file
  references, not merely present on disk.
- File and function caps, Change Log headers, structured logging, no silent catches, no stub
  deliverables.
- Smallest blast radius that solves the actual problem: store package over core, config over code,
  guard over refactor.

**Sizing.** Each item carries a T-shirt size. S is under a day, M is a few days, L is one to three
weeks, XL is a month or more. These are estimates for one competent lane with review, not commitments.

---

## Wave R0 — The fifteen defects

Independent of each other, landable in any order, no architectural change. This wave is the cheapest
value in the entire series.

### R0.1 — Declarations nothing reads (D1, D2, D7) — M

**Evidence.** A manifest may declare `phases`; nothing copies it, and the canonical ADR example uses it.
`stages` is still typed and copied into the registry but no runtime reads it, so a hand-authored staged
pipeline silently becomes a single-bot run of stage one. `extends` appears in eight persona files,
including one that describes itself as a base for others; the parser never reads the key.

**Fix.** One rule, three applications: **a declaration the runtime does not consume fails the load.**

- Add a manifest validation pass that rejects unknown and unconsumed keys with the offending key named.
- For `stages`: either delete the type and its registry copy, or restore the executor. Deleting is
  correct unless the staged shape is still wanted, because the graph engine supersedes it.
- For `extends`: **this needs an operator decision, because both answers change behavior.** Implementing
  flattening changes the prompts of eight bots and requires re-validating them. Removing the key from
  those files and deleting the concept makes the current behavior explicit. Do not leave it inert.

**Guard.** A manifest fixture per rejected shape. For `stages`, a test asserting a staged pipeline is
either executed or refused, never silently degraded.

**Blast radius.** Manifest loader, the registry bridge, persona parser. No runtime path.

**Done when.** No key can be declared that nothing consumes, and a fixture proves each rejection.

### R0.2 — One workflow shape (D3) — M

**Evidence.** The workflow shape is declared twice and bridged field by field by hand. That bridge
already dropped app-declared reviewer bots silently until it was found, and the dropped `phases` field
is the same bug still open.

**Fix.** Make the package's declaration the runtime definition. If a mapping must remain, generate it
from one type rather than hand-copying, so a field added to one side cannot be missing on the other.

**Guard.** A test that enumerates the fields of the source type and asserts every one survives the
bridge. This is the guard that would have caught the reviewer-bot loss.

**Blast radius.** The swarm-apps service and the routing types. Core, and load-bearing: propose before
building.

**Done when.** Adding a field to the workflow type either appears at runtime or fails the build.

### R0.3 — Silent degradation of a misconfigured graph (D4) — S

**Evidence.** A graph published without its process definition falls through to a single-bot run, and a
test codifies the degradation.

**Fix.** Refuse at publish and at load. An operator who publishes a broken graph gets an error naming
the missing definition, not a quiet one-bot run.

**Guard.** Replace the test that asserts the fallthrough with one that asserts the refusal. Note in the
change why the old assertion was wrong, so the next reader does not restore it.

**Blast radius.** Routing function and the publish compiler. Small, but it changes an asserted behavior,
so the pull request must call that out.

**Done when.** A graph workflow either has an executable definition or does not install.

### R0.4 — One meaning per status, and workflow position as a field (D5, D6) — L

**Evidence.** `approval_required` means a human must act, planning finished, or the planner returned
nothing. Per ADR-031's own amendment it no longer blocks children. Workflow position lives in ticket
metadata, run tables, and a legacy key, with no phase-to-status mapping function.

**Fix.** Two separable changes, in this order:

1. **Split the status.** Introduce a distinct state for planning-complete, leaving `approval_required`
   to mean only "a named principal must act". Update the parent-ready set accordingly. Amend ADR-031
   rather than leaving prose that contradicts the code.
2. **Make position a column.** One field on the ticket carrying the current node or phase, written by
   the engines that already checkpoint. Retire the legacy key behind a one-release read-compatibility
   window.

**Guard.** A test per meaning proving the two states are distinguishable, and a test that a resumed
graph reports the same position it checkpointed.

**Blast radius.** Ticket service, the sweeps, the graph worker, the cockpit's status rendering. Core and
wide. This is the largest R0 item and the one most likely to need its own ADR.

**Done when.** A person reading a ticket can tell what it is waiting for without reading metadata.

### R0.5 — Capability sets with no unrestricted representation (D14) — M, security-shaped

**Evidence.** The tool allowlist normalizer returns a null set for any non-array and the allow check
returns true for null; scopes behave identically. The docstring says so: an absent value keeps legacy
unrestricted behavior while an empty array denies everything. The security closure fixed the HTTP
carrier, not the primitive, so the swarm path is safe only because its caller always passes an array.

**Fix, in three steps, because flipping the default blind would break the legacy interactive path.**

1. **Find the callers.** Log at warning level with the caller identity every time the null branch is
   taken, and leave it running long enough to enumerate real traffic. Do not guess the caller set.
2. **Make every caller explicit.** Each one passes a set, empty if it means empty.
3. **Delete the null branch** and make the normalizers return an empty set for a non-array. After this,
   absent means nothing is allowed, and there is no representation for unrestricted.

**Guard.** A test asserting that a request with no allowlist is refused rather than unrestricted, plus a
test that the empty set still denies. The guard must exercise the real dispatch path, not the
normalizer in isolation, because the boundary that failed is the dispatch boundary.

**Blast radius.** The execution layer's capability utilities and every caller found in step 1. Security
boundary: this needs review attention out of proportion to its size.

**Done when.** No code path can obtain an unrestricted tool or scope set by omitting a field.

### R0.6 — One field declaring a bot's tools (D15) — S

**Evidence.** Thirteen of 103 personas declare `allowed_tools`; seventy declare `authorizations`, which
seeds the database; three declare both. The database-less fallback reads only the first, so about ninety
personas on a database-less node resolve to zero tools, not even the completion tool. Fail-closed, but
silently and totally.

**Fix.** Teach the fallback to derive from `authorizations` when `allowed_tools` is absent, normalizing
the mode aliases the seeder already normalizes. Then deprecate the redundant field with a load-time
warning and remove it once the personas are converged.

**Guard.** A test that a persona declaring only `authorizations` resolves a non-empty tool set on a
database-less node, and that the completion tool is always present in a non-empty set.

**Blast radius.** The authorization resolver and the containment fallback. Narrow.

**Done when.** One field declares a bot's tools, and no persona resolves to an unusable empty set.

### R0.7 — Provenance carried, not stamped (D8, D9, D11) — M

**Evidence.** The seeded platform, host and tenant layers carry no server-authored stamp, so the
swarm-wide policy layer classifies as untrusted content and lands beside the ticket body. The phase
override carries no metadata at all, so review-mode identity is demoted out of trusted policy in the
same priority slot the file persona occupies as policy. A third persona path for chat bypasses the frame
entirely, with no trust contract and no authority rebind.

**Fix.** Make the trust class a property of construction rather than a metadata flag:

- Provide constructor functions for policy layers and content layers. Only kernel modules can call the
  policy constructor. The classifier reads the constructed class instead of inspecting metadata.
- Stamp the seeded rows in a migration, or have the loader stamp rows it reads from the trusted global
  scope. Choose one and document why.
- Route the chat path through the same assembly function. This is R0.8.

**Guard.** A test per layer source asserting its resulting section, which is the test that does not
exist today and whose absence is D13. Include the seeded rows and the phase override explicitly.

**Blast radius.** Prompt containment and its callers. Security-bearing; review accordingly.

**Done when.** A layer cannot reach trusted policy without being constructed by kernel code, and the
seeded swarm-wide layer is policy again.

### R0.8 — One prompt assembly path (D10, D11) — M

**Evidence.** The assembly sequence exists twice, near line for line, and the copies have drifted: one
gained a direct short-circuit, protected execution and a skill-profile carrier the other lacks. A third
path for chat does not use the frame at all.

**Fix.** Extract the sequence once. Both transports and the chat path call it. Differences become
parameters, not copies.

**Guard.** A test asserting the three entry paths produce the same frame for the same inputs, and a
build-level check that the assembly function has exactly one definition.

**Blast radius.** Both execution handlers and the chat runtime context. Core.

**Done when.** A layer added once appears on every path.

### R0.9 — Pin the classifier (D13) — S

**Evidence.** No unit test covers the composition function, the classifier or the rebind by name, which
is why D8 and D9 were invisible.

**Fix.** A table-driven test over every layer type and provenance combination, asserting the resulting
section and that the rebind is present and last.

**Guard.** This item is the guard.

**Blast radius.** Tests only.

**Done when.** The classification table is executable.

### R0.10 — One name for "layer" (D12) — S

**Evidence.** "Layer" means the persona composition layer and the tools framework's layer one. The
collision is a live source of the confusion this work exists to end.

**Fix.** Rename in documentation and in identifiers where it is cheap. Persona composition keeps "layer";
the tools framework's concept gets its own word. Update the two ADRs that use both.

**Blast radius.** Naming and documentation. Do not rename database columns for this.

**Done when.** One word, one meaning, in the documents a new reader hits first.

### R0.11 — One workspace root resolver — S

**Evidence.** Two resolvers disagree on precedence and agree today only because compose sets both
variables to the same value. Configuration is holding a code invariant together.

**Fix.** One resolver, one precedence order, called everywhere. Delete the inline expression.

**Guard.** A test asserting the precedence order with both variables set differently.

**Blast radius.** Three call sites.

**Done when.** The invariant lives in code.

### R0.12 — A gate that gates — S

**Evidence.** A missing handover is logged and the output is accepted, flagged. A gate that does not gate
trains everyone to ignore it.

**Fix.** Decide explicitly: either the handover is required and its absence fails the round, or it is
advisory and the log line stops calling it a validation. Both are defensible; the current state is not.

**Blast radius.** The round validator. Behavior change; needs the operator's call on which way.

**Done when.** The log line and the behavior agree.

**Wave R0 total: roughly six to ten weeks for one lane**, dominated by R0.4. Every item is independently
shippable, so the wave can be paused at any point without leaving the tree inconsistent.

---

## Wave R1 — The task record

One structural change, because it is what the operator asked for and because it unblocks the workspace
and trace work.

### R1.1 — Every unit of work gets a task record — L

**Evidence.** Interactive work produces no ticket, therefore no status history, no phase trace, no run
record, and no ticket workspace. It passes a workspace folder keyed by route and user rather than by
task. A fast request that turns out to be long can only succeed or time out.

**Fix.** One submission function that creates the record first, with latency as a parameter:

- Interactive executes in the caller's context against a deadline and streams.
- Deferred dispatches through the existing queue manager, unchanged.
- Both produce the same record, workspace, cost attribution, trace and audit.
- **An interactive request that exceeds its deadline converts to deferred and returns a handle.**

The existing invocation function stays: it already resolves transport correctly and is the chokepoint.
This wraps it rather than replacing it.

**Guard.** A test asserting interactive and deferred produce identical record shapes, and a deadline
test asserting conversion rather than error. The guard must cross the real queue boundary, not a double.

**Blast radius.** The submission surface, the ticket service, and the fourteen route modules that
currently invoke a bot. Core and wide. **Propose before building.**

**Done when.** A fast answer has a trace a person can open, and a slow one has a handle.

### R1.2 — Workspace follows the task, for all work — M

**Evidence.** Interactive work uses a workspace folder keyed by route and user. Ticket work uses one
keyed by the root ticket.

**Fix.** Once R1.1 exists, the workspace key is the task id in both cases. This item is mostly deletion.

**Guard.** A test that an interactive task's artifacts are reachable from its record.

**Done when.** One keying rule.

---

## Wave R2 — The package boundary

The single highest-leverage change in this document, and the one that is language-neutral: it is worth
doing whether or not a rewrite ever happens, and a rewrite that has not done it would port a tangle.

### R2.1 — Publish the seed inventory — S

**Fix.** Generate the list of kernel modules that store packages import, with call-site counts, and mark
each `promote to SDK` or `move to package`. This is Phase 0 step 2 of the project plan and is pure
analysis.

**Done when.** Every one of the 124 modules has a verdict in a generated table.

### R2.2 — Publish a versioned SDK package — L

**Fix.** A single entry point exporting what packages are allowed to use: the scoped store, logging, the
bot invocation, intents, notifications, storage, and the declaration types. Version it. Nothing in it
reaches into a route module.

**Guard.** A build check that the SDK's own imports stay inside the allowed set.

**Blast radius.** New surface; nothing existing changes yet.

### R2.3 — Migrate packages onto the SDK, in waves — XL

**Fix.** Package by package, replace deep imports with SDK imports. Start with the smallest packages,
which are one to three days each, and let the largest wait. Roughly 1,500 import sites across 924 files,
but the distribution is heavily skewed: eight modules account for most of them, and the top two, logging
and the application context, are mechanical.

**Guard.** A lint rule that fails a deep import from a package, enabled per package as it migrates, then
globally.

**Done when.** No package imports a kernel internal, and the lint rule is global.

**This wave is the one that changes what a rewrite would cost.** After it, a kernel replacement is a
port behind a stable interface rather than a re-entanglement.

---

## Wave R3 — Properties TypeScript cannot compile-enforce

The target design makes several invariants compile errors. TypeScript cannot do that fully. These are
the strongest available substitutes, and their limits should be stated rather than papered over.

### R3.1 — Admission by construction — L

**Fix.** A request context object that is the only way to obtain a store handle, a provider handle or an
intent handle. Route handlers receive it; nothing else constructs it. Unscoped constructors become
module-private.

**Limit, stated honestly.** In TypeScript this is enforced by module boundaries, a lint rule and the
existing route-auth inventory tests, not by the compiler. It removes the accident, not the intent.

**Guard.** Keep the inventory tests. They stop being redundant in this world; they become the
enforcement.

**Blast radius.** The 88 route files that already reference the guard, plus the 169 that do not. XL if
done at once; **do it per route module as each is touched**, with the inventory test tracking coverage.

### R3.2 — Tenancy identity carried, not threaded — L

**Fix.** The scoped store derives row-level-security identity from the context once. The 113 files that
thread it by hand stop doing so as they are touched.

**Guard.** The existing coverage gate, extended to assert that no new file threads identity manually.

### R3.3 — Workspace isolation — L, and it needs a decision

**Evidence.** Every bot container mounts the same workspace volume read-write. The project's own reverted
ADR says a directory layout on a shared read-write mount is attribution, not enforcement, and names what
would be required: per-owner subpath mounts, per-owner volumes, or a filesystem jail per bot container.

**Fix options, for the operator to choose.** Per-owner subpath mounts are the least invasive and give
per-person isolation but not per-ticket. A materialization service that hands each bot only its claimed
subtree gives per-ticket isolation and is the target design, at a higher cost. Doing nothing is also a
choice, and it is defensible for a single-operator deployment, but it should be a recorded choice rather
than an accident.

---

## Wave R4 — One codebase

### R4.1 — Fold the execution layer in — XL

**Evidence.** 214K code lines of TypeScript and 41K of JavaScript, bridged.

**Fix.** Port module by module as each is touched, starting with the ones the bridge crosses most. This
wave has no deadline and should never block another.

**Note.** The execution layer is where the capability snapshot chain lives, which is the best code in the
platform. Port it faithfully or leave it alone.

---

## What this document deliberately does not propose

- **No rewrite.** No new language, no parallel kernel, no freeze.
- **No touching what works.** The declared-pipeline dispatch, the bid auction, the persona layer model
  and frame, the capability snapshot chain, the checkpoint and resume design, the cost ledger and the
  registry precedence rules are correct. They appear here only where a defect sits beside them.
- **No renaming for taste.** R0.10 renames only where the collision actively confuses.
- **No new features.** Every item removes a defect or a duplication.

---

## Sequencing

| Wave | Contents | Size | Blocks |
|---|---|---|---|
| R0 | the fifteen defects | 6–10 weeks | nothing; start immediately |
| R1 | the task record | 3–5 weeks | benefits from R0.4 |
| R2 | the package boundary | 3–6 months, mostly background | nothing; run beside R0 and R1 |
| R3 | admission, tenancy, isolation | per-module, ongoing | R3.3 needs a decision first |
| R4 | one codebase | open-ended | never blocks |

**R0 and R2.1 can start today.** R0.4, R0.5, R1.1 and R2.2 should each carry a short proposal before
work starts, because they touch core.

---

## Decisions this document needs

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| 1 | `extends`: implement flattening, or delete the key from eight personas | both change behavior; implementing alters eight bots' prompts |
| 2 | `stages`: delete the type, or restore the executor | deleting is correct only if the staged shape is genuinely superseded |
| 3 | Handover: required, or advisory | the current flagged-but-accepted state is the only indefensible one |
| 4 | Workspace isolation: per-owner mounts, per-claim materialization, or an accepted risk | all three are defensible; an accident is not |
| 5 | Does R1.1's conversion behavior need an ADR | it changes what a caller can expect from a fast request |

---

## How we will know it worked

The scoreboard from [10 §7](./10-what-we-are-improving.md#7-the-scoreboard), scoped to what repair can
move.

| Measure | Today | After R0 | After R1–R3 |
|---|---|---|---|
| Declarations nothing reads | 3 | 0 | 0 |
| Workflow shapes bridged by hand | 2 | 1 | 1 |
| Prompt assembly implementations | 3 | 1 | 1 |
| Provenance stamped by hand | 3 sites, 2 wrong | 0 | 0 |
| Meanings of one approval status | 3 | 1 | 1 |
| Places workflow position is stored | 3 + legacy | 1 | 1 |
| Capability primitives where absent means unrestricted | 2 | 0 | 0 |
| Persona fields declaring tools | 2 | 1 | 1 |
| Task records for interactive work | none | none | same as queued |
| Packages importing kernel internals | ~1,500 sites | ~1,500 | 0 |
| Cross-ticket workspace isolation | none | none | by decision 4 |

**What repair cannot reach**, and should not be claimed: layering enforced by the build rather than by
lint, admission as a compile error, and a single distributable artifact with no external services. Those
remain arguments for a rewrite, and they are the only ones this audit left standing.
