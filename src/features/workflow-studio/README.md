# Workflow Studio

Visual workflow authoring for OSHAL — author on a canvas, then Publish to a live runtime queue.

## Purpose

This feature adds a WYSIWYG workflow layer on top of the current swarm runtime without replacing:

- swarm routing
- planning/decomposition
- agent execution
- approval gates
- verification
- writeback

## What It Owns

- workflow definition schema
- node catalog for the editor
- design-time validation
- compile preview that maps graph nodes to existing runtime surfaces
- **Publish to runtime** — compile an authored canvas into a live caller-scoped ticket queue (single-shot → manifest-worker, staged → approval-gated executor, or a full branching/parallel graph → executable nodeGraph)
- persisted workflow JSON definitions
- file-backed version snapshots for every save
- draft duplication and historical version forking
- edge-level branch editing for labels and conditions
- live agent-roster compatibility checks for agent-targeted nodes
- AI-enabled decision gates that can target existing agents or capability classes
- logical gates for deterministic branching
- parallel split/join annotations for concurrent branch design

## What It Does Not Own

- execution engine replacement
- new handover model
- new approval runtime
- new agent router

## Current Storage

Definitions are stored under:

- `output/workflow-studio/definitions/*.json`
- `output/workflow-studio/definitions/.history/<definition-id>/v####.json`

## Current UI Surface

- `/workflow-studio`
- `/api/workflow-studio/*`

## Initial Node Catalog

- `start`
- `intake-source`
- `planner`
- `route-agent`
- `ai-decision`
- `logic-gate`
- `execute-agent`
- `parallel-split`
- `parallel-join`
- `approval-gate`
- `verify-output`
- `review`
- `deliver`
- `escalate`
