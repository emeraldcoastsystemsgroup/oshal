# Ticket Workspace And Routing Contract

This document defines two runtime contracts that operators need to be able to trust:

1. where ticket workspaces actually live
2. how a new ticket chooses planning versus direct execution

## Workspace Contract

### Root Tickets Own The Workspace

- every root ticket gets one shared workspace folder
- the folder ID is the root ticket ID
- the physical folder is created under `workspace-shared/<root-ticket-id>`
- in the container runtime this is mounted at `/app/workspace-shared/<root-ticket-id>`

Current implementation:

- [queue-manager-service.ts](../../src/features/swarm-orchestration/services/queue-manager-service.ts)
- [queue-manager-workspace-helpers.ts](../../src/features/swarm-orchestration/services/queue-manager-workspace-helpers.ts)

### Child Tickets Share The Root Workspace

- child tickets do not get separate codebase folders
- the queue resolves the top parent ticket ID before dispatch
- `workspaceTaskId` is set to the root ticket ID for child work
- all descendants write into the shared root workspace

This is the intended swarm behavior so planning, build, review, and delivery all operate on one shared codebase.

### Cockpit Contract

Cockpit ticket detail must expose:

- `workspaceTaskId = <root-ticket-id>`
- `workspacePath = /app/workspace/<root-ticket-id>`

The `Work Artifacts` tab then uses:

- `GET /api/v1/workspace/:workspaceTaskId/files`

Current implementation:

- [cockpit-ticket-activity-route.ts](../../src/app/routes/cockpit-ticket-activity-route.ts)
- [ticket-view-detail-renderer.js](../../src/pages/cockpit/js/views/ticket-view-detail-renderer.js)
- [task-explorer-workspace-service.ts](../../src/features/task-explorer/services/task-explorer-workspace-service.ts)

### Bug That Was Fixed

The bug was:

- ticket activity returned a task-scoped linked task ID instead of the root workspace ticket ID

That made populated workspaces look empty in Cockpit because the UI was browsing the wrong folder.

The fix now forces ticket activity to resolve the root ticket before returning workspace detail.

Regression coverage:

- [ticket-activity-rollup.spec.ts](../../tests/ticket-activity-rollup.spec.ts)
- [engineering-button-usability.spec.ts](../../tests/engineering-button-usability.spec.ts)

## Routing Contract

## L1 Classification Fields

New work is supposed to be classified into:

- `outcomeType`
- `effortTier`
- `recommendedPath`
- `planningMode`
- `planningEntryMode`
- `planStatus`
- `teamShape`
- `setupLevel`

Canonical types:

- [intake.ts](../../src/shared/types/intake.ts)

Classifier:

- [intake-l1-processor-service.ts](../../src/features/intake/services/intake-l1-processor-service.ts)

Ticket metadata writer:

- [intake-assistant-service.ts](../../src/features/intake/services/intake-assistant-service.ts)

## How Planning Versus Build Is Chosen

### 1. `instant-answer`

When intake marks:

- `recommendedPath = instant-answer`
- `planningMode = none`

Then the root ticket bypasses PM planning and goes straight to direct execution.

The bot is instructed to first ask:

- can I answer this quickly as a verbal response from current context and internal knowledge?

If yes, it should answer immediately instead of building a heavyweight plan.

### 2. `direct-execution`

When intake marks:

- `recommendedPath = direct-execution`
- `planningMode = lightweight`

Then the root ticket bypasses PM planning and goes straight to direct execution with a lighter work-unit prompt.

### 3. `structured-project`

When intake marks:

- `recommendedPath = structured-project`
- `planningMode = structured`

Then the root ticket goes into the PM planning path.

PM and architect receive the planning packet and artifact contract before execution starts.

### 4. `validate-existing`

When structured-project metadata also carries:

- `planningEntryMode = validate-existing`

PM does not restart discovery from zero. It validates, tightens, resources, and phases the supplied plan.

### 5. Child Tickets

Child tickets always bypass PM planning and route straight to specialists.

That is because PM is only supposed to own root-level project planning, not subtask execution.

## Important Default

This is the part operators need to know clearly:

- a plain manually created root ticket with no intake metadata does **not** know to bypass planning
- it falls back to the legacy structured path
- in practice that means PM planning is still the default for unclassified root tickets

So today:

- intake-assisted tickets can choose planning versus direct execution
- manually created root tickets without classification metadata still default to PM planning

That is why the long-term fix is still a true L1 conversational shaping/front-door bot. Until that exists, the metadata contract is what drives the choice.

## Runtime Code Path

Classification enters the ticket here:

- [intake-assistant-service.ts](../../src/features/intake/services/intake-assistant-service.ts)

Queue manager turns metadata into routing capabilities here:

- [queue-manager-service.ts](../../src/features/swarm-orchestration/services/queue-manager-service.ts)

Planning orchestrator decides whether the root ticket bypasses PM here:

- [planning-round-orchestrator.ts](../../src/features/swarm-orchestration/services/planning-round-orchestrator.ts)

The actual decision rule is:

- child ticket: specialist direct execution
- root ticket with `instant-answer` or `direct-execution`: direct execution
- root ticket with `structured-project` or missing metadata: PM planning

## Operational Smoke Checks

### Workspace API

`GET /api/v1/tickets/:ticketId/activity`

Expect:

- `workspaceTaskId` equals the root ticket ID
- `workspacePath` equals `/app/workspace/<root-ticket-id>`

### Workspace Files

`GET /api/v1/workspace/:rootTicketId/files`

Expect:

- `exists = true` once the queue has created the workspace
- `children` populated when files exist

### Cockpit

In `Work Artifacts`:

- the displayed workspace path should use the root ticket ID
- `Open in Code Server` should point at `/code?folder=/workspace/<root-ticket-id>`
- child tickets should show the shared parent-ticket workspace note when applicable
