# Deployable Agent Contract

## Purpose

This document defines what "done" means for a new agent in OSHAL.

An agent is not complete just because it exists in the `agents` table.

A new agent is only considered deployable when it can be:

- selected by routing
- configured by an operator
- exercised through its real runtime path
- verified with a repeatable smoke test
- handed off without hidden tribal knowledge

This contract exists to keep the platform honest, especially for tool-backed and CLI-backed agents.

## Core Rule

Treat these as separate states:

1. `created`
2. `provisioned`
3. `operational`

`POST /api/swarm/agents` proves only state 1 unless the rest of the runtime story is closed.

## Required Areas

Every new agent must be designed and reviewed across these seven areas.

### 1. Identity And Routing

The creation payload must include:

- `name`
- `role`
- `topology`
- `constraints`
- `capabilities`
- `routingKeywords`
- `selectorDescriptor`
- `providerId`
- `modelId`

The selector contract must be specific enough that the agent is routable without false positives.

### 2. Runtime Execution Path

The agent brief must state how the agent actually does work:

- persona-only reasoning
- existing OSHAL tool assignment
- repo-native CLI wrapper
- API integration service
- knowledge-backed retrieval flow

If the runtime path is not identified, the agent is not deployable.

### 3. Tooling, Auth, And Configuration

If the agent depends on tools or external services, the creation package must specify:

- `toolAssignments`
- `authMode`
- `toolConfig` when a tool needs runtime settings
- `configFields` for operator-supplied values
- `configValues` for safe defaults only
- `configGuide` pointing to a local docs file when the operator needs setup or auth instructions

Secrets must never live only in prose. They must appear as operator-configurable schema.
Setup guidance must never live only in chat history. It should live in the repo `docs/` tree and be attached to the agent.

### 4. Knowledge Bootstrap

If the agent needs documentation or manuals, the package must declare:

- `knowledgeSources`
- where the truth comes from
- what happens if knowledge bootstrap is unavailable

Do not describe a knowledge-enhanced agent as ready if the knowledge path is undefined.

### 5. Verification

Every agent must ship with concrete checks:

- how to verify creation
- how to verify config presence
- how to verify the runtime executable or tool binding
- one or more real smoke commands or ticket examples

For tool-backed agents, "it should work" is not verification.

### 6. Operator Handoff

Every agent handoff must state:

- what was auto-provisioned
- what still requires operator action
- what credentials or accounts are still needed
- which commands or endpoints to run next
- which docs/files define the runtime path

For tool-backed agents, the handoff should include one local docs path that an operator can revisit later without digging through chat history.

### 7. Deployment Sync

If the agent is represented in persona files or imported-bot scripts, the implementation must say how the runtime is kept in sync:

- persona YAML update
- registry import command
- provisioning script
- migration, if seeded in Postgres

If a bot exists in both code and runtime storage, both must be accounted for.

## Agent Classes

### Persona-only

Required:

- routing metadata
- strong system prompt
- constraints and SOP
- test ticket examples

### Knowledge-enhanced

Required:

- everything from persona-only
- `knowledgeSources`
- RAG/bootstrap story
- verification path for retrieval

### Tool-dependent

Required:

- routing metadata
- exact tool bindings
- config schema
- auth story
- smoke tests against the real runtime path

### CLI-backed

CLI agents are a strict subtype of tool-dependent agents.

They must also define:

- the executable name or wrapper command
- structured output mode such as `--json`
- approval and safety boundaries
- auth/bootstrap flow
- file output behavior when exports are created
- at least one automated smoke test

## Definition Of Done

An agent is deployable only when all of these are true:

- the creation payload is complete
- routing metadata is strong enough for selection
- required tools are assigned or explicitly called out as missing
- required config fields are registered
- safe defaults are persisted where appropriate
- knowledge bootstrap is either complete or clearly marked as pending
- a smoke test exists and has been run or explicitly blocked by missing credentials
- operator next actions are written down

## Google Workspace Example

The Google Workspace work in Session 24 exposed the exact gap this contract is meant to close.

The real runtime story for `google-bot` is not "there is a bot persona". It is:

- repo-native CLI exists: `oshal-google-workspace`
- runtime tool alias exists: `gogcli`
- tool executor dispatch is wired
- registry metadata is wired
- imported-bot provisioning registers tool auth and config schema
- operator credentials still must be supplied
- live auth must be validated with `auth status` and `auth login`
- Gmail, Docs, Sheets, Slides, Drive, and Calendar need smoke coverage

Without those steps, the bot is created but not operational.

## Factory Rule

The agent-factory must report one of these statuses for each created agent:

- `operational`
- `needs-configuration`
- `needs-tooling`
- `needs-knowledge`
- `partially-provisioned`

The factory must not describe an agent as fully deployed when required config or runtime bindings are still missing.

## Recommended Workflow

1. Design the agent and classify it.
2. Include provisioning fields in the initial payload.
3. Create the agent through `POST /api/swarm/agents`.
4. Verify the provisioning summary, not just `success: true`.
5. Sync persona/imported-bot/runtime assets when applicable.
6. Run the smoke test path.
7. Record the remaining operator actions.
