# Dynamic Bot + Tool Runtime Plan

## Purpose

Define the end-state and implementation plan for:

- dynamic tool registration at runtime
- dynamic bot registration at runtime
- per-agent config as a first-class part of every bot build
- switch-framework registration for all tools
- dynamic config/admin screens that render from backend schemas instead of hardcoded UI assumptions

This plan is intentionally grounded in:

- current OSHAL code and database contracts
- proven runtime patterns that already existed in the sibling oshal codebase

## Executive Assessment

The platform is partway there, but the pieces are not closed into one runtime loop yet.

What exists today in OSHAL:

- tool registry CRUD exists via `/api/tools`
- agent factory creation exists via `POST /api/swarm/agents`
- per-agent config storage exists in `agent_config`
- per-agent tool auth/runtime config exists in `agent_tools.tool_config`
- switch framework exists and can persist `auto|ask|off`
- selector recomposition exists
- native `/config/` UI exists

What is missing or incomplete:

- runtime tool registration is metadata-first, not runtime-first
- executable tools are still admitted through hardcoded executor/runtime lists
- `/config/` does not dynamically render `agent_config.config_schema`
- imported or factory-created bots do not automatically get a full dynamic config experience
- tool runtime config and agent config are split in the backend but not unified in the UI
- there is no single “register tool -> assign to bot -> render config -> execute -> update switch state” closed loop
- there is no single “register bot -> attach tools -> attach config schema -> make visible in `/config/` -> ready for runtime” closed loop

The result is:

- backend contracts are stronger than the screens
- the registry is stronger than the executor
- provisioning is stronger than the operator workflow

## What oshal Already Solved

The sibling oshal codebase already contains the runtime patterns we should port and adapt.

Primary source files:

- [ToolRegistry.js](../../any-bot/server/services/ToolRegistry.js)
- [DynamicToolManager.js](../../any-bot/server/services/queue-manager/DynamicToolManager.js)
- [AgentConfigManager.js](../../any-bot/server/services/AgentConfigManager.js)
- [ProvisioningManager.js](../../any-bot/server/services/ProvisioningManager.js)
- [app.js](../../any-bot/server/app.js)
- oshal tool implementation folder:
  [services/tools](../../any-bot/server/services/tools)

Important oshal patterns to preserve:

- every factory-created bot can have config schema + config values
- config UI is driven by schema, not hardcoded per-bot UI
- tools can be registered dynamically at runtime
- tool registration persists and restores after restart
- agent deployment and config registration are part of one provisioning story

## Core Any-Bot Impact

This plan does **not** require oshal core any-bot to be the primary implementation target.

Default boundary:

- oshal remains the source/reference system
- OSHAL is the implementation target
- behavior, contracts, and tool families are ported from oshal into OSHAL
- operators should not need to keep enhancing oshal just to make OSHAL complete

What should happen in oshal:

- read and reuse proven source code/patterns
- optionally extract reusable reference notes or parity matrices
- optionally fix clearly dangerous issues discovered during comparison if they matter to shared operations

What should happen in OSHAL:

- implement the runtime registration system
- implement the schema-driven `/config/` experience
- implement dynamic tool admission and switch-framework parity
- implement bot provisioning that closes the runtime loop end to end

What should **not** happen by default:

- do not split the feature across both repos
- do not make OSHAL depend on continued manual oshal edits
- do not treat oshal as the live runtime that operators must configure in parallel

If a change is needed in oshal, it should be limited to one of these cases:

- the source implementation must be clarified before porting
- a shared credential/integration path is unsafe and must be corrected
- we want a temporary parity patch while OSHAL catches up

## Target End State

The desired runtime model for OSHAL should be:

1. A tool can be registered dynamically through an API or factory workflow.
2. That tool is persisted in the OSHAL tool registry with execution metadata.
3. The tool is admitted into the executable runtime without code edits to unrelated files.
4. The tool appears in switch-framework APIs and UI automatically.
5. If the tool requires settings, the required config schema is attached to either:
   - the tool assignment
   - the agent config
   - or both, depending on scope
6. A bot can be created dynamically with:
   - persona
   - selector metadata
   - tool assignments
   - config schema
   - default config values
7. The `/config/` screen dynamically renders:
   - bot profile
   - tool switches
   - tool runtime settings
   - agent-level config schema fields
8. Changes made in `/config/` immediately persist and are visible to runtime execution.

## Architecture Principles

### 1. Every Bot Has Config Capability

Every bot should be treated as config-capable, even if its schema is empty.

Rules:

- every bot row may have an `agent_config` record
- if no special parameters exist, `config_schema` is `[]`
- if parameters exist, they are rendered dynamically from `config_schema`
- no bot should require bespoke UI code just to expose its settings

### 2. Every Executable Tool Must Register With Switch Framework

No executable tool should bypass the switch framework.

Rules:

- tools must be present in `tools`
- agent assignments must be present in `agent_tools`
- auth mode must be controlled through switch framework
- runtime config must persist through `agent_tools.tool_config`
- selector recomposition must occur when assignments change

### 3. Screens Must Be Schema-Driven

The UI should not know bot-specific fields in advance.

The UI should render from:

- `GET /api/agents/:agentId/profile`
- `GET /api/agents/:agentId/tools`
- `GET /api/swarm/agents/:agentId/config`
- `GET /api/tools`

### 4. Runtime Admission Must Be Data-Driven

The current hardcoded executable whitelist should be replaced by a registry-driven admission model.

That means:

- executor dispatch may still route by implementation key
- but runtime availability should come from registered tool metadata
- not from static lists in prompt/runtime composition

## Current OSHAL State by Layer

### Tool Registry

Current files:

- [tool-routes.ts](../../src/app/routes/tool-routes.ts)
- [tool-controller.ts](../../src/features/tool-registry/controllers/tool-controller.ts)
- [tool-registry-service.ts](../../src/features/tool-registry/services/tool-registry-service.ts)

Current strength:

- persistent CRUD exists
- categories and auth groups exist
- verification framework exists

Current gap:

- tools can be registered in metadata without becoming executable runtime tools
- execution still depends on code-level dispatch + whitelist

### Switch Framework

Current files:

- [agent-tool-routes.ts](../../src/app/routes/agent-tool-routes.ts)
- [agent-tool-controller.ts](../../src/features/tool-switch/controllers/agent-tool-controller.ts)
- [switch-framework-service.ts](../../src/features/tool-switch/services/switch-framework-service.ts)

Current strength:

- auth mode persistence exists
- group auth mode exists
- tool config persistence exists

Current gap:

- not all runtime tools register cleanly into it
- `/config/` only uses the switch portion, not the full config portion

### Agent Config

Current files:

- [agent-config-service.ts](../../src/features/agent-management/services/agent-config-service.ts)
- [capability-expansion-routes.ts](../../src/app/extensions/swarm/routes/capability-expansion-routes.ts)

Current strength:

- schema + values are persisted
- `GET/PUT/DELETE /api/swarm/agents/:agentId/config` exists

Current gap:

- main config screen does not consume this schema dynamically
- operator path is not closed

### Dynamic Bot Creation

Current files:

- [agent-factory-routes.ts](../../src/app/extensions/swarm/routes/agent-factory-routes.ts)
- [agent-factory-service.ts](../../src/features/agent-management/services/agent-factory-service.ts)

Current strength:

- bot creation can already include `toolAssignments`, `configFields`, `configValues`, and `knowledgeSources`

Current gap:

- the UI does not dynamically expose those config fields
- tool executable admission is still partially manual/hardcoded

### Config UI

Current files:

- [config-admin.js](../../src/pages/config-admin/config-admin.js)
- [config-admin/index.html](../../src/pages/config-admin/index.html)

Current strength:

- bot profile and tool switch state load dynamically
- per-bot deep linking already exists using `?agentId=...`

Current gap:

- screen loads:
  - `/api/agents/:agentId/profile`
  - `/api/agents/:agentId/tools`
- screen does not load:
  - `/api/swarm/agents/:agentId/config`
- therefore schema-defined bot settings are invisible today

## Detailed Implementation Plan

## Phase 0: Define the Contract

### Goal

Standardize what “dynamic runtime registration” means in OSHAL.

### Required decisions

1. Tool definition contract
   - persistent metadata in `tools`
   - implementation key for runtime execution
   - config scope declaration:
     - `agent`
     - `tool-assignment`
     - `global`

2. Bot definition contract
   - required:
     - identity
     - selector data
     - capabilities
   - optional:
     - tool assignments
     - config schema
     - config defaults
     - knowledge sources

3. UI contract
   - `/config/` must become schema-driven
   - no hardcoded bot-specific form sections

### Deliverables

- ADR for dynamic bot/tool runtime registration
- one shared JSON contract doc for:
  - tool registrations
  - bot registrations
  - config schema rendering

## Phase 1: Make Tool Runtime Admission Data-Driven

### Goal

Remove the mismatch between “tool exists in registry” and “tool is executable.”

### Current problem

`tool-runtime-context.ts` still uses a hardcoded executable registry whitelist.

### Work

1. Add a tool execution descriptor to the registry model
   - extend `tools` with fields like:
     - `execution_mode`
     - `runtime_binding`
     - `handler_key`
     - `executable`

2. Replace static executable whitelist logic in:
   - [tool-runtime-context.ts](../../src/app/composition/tool-runtime-context.ts)

3. Teach the executor to dispatch by registered handler key
   - refactor:
     - [tool-executor-service.ts](../../src/features/chat-orchestration/services/tool-executor-service.ts)
   - add a handler registry map:
     - `handler_key -> implementation`

4. Keep fallback tools only for bootstrapping/system survival
   - not for product tools

### oshal source pattern

- [ToolRegistry.js](../../any-bot/server/services/ToolRegistry.js)
- [DynamicToolManager.js](../../any-bot/server/services/queue-manager/DynamicToolManager.js)

### Acceptance criteria

- creating a tool row with executable metadata makes the tool visible to runtime automatically
- no manual edit to executor whitelist is required for normal tool additions

## Phase 2: Port oshal Tool Sources Into OSHAL Runtime Bindings

### Goal

Port real oshal tool code into OSHAL in a controlled, registry-driven way.

### Source of truth in oshal

- [services/tools](../../any-bot/server/services/tools)
- [ToolRegistry.js](../../any-bot/server/services/ToolRegistry.js)
- [MCPService.js](../../any-bot/server/services/MCPService.js)
- [MCPServiceV2.js](../../any-bot/server/services/MCPServiceV2.js)

### Porting model

For each oshal tool family:

1. identify source implementation
2. define OSHAL execution binding
3. register tool metadata
4. define config schema
5. attach to agents dynamically

### Port matrix

Priority 1:

- Plane tool family
  - source: `plane-mcp`
  - OSHAL target: first-class `plane-mcp` registry tool + agent assignments

- File tools
  - source: [fileTools.js](../../any-bot/server/services/tools/fileTools.js)
  - OSHAL target:
    - `read-file`
    - `write-file`
    - `filesystem`

- CLI/command tools
  - source: [cliTools.js](../../any-bot/server/services/tools/cliTools.js)
  - OSHAL target:
    - `bash`
    - `command-execution`
    - safe command wrappers

- Browser/fetch tools
  - OSHAL target:
    - `fetch`
    - `browser`

Priority 2:

- self-healing/code-deploy
  - sources:
    - [selfHealingTools.js](../../any-bot/server/services/tools/selfHealingTools.js)
    - [codeDeployTools.js](../../any-bot/server/services/tools/codeDeployTools.js)

### Acceptance criteria

- imported personas with these authorization keys no longer land with unresolved runtime gaps

## Phase 3: Make Dynamic Tool Registration a Real API Workflow

### Goal

Bring oshal-style runtime tool registration into OSHAL using the persistent Postgres registry.

### Current gap

OSHAL has CRUD for tools, but not a full runtime registration workflow with:

- validation
- registration
- runtime admission
- optional TTL or lifecycle metadata
- operator visibility

### Work

1. Add a dedicated runtime registration API
   - likely new routes:
     - `POST /api/tools/register-runtime`
     - `DELETE /api/tools/register-runtime/:toolName`
     - `GET /api/tools/runtime`

2. Build `DynamicToolRegistrationService`
   - validate tool registration
   - persist to `tools`
   - optionally persist lifecycle metadata in separate table
   - announce availability to selector composition

3. Add optional restart/restore bootstrap
   - restore all runtime-registered executable tools at startup

### oshal source pattern

- [DynamicToolManager.js](../../any-bot/server/services/queue-manager/DynamicToolManager.js)
- [dynamic tool routes](../../any-bot/server/app-modules/routes-agents-provisioning.js) (extracted from app.js in the 2026-07-11 decomposition)

### Acceptance criteria

- tool can be registered through API alone
- tool appears in `/api/tools`
- tool appears in switch-framework APIs
- tool appears in `/config/`
- tool can execute without code edits elsewhere

## Phase 4: Standardize Bot Registration as a Full Runtime Workflow

### Goal

Every bot creation should be one runtime transaction, not several separate manual steps.

### Current strength

OSHAL already supports:

- tool assignments
- config fields
- config values
- knowledge sources

### Work

1. Make `AgentFactoryService` the canonical runtime registration pipeline

The pipeline should:

- create bot row
- create/merge `agent_config`
- assign tools in `agent_tools`
- set tool config in `agent_tools.tool_config`
- trigger selector recomposition
- announce on mesh
- return a UI-ready summary

2. Add idempotency and patch semantics

Add:

- `POST /api/swarm/agents`
- `PATCH /api/swarm/agents/:agentId`
- `POST /api/swarm/agents/:agentId/provision-runtime`

3. Add a registration summary object

Return:

- created agent
- assigned tools
- missing tools
- config schema count
- unresolved setup steps

### oshal source pattern

- [ProvisioningManager.js](../../any-bot/server/services/ProvisioningManager.js)
- [deploy/config APIs](../../any-bot/server/app-modules/routes-agents-provisioning.js) (extracted from app.js in the 2026-07-11 decomposition)

### Acceptance criteria

- a newly created bot is immediately visible and configurable in `/config/`
- no follow-up SQL or scripts are required for normal bot creation

## Phase 5: Make `/config/` Truly Dynamic

### Goal

Render per-bot config from schema instead of hardcoded assumptions.

### Current problem

The UI loads profile + tools but not `agent_config`.

### Work

1. Update the config-admin page state model
   - add:
     - `selectedAgentConfig`
     - `selectedAgentConfigSchema`
     - `selectedAgentConfigValues`

2. On agent load, fetch:
   - `/api/agents/:agentId/profile`
   - `/api/agents/:agentId/tools`
   - `/api/swarm/agents/:agentId/config`

3. Render config sections dynamically by field type

Support:

- `string`
- `password`
- `url`
- `number`
- `boolean`
- `select`
- `textarea`

4. Add save path
   - `PUT /api/swarm/agents/:agentId/config`

5. Add empty-state behavior
   - if schema is empty:
     - show “No special runtime settings required for this bot”

### Files to update

- [config-admin.js](../../src/pages/config-admin/config-admin.js)
- [config-admin/index.html](../../src/pages/config-admin/index.html)
- [config-admin/config-admin.css](../../src/pages/config-admin/config-admin.css)

### Acceptance criteria

- `google-bot` config fields appear automatically
- `personal-finance-bot` config fields appear automatically
- any new factory-created bot with config fields appears automatically with no UI edits

## Phase 6: Merge Tool Runtime Config Into the Same Dynamic Screen

### Goal

The screen should manage both:

- agent-level config
- per-tool runtime config

### Work

1. Add tool detail expansion in `/config/`
   - show:
     - switch state
     - install state
     - runtime config form if tool defines config schema

2. Extend tool metadata to support optional tool config schema
   - not just freeform `tool_config`
   - add declarative schema for UI rendering

3. Persist with:
   - `PUT /api/agents/:agentId/tools/:toolId/config`

4. Recompose selector on important tool state changes

### Example

`google-bot`:

- agent config:
  - OAuth client id/secret
- tool config:
  - default account alias
  - endpoint/runtime metadata if needed

### Acceptance criteria

- operator can manage both bot-level and tool-level settings from one screen

## Phase 7: Dynamic Switch Framework Screens

### Goal

Make switch-framework surfaces render directly from registry data and assignment state.

### Work

1. Drive tool cards from `/api/agents/:agentId/tools`
2. group tools by `authGroup`, `category`, and `runtime binding`
3. show “config required” badges when:
   - tool is on
   - required config fields are empty
4. show install/verification state from tool verification service
5. add “open config section” deep links per tool

### Acceptance criteria

- enabling a tool that needs config makes the missing config obvious immediately
- operator never has to guess where to set required values

## Phase 8: Startup Recovery and Self-Healing

### Goal

Make dynamic registration survive restart and stay observable.

### Work

1. On startup:
   - load all executable tools from registry
   - restore dynamic handlers
   - verify install state

2. On bot startup:
   - load agent config
   - load tool config
   - emit warnings for missing required fields

3. Add operator endpoints:
   - list bots with unresolved config
   - list tools with unresolved config
   - list tools present in registry but not executable

### Acceptance criteria

- restart does not silently break dynamically created tools/bots

## Data Model Changes

### Tools table

Add explicit runtime execution metadata:

- `handler_key`
- `execution_mode`
- `executable`
- `config_schema` for tool-level settings
- optional `lifecycle_policy`

### Agent config

Keep current table but enforce one invariant:

- every bot may have an `agent_config` row, even if empty

### Optional new tables

- `dynamic_tool_registrations`
- `tool_runtime_bindings`
- `agent_runtime_status`

## Delivery Order

### Sprint 1

- Phase 1
- Phase 5

Reason:

- biggest operator pain today is “backend has config, UI doesn’t show it”

### Sprint 2

- Phase 3
- Phase 4

Reason:

- close the loop for runtime registration

### Sprint 3

- Phase 2
- Phase 6
- Phase 7

Reason:

- bring oshal runtime tool families over and make them visible/manageable

### Sprint 4

- Phase 8

Reason:

- harden for restart, operations, and long-lived use

## Immediate Next Actions

1. Wire `config-admin.js` to `GET/PUT /api/swarm/agents/:agentId/config`
2. Add schema-driven field rendering to `/config/`
3. Add tool-level config schema support in the registry
4. Replace hardcoded executable whitelist with registry-driven executable metadata
5. Port oshal `plane-mcp`, file tools, CLI tools, and browser/fetch tool families

## Definition of Done

This initiative is done only when all of the following are true:

- a tool can be registered dynamically and becomes executable without touching unrelated code
- a bot can be created dynamically with tools and config in one call
- every bot has config capability, even when empty
- `/config/` renders schema-driven bot settings dynamically
- `/config/` renders tool switch and tool runtime config dynamically
- switch framework reflects real registry/runtime state
- restart restores dynamic tools and bots correctly
- imported oshal personas with real code dependencies can be made operational through this runtime model instead of one-off scripts
