# Clean kernel — amendments from the ADR sweep

**Status:** DRAFT 2026-09-18, complete for the current corpus. A systematic audit of all 164 ADRs and the
core architecture documents against this series found kernel rules the first drafts missed. Each row is a
new requirement traced to the decision that establishes it. Requirement IDs extend the families defined in
[01 §5](./01-high-level-spec.md#5-functional-requirements), [05](./05-subsystem-specs.md),
[06](./06-deployment-postures.md), [07](./07-subsystem-specs-2.md) and [08](./08-workspace-and-assistant.md).

**Method.** Four read-only audits, one per ADR range, each given the series' coverage list and instructed
to report only rules that are kernel-level, absent from the series, and backed by a quotable line.
Precision over recall: a guess was worse than silence. 86 findings were returned; overlapping findings
from different ranges are merged here into one requirement citing both sources.

**New families introduced here:** **ST** stores, files, notification and search rails.

**What this changes about the series.** The audit did not overturn any decision. It found that the series
specified the *shape* of several subsystems correctly while omitting the rule that makes each one safe.
The recurring pattern is worth naming: almost every gap is a **fail-closed detail at an edge** — an empty
grant, an unknown identifier, a stale cache, a missing key, an unmeasured axis, an unknown outcome. The
kernel's posture is only as good as its behavior at those edges.

---

## 1. Control: secrets and credential handling

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| C-09 | Secrets MUST be encrypted at rest, and a missing encryption key MUST refuse reads, writes and deletes. Plaintext fallback MUST NOT exist. | ADR-002 | with no key configured every secret operation refuses with a named code |
| C-10 | When a tool genuinely needs a materialized credential, it MUST run in a single-user ephemeral session that revokes the lease and wipes its storage at teardown, provably leaving no residue. | ADR-040 | teardown asserts lease revoked and storage wiped; two concurrent privileged sessions refuse |
| C-11 | Refusal auditing MUST be throttled per caller, and a capability that is off MUST unmount its surface rather than audit every denial. | ADR-077 | a refusal flood does not grow the audit store without bound |
| C-12 | A credential-selection boundary MUST reject an unknown key rather than silently dropping it, and each owner MUST receive only its own resolved keys. | ADR-083 | a silently dropped key once made a bot report demo mode while its owner's connection was valid |
| C-21 | A machine-to-user call MUST carry a signed, single-use delegation grant bound to one workload, user, method, canonical path, body digest, audience and scope. | ADR-122 | a service secret plus an asserted subject is refused; replay and path substitution refuse |

## 2. Control: authorization depth

The series specified tiers and a door. These are the rules that keep authorization honest inside the data
operation, across time, and at the edges of the permission namespace.

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| C-13 | An executor credential MUST only narrow a business grant, never widen it, whatever the transport. | ADR-149 | a personal access token, bot, job or external call cannot exceed the human grant behind it |
| C-14 | Queued work MUST record intent, not authority. Rights MUST be re-resolved at execution, so a person disabled while work waits stops that work. | ADR-149 | revoke between enqueue and dispatch prevents the run |
| C-15 | Grants MUST combine as permission, scope and field-set tuples. Dimensions MUST NOT be unioned independently. | ADR-149 | team-summary plus own-details must not become team-details |
| C-16 | Authorization MUST be enforced inside the data operation: authorized predicates before pagination, totals, sorting and aggregation, and updates validating both current and proposed ownership. | ADR-149 | counts and totals never include unauthorized rows; an ownership change cannot escape scope |
| C-17 | A revocation and the write it revokes MUST share one transaction and version protocol. A pre-write permission lookup in an unrelated transaction is insufficient. | ADR-149 | the race is decided deterministically and the ordering recorded |
| C-18 | An unknown permission identifier MUST deny, including for an administrator. | ADR-149 | a typo becomes a denial, never an admin-only allow |
| C-19 | Forbidden and missing MUST return the same answer, and authorization MUST happen before any child read. | ADR-107, platform-shared-services | a non-owner, a missing id and a malformed id are indistinguishable |
| C-20 | Credential endpoints MUST be enumeration-safe and timing-safe. | ADR-117 | unknown accounts burn the same cost as wrong passwords; one generic failure message |
| C-22 | Untrusted content MUST be fenced with its provenance inside the prompt, and promotion out of the untrusted class MUST require deterministic validation or an exact-digest operator approval. | ADR-122, ADR-135 | retrieved and ingested text cannot re-enter as instruction |
| C-23 | A system-service principal MUST NOT read or write person-owned rows. | ADR-157 | the service subject matches no person; row-level security proves it |
| C-24 | Root MUST be transferable but never removable: a swarm can never be left rootless. | ADR-148 | revoking root fails; transfer succeeds |
| C-25 | A failed privilege-store read MUST clear the authority cache rather than serve a stale snapshot. | ADR-148 | a revoked administrator loses access when the store is unreachable |
| C-26 | A break-glass operator path MUST survive loss of the authority store. | ADR-148 | recovery is designed and tested, not improvised |

## 3. Control: budgets and runaway protection

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| C-27 | Budget enforcement MUST fail **open** on an infrastructure gap and **closed** only on a definite breach. | ADR-104, platform-shared-services | an unreadable ledger warns and allows; a proven hard-cap breach refuses |
| C-28 | A runaway kill switch MUST trip on execution count per window, not on dollars. | ADR-104 | a dispatch loop is caught before cost accrues |

This is the one place where the series' blanket fail-closed rule is deliberately inverted, and the
asymmetry is the point: an unreadable ledger must not brick all dispatch, while a proven breach must stop.

## 4. Stores, files, notification and search (new family ST)

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| ST-01 | A file write MUST resolve to the person's chosen backend, and the local fallback MUST be quota-capped. | ADR-041 | exceeding the local quota refuses |
| ST-02 | A read-only query handle MUST be proven non-modifying by the engine's own planner, never by keyword inspection. | ADR-045 | a modifying query refuses before execution; a denylist-evading query still refuses |
| ST-03 | Row-level-security coverage MUST be machine-asserted table by table, with a justified exception list. Stale or reason-less exceptions MUST fail. | ADR-076, ADR-124 | a new owner-bearing table without a policy turns the coverage gate red |
| ST-04 | Outbound notification MUST be a governed rail: per-person topic-to-channel routing, quiet hours, a transport registry, and sends and skips logged without throwing into callers. | platform-shared-services | a notification failure never breaks its caller |
| ST-05 | Search MUST be one caller-scoped rail over the person's own data through a pluggable source interface, never returning cross-person rows. | platform-shared-services | cross-store search respects the same scoping as a direct read |

## 5. Tenancy and activation

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| T-06 | A bot or worker principal MUST receive a narrower database role able to execute only enumerated derived helpers that answer one question about one row, never the underlying tables. | ADR-076 | the worker role cannot select from a walled table; the helper set re-converges every boot |
| T-07 | Tenant isolation MUST extend to the worker's network and resource boundary, not only to rows. | ADR-078 | a tenant's worker cannot reach another tenant's network |
| T-09 | A run-time authorization denial MUST suspend the activation with the decision's reason, never fail silently. | ADR-157 | rights changed after activation produce a suspended activation, not a quiet stop |

## 6. Queue, intake and scheduling

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| Q-08 | An envelope whose ticket is in a terminal state MUST be acknowledged and skipped, never executed. | ADR-023 | a redelivery after completion runs nothing |
| Q-09 | Work MUST be scheduled per tenant with rate limits so one tenant cannot monopolize workers. | ADR-035 | a saturating tenant does not starve another |
| Q-10 | Privileged nodes and tools MUST be reachable only through queue-mediated ticket dispatch, never a direct call and never an assistant delegation. | ADR-070 | a direct invocation refuses even when admitted |
| Q-11 | An intake MUST be acknowledged only after its durable commit; a landing failure MUST answer so the sender retries. | ADR-125 | nothing is acknowledged that was not durably accepted |
| Q-12 | A retry after an **unknown** outcome MUST escalate to review. Blind automatic resubmission MUST be disallowed. | ADR-101 | an in-flight row whose result is unknown routes to assisted review |
| Q-13 | A schedule tick MUST key off the due instant, so a missed window expires unfired and a restart or second replica can neither double-fire nor skip. | ADR-136 | restart and replica tests |

Q-12 is the honest limit on the series' exactly-once claim: for a non-idempotent external effect, the
unknown-outcome arm cannot be automated, so it must be named and escalated rather than retried.

## 7. Bots, dispatch integrity and inference credentials

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| B-17 | Dispatch MUST stamp the authoritative provider and model, and a result reporting a different one MUST NOT be accepted as success. | ADR-034 | mismatch fails the run rather than recording it green |
| B-18 | Tool authorization MUST support automatic, ask and off. An `ask` tool MUST request approval mid-turn, and a timeout MUST deny. | ADR-010, layer1-tools-framework | approval, denial and timeout paths all tested |
| B-19 | A package MUST declare an inference hint such as a capability tier, never bind an endpoint, model or key. | ADR-090 skills | a manifest binding a model or endpoint fails the load |
| B-20 | The credential for a call MUST resolve caller-first: bring-your-own, then tenant key, then a capped operator pool, else refuse. The ledger MUST record which key paid. | ADR-090 skills | ledger rows carry the paying key class; pool exhaustion refuses |
| B-21 | After execution, what actually ran MUST match what the authorizing record specified; a provider failover onto an unauthorized brain MUST be refused after the fact. | ADR-162 | a fallback-completed result is refused because it reports the fallback's name |
| B-22 | Created, provisioned and operational MUST be distinct states reported truthfully. A registered bot with unbound tools MUST NOT be described as deployed. | deployable-agent-contract | an incompletely bound agent reports its real state |

## 8. Packages, registries and surfaces

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| P-09 | Dependencies MUST be reference-counted. Uninstall MUST block while active dependents exist, a dependent MUST block rather than retain, and an orphan MUST NOT cascade. | ADR-085, kernel-vs-app doc | uninstall with a dependent refuses and names it |
| P-10 | Deactivate and uninstall MUST tear down the package's schedules. | ADR-085 | a deactivated package stops polling and stops spending |
| P-11 | Tool names MUST be global: a collision with another active package fails the load closed, and ownership derives only from active manifests. | ADR-085 | last-loader-wins once repointed one app's live tool at another app's endpoint |
| P-12 | A schedule target MUST resolve to the exact package-owned export, with no fallback to a route at the same path. | ADR-085 | an inactive package's tick resolves to nothing |
| P-13 | An empty or absent capability grant MUST mean the narrowest set, never unrestricted. | ADR-089 | an empty grant yields a minimal read-only set |
| P-14 | Visibility and authorization MUST be separate axes: publishing an export never confers the right to call it, and depending on a private export fails resolution closed. | ADR-090 skills | public never means safe for anyone to execute |
| P-15 | A manifest MUST declare which access tiers it supports and its default for a signed-in person, validated at load. Deny MUST always be available. | ADR-118 | an undeclared tier mapping fails the load |
| P-16 | Install MUST present a per-package blast radius (routes, migrations, schedules, connectors) as a confirmation. Trusting a registry MUST NOT imply consenting to a package. | ADR-147 | installing is the second click, never the first |
| P-17 | A transitive dependency offered by two registries MUST fail closed rather than silently selecting a source. | ADR-147 | ambiguous source refuses; this is the supply-chain substitution the trusted-registry row exists to prevent |
| P-18 | Package bots MUST launch through a substrate seam with a platform-fixed image. A launch specification MUST have no image field. | ADR-129 | a caller-supplied image is impossible by type |
| P-19 | When the kernel calls a package hook as a person, it MUST do so over a fenced service rail with per-package failure isolation: one package's failure or timeout never blocks the others or the caller. | ADR-144 | a failing package does not abort the flow |
| P-20 | A surface-to-shell bridge MUST carry only declared operations, defaulting to none. | kernel-vs-app doc | an absent allow-list means the relay carries nothing |

## 9. Connectors and streaming

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| X-07 | Connections MUST be keyed per account, and selection MUST be deterministic: explicit selector, then the person's default, then a sole candidate, then a stable tiebreak. Recency MUST NOT be a rule, and ambiguity MUST refuse so the bot asks. | ADR-042, ADR-113 | a second mailbox is expressible; no silent cross-account action |
| X-08 | Webhook ingress MUST be an admission entry kind: signature-verified, declared in advance, replay-deduplicated. Unsigned, wrongly signed or undeclared deliveries MUST be refused. | ADR-065 | the signature is the only reason such a route may sit outside the identity wall |
| X-09 | Outbound provider calls MUST go through one client with retry and backoff honoring the provider's retry hint, a per-provider rate bucket and one error shape. | ADR-065 | rate-limit governance holds across packages and tenants |
| X-10 | Operation risk level MUST be derived by the kernel from declared operations, never self-declared by a package. | ADR-067 | a manifest asserting its own risk level is rejected |
| X-12 | A streaming upstream MUST terminate in the kernel with one process-wide connection, reference-counted fan-out, and explicit staleness labels. No store module MUST have a path to the key. | ADR-143 | one credential holder; liveness is honest |

## 10. Knowledge and retrieval

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| R-07 | Retrieval MUST run index-backed queries and MUST NOT degrade to a full-collection scan. | ADR-091 | index presence is asserted; a missing index fails rather than scanning |
| R-08 | Fusion and ranking MUST use one shared implementation so semantics are identical across store engines. | ADR-091 | the same query ranks identically on each engine |
| R-09 | The embedding dimension MUST be pinned by the index, and changing the embedding model MUST be treated as a reindex migration. | ADR-091 | a model swap without a migration is refused |
| R-10 | Chunk lifecycle MUST be transactional with the owning rows, so deleting a source deletes its chunks. | ADR-091 | no orphaned chunks survive a delete or an uninstall |

## 11. Workflow, gates and artifacts

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| F-07 | Tickets MUST form a parent-child tree, and cost MUST aggregate recursively through all descendants. | ADR-027 | a decomposed ticket's total includes every child |
| F-08 | Operator input to a running ticket MUST be durable and MUST reach the bot on its next pick-up, surviving restarts. | ADR-026 | guidance submitted mid-run appears after a restart |
| F-09 | An approval gate MUST suspend the run durably, and resuming MUST re-enter at the gate's successor without re-running completed phases. | human-in-the-loop | resume test; no repeated spend |
| WS-11 | An artifact handle MUST be owner-bound, short-lived, audit-logged and carry no bytes at rest; only the minting principal resolves it. | ADR-139 | another principal cannot resolve a handle |
| WS-12 | A handle's source MUST be a same-origin application route. Local paths and absolute external URLs MUST be refused at mint. | ADR-139 | a mint cannot launder a server-side fetch into an authorized artifact |

## 12. Nodes, devices and physical acts

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| Z-08 | Authorization MUST filter candidate machines before any preference order runs, and enumeration MUST be scoped too. | ADR-114 | a foreign pin resolves to nothing and dispatches nothing |
| Z-09 | A physical act MUST carry a safety class. Kinetic acts MUST be human-executed with the fence re-validated at execution, stop and abort MUST be confirmation-exempt, and a node MUST fail closed on link loss. Every command MUST be audited. | ADR-151 | each class behaves per the taxonomy; link-loss test |

## 13. Monitoring, verdicts and self-healing

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| H-07 | Alarms MUST fire on **absence** of expected data, not only on thresholds. | ADR-125 | a wedged pipeline alarms; silence is not health |
| H-08 | A remediation MUST complete only after its effect is verified. A command exiting successfully is not evidence, and failed verification MUST reopen and escalate. | ADR-119 | a restart that did not restore the component reopens |
| O-05 | An unmeasured verdict axis MUST be stored and displayed as null, never a fabricated zero, and an escalated-but-scored run MUST read as degraded rather than pass. | ADR-063 | no false green |
| K-07 | A judge verdict MUST carry its mode, and deterministic-fallback verdicts MUST NOT be blended with model verdicts into one number. | ADR-106 | blended scores are impossible by type |
| A-06 | A per-person status probe MUST run in the caller's own session, never with a service credential or a personal access token. | ADR-145 | per-user data is read in the person's session or not at all |
| A-07 | An unreachable or unresolvable probe MUST render as "cannot check", never as fact and never as zero. | ADR-145 | a green check the application never asserted is impossible |

K-07 matters beyond monitoring: the judge is what gates optimization promotion in
[07 §M](./07-subsystem-specs-2.md#m-token-optimization-and-cost-efficiency), so a blended verdict would
make every savings claim unverifiable.

## 14. Self-writing and deployment safety

| ID | Requirement | Source | Acceptance |
|---|---|---|---|
| S-05 | An untrusted-code sandbox MUST refuse to run unless a narrow egress network is explicitly configured. | ADR-077 | credentials plus seeded source plus open egress is the exfiltration path being closed |
| S-06 | A change class MUST be re-derived server-side from the real changed paths, taking the highest severity. A model-supplied class is a hint only. | ADR-077 | a fast lane cannot ship core code |
| S-07 | The self-repair and deploy runtime MUST run beside the kernel, never inside it. | ADR-077 | a kernel outage does not take the repair path with it |
| S-08 | Kernel fetches of operator-supplied URLs MUST be fenced against server-side request forgery: secure scheme only, public address, no cross-host redirect following. | ADR-147 | an administrator-typed address is still untrusted input |
| D-06 | A deploy outcome MUST distinguish rolled-back-and-serving from nothing-serving, and an unrecognized outcome MUST fail closed. | ADR-077 | each outcome maps to a distinct operator response |

---

## Amendment index

| Family | New IDs | Count |
|---|---|---|
| C control, authorization, budgets | C-09 … C-28 | 20 |
| ST stores, files, notify, search (new) | ST-01 … ST-05 | 5 |
| T tenancy and activation | T-06, T-07, T-09 | 3 |
| Q queue, intake, scheduling | Q-08 … Q-13 | 6 |
| B bots and dispatch integrity | B-17 … B-22 | 6 |
| P packages, registries, surfaces | P-09 … P-20 | 12 |
| X connectors and streaming | X-07 … X-10, X-12 | 5 |
| R knowledge and retrieval | R-07 … R-10 | 4 |
| F workflow and gates | F-07, F-08, F-09 | 3 |
| WS artifacts | WS-11, WS-12 | 2 |
| Z nodes and physical acts | Z-08, Z-09 | 2 |
| H, O, K, A monitoring and verdicts | H-07, H-08, O-05, K-07, A-06, A-07 | 6 |
| S, D self-writing and deployment | S-05 … S-08, D-06 | 5 |

**Total: 79 new requirements**, consolidated from 86 audit findings after merging overlaps between ranges.

## The pattern worth keeping

Read as a set, these amendments say one thing the first drafts under-specified: **the kernel's guarantees
live at its edges.** An empty grant, an unknown permission id, an unknown outcome, a stale cache, a missing
key, an unmeasured axis, an unreachable probe, a second registry offering the same dependency. Each is a
moment where a system either fails closed, fails open deliberately, or drifts. The series already said
"fail closed"; what it lacked was the enumeration of edges where that sentence has to be cashed out, and
the one place it must be inverted on purpose (C-27).
