# Ticket as workflow: read model and core execution contract

Status: first read-only slice in progress. This is a technical contract, not a claim that all tickets already execute through a graph or that n8n exports are compatible.

## Model

A ticket is the durable work instance. Its `ticketType` selects one registered workflow; the queue owns intake, dispatch, pause, retry and completion. A workflow step may be deterministic work, a bot assignment, a human gate or a child ticket. Child tickets are separate work instances with their own routing, linked to the parent. A shared root workspace can carry handover artifacts, but a file in that workspace is not automatically a typed step output or proof that a gate passed.

The operator should be able to answer: what process is registered for this ticket type; where did this ticket actually go; which bot worked on each recorded step; who approved a gate; what redacted inputs/outputs and artifacts were produced; which child tickets were created; and what is waiting or failed. Missing telemetry must remain visibly missing. A lifecycle status alone is not evidence that every workflow step executed.

## First read-only slice

`GET /api/v1/tickets/:ticketId/workflow` checks ticket ownership **and** application-result access before reading anything else. It returns only a safe projection:

- ticket identity, type, recorded canonical queue ID/name, state, current assigned agent;
- the **currently registered** workflow name/pipeline, default worker/reviewer roles, graph node IDs/types/titles, edges and explicitly declared bot bindings (not node config or credentials);
- the latest owner-matched graph run and its ordered recorded steps, with recorder-redacted input/output summaries;
- up to 100 status transitions with actor labels but no raw history metadata, plus graph-gate receipts correlated by the worker-stamped gate node/run IDs and the next transition out of that hold;
- up to 100 direct child tickets with status and assignment; and
- `available`/`unavailable` source markers, including for databases or history that cannot answer.

The cockpit Workflow tab reads only this endpoint. Its graph is labelled a **current registered definition**, not a historical snapshot. Recorded steps are shown separately, in observed order. An unrecorded graph node is **not** called pending or skipped: run recording is best-effort and a branch may not have been selected. A run step without a current matching node still renders. New graph suspensions stamp the gate node/run IDs on the approval-request status receipt. The next transition out of that hold supplies the recorded decision actor and status; `/api/tickets/:id/resume` now records the authenticated actor. This is a correlated transition, **not** proof that a human read or approved the contents. Older or truncated history, generic approval holds and missing run IDs are not guessed into a gate decision. The view never sends raw ticket metadata or definition node config to the browser.

The existing Process tab remains the lifecycle timeline. The Workflow tab complements it; it does not replace the queue, Workflow Studio inspector or Run Trace. Workflow-less chat/fallback tickets show an honest empty state. Built-in `swarm`, `incident-rca` and `manifest-worker` workflows show their registered process and observed ticket/child/lifecycle facts; only `graph` currently has node-level run records.

Queue classification and workflow selection are distinct: the queue is the ticket's recorded owning application, while `ticketType` currently selects the workflow. Multiple ticket types may share a queue, and an explicit queue override can differ from the derived type mapping. Displaying both does not establish a 1:1 queue/workflow invariant or prove execution.

## Core invariants for subsequent execution slices

1. On ticket intake, persist the resolved workflow **identity and immutable version/hash** or a clear unresolved state. Current registry lookup alone is not a historical binding. Exactly one dispatch authority owns the ticket; there is no hidden second scheduler.
2. Assignment is a durable ticket event before a worker accepts a step. Optional/best-effort `assignAgent` logging is not an auditable assignment contract. Child-ticket assignment and parent linkage must be visible in the same projection.
3. A human gate has a durable gate ID, requested approver role/principal, decision actor, decision time and outcome. The new gate-node/run receipt links a request to the next status transition; it still lacks a separately enforced approver role/principal and a semantic approve/deny operation. A failed/denied gate cannot silently continue.
4. A step has schema-checked inputs, outputs and artifact references, source/target ports where relevant, and a provenance link to the prior step or child ticket. The shared workspace is a handover transport; typed data lineage needs its own contract. Secrets are never copied into run previews.
5. Queue pause/resume, timeout, retry, cancellation and restart have explicit receipts and idempotency behavior. Do not close on a mocked happy path. A 45-second timeout anecdote is a live configuration/receipt question, not a measured default; the current queue backstop defaults to two hours.
   The in-memory status-history reader now preserves insertion order for equal millisecond timestamps. PostgreSQL still sorts by `created_at DESC` alone and has no durable per-ticket transition sequence; an identical-timestamp tie must be addressed before claiming exact ordered approval provenance under concurrent or rapid writes.
6. An imported n8n node is a versioned adapter to an approved deterministic operation, not a prompt with a similar name. Unsupported ports, per-item routing, joins, expressions, waits, retries or imported Code block publication. See `docs/research/n8n-import-assessment/README.md` for the measured compatibility boundary.

## Acceptance and closure

Mocked tests for this slice must cover owner/other-user/application denial before run/history reads; graph and non-graph projections; untrusted text escaping; no raw config/metadata; missing recorder/history; current-definition versus recorded-run mismatch; child assignment; and approval actor honesty. The first UI run may use fixtures, but that is not production proof.

The larger core uplift remains open until an actual ticket of each claimed pipeline class is observed from intake through queue dispatch, bot/child assignment, handover, human decision where applicable, output/artifact and terminal outcome; restart and failure paths are exercised; the installed cockpit renders the same receipts; and the current n8n adapter support matrix is proven against real exports. A published graph or passing compiler is not equivalent to a successful ticket run.
