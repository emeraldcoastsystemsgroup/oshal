# ADR-165: Import n8n processes through native ticket workflows

## Status

Proposed — 2026-09-26. Records the operator's requested direction and the remaining
implementation contract. The analysis tool and private Packs review draft are built in the
checkout. Executable conversion, publication and installed acceptance remain open in the
[delivery backlog](../backlog/n8n-import-forward-plan.md). No existing ADR is superseded.

## Context

The operator wants to reuse existing workflow nodes, ticket queues, shared workspaces, bot
personas and Codex Packer to import useful n8n processes. Users should see a ticket as a workflow:
its steps, assigned bots, approvers, inputs, outputs, handovers and results. A process may also be
packaged for reuse, and proven examples should become searchable.

The [assessment](../research/n8n-import-assessment/README.md) found useful native building blocks
and specific execution gaps. Shared files carry handovers, but do not by themselves define item
types, output ports or lineage. A ticket-level branch does not partition a list of items. A
parallel join does not implement a field-based data join. These differences require explicit
adapters and runtime behavior.

Current code and evidence:

| Component | What exists | Boundary relevant to this decision |
| --- | --- | --- |
| [Import analyzer](../../src/features/workflow-studio/services/n8n-import-analyzer.ts) | Bounded JSON analysis, source type/version and port topology, explicit unsupported reasons | Reports are non-executable; source parameters and private data are discarded |
| [Packs draft builder](../../src/features/workflow-studio/services/n8n-import-pack-draft.ts) and [routes](../../src/app/routes/swarm-pack-routes.ts) | Owner-scoped review pack, read-only graph, download, server deploy refusal | Manual Trigger v1 can produce a disconnected Start proposal through the existing Studio factory |
| [Studio node factory](../../src/features/workflow-studio/schemas/workflow-studio-schemas.ts) | Fresh IDs and catalog defaults for known native nodes | Creating a node does not implement a new operation or establish source equivalence |
| [Publish compiler](../../src/features/swarm-apps/services/workflow-publish-compiler.ts) | Native graph compilation into the existing runtime | Imported ports, item semantics and deterministic-only graphs need explicit compiler support |
| [Process engine](../../src/features/workflow-studio/engine/process-definition-execution-engine.ts) | Native control flow and execution services | The assessment recorded missing item routing, retry/error behavior and a placeholder sub-process result |
| Codex Packer / Bot Forge | Persona and manifest authoring, pack deployment, edit-in-place identity | The current pack deploy emits `incident-rca`; it does not execute the supplied `workflow.json` |
| [Ticket workflow projection](../architecture/ticket-workflow-view-spec.md) | Current definition, recorded run steps, assignments, children and correlated gate transitions | Current registry lookup is not an immutable historical binding; a status transition is not an enforced approval decision |

The prior implementation receipt is 25 focused analyzer/tool/HTTP/browser/Forge tests and both
source/server TypeScript checks passing. It proves the review slice in the checkout. The
assessment's public examples have no demonstrated complete native conversion.

## Decision

### D1. Keep the ticket and queue as the execution authority

A ticket is a durable work instance. Its type resolves to a registered workflow. Queue identity
continues to describe ownership and scheduling; a queue may serve multiple ticket types.
Imported processes use the existing intake, registry, queue and worker paths.

At intake, persist the resolved workflow identity and immutable version/hash, or an explicit
unresolved state that prevents dispatch. A step may run a deterministic operation, invoke an
assigned bot, wait for a human decision, or create a linked child ticket. A child process receives
its own ticket and pinned workflow binding when its lifecycle requires independent dispatch.
The importer does not introduce another scheduler or independently advance ticket status.

### D2. Separate source review, native conversion and assisted redesign

The existing review draft remains useful without execution. An executable draft is a separate,
versioned model created after mappings and local bindings are resolved. Because today's review
pack discards parameters, executable conversion needs an explicit source re-upload or operator
configuration. Check the source hash and show changes before creating a new revision.

Use two visible authoring outcomes:

- **Native conversion:** every executable source step, option, expression and connection is
  covered by a versioned adapter and matching behavioral evidence.
- **Assisted redesign:** Codex Packer builds a native process for the operator's stated outcome.
  Show changed or omitted behavior and test the new acceptance contract. A redesign is not
  cataloged as an equivalent conversion of its source.

Unknown behavior stays unresolved. Imported text is process data, not authority to call tools.
Credential references become local owner-authorized bindings. Preserve only validated operation
configuration needed by the selected adapters; exclude source secrets, executable Code and pinned
payloads from normal drafts, previews, logs and public catalog records.

### D3. Add explicit item and port contracts to the native runtime

Use the following logical records. Storage changes must extend the existing owner-scoped stores;
this ADR does not prescribe a second copy of ticket history or a separate workflow database.

| Record | Required information |
| --- | --- |
| Import draft revision | Owner, source hash, schema revision, node ordinals/local IDs, source type/version, validated options, connection channels/ports, unresolved reasons, conversion/redesign mode |
| Adapter binding | Exact source type/version and option schema, native operation and adapter revision, expression subset, input/output schemas, required local bindings, side-effect and retry policy |
| Item envelope | Run/step/item identity, JSON value or authorized artifact reference, source-item lineage and schema revision |
| Step receipt | Ticket/run/workflow revision, node/attempt, assigned bot or operation, input/output references, selected ports, times, terminal state and failure reason |
| Gate/child reference | Durable gate or child ID, parent ticket/step, required approver or child workflow, decision/result provenance |

Each adapter declares whether it processes each item or the whole input batch. Outputs are ordered
item collections on named channels and indexed ports. Distinguish no items, missing values, null
and false. Preserve lineage through filtering and joining. Carry large or binary artifacts through
existing owner-scoped artifact references once that family is supported.

The runtime must preserve the admitted source ordering policy. It must not silently turn ordered
branches into parallel work. Unsupported fanout, cycles, ports or node options fail validation
before a run. The compiler must admit a valid deterministic-only graph without adding a fake bot.
Runtime admission must reject unsupported persisted nodes as well as the publish endpoint.

The first candidate families are Manual Trigger, NoOp, Set/Edit Fields, If and HTTP Request.
Choose exact versions and option subsets from pinned fixtures before registering support. HTTP
actions bind existing authorized operations/connectors; source URLs and headers do not create a
new unrestricted network tool. Expressions use a bounded parsed subset with explicit type rules.

### D4. Reuse native node creation, bot capabilities and process packing

Adapters create supported native nodes through the existing factory and compiler. If an operation
is missing, add a reviewed native capability with tests and a backlog item; a similar node name or
free-form bot prompt does not supply that implementation.

Bot selection uses declared capabilities, allowed tools and existing registration/hot-load paths.
Create a persona only when the native process calls for a distinct accountable role. Persist which
bot accepted each ticket step. A persona description cannot grant connector or tool authority.

Codex Packer remains the process-packaging path. Add an explicit graph-capable pack contract that
compiles the reviewed native graph through the existing publisher. Preserve owner, app identity,
ticket type and existing bot IDs when updating a pack. Keep the current single-worker/reviewer
pack mode available for processes deliberately authored that way. An n8n review marker alone
cannot be relabeled into a runnable pack; conversion produces a separately validated revision.

### D5. Make the ticket workflow view explain recorded execution

The ticket and workflow views read the same durable facts. Show the definition pinned to the run,
the actual path, assigned bots, operation attempts, approver requests/decisions, data summaries,
artifacts and child tickets. Keep current-definition previews separate from historical runs.

Persist assignment before worker acceptance. Gate decisions must enforce the requested approver's
authority and record approve/deny explicitly. Give transitions a durable sequence so equal
timestamps cannot reorder evidence. Record retry, cancellation, timeout and restart behavior,
including whether a side effect was committed or its outcome is unknown. A shared handover file
becomes a step output only through a validated reference and recorded provenance.

Reuse existing queue checkpoints and human-action/escalation paths. A worker timeout does not
imply successful completion or permit an unbounded replay. Before enabling a side-effecting
adapter, define its idempotency and recovery behavior and verify exact call counts under failure.

### D6. Publish support claims only with reproducible evidence

Maintain a support matrix keyed by source node type/version/options and adapter revision.
Evidence distinguishes analysis, unresolved configuration, unsupported behavior, equivalence in
controlled tests and installed acceptance. Run pinned n8n fixtures and the corresponding OSHAL
process with controlled inputs and local fake endpoints; compare values, types, item order,
selected ports, lineage and side-effect counts. Then exercise the real OSHAL queue and signed-in
workflow view for the claimed subset.

For public examples and training material, record source URL, hash, retrieval date and reuse terms.
Each observed unsupported behavior links to a work item or an explicit exclusion. A searchable
catalog may expose reviewed metadata and current proof; it must not label an untested example
working. Adapter/source changes invalidate or supersede the associated proof.

### D7. Roll out in independently verifiable stages

1. Install and accept the current review UI and analysis tool.
2. Build the item/port contracts and durable ticket receipts, then certify the first adapter subset.
3. Add executable draft publication and faithful process packing through the native queue.
4. Run installed acceptance and expose proven examples in the searchable catalog.
5. Add advanced node families individually against the same evidence requirements.

Each release may support a narrow, named subset. All unsupported families remain visible. Record
remaining work under stable N8N IDs in the [forward backlog](../backlog/n8n-import-forward-plan.md).

## Alternatives considered

- **Rename nodes or translate JSON directly to YAML:** loses item, port, version and failure
  semantics. Use explicit adapters instead.
- **Run every source step as a bot prompt:** appropriate only for a separately reviewed redesign;
  it cannot substantiate deterministic conversion claims.
- **Embed n8n as a second production executor:** would introduce another execution/credential
  lifecycle. Use an isolated n8n harness for comparison while native tickets remain authoritative.
- **Build another packer or queue:** existing creation, packaging and dispatch paths cover the
  foundation; extend their contracts where the assessment demonstrated a gap.

## Consequences

Imported work gains the same ticket ownership, assignment, approval and result surfaces as native
work. Existing node creation and packing investments remain useful. The compatibility matrix can
grow without implying that every public template works.

The runtime/compiler and durable receipt work are prerequisites for executable import. Redacted
review packs need source re-upload or configuration before conversion because they deliberately
lack execution parameters. Graph packing requires a distinct validated path because the current
pack deploy does not execute its graph. Release and catalog claims therefore follow behavioral
and installed evidence rather than successful parsing or compilation.
