# Workflow Studio Framework

> **Status:** design-time canvas + **executable publish on the graph engine**. The canvas
> authors/validates workflow graphs and produces a *descriptive* compile preview; the
> **Publish** action compiles the authored workflow into a ProcessDefinition `nodeGraph` and
> loads it LIVE as a caller-scoped ticket queue via `POST /api/swarm/apps/publish` — no
> rebuild. At runtime that queue dispatches through the **`graph` path** of the queue
> manager, which runs the `ProcessDefinitionExecutionEngine` (graph walk: ordering, branches,
> gates) and dispatches each `execute-agent` node to its pinned bot via the EngineServices
> adapter. This is the single authored-workflow engine — the interim linear `staged` executor
> has been retired in its favour. **Human approval-gate nodes pause the run**: the engine
> suspends at the gate, the ticket parks at `approval_required`, and operator approval resumes
> the workflow from the gate's successor (no re-run of completed stages). `swarm-apps/*.yaml`
> manifests remain the other authoring path. Agentic (builder-bot) authoring is still a roadmap item; see
> ["Vision"](#vision-the-canvas-is-the-end-state) below and [ROADMAP.md](../../ROADMAP.md).

## Purpose

Workflow Studio is a design-time WYSIWYG layer for OSHAL.

It exists to:

- visually author workflow definitions
- validate graph structure before runtime use
- compile definitions into a preview of existing swarm/runtime integrations

It does not exist to:

- replace swarm execution
- replace routing
- replace approval handling
- replace handovers
- replace verification or writeback

## Core Rule

Workflow Studio is an abstraction layer on top of the existing platform.

The runtime remains authoritative in these areas:

- `PlanningRoundOrchestrator`
- `PhaseRoutingService`
- `SwarmAgentWorker`
- `TicketCycleStateMachine`
- `SwarmVerificationService`
- `ConsensusReviewService`
- `SwarmWritebackHandler`
- `SwarmEscalationStore`

## Initial File Layout

- `src/features/workflow-studio/`
- `src/app/routes/workflow-studio-routes.ts`
- `src/pages/workflow-studio/`
- `output/workflow-studio/definitions/`

## Current Storage Model

Definitions are persisted as JSON files:

- `output/workflow-studio/definitions/<definition-id>.json`
- `output/workflow-studio/definitions/.history/<definition-id>/v####.json`

That keeps the feature lightweight and visible while design-time contracts settle.

## Initial Node Catalog

- `start`
- `intake-source`
- `planner`
- `route-agent`
- `ai-decision`
- `logic-gate`
- `execute-agent`
- `parallel-split`
- `approval-gate`
- `verify-output`
- `review`
- `deliver`
- `escalate`
- `parallel-join`

## Compile Contract

The compile preview produces:

- ordered visual steps
- mapped runtime bindings
- non-interference rules
- structural warnings and errors
- live agent-roster compatibility notes for route, execute, and AI decision nodes
- branch validation for AI gates, logic gates, and parallel split/join nodes

The compile preview is intentionally descriptive. The **Publish** action is the
executable counterpart: it maps the definition to a scoped `SwarmAppManifest`
(via `compileWorkflowSpec`) and loads it live as a ticket queue.

## WYSIWYG UX Contract

The initial editor supports:

- adding nodes from a palette
- dragging nodes on a canvas
- connecting nodes visually
- editing properties in an inspector
- selecting edges and editing branch labels / conditions
- duplicating workflow drafts
- browsing version history and forking older snapshots
- targeting live agents from the existing `/api/agents` roster
- AI decision gates
- deterministic logic gates
- parallel split/join modeling
- saving named definitions
- validation
- compile preview
- JSON export

## Why This Shape

OSHAL already has the hard runtime pieces. The gap is a way to author and inspect workflow intent visually.

This framework fills that gap without introducing a second orchestration engine.

## Vision: the canvas is the end state

The canvas is the intended **single representation of a workflow** — its agents, gates,
goals, and routing. What changes over time is *how the canvas gets produced*:

- **Manual designer (today).** A human authors the canvas directly on the WYSIWYG
  surface.
- **Agentic studio (roadmap).** A human *describes* the workflow in natural language and
  an agent composes the canvas. This is the same idea `codex-packer` already applies to
  *bots* (interview → packed bot), extended to whole workflows.

Either path converges on the same artifact. The agentic studio drives the canvas, and the
canvas can in turn be used as a reference the agentic studio reads back and refines.
Neither path is useful until the canvas is **executable**, so compile-to-runtime (below)
is the prerequisite for both. See [ROADMAP.md](../../ROADMAP.md) → "Later" and
[BACKLOG.md](../BACKLOG.md) → "Workflow Studio".

## Next Steps

1. add read-only overlays for live run playback from Process Lab / swarm runs
2. add compile-to-runtime contract objects that queue-manager or future operator tools can consume
3. add branch-level templates so common AI gate and parallel review patterns can be dropped in quickly
4. add import/export from historical snapshots directly in the studio
5. decide whether definitions stay file-backed or move to Postgres once the model stabilizes
