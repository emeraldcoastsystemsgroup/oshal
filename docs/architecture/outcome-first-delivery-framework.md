# Outcome-First Delivery Framework

This document defines how OSHAL should decide whether incoming work is:

- an immediate answer
- a lightweight execution
- a structured project

The goal is simple:

- serious product work must get professional setup, planning, and delivery structure
- low-fidelity PoCs and small bounded efforts should not be forced through heavyweight project ceremony
- direct question-and-answer work should be answered immediately when possible

## Core Principle

The platform should decide work shape in this order:

1. Outcome needed
2. Level of effort requested
3. Team shape required
4. Structure and artifacts required
5. Execution path

This is the inverse of the current anti-pattern where the system often jumps straight to agent routing or project-manager planning before deciding what class of work the user actually wants.

## L1 Processor

The front door should act as an L1 processor.

Its job is to classify every request into:

- `outcomeType`
- `effortTier`
- `recommendedPath`
- `planningMode`
- `teamShape`
- `setupLevel`
- `requiredArtifacts`
- `artifactBlueprints`
- `pmPrepPacket`

Current canonical values live in:

- [src/shared/types/intake.ts](../../src/shared/types/intake.ts)
- [src/features/intake/services/intake-l1-processor-service.ts](../../src/features/intake/services/intake-l1-processor-service.ts)

For structured-project work, planning also has an entry contract:

- `planningEntryMode`
- `planStatus`

Supported values live in:

- [src/shared/types/intake.ts](../../src/shared/types/intake.ts)

The shaping layer should not only name artifacts. It should provide explicit artifact blueprints:

- purpose
- owner role
- minimum contents
- example outline

That guidance should be materialized into `PM-PREP-PACKET.md` so PM and architect can read a real preparation contract from the workspace instead of inferring the shape from ticket prose alone.

## Outcome Types

- `question-answer`
- `small-change`
- `proof-of-concept`
- `product-delivery`
- `integration`
- `investigation`

## Effort Tiers

- `quick`
- `low-fidelity`
- `standard`
- `professional`

The user should be able to set this intentionally.

The system may recommend a stronger path when the request implies higher risk or delivery expectations.

## Delivery Paths

### 1. `instant-answer`

Use when:

- the request is mainly Q and A
- one bot likely has the answer
- no credentials, review gates, or structured delivery are needed

Default shape:

- planning mode: `none`
- team shape: `single-agent`
- setup level: `none`
- artifact: `answer-in-thread`

### 2. `direct-execution`

Use when:

- the request is small or medium
- a low-fidelity PoC is acceptable
- execution can proceed with lightweight structure

Default shape:

- planning mode: `lightweight`
- team shape: `single-agent` or `specialist-pair`
- setup level: `basic`

Typical artifacts:

- `lightweight-scope`
- `success-criteria`
- `lightweight-technical-approach`
- `handover-notes` when multiple agents contribute

### 3. `structured-project`

Use when:

- the user wants serious product delivery
- integration or production delivery is involved
- credentials/access are required
- review gates are explicitly requested
- the work needs planning, phasing, risk management, and setup rigor

Default shape:

- planning mode: `structured`
- team shape: `project-swarm`
- setup level: `professional`

Required structure should include:

- `OUTCOME-BRIEF.md`
- `BUSINESS-REQUIREMENTS.md`
- `FEATURE-INVENTORY.md`
- `PROCESS-FLOW.md`
- `APPLICATION-ARCHITECTURE.md`
- `TECHNICAL-SPECIFICATION.md`
- `INTEGRATION-ARCHITECTURE.md`
- `FUNCTIONAL-SPECIFICATION.md`
- `INTEGRATION-PLAN.md`
- `PRODUCT-DIAGRAMS.md`
- `RESEARCH-SUMMARY.md`
- `KEY-DECISIONS-LOG.md`
- `STACK-DEFINITION.md`
- `HOSTING-AND-ENVIRONMENT-PLAN.md`
- `COSTING-AND-BUDGET-VIEW.md`
- `EFFORT-ESTIMATE.md`
- `PHASED-DELIVERY-PLAN.md`
- `IMPLEMENTATION-PLAN.md`
- `MASTER-PLAN.md`
- `ESTIMATION.md`
- `STAKEHOLDER-AND-COMMS-PLAN.md`
- `RESOURCE-PLAN.md`
- `TASK-BRIEF.md`
- `RISK-REGISTER.md`
- `ACCEPTANCE-CRITERIA.md`
- `SETUP-AND-CONFIG-CHECKLIST.md`

Standards alignment for serious delivery:

- PM planning should follow **PMP-style** controls for scope, schedule, estimate, risk, stakeholder/comms, resource, dependency, and readiness management.
- Architecture should follow **TOGAF-style** structure for business/process, application, integration/data flow, and technology/runtime viewpoints.
- Execution and handovers should follow **RALF** discipline for task briefs, handovers, validation, and delivery quality.

## Planning Entry Modes

Structured-project work can enter PM planning in two ways:

### `discovery`

Use when:

- no approved plan package exists yet
- PM and architect need to assemble the plan from discovery artifacts

This is the legacy path and remains the default.

### `validate-existing`

Use when:

- the user or an upstream step already supplied a serious plan package
- PM should validate, tighten, resource, and phase the work rather than restart planning from zero

This path should still go through PM and architect review.

The difference is not quality bar. The difference is whether PM is creating the plan or validating an existing one.

## Team Shape Rules

### `single-agent`

Use for:

- direct answers
- bounded one-owner tasks
- small changes with low coordination cost

### `specialist-pair`

Use for:

- low-fidelity PoCs
- investigations
- tasks with uncertainty that benefit from execution plus review or handoff

### `project-swarm`

Use for:

- real product work
- multi-surface integrations
- work needing planning, review, QA, and deployment/setup coordination

Typical roles:

- L1/front-door intake
- project-manager for structured planning
- specialists for implementation
- task-manager for validation/governance

## Product Rule

The build factory is for serious products.

That means the platform should assume:

- professional setup matters
- architecture and functional specs matter
- integration boundaries matter
- decisions need to be recorded
- hosting and stack choices must be explicit
- costing and estimation must be visible
- work should be phased like a real project

If the user does not want that overhead, they should be able to choose a lower effort tier and stay on the `instant-answer` or `direct-execution` path.

## Current First Slice

The first implementation slice now exists in the intake assistant:

- [src/features/intake/services/intake-assistant-service.ts](../../src/features/intake/services/intake-assistant-service.ts)

It now gathers:

- desired outcome
- level of effort
- project type
- delivery constraints

And it stores a reusable L1 assessment in ticket metadata.

It now also generates:

- artifact blueprints for every required artifact
- `PM-PREP-PACKET.md` content for the planning team

## Runtime Status

The runtime now acts on the classification contract:

- `instant-answer` root tickets bypass PM planning and go straight to direct execution/routing
- `direct-execution` root tickets bypass PM planning and go straight to direct execution/routing
- `structured-project` root tickets enter `in_process_discovery` as Phase 0 for discovery and planning
- once planning/decomposition finishes, the structured-project parent moves to `approval_required`
- approved child build tickets stay queued until the parent is promoted into `in_process_build`
- `validate-existing` supplied-plan tickets enter PM planning in validation/resourcing mode instead of restarting discovery
- planning work units read the explicit PM prep packet when it exists

Important current default:

- root tickets created without intake/classification metadata still fall back to the legacy structured planning path
- in other words, a manually created root ticket does not bypass PM unless `recommendedPath` / `planningMode` metadata is present
- child tickets still bypass PM and route directly to specialists

The runtime contract for both workspace ownership and planning-vs-execution routing is documented here:

- [ticket-workspace-and-routing-contract.md](../../docs/architecture/ticket-workspace-and-routing-contract.md)

## What Still Needs To Happen

- add a true front-door bot or service that can act as the default L1 processor outside the intake assistant flow
- show the L1 assessment in cockpit/ticket UI
- let operators override the system recommendation when needed
