# ADR-172: The Jarvis multi-step request process

Date: 2026-10-01
Status: **Proposed. Nothing in the Decision is built.**
The Context records what exists at core `main` `7bf94478`, which is deployed on the operator's box. The
ticket figures come from read-only queries of that box's database at 2026-10-01 03:55 UTC, covering the
previous 30 days.

Related: [ADR-039](039-bot-driven-workflow-authoring.md) (Workflow Studio, talk-to-build and Publish),
[ADR-050](050-unified-assistant-route-orchestrator.md) (Jarvis as the assistant over the swarm),
[ADR-082](082-video-series-pipeline.md) (the graph engine discards bot replies),
[ADR-083](083-knowledge-owner-call-out-routing.md) (call-out routing for Jarvis tasks),
[ADR-087](087-access-roles-jarvis-visibility-scoping.md) (access roles and Jarvis visibility),
[ADR-149](149-enterprise-application-authorization.md) (application authorization),
[ADR-165](165-n8n-import-through-native-ticket-workflows.md) (step receipts, gate records and pinned
workflow versions), [ADR-170](170-token-rating-and-code-offload.md) (capability tiers).

## Context

### The request

The operator asked Jarvis, on the central assistant screen, to do a multi-step process. It did not run one.
The operator's model of how it should work, in their words from 2026-10-01:

- "the ticket process is just a receipt of the actions that are being taken hitting predefined gates ... if
  we don't have a process generic enough that [has a] full path to completion without approval maybe we need
  to create a new jarvis ticket process workflow that does what we need."
- "maybe jarvis needs a file system that it works out of with the information about the tools it has access
  to and their features ... search your tools directory for the tools that you need ... so it gets the idea
  that it needs a round of investigation to put together the multistep process."
- "make sure to use workflow studio to build to production."
- Jarvis is per user. It must not gain a process that shares one user's queries or data with another.

### What was fixed on 2026-10-01

Three changes are merged and deployed:

- **#964.** Every Jarvis model turn was about 37,800 characters. The bot node keeps the first 24,000 of a
  direct prompt (`MAX_UNTRUSTED_BLOCK_CHARS`, `prompt-containment.ts:19`). The plan instructions were last in
  the prompt, so they were cut on every turn. The model never learned it could emit an `oshal:plan`.
  - Application tool proposals now carry their full input schema only when the request is about that tool.
  - The plan instructions now follow the catalog directly.
  - A live turn now measures 28,744 characters, with the plan instructions at character 11,741.
- **#966.** The catalog showed the first 40 of the box's 66 routes. Calendar was route 62. Every route is now
  listed: the apps the request names lead with their description and the rest get one compact line.
  Visibility did not change. A route is still listed only when application authorization lets this user
  discover it (`canDiscover`, applied in `loadEffectiveRoutes`).
- **#965.** Jarvis answers "where am I" (ADR-169). This is not part of the process question.

Live result: "draft a LinkedIn post about smart home automation, then turn that post into a three-slide
presentation" came back as a compiled two-step plan, social then presentations, whose second step takes the
first step's output (`${step1}`). The probe cancelled the plan before it ran.

### How a Jarvis request runs today

`POST /api/jarvis/ask` (`jarvis-routes.ts:661`) opens one `chat` ticket per conversation thread. That ticket
is a board card; it is never dispatched. The request then takes the first of these paths that applies:

1. **Fixed-rule provider reads** (`detectProviderBoundHandoff`, `jarvis-provider-intent-detect.ts:83`, called at
   `jarvis-routes.ts:720`). Career, trading, Walmart, weather and priority-inbox reads become one ticket of type
   `task`. Weather with a location, Walmart and priority-inbox carry a schema-bounded provider operation that
   runs on a fixed bot without a model.
   - The patterns match anywhere in the message. A request that contains one of these reads becomes that
     read alone, and the rest of the request is dropped. Four of five multi-step probes on 2026-10-01 were
     taken this way, including "Summarize my inbox, then draft a LinkedIn post about it".
2. **Location and time reminders** and **build requests** (`jarvis-routes.ts:744`, `:757`).
3. **A model turn** (`runJarvisBot`, `jarvis-routes.ts:936`). The model can answer, or it can write:
   - one or more `handoff` blocks, each becoming a `task` ticket (`dispatchHandoffs`, `jarvis-routes.ts:308`);
     a ticket is "complex" only when the model writes that word (`jarvis-directives.ts:122`);
   - one `oshal:plan` block with two to twelve steps (`jarvis-routes.ts:1011-1014`), compiled by
     `compileAndDispatchPlan` (`jarvis-orchestrator.ts:695`) into a graph with one step per app and an
     approval gate before each step the model marks `outward`.
   - When the model takes longer than 75 seconds (`DECISION_TIMEOUT_MS`, `jarvis-orchestrator.ts:90`), a
     message that looks like work is filed as a "complex" `task` ticket instead.

Every Jarvis work ticket is created already `approved`. The queue manager polls, maps type `task` to the
"Jarvis Assistant Task" manifest-worker workflow and gives the ticket to **one bot**:

- The bot is chosen by call-out. A bid of at least 0.5, or **any keyword match**, counts as the bot claiming
  the ticket (`CONFIDENT_STRATEGIES`, `task-call-out.ts:53`).
- The project manager is not a candidate. It plans a ticket only when the ticket is "complex" **and** no bot
  claimed it (`dispatch-manifest-worker.ts:684-695`).
- The worker receives a fixed template of the ticket's title and description. Neither the queue manager nor
  the project manager rewrites it.

Gates:

- No step on paths 1 to 3 waits for a person, except a plan step the model marked `outward`.
- `outward` is an optional field the model writes (`multi-app-plan.ts:37`); the compiler adds a gate only when
  it is set (`multi-app-plan-compiler.ts:63`). Nothing on the server classifies an action as outward.
- A compiled plan is registered only in memory (`registerFromApp`, `jarvis-orchestrator.ts:720`), and old
  plans are reaped (`:725`). A plan waiting at a gate does not survive an API restart.

### What the record shows

From the 30 days before 2026-10-01 03:55 UTC, excluding per-thread `chat` cards:

| Measure | Count |
|---|---|
| Jarvis work tickets | 29 |
| Outcome: complete / escalated / cancelled | 17 / 4 / 8 |
| Complexity: simple / complex | 15 / 14 (all 14 complex ones auto-filed: build requests, or turns that outran the 75-second decision window) |
| Routed by keyword / bid / provider operation / promoted to the project manager | 13 / 11 / 2 / 3 |
| Tickets that ever paused or waited for approval | 0 |
| Plan tickets, ever | 0 |

- **Keyword claims mis-route.** "Microsoft 1-Month Stock Performance" went to weather-bot and "Microsoft (MSFT)
  1-month stock performance" to travel-concierge, both on keyword matches.
- **The project manager path cannot run on this box.** All three promoted tickets escalated with
  "claude-code unattended execution is disabled".
- **The ticket is a thin receipt.** Each of the 17 completed tickets has exactly two status rows: created
  `approved`, then `complete`. Who did the work appears only in status-history metadata, and no row records a
  gate decision.

### What Workflow Studio can build today

The operator wants the production workflow built in Workflow Studio. Today Studio cannot express it:

- **Steps do not pass data.** An `execute-agent` node sends its bot a fixed text: the ticket's title, id
  and body (`engine-services-adapter.ts:127-136`). The bot's reply is not returned to the run (`:221`), so a
  later step cannot use an earlier step's result. ADR-082 records the same limit.
- **Steps cannot be decided per request.** `plan-step`, the only node that runs model-written steps and
  passes results forward (`plan-step-executor.ts:97-136`), is not in the set Publish accepts
  (`KNOWN_GRAPH_NODE_TYPES`, `workflow-publish-compiler.ts:85-89`), and the canvas cannot place it.
  `sub-process` is a placeholder. A published graph's shape is fixed when it is published.
- **Several catalog nodes do nothing yet.** `route-agent` sends no message, and `intake-source`, `planner`,
  `verify-output` and `review` return fixed results. `approval-gate` pauses the run but ignores its approver
  role, so any resume by the ticket owner or an operator continues it.
- **Jarvis cannot file into a published workflow.** Jarvis files only `task`, `oshal-dev` and per-plan
  `plan-*` tickets. `task` is a built-in type that a published workflow cannot claim. A plan step that names
  a published app is sent straight to that app's bot, bypassing its graph.
- **What Publish does give.** `POST /api/swarm/apps/publish` writes the manifest to
  `deployed-apps/<name>.yaml` and a `swarm_applications` row, and it is re-registered at every boot, so a
  published workflow survives a restart.
  - The Studio UI publishes with `scope: 'person'` (`workflow-studio-data.js:315`). Public scope is an
    operator action.
  - A published workflow registers with application authorization as `legacy`: it is not a protected
    package.
  - Runs record each node in `workflow_run_steps`, but not the definition version they ran.
  - The workflow's bots run as the ticket owner, not as the publisher (`resolveEngineDispatchIdentity`,
    `engine-services-adapter.ts:57-65`).
- **Workflows cannot call workflows yet.** `sub-process` returns a placeholder result and the walk continues
  (`process-definition-execution-engine.ts:929-932`). Tickets already carry a parent:
  `tickets.parent_ticket_id` (migration 100). The swarm path files child tickets with `parentTicketId`
  (`queue-manager-dispatch-helpers.ts:507-514`).
- **There is no draft run.** A workflow is first exercised after it is published.
- **The concierge.** Studio's concierge is `workflow-assistant` (`swarm-apps/workflow-studio.yaml:63-67`).
  It drafts a `workflow-graph` block from the operator's description, the Studio surface validates and saves
  it, and Publish stays the operator's action. It knows the 14 catalog node types and does not execute
  workflows.

### What is wrong

- **G1. Fixed rules take multi-step requests.** A request that mentions inbox, weather, jobs, Walmart or
  trading runs only that read, and the rest of the request is dropped.
- **G2. One bot per ticket.** A request that needs several apps goes to one bot, picked by an auction where
  any keyword overlap wins.
- **G3. No working decomposition.** The project manager sees only unclaimed complex tickets and fails here.
- **G4. Gates are the model's choice.** Only a step the model marks `outward` pauses, and the server never
  checks that mark.
- **G5. Plans are not durable.** A gated plan is lost when the API restarts.
- **G6. No receipts.** Tickets do not record which gates a request passed or who acted.
- **G7. Jarvis cannot investigate.** Everything it knows about the apps rides in one budgeted prompt: one
  line per app, with no per-tool features. It has no way to look further before it plans.
- **G8. Studio cannot build the fix.** Steps cannot pass results or be decided per request, a workflow cannot
  call another, and Jarvis cannot file into a published workflow.

## Decision (proposed)

### D1. One production workflow for multi-step requests, built in Workflow Studio

A multi-step Jarvis request runs as one ticket of a single workflow, `jarvis-request`. The workflow is drawn
on the Workflow Studio canvas and published through Studio's Publish. It is not hand-coded in TypeScript,
not an eleventh kernel manifest (CLAUDE.md Rule 0c), and not a graph compiled in memory per request, as
plans are today.

Its nodes, in order (D8 adds the three new types to Studio):

1. **start.**
2. **plan-request (new).** The planning bot investigates the requesting user's capability directory (D3)
   and returns a bounded plan as JSON, an ADR-170 T2 task. The plan has a title and ordered steps. Each step
   names an app key, the operation or instruction to run, and which earlier results it uses.
3. **validate-plan (new, deterministic code).** It checks every step against the requesting user's
   directory: the app is discoverable for that user, the operation exists, and the inputs are well formed.
   It decides each step's gate (D4) and turns provider reads into provider operations (D6). A plan that fails
   ends the run with its reason; nothing is guessed.
4. **run-plan (new).** It runs the validated steps in order and passes each result to the steps that use
   it. A step is either an instruction to an app's bot or a synchronous call to a published workflow (D9).
   Before an outward step it pauses for the requesting user. Each step writes a receipt (D5). The plan is
   kept in the run's durable state, so a run waiting at a gate survives a restart.
5. **deliver.** The result goes back to the Jarvis conversation that asked.

A request with one step keeps today's paths.

### D2. Jarvis files multi-step requests into the workflow

- When Jarvis decides a request has more than one step, it files one ticket of the published workflow's
  ticket type, owned by the requesting user, with the request as the ticket body.
- That ticket type is a deployment setting naming the published workflow, because `task` is built in and
  cannot be claimed.
- The workflow's bots run as the ticket owner, so each request runs as the user who asked. No query, result
  or directory is shared between users.

### D3. The capability directory Jarvis investigates

- One entry per app the requesting user can discover, using the same `canDiscover` check as the catalog.
  Each entry says what the app does, which bot does its work, and lists its tools and operations: what each
  needs, and whether it reads, drafts or acts outward.
- Entries are generated from installed manifests and tool declarations, never written by hand, and
  regenerated when an app is installed, upgraded or removed.
- Jarvis reads it through two read-only tools on the bot node's existing read-only rail, shaped like
  `conversation_query` and `conversation_fetch` (`bot-node-read-only-tools.ts:52-58`):
  - `capability_search` returns ranked keys with one-line summaries;
  - `capability_read` returns one app's full entry.
- The prompt keeps the compact catalog and adds one rule: for a request with more than one step, search the
  directory first, and plan only with what you found.

### D4. Gates come from declarations, not from the model

- Every tool and operation declares its effect: read, draft or outward. Outward means it sends, posts,
  books, buys, pays or deletes.
- validate-plan gates a step when any operation the step may use is outward or undeclared.
- The model's `outward` mark can add a gate but never remove one.
- The requesting user approves or rejects a gated step, and the gate records who decided and when.

### D5. Receipts

- Every node and every gate writes a receipt on the run. A receipt names the plan version, the step, who
  acted (a bot or a provider operation), references to its inputs and outputs, the gate decision with its
  approver, the times and the outcome.
- The receipt shape follows ADR-165's step receipt and gate reference.
- The run pins the published workflow's version at intake, so a later re-publish does not change a run
  already in flight.

### D6. Provider reads join the plan

The fixed-rule path (`jarvis-provider-intent-detect.ts`) answers a request only when that read is the whole
request. In a multi-step request the read becomes a step that runs the same schema-bounded provider
operation. The credential stays on the server, and the result passes to the next step.

### D7. Routing inside the workflow

- Each step names its app, taken from the directory, so steps do not go through the keyword-and-bid
  auction.
- The project manager's decomposition path is not used for multi-step Jarvis requests.

### D8. Studio learns the new node types, and its concierge manages the workflow

- `plan-request`, `validate-plan` and `run-plan` become catalog node types, and `sub-process` becomes the
  call node (D9). Today the canvas cannot place `sub-process`. After this change the canvas can place all four,
  Publish accepts them, and the engine runs them and keeps each step's reply.
- `workflow-assistant`, Studio's concierge, owns authoring and upkeep of production workflows, starting with
  `jarvis-request`. It already drafts graphs by conversation (ADR-039). Its role widens to:
  - drafting and revising `jarvis-request` with the new node types;
  - reading run receipts to find failing steps and proposing graph changes;
  - preparing a publish for the operator to confirm.
- It stays reason-only: it emits the graph, and the Studio surface validates and saves it. Publish, and the
  public scope this workflow needs, stay operator actions.

### D9. Any workflow can call another, synchronously or asynchronously, and every call is a ticket

Operator, 2026-10-01: "there is no reason workflows can't call other workflows ... it should be a async or
sync feature of any workflow ... which is represented as a ticket."

- `sub-process` becomes the call node. It names a published workflow and a mode. Any published workflow is
  callable this way, and the canvas places the node like any other.
- A call files a child ticket of the called workflow's ticket type. The child:
  - is owned by the same user as the parent;
  - is linked through `parent_ticket_id` and the calling step;
  - runs with its own gates and receipts.
- **Sync.** The calling run waits until the child ticket ends, then continues with the child's result. A
  failed child fails the step.
- **Async.** The calling run continues at once. When the child ends, its outcome is recorded on the parent's
  receipt for that step.
- The parent's receipt references the child ticket, following ADR-165's gate and child reference. Reading a
  parent therefore shows every workflow it called and how each ended.
- A workflow can call only workflows the ticket owner can discover.
- Calls have a depth limit, and a call that would re-enter a workflow already on its own call chain is
  refused, so a cycle cannot spawn tickets without end.

## Consequences

- **What it fixes.** Every multi-step request runs on one durable process that the operator can see and edit
  in Studio. It leaves receipts, its gates follow declared effects, and Jarvis investigates before it plans.
  This addresses G1 to G8.
- **Reuse.** Workflows become building blocks: an app's published workflow can be one step of a Jarvis plan,
  or of any other workflow, and each use leaves its own child ticket.
- **Cost per request.** A multi-step request costs one planning step plus directory reads before any work
  starts.
- **Maintenance.** Three node types are added and `sub-process` becomes real, across the canvas, Publish,
  the engine and the concierge's knowledge. Every tool and operation must declare its effect; until one does,
  it is treated as outward.
- **Configuration.** A deployment setting binds Jarvis to the published ticket type.
- **Authorization.** A Studio-published workflow registers as `legacy`. Its steps still reach only the apps
  the requesting user can discover (D3), and they run as that user.

## Alternatives considered

- **Keep compiling a graph in memory per plan** (today). It is not durable (G5), cannot be seen or edited in
  Studio, and leaves no receipts (G6).
- **Hand-code the workflow in TypeScript**, like the built-in `incident` and `build` pipelines. This is
  against the operator's direction to build it in Workflow Studio.
- **Add an eleventh kernel manifest.** Rule 0c fixes the kernel set at ten.
- **Use the project manager's decomposition.** It sees only unclaimed complex tickets, produces engineering
  `build` children, and cannot run on this box (G3).
- **Draw one fixed Studio graph per kind of request.** Published graphs have a fixed shape, so arbitrary
  multi-step requests cannot be drawn in advance.
- **Let the model decide gates.** That is G4.
- **Put the whole directory in the prompt.** The 24,000-character window already holds the catalog, and
  per-tool detail does not fit.

## Operator decisions needed

1. Which actions count as outward by default, and whether a user may pre-approve a kind of action, for
   example drafts to their own inbox.
2. Where a user approves a waiting step: in the Jarvis conversation, on the ticket board, or through a
   notification.
3. Whether the model alone decides that a request has several steps, or whether markers such as "then" and
   numbered lists also count.
4. Whether the project manager's decomposition path stays available for Jarvis tickets at all.
5. Whether `jarvis-request` is published with public scope as platform plumbing now, or after Publish gains a
   protected mode.
6. Where an async child's result goes when it ends: only onto the parent's receipt, or also as a message to
   the conversation that started the parent.

## Rollout (slices with done-when)

Each slice is accepted on its own.

- **J1. Capability directory.** Generated per user, read through `capability_search` and `capability_read`.
  - Done when a two-user real-Postgres test shows one user cannot find the other's private app.
  - Done when a live Jarvis turn calls `capability_search` before it writes a plan.
- **J2. Declared effects and plan validation.** Deterministic code, tested against the installed manifests.
  - Done when every tool and operation on the box declares an effect or is treated as outward.
  - Done when a plan that omits the outward mark on a send step is still gated.
- **J3. The three node types.** On the canvas, in Publish and in the engine, with each step's reply kept and
  the plan in durable run state.
  - Done when Studio saves and publishes them.
  - Done when an engine test pauses a run at a gate, restarts, and resumes it.
- **J4. Workflow calls (D9).** `sub-process` files a linked child ticket, sync or async.
  - Done when an engine and real-Postgres test shows a sync call waiting for its child and continuing with
    the child's result.
  - Done when an async call continues at once and records the child's outcome when the child ends.
  - Done when the child is owned by the parent's owner, the depth limit holds, and a cycle is refused.
- **J5. Receipts and version pinning,** aligned with ADR-165.
  - Done when the ticket view lists every receipt of a finished run, including the gate approver, the pinned
    workflow version and every child ticket.
- **J6. The production workflow.** `workflow-assistant` drafts `jarvis-request` in Studio, the operator
  publishes it, and Jarvis files multi-step requests into it.
  - Done when a live-acceptance case runs a two-app request end to end through the published graph, as the
    requesting user, and a gated step waits for that user.
- **J7. Provider reads as plan steps.**
  - Done when the four phrasings that lost their second step on 2026-10-01 produce validated plans with
    provider-operation steps, and the credential guards still pass.
- **J8. Retire the in-memory plan path** after J6.
  - Done when Jarvis no longer registers `plan-*` workflows and the plan tests cover the published workflow
    instead.

## References

- Jarvis: `src/app/routes/jarvis-routes.ts`, `jarvis-orchestrator.ts`, `jarvis-directives.ts`,
  `jarvis-provider-intent-detect.ts`, `jarvis-catalog-block.ts`; persona `ai-lab/bot-personas/oshal-assistant.yaml`.
- Queue and routing: `src/features/swarm-orchestration/services/queue-manager-service.ts`,
  `dispatch-manifest-worker.ts`, `task-call-out.ts`, `dispatch-routing.ts`, `workflow-pipeline-registry.ts`.
- Plans and graphs: `multi-app-plan.ts`, `multi-app-plan-compiler.ts`, `plan-step-executor.ts`,
  `dispatch-graph-worker.ts`, `engine-services-adapter.ts`,
  `src/features/workflow-studio/engine/process-definition-execution-engine.ts`.
- Studio and Publish: `src/pages/workflow-studio/`, `src/features/swarm-apps/services/workflow-publish-compiler.ts`,
  `src/app/routes/swarm-app-routes.ts`, `swarm-apps/workflow-studio.yaml`,
  `ai-lab/bot-personas/workflow-assistant.yaml`.
- Read-only tools: `src/app/bot-node-read-only-tools.ts`. Prompt window: `prompt-containment.ts`.
- Guards added on 2026-10-01: `tests/unit/jarvis-plan-guidance-survives-window.spec.ts`,
  `tests/unit/jarvis-catalog-ranking.spec.ts`.
