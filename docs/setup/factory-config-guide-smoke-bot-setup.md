# Factory Config Guide Smoke Bot Setup

This local guide exists to prove that `agent-factory` can create a bot with:

- a docs-backed setup guide
- runtime config schema
- inline field help

## Purpose

`factory-config-guide-smoke-bot` is not a production specialist.
It is a validation bot used to confirm that the factory can:

- register an agent
- persist config schema
- attach a local `configGuide`
- render that guide back through the config API and UI

## Expected Config

- `SMOKE_MODE`
- `SMOKE_NOTES`

## Verification

1. Create the bot through `POST /api/swarm/agents`.
2. Load `/api/swarm/agents/<agent>/config`.
3. Confirm:
   - `configGuide.docPath` points here
   - `schema` contains the expected fields
   - field descriptions are present

## Operator Note

If this bot works end to end, the same pattern should be used for real tool-backed agents.
