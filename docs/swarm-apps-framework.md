# Swarm Applications Framework

**Status:** Active (ADR 2026-04-20 Phase 1 closed on 2026-04-21)
**Authoritative ADR:** [docs/adr/033b-swarm-application-manifests.md](adr/033b-swarm-application-manifests.md)

---

## What this framework is

The Swarm Applications Framework lets you ship a complete OSHAL application - bots, UI ribbon, route ownership, workflow routing, and declared app assets - as a single YAML file. Drop the file into `swarm-apps/`, the framework loads it; remove the file, the framework retires it.

Multiple applications coexist on the same OSHAL instance. Each is toggled independently. The framework itself (cockpit, tickets, chat) keeps running regardless.

There are currently 10 kernel manifests in `swarm-apps/` (all `status: active`): codex-packer
(Bot Forge), devops (DevOps + Vault), intelligent-operations (Intelligent Operations),
intelligent-processing (Intelligent Processing), jarvis (OSHAL Assistant), oshal-dev (OSHAL
Development), oshal-engineering (OSHAL Engineering), person-model (Ambient Recall), security
(Security Center), and workflow-studio (Workflow Studio). This roster is the post-ADR-085 kernel
shape: domain apps such as federal-capture, gov-contracting, home, cloud, travel, storage, social,
presentations, trading, Kalshi, world, career-hunter, and little-monsters install from the
[oshal-applications store](https://github.com/emeraldcoastsystemsgroup/oshal-applications). Manifests
span two broad shapes:

- **Workflow apps** — bots + ticket routing + a ribbon surface (the minimal shape; e.g. oshal-engineering).
- **Data apps** — additionally declare app-owned `routes[]` + `migrations[]` and a reason-only bot
  that triages or justifies app-owned state. Security Center is the in-kernel example; store apps
  such as Trading, Finance, Payments, and Shopping use the same shape when installed. Per the ADR-036
  split, deterministic I/O and storage stay outside LLM execution while the accountable bot only
  *reasons* over the result, so its cost lands in `chat_tasks`. As-built caveats apply per app:
  Trading is paper-only by default, Payments runs in sandbox by default, Shopping is a tracked
  affiliate deep-link handoff that never takes payment, and Security Center observes/triages/escalates
  but does not auto-remediate.

---

## The framework contract

A **swarm application manifest** is the unit of publish. The framework guarantees these behaviors when a manifest is loaded and `status: active`:

| Surface | Contract |
|---|---|
| **Bots** | Every `bots[].agentId` is upserted into the `agents` table and flipped to `status='active'`. Manifest-owned metadata/capabilities refresh on reload while operator provider/model choices remain intact. |
| **Executable tools** | Every entry in `tools[]` is upserted into the tool registry, persisted in `runtime_tool_executors`, restored at boot, exposed to the prompt resolver, and dispatched by the runtime executor. |
| **Dynamic agents** | Agents created through `POST /api/swarm/agents` can be launched through `/api/agents/:agentId/launch`; the generated dynamic compose service starts a `bot-node` worker and publishes live runtime metadata. |
| **Ribbon icons** | Every entry in `ui.static[]` is registered as a dynamic ribbon tool (appears in the cockpit sidebar, routed via `iframeUrl`). |
| **Per-row ribbon icons** | If `ui.dynamic` is declared, one icon is generated per row returned from `SELECT * FROM <source> <where>`. Tool names follow `toolNameTemplate` with `{field}` substitutions. |
| **Workflow pipeline** | If `workflow` + `ticketType` are declared, the `WorkflowPipelineRegistry` routes tickets matching that ticketType to the declared worker bot and pipeline. Built-in `build` and `incident` ticketTypes cannot be overridden. |
| **Schedules ("polls")** | If `schedules[]` are declared, the loader registers each app's default recurring jobs when it's enabled. `scope: framework` (default) is system-wide and on by default; `scope: per-user` activates when a user connects `requiresConnection`. They only EXECUTE when `ENABLE_AGENT_SCHEDULER=true`. |
| **Route gating** | Every entry in `routes[]` is gated: when the app is `status='inactive'`, requests to any path under a declared `mountPath` return `503 {error:"Application inactive", appName:"<name>"}`. Framework paths pass through. |
| **Focus mode** | Visiting `/cockpit?app=<name>` synthesises a ribbon profile from the manifest's `ribbon` block. Only the app's `ui.static` items + framework items NOT in `hideFrameworkItems` are shown. |

When a manifest is flipped to `status='inactive'` or removed from disk, all registered app behaviors reverse together.

---

## Manifest schema

```yaml
# Required root fields
name: <kebab-case-id>              # unique across all apps
displayName: <human string>
version: <semver>                  # informational
status: active | inactive          # initial state on first load
suite: <catalog suite>             # ADR-097: the app's ONE primary catalog shelf — exactly one of
                                   # ai-productivity | ai-knowledge | ai-finance | ai-creative |
                                   # ai-home | ai-engineering (platform is reserved for the framework
                                   # row). Unknown value = load FAILURE; missing = warn + "More" group.
                                   # Chosen by who the app serves — NEVER derived from tool category:.

# REQUIRED — the bots this app brings
bots:
  - agentId: <uuid>
    name: <bot-name>
    persona: <path to persona YAML>
    role: <freeform string>
    capabilities: [<strings>]

# OPTIONAL — foundation persona layered under every bot
foundation:
  persona: <path>

# OPTIONAL — declared tool source location. Informational in the current runtime;
# executable admission can use tools[] below.
toolsDir: <path>

# OPTIONAL — executable tools owned by the app
tools:
  - name: <tool-call-name>
    displayName: <human string>
    type: cli | api | mcp
    category: <string>
    description: <what this tool does>
    defaultAuthMode: auto | ask | off
    inputSchema:
      type: object
      properties: {}
    executor:
      executorType: cli | api | mcp | builtin
      cliCommand: <shell template using {input.field}>
      apiEndpoint: <url template using {input.field}>
      mcpServerName: <configured MCP server name>
      builtinKey: <ToolExecutorService builtin key>

# OPTIONAL — UI surfaces
ui:
  static:
    - toolName: <kebab-case-id>     # unique across all registered tools
      label: <string>
      icon: <codicon class>
      iframeUrl: <path>
      section: top | bottom
  dynamic:
    source: <table-name>             # must match /^[a-z_][a-z0-9_]*$/
    where: <SQL WHERE clause, no leading WHERE>
    toolNameTemplate: <template with {fields}>
    labelField: <column-name>
    icon: <codicon class>
    iframeUrlTemplate: <template with {fields}>
    section: top | bottom

# OPTIONAL — routes this app owns (gated when inactive)
routes:
  - module: <ts path>                # informational (route is hardcoded in server.ts today)
    factory: <export name>           # informational
    mountPath: <path prefix>         # AUTHORITATIVE — drives the gate middleware
    requiresAuth: bool
    requiresContext: bool

# OPTIONAL — migrations this app owns
migrations:                          # informational in Phase 1 (still applied by framework bootstrap)
  - <path to SQL file>

# OPTIONAL — workflow contribution
ticketType: <string>                 # new ticket types allowed; cannot override 'build' or 'incident'
workflow:
  name: <human string>
  pipeline: <pipeline handler>       # 'incident-rca', 'swarm', or an app-specific single-worker label
  workerBot: <bot name>
  phases: [<strings>]                # informational
  maxRevisions: <int>                # incident-rca only

# OPTIONAL — default recurring jobs ("polls"). The loader registers these when the
# app is enabled; they only EXECUTE when ENABLE_AGENT_SCHEDULER=true. (taskType is
# namespaced `app:` internally so these system-declared jobs bypass the per-agent
# scheduler tool gate.)
schedules:
  - id: <string>                     # unique within the app; forms the schedule id
    cron: <cron expr>                # standard 5-field, e.g. every 6 hours
    prompt: <string>                 # the agentic task to run on each tick
    targetAgent: <agentId>           # optional; defaults to the framework chat agent
    scope: framework | per-user      # framework (default) = system-wide, on by default;
                                     #   per-user = registers for a user when they connect requiresConnection
    requiresConnection: <provider>   # per-user only; connector that must be connected, e.g. 'facebook'
    description: <string>            # optional human label
    enabled: <bool>                  # optional; default true

# OPTIONAL — theming
theme: <path to css>                 # informational in Phase 1
sharedCss: <path to css>             # informational in Phase 1

# OPTIONAL — ribbon visibility when focused via ?app=<name>
ribbon:
  hideFrameworkItems:                # subtract these from the framework ribbon when focused
    - <framework-item-id>
  defaultView: <ribbon-item-id>
```

**Framework ribbon item IDs** (for `hideFrameworkItems` and referencing): `tickets`, `chat`, `calendar`, `addressbook`, `dashboard`, `echo`, `logs`, `settings`, `operations`.

---

## How to publish a new application

Three steps. No code, no rebuild, no restart of anything but the api container.

1. **Write `swarm-apps/<your-app>.yaml`** following the schema above.
2. **If the manifest references brand-new bot agentIds**, they'll be upserted on first load. If the bots require personas, make sure the persona YAML paths resolve inside the container (mount `ai-lab/bot-personas` if adding new persona files).
3. **Restart the `oshal-local-api` container** (or POST the manifest path to `/api/swarm/apps/load` to hot-load without restart).

```bash
# Hot load without restart
curl -X POST http://localhost:35457/api/swarm/apps/load \
  -H 'Content-Type: application/json' \
  -d '{"path":"swarm-apps/my-new-app.yaml"}'

# Or restart (auto-loads everything in swarm-apps/)
docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api
```

After load:
- `GET /api/swarm/apps` lists the new app
- `http://localhost:35457/applications` shows a row with toggle/export/unload buttons
- `http://localhost:35457/cockpit?app=<your-app>` opens the cockpit with the app-focused ribbon

---

## How to retire an application

Two paths, depending on whether you want history kept:

**Soft retire** — remove the YAML, keep the DB row:
```bash
mv swarm-apps/my-app.yaml /tmp/retired/
docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api
# Autoload's reconcile pass flips the DB row to inactive,
# deactivates bots, deregisters UIs. Row remains visible in
# /applications with status=inactive. Put the YAML back to restore.
```

**Hard purge** — remove DB row too:
```bash
curl -X DELETE http://localhost:35457/api/swarm/apps/my-app
# Row gone from DB. Manifest file untouched. Next restart won't re-add it
# unless you POST /api/swarm/apps/load with the path.
```

---

## How to transfer an application between instances

```bash
# On source instance
curl -sS http://localhost:35457/api/swarm/apps/gov-contracting/export -o app.yaml

# On destination instance
curl -F 'manifest=@lm.yaml' http://localhost:35457/api/swarm/apps/import
# Manifest lands in destination's swarm-apps/, auto-loads, activates.
```

The exported YAML is self-contained metadata. If your manifest references persona files, tool files, or theme CSS not in the source image, copy those separately.

---

## Lifecycle — what happens when

| Event | SwarmAppService action | Observable effect |
|---|---|---|
| Server boot | `autoLoadAll()` reads every `swarm-apps/*.yaml`, upserts each, runs `activate()` for any with `status='active'`. Reconciles: DB rows whose YAML is missing get flipped to `inactive`. | Ribbon icons appear, bots go active, routes open. |
| `POST /api/swarm/apps/load {path}` | Reads the YAML, upserts, activates if `status='active'`. | Same as boot for that one app. |
| `PATCH /api/swarm/apps/:name/toggle {active:false}` | Deactivates bots (`status='inactive'`), deregisters manifest tools, deregisters all static + dynamic ribbon icons, unregisters workflow. | Tool calls are disabled, ribbon icons vanish immediately. Any `curl` to the app's `mountPath` returns 503. |
| `PATCH .../toggle {active:true}` | Re-upserts bots, flips to active, re-registers executable tools, UIs, and workflow. | Everything reappears. |
| `DELETE /api/swarm/apps/:name` | Deactivates + deletes DB row. | Full purge. Manifest file stays on disk — next boot would re-add it. |
| Remove YAML + restart | Reconcile pass flips to inactive. | Same as toggle-off. |
| Put YAML back + restart | Autoload upserts + activates. | Same as toggle-on. |

---

## Constraints the framework enforces

1. **Built-in workflows are untouchable.** Apps cannot override `build` or `incident` ticketTypes. Attempts are logged and rejected.
2. **Dynamic UI source names are validated.** The `ui.dynamic.source` must match `^[a-z_][a-z0-9_]*$` — SQL-injection protection on an operator-trusted config surface.
3. **Missing manifest files don't crash the boot.** A malformed YAML is logged, skipped, and the rest of the apps load normally. `autoLoadAll()` returns `{loaded, deactivated, failed}` for observability.
4. **One mountPath, one owner.** The ownership map is a last-writer-wins on collision. If two apps claim `/api/foo`, the later-loaded one wins — log it and fix the manifest.
5. **Bot upserts preserve operator runtime choices.** Reloads refresh manifest metadata/capabilities/persona for manifest-owned bots without rewriting provider/model selections.

---

## What's in Phase 1 (closed 2026-04-21)

This section records the framework verification at the time Phase 1 closed. Current manifest `status` values may differ because app activation is an operator toggle.

### Framework layer (verified by `tests/swarm-apps-framework.spec.ts`, 5/5 green)

- Manifest schema + YAML loader
- `swarm_applications` DB table
- SwarmAppService lifecycle (load, toggle, unload, reconcile)
- REST API (`/api/swarm/apps/*`) + operator panel (`/applications`)
- UI profile synthesis (focused mode via `?app=<name>`)
- Dynamic ribbon icon registration/deregistration
- Bot upsert from manifest (new bots can be introduced by YAML)
- Workflow pipeline registry (merges built-ins with app-contributed; built-ins protected from override)
- Route gate middleware (inactive apps 503 their claimed paths)
- YAML-drop reconciliation (file missing = app deactivates)
- Export/import for transfer between instances
- Removed drift: education-routes no longer competes with the LM manifest for ribbon ownership

### Little Monsters application layer (verified by `tests/little-monsters-e2e.spec.ts`, 22/22 green)

- All 8 static UI pages render (student dashboard, my-day, class view, recorder, tutor, flashcards, mascot, CSS)
- Class CRUD (list, create, info lookup)
- Flashcards CRUD (list sets, create set with cards)
- Assignments CRUD (list, create)
- Students CRUD (create)
- Calendar events + notifications endpoints
- Material upload (PDF) creates a tracked ticket
- Tutor chat — returns 200 with real response when `ANTHROPIC_API_KEY` is set, 503 with structured error otherwise (no silent fallback)
- All 6 education bots active in the `agents` table after manifest load

### Bot workflow dispatch (verified by `bot workflow dispatch` test in LM e2e)

This is the piece that was "worked on for days but never verified." It is now verified:

- An approved build-type ticket transitions from `approved` → `in_process_discovery` within 2 seconds
- Queue manager poll picks up approved tickets (dev: 15s interval, prod: 60s)
- Agent router resolves the worker bot (tier 1/2/3 fallback chain works)
- Phase round orchestrator initializes the round
- Work item row is pre-created for output tracking
- Mesh envelope is published to the bot's Redis Stream (`oshal:mesh:agent.{agentId}`)
- Bot-node's `swarm-agent-worker` consumes the envelope, marks the work item `assigned`
- Persona prompt resolver writes the 11KB+ layered context file to the workspace
- LLM execution handler invokes the configured harness adapter
- All 7 engineering bot containers are running and subscribed to their Redis channels

### Dynamic agent and runtime tool insertion (live Docker validation on 2026-05-09)

This path is covered by the opt-in `tests/dynamic-agent-live-e2e.spec.ts` test and was validated against `docker-compose.oshal-local.yml`:

- Runtime CLI tool registered through `/api/tools/runtime/register`
- Executor persisted in `runtime_tool_executors`
- Dynamic agent created through `/api/swarm/agents`
- Tool assignment persisted with `authMode=auto`
- Persona YAML generated on the host-mounted persona directory
- `/api/agents/:agentId/launch` wrote `docker-compose.dynamic.yml`
- Dynamic container started from `oshal-bot:latest`
- Bot `/health` returned OK
- Redis runtime heartbeat included profile-backed role, capabilities, and internal endpoint
- `/api/swarm/bots/registry` included the dynamic runtime registration
- Bot-node subscribed to direct, alias, broadcast, and capabilities mesh channels

### Runtime dependencies (must be provided by the operator, not shipped by the framework)

| Feature | Required env var | Effect if missing |
|---|---|---|
| Tutor chat | `ANTHROPIC_API_KEY` | Returns 503 with a structured error pointing the operator at `.env` |
| Bot ticket execution | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (whichever matches the configured harness) | Envelopes are still dispatched and work items are still tracked; the harness subprocess fails fast with an auth error and the work item goes into an error state |
| Audio transcription (`/process-lecture`) | `OPENAI_API_KEY` (used by Whisper via the lecture-scribe bot) | Audio is saved, ticket is created; ingestion fails in the bot subprocess |
| PDF ingestion into ChromaDB | ChromaDB reachable at `CHROMADB_URL` (default `http://oshal-chromadb:8000`) | Document is saved to disk, ticket created; ingestion fails when the textbook-librarian bot runs |

---

## What's in Phase 2 (deferred)

- Dynamic route **mounting** — today `routes[]` is authoritative for the gate but the Express mounts themselves are still hardcoded in `server.ts`. A full Phase 2 would load + unload route modules dynamically.
- Dynamic migration application — `migrations[]` is informational; SQL still runs via `DatabaseBootstrapService` at framework boot.
- Dynamic theme/shared CSS loading — `theme` + `sharedCss` are informational.
- Per-app permissions (who can toggle which app).
- App versioning, rolling updates, signed manifests.
- Inter-app communication / shared bot pools.
- **Schedules — next steps.** `schedules[]` ships (framework-scope on enable + per-user on connect), but follow-ons remain: (1) **unregister/pause on app deactivate or unload** — schedules currently persist in the scheduler when their app is toggled off; (2) a **cockpit surface to view/pause** an app's registered schedules (the data is already queryable via `listSchedules` scoped by queue); (3) **per-user reconcile on disconnect** (today connect registers; disconnect leaves the schedule dormant). Source: `swarm-app-service.registerManifestSchedules`, `src/app/per-user-schedule-reconcile.ts`, and the registrar wiring in `server.ts`.

---

## Key source files

| Path | Responsibility |
|---|---|
| [src/features/swarm-apps/types.ts](../src/features/swarm-apps/types.ts) | Manifest + record types |
| [src/features/swarm-apps/services/swarm-app-loader.ts](../src/features/swarm-apps/services/swarm-app-loader.ts) | YAML read / list / serialise |
| [src/features/swarm-apps/services/swarm-app-repository.ts](../src/features/swarm-apps/services/swarm-app-repository.ts) | Postgres CRUD on `swarm_applications` |
| [src/features/swarm-apps/services/swarm-app-service.ts](../src/features/swarm-apps/services/swarm-app-service.ts) | Lifecycle orchestrator |
| [src/features/swarm-orchestration/services/workflow-pipeline-registry.ts](../src/features/swarm-orchestration/services/workflow-pipeline-registry.ts) | Built-in + app workflows |
| [src/app/middleware/swarm-app-gate-middleware.ts](../src/app/middleware/swarm-app-gate-middleware.ts) | 503 gate |
| [src/app/routes/swarm-app-routes.ts](../src/app/routes/swarm-app-routes.ts) | REST surface |
| [src/pages/applications/index.html](../src/pages/applications/index.html) | Operator panel |
| [scripts/migrations/022-swarm-applications.sql](../scripts/migrations/022-swarm-applications.sql) | Table schema |
| [swarm-apps/](../swarm-apps/) | Manifest drop-zone |
| [tests/swarm-apps-framework.spec.ts](../tests/swarm-apps-framework.spec.ts) | Lifecycle Playwright coverage |
| [tests/dynamic-agent-live-e2e.spec.ts](../tests/dynamic-agent-live-e2e.spec.ts) | Opt-in live Docker coverage for dynamic tool + dynamic bot insertion |

---

## Example - current manifests

These manifests are examples of the framework contract. Their `status` field is an operator toggle, not a statement that every dependent external service is currently available. The full roster is 33 manifests (see [What this framework is](#what-this-framework-is)); the table below highlights examples of each shape.

| Manifest | Ticket type | Owns routes[] / migrations[] | Workflow behavior | Focus URL |
|---|---|---|---|---|
| [swarm-apps/oshal-engineering.yaml](../swarm-apps/oshal-engineering.yaml) | `build` | no | Uses the built-in build/swarm pipeline; apps cannot override the built-in `build` owner. | `/cockpit?app=oshal-engineering` |
| [little-monsters](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/little-monsters) (store package, ADR-085) | `education` | yes | App-contributed single-worker workflow routed to `lecture-scribe`. | installs from the oshal-applications store |
| [swarm-apps/intelligent-operations.yaml](../swarm-apps/intelligent-operations.yaml) | (incident pipeline) | — | Self-healing ops: Prometheus/Alertmanager/cAdvisor alerts hit `/api/alerts/alertmanager`, become incident tickets, the RCA pipeline proposes a fix, and the self-healing-bot applies it only after operator approval. Unifies the former incident-remediation / issue-rca manifests. | `/cockpit?app=intelligent-operations` |
| [trading (store package)](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/trading) | `trading-decision` | `/api/trading`, migrations 034-035 | Data app: deterministic broker I/O in the controller, an inline reason-only `trading-analyst`. Paper-only by default. | `/cockpit?app=intelligent-trades` |
| [swarm-apps/security.yaml](../swarm-apps/security.yaml) | `security-finding` | `/api/security`, migration 039 | Data app: deterministic scanners + threat detection in the controller, an inline reason-only `security-analyst`. Triages and escalates to tickets; does not auto-remediate. | `/cockpit?app=security-center` |

All load from YAML alone. The framework treats each manifest identically for app lifecycle, bot status, route gating, ribbon registration, and workflow registration rules.
