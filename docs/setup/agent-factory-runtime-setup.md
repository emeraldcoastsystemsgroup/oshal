# Agent Factory Runtime Setup

This is the local operator and builder guide for `agent-factory`.

It documents how `agent-factory` should create agents after the Google CLI and `google-bot` work clarified what "deployable" really means.

## Purpose

`agent-factory` should not stop at creating an `agents` row.

Its job is to produce agents that are:

- routable
- provisioned
- configurable
- documented
- smoke-testable

If any of those are missing, the result is only partially complete.

## The Rule Learned From Google Bot

The Google work exposed the real gap:

- a bot persona can exist
- a tool can exist
- credentials can exist
- and the bot can still be non-operational because the runtime path, setup story, or registration path is incomplete

That lesson now applies to every agent created by `agent-factory`.

## Required Agent Package

When `agent-factory` creates a tool-backed or externally-configured agent, the creation payload should include:

- `name`
- `role`
- `topology`
- `constraints`
- `capabilities`
- `routingKeywords`
- `selectorDescriptor`
- `toolAssignments`
- `configFields`
- `configValues` for safe defaults only
- `configGuide`

If the agent uses retrieval, also include:

- `knowledgeSources`

## Required Local Guide

The `configGuide` should point to a file in the local docs tree, usually:

- `docs/setup/<agent-name>-runtime-setup.md`

That guide should explain:

- runtime executable or tool path
- required config fields
- auth or account setup
- required external APIs/services
- runtime storage location if relevant
- smoke-test commands
- known blockers or optional extensions

## Factory Output Standard

The correct factory outcome is a provisioning summary plus a readiness status:

- `operational`
- `needs-configuration`
- `needs-tooling`
- `needs-knowledge`
- `partially-provisioned`

The factory should never claim "done" when the agent still lacks config, auth, tooling, or docs.

## Registration Paths

For imported or persona-backed bots, make sure these stay aligned:

- persona YAML in `ai-lab/bot-personas/`
- local guide in `docs/setup/`
- imported metadata in `agents.metadata`
- runtime config schema in `agent_config`
- tool bindings / auth modes

## Recommended Build Flow

1. Classify the agent.
2. Define the runtime execution path.
3. Attach tools.
4. Define `configFields`.
5. Persist safe defaults.
6. Write the local setup guide.
7. Attach the guide using `configGuide` or `config_guide`.
8. Register or import the bot.
9. Run or record smoke tests.
10. Return readiness honestly.

## Minimum Smoke Checks

Before calling a new agent operational, verify:

- the agent can be listed and selected
- the config schema exists
- the guide path resolves to a local docs file
- the runtime path exists or is reachable
- at least one real command, tool call, or ticket flow succeeds

## Practical Goal

The operator should be able to open a bot in Config Admin and see:

- what to configure
- how to configure it
- where the local guide lives
- what to run next

That is the standard `agent-factory` should build toward every time.
