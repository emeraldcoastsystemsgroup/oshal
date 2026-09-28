# n8n workflow import: forward feature backlog

Open work as of 2026-09-26. [ADR-165](../adr/165-n8n-import-through-native-ticket-workflows.md)
records the proposed architecture. The [assessment](../research/n8n-import-assessment/README.md)
and [ticket workflow contract](../architecture/ticket-workflow-view-spec.md) supply the source
findings. The current analyzer, swarm tool and private Packs review draft are implemented in the
checkout; their prior receipt is 25 focused tests and both TypeScript checks passing. Executable
conversion and installed acceptance remain unfinished.

This is the detailed work queue for the import feature. The audit lane owns `docs/BACKLOG.md` and
the closed ledger; its registration handoff is in `COLLABORATE.md`. Keep these N8N IDs stable when
adding concise main-queue pointers. A source test, schema declaration or prototype alone does not
satisfy an item's installed or execution criteria.

## Delivery order and ownership

| Work | Implementation owner | Dependencies for completion |
| --- | --- | --- |
| N8N-01 — review UI and tool rollout | Core Packs/Studio and tool registry | Current review implementation |
| N8N-02 — adapter registry and item/port execution | Core compiler and workflow engine | ADR-165 contract |
| N8N-03 — first deterministic adapter subset | Core adapters; connector owners for bindings | N8N-02; retry/receipt contracts from N8N-08 |
| N8N-04 — example corpus and comparison harness | Core test/evidence tooling | Collection can start now; runnable comparisons need N8N-03 |
| N8N-05 — searchable proven-workflow index | Workflow catalog surface | N8N-04 and N8N-07 evidence |
| N8N-06 — bot capability and persona mapping | Core tool registry and existing packer | Mapping work can start now; installed grant/reload proof required |
| N8N-07 — executable drafts, publication and installed run | Core Studio, publisher and queue | N8N-02/03/08 and selected N8N-04 fixtures |
| N8N-08 — durable ticket execution and workflow view | Core ticket stores, workers and cockpit projection | Existing ticket workflow slice |
| N8N-09 — faithful native graph process packs | Existing Codex Packer, pack routes and publisher | N8N-06/07; reuse existing edit-in-place identity |
| N8N-10 — additional node families | Core adapters and relevant service owners | N8N-02/04/08; certify each family separately |

Start N8N-01, N8N-02, N8N-04 inventory and N8N-08 in parallel when file claims permit. Then
complete N8N-03 and N8N-07, followed by graph packing and the proven-workflow index. N8N-10 does
not block release of a narrower, explicitly supported subset.

## Sources for controlled evaluation

- [Official n8n workflow template library](https://n8n.io/workflows/): the primary source for public, diverse example definitions. Search by category, app and workflow shape; pin the exact source URL, retrieval date and SHA-256 of each allowed test export. The library's current size is not an acceptance metric.
- [Official n8n Academy](https://n8n.io/education/) and [course catalog](https://learn.n8n.io/courses): hands-on training scenarios for triggers, data transformation, API calls, error handling and agents. Use documented exercises/practice APIs as scenario ideas; do not scrape gated course content or assume a lesson has a downloadable workflow export.
- Initial three source definitions already examined in the [assessment](../research/n8n-import-assessment/README.md) are research fixtures, not working conversions.

No template is trusted code. Do not import embedded credentials, execute Code nodes, install packages, hit template-specified endpoints, activate schedules, or republish someone else's template without a separate security, authority and licensing review. A catalog entry can link to the source without copying its JSON.

## Open items

### N8N-01 — Publish analysis-only import on the website

- **Status:** OPEN — actionable · checkout slice built; release and installed proof remain
- **Scope:** Finish navigation from Workflow Studio to the existing Packs import, bounded JSON upload/paste, topology, readable blockers and keyboard/accessibility behavior. Show node version, channel/port and source-active warnings. Register the actual import checks with Test Lab and document how authorized bots discover the analysis tool. Keep review drafts inactive.
- **Current evidence:** The existing authenticated Packs panel accepts bounded multipart JSON into an owner-private, redacted and non-deployable process-review pack. Focused HTTP/browser tests cover valid private export, malformed/unsafe/oversize refusal, owner isolation, port topology and absence of a deploy control. This is a Forge handoff, not a Workflow Studio authoring/publish flow; paste UX, installed signed-in proof and any remaining accessibility/security checks are still open.
- **Done when:** browser and route tests cover a valid private export, oversize/malformed/unsafe-key refusal, no credential/code/pinned-data echo in browser or logs, owner isolation, keyboard/accessibility behavior, and no visible action that could publish an unsupported import. Installed authenticated browser proof is required before claiming the feature live.

### N8N-02 — Versioned node-to-operation adapters and typed item/port runtime

- **Status:** OPEN — actionable
- **Scope:** Implement ADR-165's strict type/version/option registry and native item/port contracts. Preserve list cardinality/order/lineage, typed values, named channels, indexed ports, explicit per-item versus run-once behavior and source-node-to-ticket-step links. Admit deterministic-only graphs through the real compiler. Refuse unknown persisted nodes at runtime. Validate source execution order, disabled nodes, `onError`/retry options, ID-less nodes and non-executable notes explicitly; a skipped option cannot imply support.
- **Done when:** zero/one/many item, fanout, missing/null, unknown option/version/port and restart tests execute through the real ticket queue and fail closed where unsupported. Each claimed adapter/version has a pinned behavioral equivalence receipt against isolated n8n using controlled inputs; no broad compatibility percentage is claimed.

### N8N-03 — Expressions, branching and connector operations

- **Status:** OPEN — actionable
- **Scope:** Certify the first candidate families: Manual Trigger, NoOp, Set/Edit Fields, If and HTTP Request. Pin exact node versions and allowed options from the corpus before implementation. Add a bounded expression parser, typed comparisons, per-item true/false outputs and schema-validated operation bindings to existing authorized services. Define HTTP pagination, response/error outputs and retry behavior for each admitted subset. Imported URLs, headers and credentials do not grant authority. Arbitrary Code remains excluded; additional families are N8N-10.
- **Done when:** branch/empty-output and strict-coercion fixtures match n8n behavior; unauthorized connector/credential and unknown syntax are refused before side effects; timeout/retry/idempotency/cancellation receipts show exact call counts; supported operations use real service boundaries rather than mock final answers.

### N8N-04 — Controlled template and training-scenario evaluation

- **Status:** OPEN — actionable
- **Scope:** Sample representative official templates and Academy exercise shapes across manual/schedule/webhook triggers, Set/If/Merge, HTTP/API, sub-workflow and AI/tool attachments. Record source/version/hash/license, analyzer report, unsupported reasons, and a linked feature gap for each distinct blocker. Run candidate templates only in an isolated n8n fixture with local fake endpoints; run OSHAL only for the enumerated supported subset. Do not bulk-run downloaded workflows or use user connectors.
- **Done when:** a reproducible, bounded sample matrix publishes per-template `analysis-only`, `unsupported`, `needs configuration`, `mock-equivalent`, or `installed-equivalent` evidence; each unsupported behavior maps to an owned feature ticket or explicit exclusion; no source execution happens outside the isolated harness. Human review resolves license and side-effect boundaries before any public reproduction.
- **Evidence gap:** The earlier larger-repository spot check is exploration, not a durable equivalence receipt. Save a reproducible pinned corpus manifest and reports before using its sample counts in release claims. Compare values/types, item order/lineage, selected ports, errors and exact side-effect counts, including empty inputs and unknown options.

### N8N-05 — Searchable user index of proven workflows

- **Status:** OPEN — actionable · completion depends on N8N-04/07 proof
- **Scope:** Index only reviewed template metadata and explicit compatibility evidence. Users can search/filter by capability, category, required connector, version and proof level; a result links to its origin, adapter/exclusion detail and authorized import path. Keep raw third-party JSON, secrets, pinned data and user-specific bindings out of the public index.
- **Done when:** search/browser tests reject an unverified template as “working,” enforce ownership on private evidence, show stale-version/revoked-proof warnings, and a sampled indexed workflow completes the real signed-in ticket/result path with a current installed receipt. Source terms/licensing are cleared for all displayed content.

### N8N-06 — Bot capability mapping and hot-loaded persona contracts

- **Status:** OPEN — actionable
- **Scope:** Define versioned descriptions of each bot's capabilities and allowed tools, with stable capability keys and routing tags. Treat a bot as a configurable persona/tool authority boundary, not an automatic one-to-one translation of an n8n node. Introduce a narrowly scoped import analyst persona in hot-loaded YAML only after its per-agent grant, approval and reload semantics are tested; preserve `workflow-assistant` as reason-only. Map n8n node families to deterministic operations first; select a bot only where the task truly needs one.
- **Done when:** an operator can inspect capability and tool/approval descriptions, change a permitted persona/tool grant, hot-reload and observe the new routing without changing a running ticket's authority; tests prove a generic workflow bot cannot call the import tool or acquire an imported credential/code/CLI ability through the mapping. Unknown capability/tool names fail closed.

### N8N-07 — Draft, publish and live ticket equivalence gate

- **Status:** OPEN — actionable · execution depends on N8N-02/03/08
- **Scope:** Persist versioned executable drafts with owner/source provenance, validated operation configuration, local credential references, adapter revisions, preview and rollback. Today's review draft discarded parameters: require explicit source re-upload/hash comparison or operator configuration to produce a new revision. Compile supported graphs through existing publication and queue paths; expose pinned workflow, steps, assignments, approvers and artifacts through N8N-08. Never copy source `active` into local activation.
- **Current boundary:** The redacted Packs review draft is not this executable draft. Codex Packer's existing deploy path does not execute its `workflow.json`; source graph/ports cannot be silently converted to a worker/reviewer manifest. Native operation mapping, item/port semantics, authority and equivalence receipts are prerequisites.
- **Done when:** a signed-in user uploads, resolves bindings, reviews policy, publishes an entirely supported draft, creates a disposable ticket, sees exact steps/approvers/data provenance/result and rolls back; incomplete/unsupported drafts cannot publish; cross-user and tenant boundary tests pass; real installed browser and queue receipts back the claim.

### N8N-08 — Durable ticket workflow binding, assignments, approvals and recovery

- **Status:** OPEN — actionable
- **Observed gap:** The [current projection](../architecture/ticket-workflow-view-spec.md) shows the current registry definition and best-effort recorded steps. Its correlated gate transition does not enforce a separately declared approver or establish an immutable workflow snapshot. PostgreSQL history has no durable per-ticket transition sequence for equal timestamps.
- **Scope:** Persist workflow identity/version/hash at intake; record assigned bot/operation before worker acceptance; tie step attempts, typed handovers, child tickets and artifacts to the run. Add explicit authorized approve/deny receipts and durable ordering. Extend existing queue checkpoints for timeout, retry, cancellation and restart, with bounded retries and side-effect idempotency. Make ticket and workflow views render these same records, including missing evidence and unresolved dispatch.
- **Done when:** disposable PostgreSQL and real queue tests cover graph, swarm, incident-RCA and manifest-worker tickets through each claimed assignment/child/gate path; unauthorized approval fails, denial stops downstream work, equal timestamps retain correct order, restart resumes the pinned version, and retries cannot silently duplicate a committed action. An installed ticket workflow view shows the same bot, approver, input/output references and terminal result as the stored receipts. Older runs with missing receipts remain visibly incomplete.

### N8N-09 — Pack a native process without losing its graph

- **Status:** OPEN — actionable · graph execution depends on N8N-07
- **Observed gap:** `buildPackManifest()` in the current pack route emits `pipeline: incident-rca` with a worker and optional reviewer; it does not compile `workflow.json`.
- **Scope:** Extend existing Codex Packer and the pack descriptor with an explicit native graph mode. Validate and compile that graph through the existing publisher; retain step/port/binding provenance and required capabilities. Preserve current single-worker/reviewer packs and stable owner/app/ticket/bot identities on update. Reconcile persona instructions with the selected mode. Offer assisted redesign as a separately labeled process with its own acceptance contract.
- **Done when:** a pack containing a supported branch and approval gate executes the specified path through the real queue; the unselected branch has no side effects and the gate is enforced. Repacking changes the version while preserving identity and existing tickets' pinned definitions. Unsupported review packs cannot deploy by changing a label. Download/reimport and installed browser-to-ticket proof retain behavior and owner boundaries. A collapsed single-bot redesign is presented as redesign, with its own tested result contract.

### N8N-10 — Certify additional control-flow and data node families

- **Status:** OPEN — actionable · each family follows the N8N-02/04/08 contracts
- **Scope:** Track exact versions/options for each family below in the adapter matrix. Reuse existing services where their behavior matches; unsupported cases continue to return explicit blockers.
  - Merge: append, positional and field joins, duplicate matches, empty/unbalanced inputs and lineage.
  - Switch and Loop Over Items/SplitInBatches: multiple outputs, completion outputs, bounded cycles and resumable iteration.
  - Wait: persisted timer/date and authorized webhook/form resumption, expiry and duplicate resume handling.
  - Sub-workflows: parent/child tickets, typed inputs/results, cancellation and failure propagation; replace the current placeholder result before admitting the mapping.
  - Schedule/webhook/chat triggers: authorized intake, trigger lifecycle, response timing and duplicate delivery.
  - Binary/file operations: owner-scoped artifact references, bounded I/O and cleanup, with no source-specified unrestricted filesystem path.
  - Model/tool attachment channels: typed configuration dependencies and local capability bindings, kept distinct from execution-order edges.
- **Done when:** each named family has an explicit version/option support row, matching controlled comparison receipts and a real queue/restart/failure receipt for its admitted behavior. Every remaining unsupported option has a named blocker; this item stays open while a family is unimplemented. Each family can ship independently. Arbitrary imported Code execution is outside this ADR's scope.

## Closure evidence

For each work ID, retain the tested source/adapter versions, exact checks and their results, any
installed principal/application/ticket/run receipt required by its Done when, and unresolved
limits. Move completion evidence to the ADR or feature record when the authoritative queue owner
closes the item. Never count the review draft as proof of native execution or the fixture browser
as proof of installation.
