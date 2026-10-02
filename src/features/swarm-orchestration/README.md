# Swarm Orchestration Feature

## Purpose
Provides the surrounding application workflow for swarm ticket processing in OSHAL, separate from BaseAgent internals.

## Canonical References
- `docs/architecture/swarm-processing-design-contract.md`
- `docs/architecture/swarm-orchestration-process-flow.md`
- `docs/adr/018-swarm-processing-runtime-contract.md`
- `docs/adr/034-bidirectional-config-ownership-sync.md`

## Public API
- `SwarmOrchestrationController`
- `SwarmTicketProcessingService`
- `TicketCycleStateMachine`
- `TicketDecompositionService`
- `PostgresSwarmRunStore`
- `TicketStateProjectionService`
- `TicketWritebackAdapter`
- `PlaneTicketWritebackAdapter`
- `InMemorySwarmRunStore`

## Remote Provider Authority

Manifest-worker and incident bot-node dispatches use ADR-034's default-on provider/model stamp.
`providerConfigRequired` distinguishes a missing authoritative record from an intentional legacy
request. The bot reconciles before task creation, refuses an unavailable seam/provider or concurrent
mismatch, verifies the reported execution identity, and returns the config source/action/version.
Only explicit `OSHAL_PUSH_ON_DISPATCH=off` permits the unstamped compatibility fallback.

## Canonical Ticket Model
- OSHAL canonical states:
  `backlog`, `approved`, `in_process_discovery`, `in_process_design`, `in_process_build`, `in_process_deploy`, `in_process_test`, `in_process_release`, `approval_required`, `customer_action`, `complete`, `escalated`
- provider-native names such as Plane `todo` are normalized into OSHAL state keys before orchestration logic runs
- queue-manager semantics now anchor state projection: `approved` after intake, `in_process_discovery` for Phase 0 discovery/planning, `approval_required` as the planning-complete marker (children auto-dispatch from here — the ADR-031 human build gate was relaxed 2026-06-22; see "Decomposition depth and limits" below), `in_process_build` for execution, `in_process_test` for validation/review, `in_process_release` for delivery packaging, then `customer_action`
- swarm processing now accepts bounded policy overrides for verification attempts, design/build regressions, write-back retries, retry delays, and explicit `human_review` escalation routing so the orchestration path can be tested without queue transport
- subtickets default to `tree_only` visibility so lead/root tickets remain the only items returned unless `includeSubtickets` is explicitly requested
- provider processing is explicitly `ticket` mode only; chat-mode interactions must stay outside the provider ticket-processing route

## Seven-Phase Processing Model
1. `intake` - normalize/classify the work item and score complexity
2. `planning` - decompose work, select the primary agent, and persist work items
   Decomposition now infers coarse work intent like implementation, testing, documentation, review, integration, or analysis so routing and later review phases get clearer signals.
   PM planning parsing also preserves inline `Suggested agent role` hints when no explicit `AGENT_ASSIGNMENTS` block is present, so decomposition can carry specialist routing intent forward.
3. `specialist_input` - optional high-complexity enrichment from a specialist path
4. `execution` - dispatch work and run bounded execution/verification policy
5. `testing` - record verification results for medium/high complexity paths
6. `review` - required completion review for medium/high complexity paths, with review prompts focused on the inferred work-intent evidence classes and reviewer findings normalized into stable evidence-gap signals
7. `delivery` - finalize lifecycle, write back, and record completion metrics

Complexity gating:
- low complexity: `intake -> planning -> execution -> delivery`
- medium complexity: `intake -> planning -> execution -> testing -> review -> delivery`
- high complexity: all 7 phases

## Decomposition depth and limits

Recursive/multi-layer builds are **2-level only**:

- A root ticket (depth 0) decomposes into **up to 5 child tickets** (depth 1). Children do **not** decompose further — this is a hard cutoff, not a soft default. Constants: `MAX_DECOMPOSITION_DEPTH = 1`, `MAX_ACTIVE_SUBTASKS_PER_PARENT = 5` in [src/entities/work-item/types.ts](../../entities/work-item/types.ts). Total build size is therefore bounded by 5 × (leaf size); deeper trees require lifting the depth cap.
- Once the root reaches `approval_required` (planning complete), its `approved` children **auto-dispatch** on the next poll cycle — `approval_required` is in `PARENT_READY_FOR_CHILD_DISPATCH_STATES` by design ("parent planned, children created — let them dispatch"). There is no enforced manual approval step between planning and child execution (see the ADR-031 Amendment, 2026-07-18).
- Siblings with a planning order (`subtaskIndex`) run **one at a time**: a child waits while an earlier sibling is unfinished or still in flight. A child owned by someone other than its root's owner is cancelled (`child_owner_mismatch`) and never dispatched (ADR-031 Amendment, 2026-10-01).
- The **decompose-or-not decision is LLM-driven** by the PM (`system-architect`) Phase-2 planning round, and it is **not deterministic**. Complex, clearly multi-component tickets decompose reliably (verified 2026-07-18: a smart-home build split into 4 typed children — device layer / rules engine + scheduler / REST API / tests). Mid-size tickets can collapse to a single work unit when the PM produces no parseable `## SUBTASK DECOMPOSITION` block with ≥2 subtasks (verified 2026-07-18: a URL-shortener build produced 0 children). Reliable mid-size decomposition is a PM-prompt tuning target, not a guarantee.

## Routes
Registered through the swarm extension under:
- `GET /api/swarm/smoke`
- `POST /api/swarm/tickets`
- `POST /api/swarm/providers/:provider/process`
- `GET /api/swarm/runs`
- `GET /api/swarm/runs/:runId`
- `GET /api/swarm/work-items`
- `GET /api/swarm/escalations`

## Notes
The `/ui` debug surface exposes a manual `Run Smoke Test` control and direct swarm actions, but that surface is diagnostic, not proof of end-to-end production readiness.

Direct submission and provider processing are both synchronous orchestration calls. Today they should be treated as infrastructure-backed features, not pure local UI actions.

Current runtime dependencies for a real successful execution:
- authenticated request
- reachable Postgres for work items, agent profiles, persona layers, and run state
- a resolvable LLM provider from the main app configuration
- seeded swarm agents

Plane-specific requirements:
- `PLANE_API_URL`
- `PLANE_API_TOKEN`
- project/workspace identifiers or explicit intake/write-back URLs

Transport behavior:
- Redis is used when `SWARM_MESH_TRANSPORT=redis` or `REDIS_URL` is configured
- otherwise the app falls back to in-memory mesh transport
- when Redis is active, live worker heartbeats are stored in the runtime registry and routing can filter candidates down to online agents only
- execution, verification, and consensus-review delivery now target direct mesh channels (`agent.<canonical-agent-id>`) instead of relying only on the shared `swarm.ticket.execute` stream
- worker containers keep alias direct-channel subscriptions for legacy bot-name identities so existing `BOT_NAME` containers remain reachable while runtime IDs converge on canonical agent UUIDs

Recent ticket-processing hardening:
- structured root tickets now enter `in_process_discovery`, decompose in planning, and move to `approval_required` (planning-complete marker) once children are created
- approved child tickets **auto-dispatch as soon as the parent reaches `approval_required`** — `PARENT_READY_FOR_CHILD_DISPATCH_STATES` includes `approval_required` by design, so no operator action is required to release them. (This supersedes the earlier "wait for the build gate at `in_process_build`" behavior described in ADR-031 — relaxed 2026-06-22 in commit `6a376cb6`; see the ADR-031 Amendment for the as-built record.)
- child tickets created from PM planning now retain `subtaskTitle`, `pmAssignedRole`, and `pmAssignedAgentId` metadata so direct specialist execution can honor PM routing guidance; they also carry the root's owner and verified issuer and their planning order (`subtaskIndex`, `subtaskCount`, `siblingTitles`)
- child-ticket direct execution units remain depth `0` within their own run, preventing them from being misclassified as nested subtask rows during lifecycle polling
- the worker now persists `subtask-pending/subtask-assigned/subtask-executing` rows to `subtask-completed` or `subtask-failed`, and orphan dedup now treats those terminal subtask rows as already complete
- work-type inference now ignores acceptance-criteria test wording when the subtask title and suggested role indicate implementation work, preventing implementation subtasks from being misrouted as testing

Current operational limitation:
- the execution-completion path still polls `WorkItemRepository.findByExternalIdAnyProvider()`
- when Postgres or provider readiness fails, the route now returns `503` before execution starts
- there is still no true no-Postgres execution mode behind that guard
- the static compose bot registry remains as a compatibility overlay for cockpit/legacy engineering surfaces, so registry drift can still occur when a container exists without a seeded canonical agent profile

Verification is policy-aware and supports retries, regression accounting, escalation metadata, work-type-aware structural checks for testing/docs/review/integration/analysis outputs, and more specific retry/escalation reasons when those evidence classes are missing. Consensus review now emits normalized evidence-gap findings too, but the overall system is still not yet equivalent to full domain/business acceptance testing.

## Live proof: tickets in tickets (2026-10-02)

`node scripts/operations/live-acceptance.js tickets-in-tickets` printed `PASS tickets-in-tickets` five
times on 2026-10-02, the first at 01:31 UTC on the preview deploy of `4d244b8a` and the latest at 21:33 UTC
on the image of `main` `b63effdf` (verification runs the tests, #1020) with the case's probe fix `f9c4ba67`
(delegation signing configured):

- Root `e0e8a4d7` filed 21:25:36 as the operator, planned on system-architect's node
  (`antigravity-cli / gemini-3.8-flash-low`, the installed fleet default) in 77 s and parked at
  `approval_required` (`planning_complete`) with two owned children in planning order.
- Child 1 (code-developer, "Build the Slugify Utility Function with Token Splitting…") and then child 2
  (test-engineer, "Implement the Comprehensive Slugify Test Suite…"), one at a time over the signed hop
  on the same configured engine; after each, verification ran the workspace's tests on test-engineer's
  node as the `workspace-tests/run` deterministic intent and recorded the run on the child
  (`metadata.verificationTests`): `npm test` exit 0, 6 passed; then exit 0, 14 passed. The root assembled
  to `customer_action` with 40 files in its folder. Activity: 3 requests, 403,064 input tokens, cost 0 on
  the subscription.
- Before cleanup the cockpit hierarchy listed the root with exactly its children, each child detail
  named the root as its parent, and `/code?folder=/workspace/<root>` redirected onto the root folder.
- Cleanup receipt: removed 7 (the root, both children, the root folder, three shadow tickets), kept 1
  (cost rows), outstanding 0, errors 0; residue 0 in every table the run touches; the folder gone.

The pass before it (19:11 UTC, `main` `1848fb4f`, root `ee42ab93`) had the same shape without the test
gate: 159 files, 322,939 input tokens, cost 0.

Two review build tickets filed outside the case that evening showed what the case had not judged: one
reached `customer_action` with a failing test in its deliverables (verification was structural), the next
had a test-engineer that never ran its suite. Those became the test-engineer persona's execution contract
(#1018), the executed test gate (#1020), the case's per-child test-run judge, and two fixes the gate's
first live runs found: the probe's 400-entry listing truncating inside a `node_modules` (#1021) and
vitest's upward config search reaching the image's own `vite.config.ts` from a config-less workspace
(#1022).

The runs between those passes each failed on a box condition the case names, and each became a fix the
same day: a re-read answered during a database lock (#1004), a planning reply without its decomposition
section while the node had written `IMPLEMENTATION-PLAN.md` (#1006), api event-loop stalls of one to six
minutes (#1007, #1009), and one approved root claimed twice after such a stall (#1010). One further run
(19:00 UTC, same code) got a one-turn planning answer with no decomposition and no plan file from the
node's engine, which the case fails by name ("one child titled like the root"); the next run passed.
Two runs before the first pass failed at planning while the round still used a hosted API key (503,
then a 429 request quota); that path is gone (`controller-pm-round-executor.ts`).

## Design Alignment Summary

Currently true:
- auth protects the live swarm routes
- route-level readiness failures return `503`
- Redis is optional for transport boot
- the active lifecycle is 7-phase, not 5-cycle

Not yet true:
- no reduced-capability local execution mode exists
- a mounted route or loaded UI does not prove successful swarm completion
- verification is not yet equivalent to domain/business acceptance testing
