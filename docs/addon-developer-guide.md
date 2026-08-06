# Addon Developer Guide — build an app from tools, bots, workflows, surfaces, and connectors

This is the front door for **building an OSHAL application as a set of addons** and wiring
them together. It is organized the way an app is actually composed:

> An oshal app reduces to **a tool, an exact server operation, a connector, a bot, and a surface.**
> This supersedes the earlier "a tool, a CLI, a connector, a bot, and a surface" formulation used by
> pre-containment application manifests.

You build each block, then **bind them into one application manifest** and **import** it.

> **Current security boundary (2026-08-06):** unattended Cline, Claude Code, Codex, and Gemini
> CLI execution is operationally disabled until an audited oshal-brokered sandbox exists. Mounted
> OAuth presence is not autonomous-execution authority. Connector credentials remain inside exact,
> schema-bounded server operations; they never enter a prompt, model/CLI environment, generic bot
> request, or workspace. Use hosted/BYO inference for reasoning and a deterministic server provider
> intent for a provider read/action.

## Where this fits among the existing docs

The framework is already documented; this guide is the practical index that threads those docs
together by addon type and adds the one shape they do not cover standalone — a **native data app
that vendors an existing engine** (the [`gov-contracting`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/gov-contracting) /
[`career-hunter`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter) shape).

| Doc | What it is | Read it for |
|---|---|---|
| [build-your-own-swarm-app.md](build-your-own-swarm-app.md) | 10-minute tutorial: a minimal one-bot manifest app | The smallest possible app, and the "compiles-but-fails" core-code checklist |
| [swarm-apps-framework.md](swarm-apps-framework.md) | The manifest **contract** + lifecycle + the Phase-1/Phase-2 boundary | The authoritative field-by-field manifest reference |
| [framework-developer-guide.md](framework-developer-guide.md) | The broad extension-point map (tools, agents, workflows, UI, OIDC, clusters) | Cluster/OIDC/agent-factory and the "Current Truth Matrix" |
| [connector-backed-apps.md](connector-backed-apps.md) | The six-piece recipe for giving a bot an external account | Any app that calls a third-party API on a user's behalf |
| **this guide** | Per-addon recipe + how binding & import really work, incl. the compile-time seam | Building a real data app end to end and knowing exactly what is hot vs what needs a rebuild |

If you only want the smallest app, stop here and read
[build-your-own-swarm-app.md](build-your-own-swarm-app.md). Come back when your app owns
server-side state, a vendored engine, or its own surfaces.

---

## The two-layer model (read this first)

This is the single most important thing to understand, and the question most people ask first:
**why are some apps "just a YAML file" and others touch core code?**

OSHAL has a declarative addon layer **and** a compile-time binding layer. The manifest declares
*intent*; some of that intent is honored purely from YAML at runtime, and some still needs a code
change and an image rebuild. The framework is honest about this — it is "Phase 1" of the swarm-apps
ADR, with the rest deferred to Phase 2 (see
[swarm-apps-framework.md → What's in Phase 2](swarm-apps-framework.md#whats-in-phase-2-deferred)).

| Addon piece | Declared in | Hot-loaded? (no rebuild) | Where it actually binds |
|---|---|---|---|
| Bots (identity, status, capabilities) | manifest `bots[]` | **Yes** — upserted into `agents` on load | `SwarmAppService.activate()` |
| Bot **dispatch endpoint** | — | **No — rebuild** | `swarm-bot-registry-local.ts` (+ `swarm-bot-registry.ts`) |
| Framework tools | manifest `tools[]` | **Yes** — registered into the runtime tool registry | `registerManifestTools()` |
| Legacy toolkit descriptors | manifest `toolsDir` | **Discovery only** — generic connector CLI execution is disabled | any-bot `collectToolFiles` |
| Ribbon icons | manifest `ui.static` / `ui.dynamic` | **Yes** — registered as dynamic ribbon tools | `registerUiSurfaces()` |
| Workflow routing | manifest `ticketType` + `workflow` | **Yes** — registered with the pipeline registry | `registerWorkflow()` |
| Schedules ("polls") | manifest `schedules[]` | **Yes** (execute only when `ENABLE_AGENT_SCHEDULER=true`) | `registerManifestSchedules()` |
| App-owned HTTP **routes** | manifest `routes[]` (informational) | **No — rebuild** | hardcoded `app.use(...)` in [`src/app/server.ts`](../src/app/server.ts) |
| DB **migrations** | manifest `migrations[]` (informational) | **No** — applied by the bootstrap at boot | `scripts/migrations/*.sql` |
| Surface in the **everything view** | — | **No — rebuild** | [`config-seed/profiles/oshal-framework.json`](../config-seed/profiles/oshal-framework.json) |
| Openable in **`/applications`** | — | **No — rebuild** | `WORKING` array in [`src/pages/applications/index.html`](../src/pages/applications/index.html) |

The right mental model: **a workflow app** (one or more bots + ticket routing + a ribbon surface
that just renders tickets) is genuinely **100% YAML, hot-loadable**. A **data app** (its own HTTP
routes, its own tables, its own native surfaces) declares the same way but has **five core-code
touch points** that require an edit + rebuild. Most apps in the roster started as a YAML idea and
then "grew into the codebase" through exactly those five points — that is not a smell, it is the
documented Phase-1 contract.

The five compile-time touch points for a data app, in one place:

1. **Mount the route** in [`src/app/server.ts`](../src/app/server.ts) — `import` the factory, then
   `app.use('/api/<app>', requiresAuth, create<App>Routes(ctx))`. The manifest `routes[]` block is
   informational (it only drives the inactive-gate); it does **not** create the mount.
2. **Register the bot endpoint** in
   [`swarm-bot-registry-local.ts`](../src/app/extensions/swarm/swarm-bot-registry-local.ts) (and
   `swarm-bot-registry.ts`). Without it, `BotNodeClient` cannot resolve the bot and any LLM action
   throws at runtime even though the build is green. (Skip this only if you reuse a bot another
   manifest already registered — see gov-contracting below.)
3. **Curate the surface** into [`config-seed/profiles/oshal-framework.json`](../config-seed/profiles/oshal-framework.json)
   so it appears in the default unified home.
4. **Allow-list the app** in the `WORKING` array of
   [`src/pages/applications/index.html`](../src/pages/applications/index.html) so it is openable
   (not greyed "coming soon").
5. **Add the migration** under `scripts/migrations/NNN-<app>.sql` (and/or self-heal the schema in the
   route on first call).

`gov-contracting` carries this exact note in its own manifest:

```yaml
# INFORMATIONAL — routes are mounted in src/app/server.ts (the loader does not yet mount from
# manifests). Kept here so the app's surface area is declared in one place.
```

Everything below is organized by addon type. For each, you get: **what it is**, **where it lives**,
a **minimal copy-paste**, whether it is **hot or needs a rebuild**, and **where to copy from**.

---

## Addon 1 — Tool addon

**What it is.** A callable capability a bot can invoke: a CLI command, an HTTP endpoint, an MCP
tool, or a builtin. There are two flavors.

### 1a. Framework tool — declared in the manifest (`tools[]`), runs server-side

The runtime executes it; the bot **calls** it (it does not shell out). Hot-loaded.

```yaml
tools:
  - name: career_database          # the call name the bot uses; must match the persona authorization
    displayName: Career Database
    type: cli                       # cli | api | mcp | builtin (inferred from executor if omitted)
    description: Read the signed-in user's scored matches, pipeline, and gaps.
    executor:
      executorType: cli
      cliCommand: node {packageDir}/bin/oshal-jobhunter.js query   # {packageDir} = THIS add-on's own dir; {input} is substituted as JSON
    defaultAuthMode: auto           # auto | ask | off
    inputSchema:                    # optional; property keys map to {input.<key>} placeholders
      type: object
      properties:
        entity: { type: string }
      required: [entity]
    usageInstructions: >-           # injected into the authorized bot's prompt
      Call career_database to get a JSON snapshot of THIS user's hunt; answer with real numbers.
```

`{input}` in `cliCommand` is replaced with the JSON arguments the bot supplies. The descriptor is
persisted in `runtime_tool_executors`, restored at boot, exposed to the prompt resolver, and
dispatched by `ToolExecutorService`. **Copy from:** the `world_*` tools in
[world's store package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/world)
and the `career_database` tool in
[career-hunter's store package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter) (both carved out per ADR-085).

> Gotcha (Vault learned it the hard way): a `cliCommand` that needs `{input}` inside a YAML block
> scalar is fragile. Keep the command on one line and let the runtime do the substitution.

### 1b. Legacy toolkit descriptor — discovery is not execution authority

`toolsDir` is still scanned for compatibility and catalog discovery, but do not add a wrapper that
shells a connector CLI or expects `OSHAL_CRED_*`/`.oshal-cred-*`. The generic connector CLI runner
is disabled pending an audited brokered sandbox. A discovered name still needs the server-resolved
dispatch allowlist and an exact handler; discovery never grants execution by itself.

For a provider-backed capability, implement a closed deterministic provider intent or fixed server
operation as described in [connector-backed-apps.md](connector-backed-apps.md). Call a tested client
or imported function without a shell, resolve the minimum caller-owned credential inside that
handler, and return only normalized/redacted data.

### Granting a tool to a bot

A tool a bot cannot call is dead weight. The persona's `authorizations` map is the switch — and the
**tool name must match exactly**, or the bot gets a stub instead of the tool:

```yaml
# ai-lab/bot-personas/<bot>.yaml
authorizations:
  career_database: "auto"   # auto = run without asking
  write_file: "off"         # off = not available to this bot
  bash: "ask"               # ask = require approval
```

**Hot vs rebuild:** declarations remain hot-loaded, but hot discovery does not relax authorization
or the credential boundary. A new deterministic server handler is reviewed, registered, and tested
as code; it is not smuggled in as a model-selected shell command.

Deeper reference: [framework-developer-guide.md → Add A Tool](framework-developer-guide.md#add-a-tool).

---

## Addon 2 — Bot addon

**What it is.** An agent identity with a persona (its system prompt + quality gate) that processes
tickets or answers chat. Cost lands under its own `agent_id`.

### Two forms

| | Form A — dedicated node | Form B — inline concierge |
|---|---|---|
| Runs in | its own container | the `oshal-api` controller |
| Talks via | HTTP (`BotNodeClient` → `/api/swarm-execute`) | direct `orchestrator.processMessage()` |
| Use for | isolation, long work, a dedicated store, or an audited deterministic provider intent | reason-only over already-authorized/redacted data (ADR-036) |
| Registry `container` | the bot's own service name | `oshal-api` |
| Example | `career-hunter` (runs the job engine) | `career-advisor`, `finance-analyst` |

The route layer does not care which form runs — it calls **`executeBotOrInline(ctx, botClient,
agentId, request)`** ([`src/app/routes/inline-bot-execution.ts`](../src/app/routes/inline-bot-execution.ts)),
which HTTP-dispatches if `botClient.hasEndpoint(agentId)` (Form A) and otherwise runs inline (Form B).
Both return a unified `BotNodeResponse` with token usage + cost.

### The persona (hot — bind-mounted)

```yaml
# ai-lab/bot-personas/<bot>.yaml
name: career-advisor
role: Career Advisor — job-hunt knowledge owner
agent_id: cb000000-0000-0000-0000-000000000002   # MUST match the registry + manifest

perspective: |
  You are the knowledge owner of the operator's job hunt. Read their REAL data with your tools
  before answering. Never invent numbers; never ask them to "set up a database" — you have it.

capabilities: [job-fit-advice, application-strategy, resume-tailoring]

authorizations:
  career_database: "auto"
```

Do not copy a legacy `runtime.harness` CLI value and assume it is live. CLI harness names remain in
the configuration schema for compatibility, but unattended execution fails closed. The request must
carry an authorized hosted/BYO inference rail, or an exact deterministic provider intent handled
outside the model runtime.

### The registry entry (compile-time — rebuild)

Every bot needs an endpoint entry in
[`swarm-bot-registry-local.ts`](../src/app/extensions/swarm/swarm-bot-registry-local.ts) **and**
`swarm-bot-registry.ts`:

```ts
{
  agentId: 'cb000000-0000-0000-0000-000000000002',
  name: 'career-advisor',
  port: 3010,                 // inline bots share 3010; a dedicated node gets its own unique port
  container: 'oshal-api',     // 'oshal-api' = Form B inline; a service name = Form A node
  role: 'career/advisor',
  capabilities: ['job-fit-advice', 'application-strategy'],
}
```

`harnessType` + `apiType`, when present, select configured runtime precedence; they do not override
the autonomous-CLI preflight. A mounted `~/.claude`, `~/.codex`, or `~/.gemini` file reports local
authentication presence only. Per-user connector credentials are never brokered into a harness.
Reasoning uses hosted/BYO inference; provider actions use exact deterministic server operations.

### Binding bots into the manifest (hot)

```yaml
chatBot: career-advisor          # the right-rail chat agent (synthesiseProfile: chatBot wins over workerBot)
bots:
  - agentId: cb000000-0000-0000-0000-000000000001
    name: career-hunter
    persona: ai-lab/bot-personas/career-hunter.yaml
    role: career/job-hunter
    capabilities: [ats-scraping, job-scoring, resume-generation]
```

**`chatBot` can point at a bot another manifest already declares.** `gov-contracting` reuses the
`capture-specialist` worker from `federal-capture.yaml` by naming it as its `chatBot` and **not**
re-declaring it — a duplicate `agentId` fails boot validation. This is how you add a surface-only app
on top of an existing bot with zero new registry work.

UUID consistency is load-bearing: the `agent_id` in the persona, the `agentId` in the registry, and
the `agentId` in the manifest must be identical, and collision-free (grep existing ids first).

Deeper reference: [build-your-own-swarm-app.md → the compiles-but-fails checklist](build-your-own-swarm-app.md#the-wiring-the-manifest-does-not-do-compiles-but-fails-checklist)
and [CONTRIBUTING.md → Adding a new bot persona](../CONTRIBUTING.md).

---

## Addon 3 — Workflow addon

**What it is.** A ticket-type that routes work to a worker bot through a pipeline. Hot-loaded.

```yaml
ticketType: federal-capture      # new types are allowed; you cannot override built-in 'build' or 'incident'
workflow:
  name: Federal Capture Pipeline
  pipeline: capture              # see pipeline table below
  workerBot: capture-specialist  # persona name, resolved via the registry
  # reviewerBot: <name>          # optional Phase-2 reviewer (incident-rca); omit for one-and-done
```

On app activation, `registerWorkflow()` registers this with the `WorkflowPipelineRegistry`. When a
ticket of that type arrives, `chooseDispatchPath()` picks the handler:

| `pipeline` value | Dispatch path | Use for |
|---|---|---|
| `swarm` (or `ticketType: build`) | full 7-phase decomposition swarm | a build/plan team assembled on the fly |
| `incident-rca` | single-bot RCA loop (optional reviewer) | incident analysis |
| any other label **with** a `workerBot` | **`manifest-worker`** — one self-gating bot | most app workflows (capture, career-application) |
| `graph` + a compiled `processDefinition` | the ProcessDefinition execution engine | authored branch/gate workflows |

`build` and `incident` are protected — attempts to override them are logged and rejected. The
common case for an app is the **`manifest-worker`** path: one persona that carries the entire quality
bar (it self-gates; no external reviewer). `federal-capture` (`pipeline: capture`) and
`career-application` both use it.

**Workflow Studio** ([`/workflow-studio/`](../swarm-apps/workflow-studio.yaml)) authors and saves
graphs, and its **Publish** action compiles a canvas into a live runtime workflow — single-shot,
staged (approval gates), or a full branching/parallel graph loaded as a caller-scoped ticket queue.
Manifest `ticketType` + `workflow` is the other runtime registration path. Publish emits into the
same queue-manager runtime; it does not replace it.

Deeper reference: [framework-developer-guide.md → Add A Workflow](framework-developer-guide.md#add-a-workflow)
and [architecture/workflow-studio-framework.md](architecture/workflow-studio-framework.md).

---

## Addon 4 — Surface / toolbar addon

**What it is.** A native HTML page embedded in the cockpit as an iframe, themed to match the
cockpit, talking to your app's JSON routes. This is the "toolbar" piece — a `ui.static` entry is one
ribbon icon.

### The surface skeleton (hot — bind-mounted)

A native surface lives at `any-bot/server/services/tools/<app>/<surface>.html` and must do four
things. **No hardcoded colors** — everything flows from the theme bridge.

```html
<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Capture Board</title>

  <!-- 1. Inline :root fallback palette (used standalone / before the bridge runs) -->
  <style>:root{ --bg:#0d1117; --panel:#161b22; --ink:#e6edf3; --acc:#2f81f7; }
    body{ margin:0; background:var(--bg); color:var(--ink); }</style>

  <!-- 2. Theme bridge: copy the cockpit's design tokens into this surface's local vars -->
  <script>(function(){
    const M={'--bg':'--bg-primary','--panel':'--bg-secondary','--pill':'--bg-tertiary',
             '--line':'--border-color','--ink':'--text-primary','--mut':'--text-secondary',
             '--acc':'--accent-primary','--good':'--status-success'};
    function m(){try{const p=(window.parent&&window.parent!==window)?window.parent:null;if(!p)return;
      const cs=p.getComputedStyle(p.document.documentElement);
      for(const k in M){const v=cs.getPropertyValue(M[k]).trim();if(v)document.documentElement.style.setProperty(k,v);}
    }catch(e){}}
    m(); window.addEventListener('storage',e=>{if(e.key==='cockpit-theme')setTimeout(m,30);});
    try{const p=window.parent;if(p&&p!==window)new MutationObserver(m)
      .observe(p.document.documentElement,{attributes:true,attributeFilter:['data-theme']});}catch(e){}
    document.addEventListener('DOMContentLoaded',m);
  })();</script>

  <!-- 3. Link the shared glass design system (served from /shared/ui/css) -->
  <link rel="stylesheet" href="/shared/ui/css/surface-glass.css">
</head><body>
  <!-- 4. Fetch your app's native JSON routes (scoped to the signed-in user server-side) -->
  <script>
    const API='/api/gov-contracting';
    async function load(){ const r=await fetch(API+'/summary'); render(await r.json()); }
    load();
  </script>
</body></html>
```

Use the glass classes (`.glass-card`, `.surface-card`, `.app-card`, `.stat-card`, …) on your panels
so they pick up the theme. The canonical, fuller theme-bridge var map is in
[`jarvis.html`](../src/api/jarvis.html); a working board is
`gov-contracting/govcon-board.html` in the store-side package.

> Surfaces **follow** the cockpit theme by reading the parent's `data-theme`; they never hardcode a
> palette. A surface that ships its own colors looks broken in half the themes.

### Getting the surface into the cockpit

```yaml
ui:
  static:
    - toolName: govcon-board          # globally-unique kebab id
      label: Capture Board
      icon: codicon codicon-target
      iframeUrl: /api/gov-contracting/board   # a route YOUR factory serves (serveFile of the HTML)
      section: top                    # top = scrollable rail; bottom = pinned (near Settings)
```

`ui.static` powers the **focused** view (`/cockpit?app=<name>`) for free — `synthesiseProfile`
builds a ribbon from the manifest. For the surface to also show in the **default everything view**,
add it to [`config-seed/profiles/oshal-framework.json`](../config-seed/profiles/oshal-framework.json)
(compile-time) under a `group`:

```json
{ "id": "tool-govcon-board", "icon": "codicon codicon-target", "label": "Capture Board",
  "section": "top", "group": "Intelligent Opportunities — Federal",
  "toolUi": { "iframeUrl": "/api/gov-contracting/board", "sidebarLabel": "Capture Board" } }
```

And to be **openable** from `/applications`, add the app name to the `WORKING` array in
[`src/pages/applications/index.html`](../src/pages/applications/index.html) (compile-time) — otherwise
it renders greyed "coming soon".

### The hover-bot surface standard (`/guide`): let a bot edit a document live

When a surface needs a bot to *reach in and edit* a document (a resume, a slide deck) with a live
preview, use the structured-action loop — the bot returns edits, the surface applies them, **the bot
never touches disk**:

1. Surface `POST`s the current doc state + the user's message to a `/guide` route.
2. The route prompts the bot for **`{ "reply": "<one sentence>", "actions": [ {"op":"set_summary","text":"..."}, ... ] }`** — JSON only, from a whitelist of ops.
3. The surface validates the ops, applies them to its in-memory doc, and re-renders instantly (no LLM re-render).
4. The user clicks **Save** when satisfied; a separate route persists + re-renders.

Reference: `career-resume-studio-routes.ts` + `career-resume-studio.html` — both now in the
[career-hunter store package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter) (ADR-085) —
and the presentation `/guide` in the store-side AI Office package.

---

## Addon 5 — Connector addon

**What it is.** Auth to an external service (Jira, Slack, Gmail, a merchant) so a bot can act on a
user's account. **Auth and action are separate**: the connector stores a per-user token in
`oshal_connections` (encrypted); an exact deterministic server operation calls the provider API and
returns a normalized/redacted result. If reasoning is needed, hosted/BYO inference receives that
result only—not the token.

There are two ways to add one. Pick by how much custom logic you need.

### 5a. Declarative connector spec (ADR-065) — preferred for plain REST

Drop a YAML spec in [`swarm-apps/connectors/`](../swarm-apps/connectors/) (validated by
[`connector.schema.json`](../swarm-apps/connector.schema.json)); the shared `ConnectorClient` handles
auth, rate-limit, retry, refresh, and pagination. Each resource with a `tool:` is auto-exposed as a
bot tool.

```yaml
provider: jira
displayName: Jira
baseUrl: https://<site>.atlassian.net/rest/api/3
auth: { type: basic }            # none | oauth2 | basic | apiKeyHeader | apiKeyQuery
pagination: { strategy: cursor, param: nextPageToken, nextField: nextPageToken, itemsField: issues }
resources:
  - { name: search-issues, tool: jira-search-issues, method: GET, path: /search/jql, query: { jql: '{jql}' }, paginate: true }
  - { name: create-issue,  tool: jira-create-issue,  method: POST, path: /issue, body: '{data}' }
```

**Copy from:** [`swarm-apps/connectors/jira.yaml`](../swarm-apps/connectors/jira.yaml),
[`slack.yaml`](../swarm-apps/connectors/slack.yaml). There are 400+ specs in that directory.

### 5b. Custom deterministic operation — for OAuth flows, signed requests, or deep links

When the provider needs a custom OAuth card, signed request, or deep-link handoff, follow
**[connector-backed-apps.md](connector-backed-apps.md)**: add the authenticated connector, define a
closed versioned operation schema, bind one audited server handler, resolve the caller-owned
credential at that boundary, call the provider without a shell, normalize/redact the response, and
then wire the persona, manifest, and surface.

Either way, per-user secrets live in `oshal_connections`. `resolveServerOperationCreds` may resolve
the minimum token only for a `trusted-provider-intent` or `fixed-server-operation`; it must be
consumed inside that handler and never attached to a bot request, model/CLI environment, or
workspace. Adding a connector mints a new partner credential—that is a **governance decision**,
recorded in [partner-app-registration.md](partner-app-registration.md), not an auto-approved add.

---

## Binding it together: the application manifest

The manifest is where the blocks become one app. Two reference shapes bracket the range:

**Lean shape — `gov-contracting` (reuse a bot, native surfaces, compile-time route).** No `bots[]`
(it borrows `capture-specialist` via `chatBot`), two `ui.static` surfaces, an informational
`routes[]`, a theme, and a focused ribbon:

```yaml
name: gov-contracting
displayName: Intelligent Opportunities — Federal
status: active
scope: person                    # person | tenant | public — person = visible only to the owner
chatBot: capture-specialist      # reuse the federal-capture worker; do NOT re-declare its agentId
ui:
  static:
    - { toolName: govcon-board, label: Capture Board, icon: codicon codicon-target, iframeUrl: /api/gov-contracting/board, section: top }
    - { toolName: govcon-plan,  label: Formation Plan, icon: codicon codicon-checklist, iframeUrl: /api/gov-contracting/plan, section: top }
routes:                          # informational — the real mount is in server.ts
  - { module: src/app/routes/gov-contracting-routes.ts, factory: createGovContractingRoutes, mountPath: /api/gov-contracting, requiresAuth: true }
theme: midnight
ribbon: { defaultView: govcon-board, hideFrameworkItems: [chat, calendar, dashboard, logs] }
```

**Full shape — `career-hunter`** declares its own `bots[]` (worker + advisor), a `toolsDir`, a
framework `tools[]` entry, seven `ui.static` surfaces, `routes[]`, `migrations[]`, `ticketType` +
`workflow`, `sharedCss`, and `ribbon`. Read it in full in the
[career-hunter store package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter) — it exercises nearly every block.

For the field-by-field contract (every key, every default, the lifecycle table), see
[swarm-apps-framework.md → Manifest schema](swarm-apps-framework.md#manifest-schema). An app **is** a
queue — its `name` is its queue id.

---

## Importing / loading the app

### Hot path (workflow apps — pure YAML)

```bash
# Drop swarm-apps/<app>.yaml, then either restart the api or hot-load it:
curl -X POST http://localhost:35457/api/swarm/apps/load \
  -H 'Content-Type: application/json' -d '{"path":"swarm-apps/<app>.yaml"}'

# Verify:
curl http://localhost:35457/api/swarm/apps                 # lists it
# open http://localhost:35457/cockpit?app=<app>             # focused ribbon
```

Manifests in `swarm-apps/` (built-in) and `deployed-apps/` (Forge/Studio-authored) auto-load at boot
via `autoLoadAllWithRetry()`. Toggle, export, and import between instances are documented in
[swarm-apps-framework.md → How to publish / retire / transfer](swarm-apps-framework.md#how-to-publish-a-new-application).

### Data-app path (route + tables + native surfaces — needs a rebuild)

A data app's hot YAML is necessary but **not sufficient**. After writing the manifest, do the five
compile-time steps from [the two-layer model](#the-two-layer-model-read-this-first) (mount the route,
register the bot endpoint unless reused, curate the profile JSON, allow-list in `/applications`, add
the migration), then rebuild and recreate:

```bash
docker build -f Dockerfile.oshal -t any-bot:latest .
docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api
```

Recreate (not restart) so env is re-read; `--force-recreate` so a changed `displayName`/profile
actually reloads; hard-refresh or purge the CDN for baked JS. Pin `MOCK_OIDC=false` (or every user
collapses to `mock-user-001`) and pin `UI_PROFILE` so the cockpit does not drop to the bare starter
tiles.

---

## Worked recipe: vendor an existing engine as a native data app

This is the shape none of the sibling docs cover standalone, and it is how both `gov-contracting`
and `career-hunter` were built: take a working standalone app (a Python CRM, a job engine) and bring
it in as a **native** OSHAL data app — same cockpit CSS, same per-user isolation, same bots — without
rewriting the engine.

1. **Vendor the engine** under `apps/<app>/engine/` and bind-mount `./apps:/app/apps` so iterations
   apply without a rebuild. Add a `GOVCON_STORE_ROOT`-style env for the per-user data root.
2. **Add a thin CLI dispatcher** (`api.py`) that **reuses the engine's tested response builders** —
   do not reimplement them. Usage: `python api.py GET /api/summary` with the POST body on stdin.
3. **Write the TS route factory** (`src/app/routes/<app>-routes.ts`): `serveFile()` for each native
   surface, and JSON routes that `spawnSync` the dispatcher with the user's store in env. Scope every
   request by `callerSub(req)` (the OIDC sub) so user A never sees user B's data. Keep **system data**
   (the shared SAM/job feed) separate from **user data** (proposals, resumes) — the latter lives in
   the user's own store, never on the platform volume.
4. **Build the native surfaces** (Addon 4) — port the **full** original UI, not a stub: the pipeline,
   the breakdowns (set-aside / wedge), the detail drawer with the real strategy docs, and the
   human-gate approve/advance workflow.
5. **Do the five compile-time steps** (mount, bot endpoint or reuse, profile JSON, `WORKING`, migration).
6. **Add a gated cron** (`src/app/routes/<app>-cron.ts`) for the daily pull/triage the old Windows
   Task Scheduler job ran; keep it off by default (`<APP>_CRON=1` to enable) so heavy scans never
   fire unexpectedly in dev.

The result: the foreign app's data and workflow, themed and isolated like a first-class OSHAL app,
with its engine untouched.

---

## Lessons learned migrating gov-contracting

Each is *symptom → cause → rule* — the house style for an OSHAL lessons doc — so it survives being
copied into the next migration.

**Don't proxy the foreign app's own UI.**
*Symptom:* the migrated board loaded with the wrong fonts/colors and didn't appear in the cockpit
theme; it looked bolted-on.
*Cause:* iframing the standalone app's own HTML brings its own CSS and ignores the cockpit design
system and theme switches.
*Rule:* build a **native surface** that links `/shared/ui/css/surface-glass.css` + the theme bridge
and fetches native JSON routes. The engine stays headless behind `api.py`; only data crosses the line.

**Don't ship a stub and call it migrated.**
*Symptom:* the first board was a list of titles and fit percentages — the operator's real workflow
(approve a bid to proposal, per-opportunity strategies, the wedge / set-aside breakdown) was gone.
*Cause:* I rebuilt a thin approximation instead of porting what already existed.
*Rule:* port the **full** original surface — every view, the detail drawer with the actual strategy
documents, and the human-gate approve/advance flow. Migrating means parity, not a sketch.

**Never hardcode credentials.**
*Symptom:* tempted to drop an API key into the route/engine to make the bot run.
*Cause:* confusing credential presence with authority to expose it to a model runtime.
*Rule:* use hosted/BYO inference for reasoning. Resolve a per-user connector credential from
`oshal_connections` only inside an exact deterministic server operation and discard it before any
model call. A mounted CLI OAuth file does not authorize unattended execution, and a bot/CLI must not
resolve, receive, or persist the secret.

**Name the app what it is.**
*Symptom:* "Federal Capture" was a generic, internal-sounding label.
*Cause:* naming for the engine, not the user.
*Rule:* name for the operator's outcome — **"Intelligent Opportunities — Federal."** The display name
is product surface; make it earn its place.

**Match the engine's real field names.**
*Symptom:* the funnel rendered empty.
*Cause:* the surface invented fields (`name`/`fit`/`win`) the engine never emits; the funnel rows
actually use `title`/`score`/`rec`/`stage_label` with `kind='tracked'`.
*Rule:* read the engine's response builder and bind to its **actual** keys; do not assume a schema.

**Reuse a bot; never duplicate an agentId.**
*Symptom:* boot validation failed.
*Cause:* re-declaring `capture-specialist` (already in `federal-capture.yaml`) in a second manifest.
*Rule:* a surface-only app references an existing worker via `chatBot:` and skips `bots[]` + the
registry entry entirely. One identity, one declaration.

**The build is green but the feature is dead — you skipped a compile-time step.**
*Symptom:* the route 404s, or the surface never appears, or "Assess" throws at runtime.
*Cause:* the manifest is hot, but the route mount, the bot endpoint, the profile JSON, and the
`WORKING` allow-list are core-code and were not edited (and an image rebuild was needed).
*Rule:* run the five-step checklist every time, then rebuild + `--force-recreate`. A passing `tsc` is
not a working app.

**Keep user data off the platform.**
*Symptom:* (anti-pattern avoided) one shared CRM database for everyone.
*Cause:* not separating system data from user data.
*Rule:* the shared SAM/job feed is system data on the platform; each operator's `crm.db` + capture
folders live in **their own store** keyed by sub (`GOVCON_STORE_ROOT/{tenant}/{sub}/`). The app saves
to the user, it does not own the user's data.

**Verify in-container files with PowerShell, not the Bash tool.**
*Symptom:* `docker exec ... cat /app/...` returned nothing or the wrong path on Windows.
*Cause:* MSYS rewrites `/app/...` into a Windows path before it reaches the container.
*Rule:* on Windows, inspect container files via PowerShell (`docker exec` from PowerShell), and pass
multi-line commit messages / scripts via files + `docker cp`, not shell here-strings.

---

## New-app checklist

```
Hot (YAML — no rebuild):
[ ] swarm-apps/<app>.yaml — name, displayName, status, scope
[ ] bots[] (or chatBot reusing an existing bot)         + matching persona YAML(s)
[ ] tools[] / toolsDir                                  + persona authorizations (names must match)
[ ] ui.static[] surfaces                                + the native HTML (glass css + theme bridge)
[ ] ticketType + workflow (if it processes tickets)
[ ] schedules[] (execute only with ENABLE_AGENT_SCHEDULER=true)

Compile-time (edit + rebuild) — for a data app:
[ ] mount the route in src/app/server.ts
[ ] register the bot endpoint in swarm-bot-registry-local.ts (+ swarm-bot-registry.ts)  [skip if reused]
[ ] curate the surface into config-seed/profiles/oshal-framework.json
[ ] add the app to the WORKING array in src/pages/applications/index.html
[ ] add scripts/migrations/NNN-<app>.sql (and/or self-heal schema on first call)
[ ] docker build + up -d --force-recreate; MOCK_OIDC=false; pin UI_PROFILE; purge baked JS

Identity:
[ ] agent_id identical across persona + registry + manifest, and collision-free (grep first)

Security boundary:
[ ] hosted/BYO inference or a schema-bounded deterministic server provider intent
[ ] no unattended Cline/Claude Code/Codex/Gemini CLI assumption
[ ] no creds/credentials/OSHAL_CRED_* or .oshal-cred-* model/workspace carrier
[ ] connector credential consumed only inside an exact server operation; result normalized/redacted
```
