# Swarm Orchestration Feature

## Purpose
Provides the surrounding application workflow for swarm ticket processing in OSHAL, separate from BaseAgent internals.

## Canonical References
- `docs/architecture/swarm-processing-design-contract.md`
- `docs/architecture/swarm-orchestration-process-flow.md`
- `docs/adr/018-swarm-processing-runtime-contract.md`

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
- child tickets created from PM planning now retain `subtaskTitle`, `pmAssignedRole`, and `pmAssignedAgentId` metadata so direct specialist execution can honor PM routing guidance
- child-ticket direct execution units remain depth `0` within their own run, preventing them from being misclassified as nested subtask rows during lifecycle polling
- the worker now persists `subtask-pending/subtask-assigned/subtask-executing` rows to `subtask-completed` or `subtask-failed`, and orphan dedup now treats those terminal subtask rows as already complete
- work-type inference now ignores acceptance-criteria test wording when the subtask title and suggested role indicate implementation work, preventing implementation subtasks from being misrouted as testing

Current operational limitation:
- the execution-completion path still polls `WorkItemRepository.findByExternalIdAnyProvider()`
- when Postgres or provider readiness fails, the route now returns `503` before execution starts
- there is still no true no-Postgres execution mode behind that guard
- the static compose bot registry remains as a compatibility overlay for cockpit/legacy engineering surfaces, so registry drift can still occur when a container exists without a seeded canonical agent profile

Verification is policy-aware and supports retries, regression accounting, escalation metadata, work-type-aware structural checks for testing/docs/review/integration/analysis outputs, and more specific retry/escalation reasons when those evidence classes are missing. Consensus review now emits normalized evidence-gap findings too, but the overall system is still not yet equivalent to full domain/business acceptance testing.

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
