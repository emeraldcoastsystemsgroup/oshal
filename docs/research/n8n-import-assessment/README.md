# n8n to OSHAL workflow import: feasibility assessment

Assessed: 2026-09-25; implementation update: 2026-09-26. Status: **analysis-only import draft built in the checkout; executable conversion and installed acceptance not proven**.

## Verdict

OSHAL can support importing n8n workflows, but a reliable importer must translate **execution semantics**, not just JSON into YAML. Start with an analyzer and a deliberately small executable subset. Unsupported behavior must block publication, not become a successful-looking placeholder.

With the current backend unchanged, we can build a useful analysis/assisted-authoring experience and reuse existing bot-workflow primitives. We cannot faithfully run arbitrary n8n data pipelines through the current graph engine. A useful native data-workflow subset requires runtime/compiler additions; this is not a UX-only skin.

None of the three public examples assessed is currently a demonstrated, fully equivalent native conversion. That is a finding about these examples and this execution path, not an estimate of compatibility across the n8n catalog.

Architecture and remaining delivery are recorded in [ADR-165](../../adr/165-n8n-import-through-native-ticket-workflows.md) and the [N8N forward backlog](../../backlog/n8n-import-forward-plan.md). The operator authorized the implementation described below. Native execution claims still require behavioral and installed evidence for each supported subset.

## Scope and evidence

- Read official n8n documentation and three actual public workflow JSON definitions: 12 nodes and 10 connections in total.
- Compared OSHAL's authoring preview, publish compiler, manifest serializer, graph engine, execution services, state and schemas. No n8n importer was found in the inspected workflow/studio/publish paths.
- Ran 11 isolated behavioral probes against the actual local compiler, expression evaluator and graph walker, using **explicit in-memory service fixtures**. All 11 reproduced their asserted observations; most assert limitations, not compatibility.
- Ran six existing focused compiler/engine test files: **30 tests passed**. These include fixture-backed and no-service tests, not live application acceptance.
- No n8n runtime was installed or executed. No provider, webhook, schedule, credentials, database, publication endpoint or live ticket was exercised. Public source downloads were ordinary read-only HTTPS GETs, never URLs extracted from workflow parameters.
- At assessment time there was no production implementation, roadmap/backlog closure, commit, push or deployment. The later analysis-only implementation is described below; it has not been installed or live-proven.

The engine-probe receipt records working HEAD `34b9065992405765738369923652fe02a5141e97`, Node `v24.11.0`, time and SHA-256 fingerprints for six inspected source files. Another lane advanced the shared checkout during assessment; the fingerprinted workflow files were not modified by this lane. Recheck those hashes before using this assessment against a later build.

Evidence files:

- [Public export inventory, provenance, versions and hashes](public-export-evidence.json)
- [Runtime observations and source hashes](runtime-probe-evidence.json)
- [Read-only public export inspector](inspect-public-exports.cjs)
- [Offline compatibility probes](probe-runtime.cjs)
- [Existing-test run receipt](baseline-test-evidence.json)

## Actual n8n examples

| Public definition | What the file actually contains | Native conversion disposition |
| --- | --- | --- |
| [Official starter-kit chat demo](https://raw.githubusercontent.com/n8n-io/self-hosted-ai-starter-kit/refs/heads/main/n8n/demo-data/workflows/srOnR8PAY3u4RSwb.json) | Chat Trigger v1, LLM Chain v1.7, Ollama model v1; one normal connection and one typed model attachment | **Assisted redesign candidate.** A ticket plus approved bot binding could reproduce the broad intent, but chat response, model configuration, conversation lifecycle and result delivery need separate proof. Not an exact conversion today. |
| [Official Merge example, template 655](https://api.n8n.io/workflows/templates/655) | Manual Trigger v1, two Code v2 nodes producing sample lists, Merge v3 matching `language`; different merge input indexes | **Blocked on deterministic data operations.** Needs two independent streams and an actual field-based join. A parallel-join is not that join. Imported Code must remain blocked or be explicitly rewritten into reviewed declarative fixtures/operations. |
| [Official If v2 Boolean test fixture](https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/If/test/v2/IfV2.boolean.json) | Manual Trigger, test-data node, If v2.2 with loose Boolean validation, two NoOp destinations; five input items | **Blocked on per-item routing and coercion.** The fixture's pinned expectations split two items true and three false. One OSHAL Boolean branch for the whole ticket does not reproduce this. The test-data node is an n8n test helper, not a production connector. |

All three were rejected when their native node types were presented to the current publish compiler. That is the correct refusal, not a compiler defect. Renaming types until validation passes would conceal the missing behavior.

For the Boolean example, numeric `1` belongs to the fixture's expected true output. OSHAL's strict `admin === true` returns false for numeric `1`; copying the original `={{ $json.admin }}` expression also returns false, even when `admin` is Boolean true. The probe executes the OSHAL side; the n8n-side expectation is inspected fixture data, **not a fresh n8n run**.

The chat model connection is configuration/dependency wiring, not an extra sequential work step. Its credential reference must become a user-authorized local binding, never an inferred permission or copied secret.

The recorded URLs track upstream branches/template content and may change. Receipts fingerprint the fetched bytes; no full third-party code bodies, item payloads or credential names/IDs/values were retained.

## Format versus behavior

n8n exports workflows as **JSON**, including node definitions, parameters and connections. Exported files may include credential references or embedded authentication headers, so imports must be treated as potentially sensitive. The format correction does not prevent conversion. [Official export/import documentation](https://docs.n8n.io/build/manage-workflows/export-and-import)

OSHAL publishes a `WorkflowPublishSpec` through `compileWorkflowSpec()`, which produces a manifest containing `workflow.pipeline: graph` and `processDefinition.nodeGraph`; the manifest can be serialized as YAML. YAML is the container, not the missing compatibility layer. The separate Studio compile preview is design-time analysis, not evidence of successful runtime execution. [Publish compiler](../../../src/features/swarm-apps/services/workflow-publish-compiler.ts), [serializer](../../../src/features/swarm-apps/services/swarm-app-loader.ts), [preview compiler](../../../src/features/workflow-studio/services/workflow-studio-compiler.ts)

| Concern | n8n behavior that matters | Observed OSHAL boundary / required treatment |
| --- | --- | --- |
| Nodes and versions | Type plus `typeVersion` and options define behavior | Explicit versioned adapters, not name matching. Current known graph types do not include n8n app/data nodes. |
| Connections | Source output index, destination input index and connection type carry meaning | Current published edges retain ID/source/target/label, not ports. Preserve ports in an import model; lower only when equivalent. |
| Data | Arrays of JSON/binary items, often automatically processed per item | Current state is ticket context, variables and node outputs. Arrays can be stored as values, but there is no automatic item-stream contract in this graph walker. |
| Item ancestry | Downstream expressions can reference the originating upstream item | Preserve lineage through filtering, reordering and joins or reject expressions that depend on it. |
| Expressions | Item lookup, prior-step lookup, functions and JavaScript expressions | Current evaluator supports a small Boolean/string/complexity subset. Parse a supported subset; reject everything else without executing it. |
| Branching | An If can partition items into two outputs in one run | A ticket-level `logic-gate` selects one successor, not both item partitions. |
| Fanout | Execution order is a workflow semantic | Plain OSHAL fanout takes one edge; explicit parallel-split is concurrent. Neither is a general replacement for n8n branch ordering. |
| Merge | Combines streams according to mode and field/position rules | OSHAL parallel-join is a synchronization point; it does not implement a relational/item merge. |
| Wait | Timer, date, webhook or form resume | Approval suspension supplies useful checkpoint infrastructure, but not equivalent timer/webhook/form semantics. |
| Sub-workflow | Invoke another workflow with inputs/results | Current default `sub-process` executor returns `not-implemented`. Refuse this mapping until implemented and tested. |
| Errors and retries | Operation-specific failure behavior affects results and duplicate actions | The inspected graph walker does not apply its declared per-node retry/error-branch fields. Add semantics or block workflows relying on them. |
| App/HTTP actions | Real typed operations with account, payload and response behavior | Bind approved existing service/tool/connector operations; do not replace deterministic actions with free-form bot prompts. |
| Triggers | Manual, schedule, webhook and chat entrypoints differ | Map to an authorized ticket-intake contract; schedules, webhook responses and streaming chat require dedicated adapter acceptance. |

Sources for n8n data and expression semantics: [item structure](https://docs.n8n.io/build/work-with-data/understand-n8ns-data-structure), [item lineage](https://docs.n8n.io/build/work-with-data/reference-data/link-data-items/how-items-link-through-workflows), [expressions](https://docs.n8n.io/build/work-with-data/transform-data/expressions-for-data-transformation).

n8n's documented v1 execution order completes ordinary branches in canvas-position order. Blindly translating fanout to OSHAL parallel-split changes that ordering and potentially side effects. Reject or preserve the source execution policy explicitly. [Execution-order documentation](https://docs.n8n.io/build/flow-logic/understand-execution-order)

Merge mode and node version must select the correct join semantics; waiting for branches is insufficient. [Merge documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.merge)

Wait resumption can depend on time or an execution-specific webhook. Mapping it to human approval would change the workflow's meaning. [Wait documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait)

These are findings about the inspected **graph execution path**, not claims that OSHAL lacks all HTTP, scheduling, data-processing or connector capabilities elsewhere. Existing services should be reused through validated adapters.

## Reproduced runtime findings

| Probe | Observed result | Consequence for importer |
| --- | --- | --- |
| Deterministic-only graph | Publish compiler rejects graph without bot/cluster | Supporting data-only automation needs an explicit compiler/runtime decision; do not add a fake bot to bypass validation. |
| Port metadata | Extra synthetic edge port/channel fields are omitted | Importer must preserve semantics before emitting existing edge shape. |
| Unsupported expression | False result instead of validation error | Import analysis must reject unsupported syntax before any run. False may take a consequential branch; it is not a safe compatibility fallback. |
| Native mapped branches | Both high/low fixture cases execute the correct selected bot path | Existing native control flow is reusable after a truthful mapping. This is a positive engine-seam test, not a converted n8n workflow. |
| Retry/error settings | Three configured tries still cause one call and a propagated fixture exception; error handler not invoked | Schema presence is not runtime support. No inference is made about unrelated outer worker/job retries. |
| Sub-process | Accepted by compiler; returns `subProcess: not-implemented`; graph still reaches delivery | Hard blocker for claiming equivalent nested workflow support. |
| Unknown node | Publisher rejects it; direct engine invocation skips it and can complete | Never bypass compiler/import validation. Additional runtime fail-closed hardening is advisable before external-graph support. |
| Step-output binding | Declared `rows` binding does not populate variables | Specify and implement actual data bindings; a schema field alone is insufficient. |
| Item list | Five items on one synthetic ticket cause one bot execution | Importer needs an explicit collection execution model, not an assumption about arrays. |
| Ordinary fanout | Only first outgoing path runs | Source branch structure cannot be copied blindly. |
| Cycle | Four bot calls, then regression-budget escalation | Existing regression cycles are not general Loop Over Items semantics; raising the cap is not a fix. |

Source anchors: [engine](../../../src/features/workflow-studio/engine/process-definition-execution-engine.ts), [evaluator](../../../src/features/workflow-studio/engine/expression-evaluator.ts), [state](../../../src/features/workflow-studio/engine/engine-state.ts), [schema declarations](../../../src/features/workflow-studio/schemas/process-definition-schema.ts), [execution service contract](../../../src/features/workflow-studio/engine/engine-services.ts).

No execution-engine fixes were applied by this assessment. These observations remain implementation prerequisites or hard exclusions, not silently converted into supported features.

### Analysis-only implementation slice

`analyzeN8nImport()` now accepts one bounded JSON export or explicit `{ workflow }` wrapper and returns a non-executable report. It checks byte/depth/node/connection limits, duplicate identities, unsafe object keys, missing connection targets and bounded port indexes. The report retains source node type/version and channel/port topology using opaque node ordinals; it never echoes node names/IDs, parameters, Code bodies, pinned items or credential references. It flags expressions, credential references/auth-like data, pinned data, non-main channels, cycles and multiple triggers. Manual Trigger v1 requires a ticket-intake binding; Code, If, Merge, Wait, sub-workflow and all unregistered type/versions are explicitly unsupported. Source `active: true` is reported but never activated. All reports have `analysisOnly: true`, `executable: false`, `publishable: false`.

The analyzer itself is a pure source module. It also accepts ID-less fixture nodes for **analysis only** by using unique source names for connection lookup; the saved draft mints local IDs. A null/empty explicit ID and duplicate names still fail. It remains no adapter runtime or actual n8n compatibility proof.

The source analyzer is also wired to the fixed server-side swarm tool `n8n-import-analyze`. The tool returns bounded JSON with total/omitted counts, suppresses the uploaded JSON in tool-status events, and has a dedicated `n8n-import-analysis` capability tag; its registry default asks for per-agent approval. This does not add it to the reason-only `workflow-assistant` persona or make the report a runnable graph. Forward website acceptance, official-template evaluation, searchable proof index and persona/tool mapping work is tracked in the [n8n forward sub-backlog](../../backlog/n8n-import-forward-plan.md).

### Packs/Forge import draft (checkout build, not installed acceptance)

The existing authenticated `/api/swarm/packs/studio` page now has a multipart n8n JSON upload. `POST /api/swarm/packs/import/n8n` buffers at most 512 KiB **after** owner authentication, runs the bounded analyzer, and saves a new private `packs/<owner-key>/<slug>/` review pack. It refuses slug collisions. The pack contains `pack.json`, a redacted `analysis.json`, a read-only `workflow.json` with local UUIDs and exact source/target channel and port indexes, and a sanitized `README.md` process brief. It does **not** retain the raw export, source names/IDs, parameters, Code bodies, credentials or pinned items. The only initial native authoring proposal uses the existing `createWorkflowNode()` factory to mint a Studio **Start** marker for an unmodified Manual Trigger v1; this is visibly `proposal_only`, disconnected, and still requires ticket-intake binding. The page shows unsupported reasons, active-source warning and topology; no deploy control is shown for review packs. The server independently refuses `POST /:name/deploy` when the pack has the review marker, even if a UI bypass is attempted.

Codex Packer/Bot Forge is already implemented, but its current deploy path emits an `incident-rca` worker/reviewer manifest and does not execute a `workflow.json` graph. The n8n draft therefore serves as an interview/authoring brief only; it is not a converted native ticket workflow. No imported bot is created or given tools. A later, separately reviewed native process needs explicit operations, authority/bindings, equivalence tests, and installed signed-in acceptance. The focused analyzer, HTTP and browser suite plus existing Forge edit-in-place regression passed in the checkout; no live import, queue run, commit, push or deployment is claimed here.

The updated read-only inspector ran the analyzer over the same three live public definitions on 2026-09-26; all fetched hashes matched the recorded research fixtures. The starter chat export reported three unsupported nodes and a non-main model attachment. Template 655 reported Manual Trigger as needing a local intake binding and Code/Merge as unsupported, including its second merge input port. The Boolean fixture reported Manual Trigger as needing configuration and the four remaining nodes unsupported, with expression, pinned-data and branch-port blockers. **0/3 are executable or publishable**; none was run in an n8n runtime or through an OSHAL ticket. This is an intake smoke check, not compatibility proof.

## Proposed implementation

### 1. Analyze into a non-executable draft

Accept an explicitly uploaded workflow JSON file first. Handle a single workflow or a clearly identified supported wrapper; do not silently treat packages, credential exports or workflow arrays as the same schema. Apply byte/depth/node/edge limits, structural validation, unique-ID/name checks and safe object handling before building a graph. Imported text is data, never instructions for privileged tools.

Normalize to an import-only intermediate representation containing stable source IDs/names, node type/version, parameters, typed input/output ports, execution order, dependency attachments and source provenance. Preserve canvas layout for the draft. Separate comments/notes from executable nodes. Detect expressions, embedded credentials, pinned sample data, binary references, disabled nodes, execution flags, cycles and multiple triggers.

Produce per-node **supported**, **needs configuration**, **unsupported** or **semantic mismatch** results, with exact reasons. Unknown node versions or materially unknown options must block execution. Do not report a global conversion percentage as if every node carried equal behavioral importance.

This phase can provide value without changing the existing execution engine. It still requires authoring/import UI and validation code. Persisting new draft metadata may also require extending the authoring schema; that is not assumed to be free or already available.

### 2. Add a small deterministic compatibility layer

Recommended first executable scope, after runtime work: manual intake, JSON-only items, literal field assignment/rename, simple allowlisted item lookups, strict comparisons and bounded approved connector operations. Defer merge, loops, Code, binary handling, waits, nested workflows and AI tool/model subgraphs until individually implemented and proven. This initial scope deliberately does not make the three assessed examples universally runnable.

Required work packages:

1. **Versioned adapter registry:** enumerate supported node versions, options, validation, input/output contracts and rejection reasons. One adapter per operation/behavior, not one generic prompt per node type.
2. **Execution data contract:** typed items and port-specific outputs, bounded cardinality, empty-list behavior, stable IDs/lineage and explicit per-item versus run-once execution. Define how these coexist with ticket variables and durable checkpoints.
3. **Expression translator:** parse allowed syntax into a bounded representation; preserve types/missing-value behavior. Do not use `eval`, `Function`, regex-only replacement of `$json`, or arbitrary imported Code execution.
4. **Deterministic operation dispatch:** use existing authorized service/tool boundaries with schema-validated parameters and owner/account context. A URL in an imported node is not authorization for unrestricted networking or local file access.
5. **Graph compiler/engine integration:** admit real deterministic nodes without fake agents; enforce adapter completeness at compile and run; preserve ordering and reject unsupported fanout/cycles/ports. Keep the existing queue as runtime authority, not a separate ungoverned executor.
6. **Bindings and lifecycle:** explicit connector/account selection, operation result mapping, delivery semantics, errors, cancellation, retry and checkpoint behavior. Record source-node to runtime-step correspondence for diagnosis.
7. **Trigger adapters:** add schedule/webhook/chat separately with timezone, deduplication, response, ownership and resumption semantics. A manual ticket workflow is not a faithful replacement for synchronous webhook response or streaming chat without an explicit redesign.

A future dataflow executor could be integrated as a bounded graph operation, or the graph engine could gain dedicated data primitives. Select one coherent runtime design in an ADR before implementing; this assessment does not choose or silently introduce a second scheduler.

### 3. Preserve configuration and authority

Imported workflows remain inactive drafts. Never copy `active: true` into local activation, auto-create schedules, install applications, import external account authority, or overwrite a named existing workflow. Source ownership is metadata, not OSHAL identity.

Use signed-in owner/tenant context and explicit authorized bindings; separate administrator-controlled app installation from a user's permitted workflow configuration and app opt-in. For shared scheduled work, require per-user participation and source/account scope instead of a single hard-coded credential. Mandated versus optional participation should follow the application policy and be visible to the user.

Approval versus automated execution is an editable **workflow policy**, with preview, publish and rollback. A converter must not silently remove an existing approval step or change safety policy to match an imported file. A policy change requires the same authorized publish/review path as a native edit.

The current [publish route](../../../src/app/routes/swarm-app-routes.ts) writes a manifest and loads it live. It allows authenticated personal workflow publishing and requires operator privilege for public/tenant scope. Therefore **do not use Publish as an analysis/dry-run endpoint**, and do not assume it by itself implements every desired administrator-installation policy. Resolve that boundary in the importer design.

Keep secrets out of generated YAML, reports, logs and browser previews. Redact embedded headers/tokens, omit execution history/pinned payloads by default, and require rebinding credentials. Retry and restart must be designed with idempotency and duplicate-side-effect protection; a durable checkpoint alone does not guarantee exactly-once external actions.

### 4. Prove equivalence before calling a workflow converted

For each supported adapter/version, compare a pinned source workflow's behavior in an isolated n8n runtime with the converted workflow in an isolated OSHAL runtime, using the same controlled inputs and deterministic local service endpoints. Record input/output data, item counts/order/lineage, branch choices, call counts/payloads, errors and side-effect receipts. Do not invoke third-party services from a downloaded template during this comparison.

Required acceptance cases:

- Zero, one and many items; missing/null values; strict versus loose types; both branch outputs populated; empty branches.
- Preserve correct node input/output ports and version-specific defaults. Refuse unknown options, nodes, versions, expressions and multiple-trigger shapes outside the contract.
- Verify exact operation arguments and results through the real compiled executor and authorized connector boundary, not a mock returning the expected final answer.
- Failure, timeout, retry, idempotency, cancellation, resume after restart and partial side effects. Add timer/webhook resume and nested-workflow proofs before admitting those features.
- Cross-user/tenant refusal, unauthorized credential binding, disabled/opted-out participants and app-specific schedule controls.
- Browser flow: upload, inspect warnings, configure bindings, save draft, block incomplete publish, publish authorized definition, create a real disposable ticket, inspect run history/results, revise and roll back.
- Register runnable unit/integration/browser scenarios and `regressionTests` references in the existing Test Lab/test manager. Maintain truthful local-fixture, installed-runtime and provider-live statuses separately.
- Only claim provider-specific live compatibility after an explicitly authorized bounded provider test with a disposable fixture/account and an actual result receipt. External costs/actions need separate authorization.

Passing parser/compiler tests, a successful mock response, a rendered canvas or a delivered-status label is insufficient for closure.

## Impact and choices

| Option | Backend impact | What can honestly be promised |
| --- | --- | --- |
| Analyzer and assisted native redesign | No engine change; import validation/UI and potentially draft metadata changes | Useful compatibility report and editable draft; no blanket execution claim. |
| Supported-subset native importer — recommended | Compiler, runtime data/operation semantics, adapter bindings, lifecycle and acceptance work | Exact conversion only for enumerated node versions/options that pass equivalence tests. |
| Keep n8n as an external execution service | Separate runtime deployment plus an authenticated bridge, callback/result handling and ownership policy | Interoperability/delegation, **not** native conversion. Requires a separate operational and licensing assessment before adoption. |
| Broad n8n compatibility | Major ongoing compatibility program across nodes, versions, data and lifecycle behavior | Cannot be estimated or promised responsibly from three examples. |

This is a moderate-to-large workflow-engine feature, not a small YAML utility. The first shippable scope should be decided from actual workflows the operator wants to migrate. Estimate implementation after that inventory: an analyzer, a narrow executable subset and broad compatibility have very different costs. No catalog-wide success percentage or delivery-date commitment is supported by this assessment.

Suggested next implementation milestone, if approved: pick three **operator-relevant** exports with no secrets, publish the adapter support/exclusion contract, then prove one deterministic end-to-end migration with real ticket/result evidence and Test Lab registration before expanding the matrix.

## Reproduce this assessment

From the repository root, using already-installed dependencies:

```powershell
# Read-only network inspection of three fixed public source URLs; prints redacted metadata.
node --require tsx/cjs docs/research/n8n-import-assessment/inspect-public-exports.cjs

# Offline actual compiler/engine probes; explicit local service fixtures, no live bot dispatch.
node --require tsx/cjs docs/research/n8n-import-assessment/probe-runtime.cjs

# Existing bounded compiler/engine tests; no provider or database acceptance claimed.
node node_modules/vitest/vitest.mjs run tests/unit/workflow-publish-compiler.spec.ts tests/unit/process-definition-engine-decision.spec.ts tests/unit/process-definition-engine-parallel.spec.ts tests/unit/process-definition-engine-durable.spec.ts tests/unit/process-definition-engine-suspend.spec.ts tests/unit/process-definition-terminal-outcome.spec.ts --no-file-parallelism --reporter=dot
```

The scripts print receipts and do not write files, publish workflows or run downloaded Code. The public-source inspector is a fixed-input research utility, **not** a hardened upload parser or security-reviewed importer. Evidence JSON files are saved snapshots of the observed runs, not self-updating assertions of current behavior.
