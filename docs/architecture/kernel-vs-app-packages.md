# OSHAL kernel vs. app packages: what is core and what an app declares

**Audience:** engineers and AI agents extending OSHAL — anyone writing a
`swarm-apps/*.yaml` (or store-repo `oshal-app.yaml`) manifest, adding a bot, or
touching the compose stack.

**Why this exists:** a recurring drift keeps trying to treat the core databases,
the queue, or the default bots as if an *app* were responsible for them — or to
invent a stripped-down "minimal" swarm that boots without part of the kernel.
Both are wrong, and this document is the canonical answer so that class of
mistake cannot recur. Read this alongside
[ADR-085](../adr/085-remote-app-packages-and-registries.md) (the 3-tier package
model), [ADR-036](../adr/036-bot-owned-application-architecture.md) (the bot owns
its domain, the surface is a view), and
[ADR-038](../adr/038-swarms-bundled-by-type.md) (an app is a category bundle).

---

## 1. The one rule

> **The swarm is always the full kernel. Apps install *on top* of it and declare
> only their own additions plus their cross-app dependencies. An app never
> declares — and never removes — a database, the queue, the connector broker,
> auth, storage, the cockpit shell, or a baseline bot.**

Three corollaries that follow directly and are not negotiable:

- **There is no "minimal" or "stripped" swarm *today*.** A bare `docker compose up` on
  [docker-compose.oshal-local.yml](../../docker-compose.oshal-local.yml) brings up
  28 always-on containers (4 databases + Redis + Vault + code-server + the
  diarization sidecar + the controller/API + 19 bot-nodes). Careful, though:
  **always-on ≠ kernel.** Most of those bot-nodes are *app* bots that stay baked
  into the monolith compose only as the ADR-093 D1 interim — §2e says which is
  which. Profiles (`build`, `incident`, `extras`, `local-llm`, `social-media`,
  `tunnel`) only **add** opt-in specialist containers; they never
  subtract from the base. A leaner *boot* (platform + kernel skills + the
  baseline bots + the kernel-resident apps) is the swarm-store migration's
  unfinished Definition of Done — the lean-baseline installer in
  [swarm-store-migration-plan.md](../apps/swarm-store-migration-plan.md) — but a
  smaller kernel *contract* is a misreading of the tier model: apps never
  subtract from it (§2).
- **An app *uses* the kernel; it never *owns* it.** Riding the queue means
  declaring a `ticketType` and a `workflow` — not shipping a queue. Needing a
  table means shipping your own `migrations/*.sql` — not owning Postgres. Needing
  a graph means calling `/api/graph` — not standing up ArangoDB.
- **The installer is not an installable app.** The app loader, the App Registry,
  and the Tool Registry are Tier-0 kernel; nothing an app declares can replace or
  remove them (ADR-085: *"Never. In the image."*).

---

## 2. Tier 0 — the kernel (always present, never declared, never ripped)

Tier 0 is *"it can't live without it."* Every service below starts on a plain
`docker compose up` because **none of them carry a `profiles:` key**. They are
not app dependencies; they are the ground every app stands on. **An app manifest
must never list any of these as something it provides, requires, installs, or can
remove.**

Source of truth: the always-on services in
[docker-compose.oshal-local.yml](../../docker-compose.oshal-local.yml), verified
by enumeration (47 total service keys − 19 profiled = **28 always-on**). One
caveat for §2e: *always-on* is a fact about the current monolith compose, not a
kernel-membership claim — the authoritative kernel line is
[swarm-store-migration-plan.md §2](../apps/swarm-store-migration-plan.md).

### 2a. Data plane — databases (relational, time-series, vector/RAG, graph)

| Service | Container | Role | What it holds |
|---|---|---|---|
| `oshal-db` | `oshal-local-db` | Relational (Postgres, pgvector/pg16) | Tickets, agents, work items, `chat_tasks` (canonical per-call cost); also the `RAG_ENGINE=pgvector` store |
| `oshal-tsdb` | `oshal-local-tsdb` | Time-series (TimescaleDB) | World / sentiment / market series + personal metrics, isolated from ticket writes |
| `oshal-chromadb` | `oshal-local-chromadb` | Vector store (RAG) | RAG corpus (`infra-runbooks`) and swarm memory |
| `oshal-arangodb` | `oshal-local-arangodb` | Graph engine ([ADR-045](../adr/045-two-tier-graph-database-and-connector.md)) | Per-person and per-tenant graphs, each an isolated database |

### 2b. Queue / mesh backbone

| Service | Container | Role | What it does |
|---|---|---|---|
| `oshal-redis` | `oshal-local-redis` | Queue + mesh backbone | Redis Streams — envelope `XADD`/`XREADGROUP`, agent heartbeats. This is the swarm's queue; apps ride it via `ticketType`, they never ship it |

### 2c. Infra services

| Service | Container | Role | What it does |
|---|---|---|---|
| `oshal-vault` | `oshal-local-vault` | Secrets (Vault dev-mode, KV v2) | Credential source for the DevOps/Vault app ([ADR-040](../adr/040-devops-vault-swarm.md)); the app *reads* Vault, it does not *own* it |
| `code-server` | `oshal-local-code-server` | Workspace browser | code-server over the shared `oshal_workspace` volume (127.0.0.1:8444) |
| `speaker-diarization` | `oshal-local-speaker-diarization` | Diarization sidecar ([ADR-084](../adr/084-deterministic-speaker-diarization-and-voice-profiles.md)) | Deterministic local speaker-diarization, hardened/read-only, audio only from `oshal-api` |

### 2d. Controller / API

| Service | Container | Role | What it does |
|---|---|---|---|
| `oshal-api` | `oshal-local-api` | Swarm controller (`BOT_RUNTIME=swarm`) | Cockpit, API, queue manager, migrations, phase routing; carries the `project-manager` identity. **Never calls an LLM.** |

### 2e. Always-on bot-nodes (three kinds of membership — most are NOT kernel)

Nineteen `codex` bot-nodes carry no `profiles:` key, so all nineteen boot on a
plain `compose up`. **That is a deployment fact, not a kernel claim.** By the
authoritative kernel line
([swarm-store-migration-plan.md §2](../apps/swarm-store-migration-plan.md)) they
split three ways:

- **Kernel — Tier-0 baseline identity:** `general-bot`, the ADR-083 routing
  fallback (alongside the `project-manager` identity carried by `oshal-api`
  itself, §2d, and the profiled `queue-bot` identity, §2g).
- **Kernel-resident apps' bots:** `jarvis-bot` (jarvis) and `oshal-developer`
  (oshal-dev) — their apps are among the ten `swarm-apps/` kernel manifests.
- **Carved apps' bots, baked in ONLY as the ADR-093 D1 interim:** everything
  else in the table below. Their applications live in the store repo
  (`oshal-applications`, ADR-085); the bot containers remain in the monolith
  compose solely because the lean-baseline installer does not exist yet. They
  are **app bots** whose eventual home is their package — calling them kernel
  was this doc's error before 2026-07-23.

The operational rule is the same for all three kinds: **an app brings its *own*
bots (see §3); it does not depend on, re-declare, or claim the agentId of any
bot already in this table.**

| Bot-node | Container | Domain |
|---|---|---|
| `weather-bot` | `oshal-local-weather-bot` | NWS current-condition / forecast specialist |
| `email-bot` | `oshal-local-email-bot` | Communications: owns Gmail + Calendar, shells `scripts/oshal-gmail.js` |
| `oshal-developer` | `oshal-local-oshal-developer` | Platform-dev ([ADR-081](../adr/081-oshal-developer-bot-and-idle-timeouts.md)); owns `ticketType oshal-dev`, works in `/app/dev-repo` |
| `jarvis-bot` | `oshal-local-jarvis-bot` | `oshal-assistant` "Jarvis" front door — classify / delegate / synthesize with an agentic tool loop |
| `eats-bot` | `oshal-local-eats-bot` | eats-concierge — Uber Eats via `scripts/oshal-uber.js` |
| `rides-bot` | `oshal-local-rides-bot` | rides-concierge — Uber Rides via `scripts/oshal-uber-rides.js` |
| `shopping-bot` | `oshal-local-shopping-bot` | shopping-concierge — Walmart via `scripts/oshal-walmart.js` (ADR-083 own-node) |
| `spotify-bot` | `oshal-local-spotify-bot` | spotify-concierge — Spotify Web API |
| `travel-bot` | `oshal-local-travel-bot` | travel-concierge — Duffel flights / hotels / cars ([ADR-059](../adr/059-travel-booking-concierge.md)) |
| `movies-bot` | `oshal-local-movies-bot` | movies-concierge — TMDB discovery + where-to-watch |
| `social-writer-bot` | `oshal-local-social-writer-bot` | social-writer — post drafting / voice-matching (LinkedIn / X / Facebook Pages) |
| `storage-bot` | `oshal-local-storage-bot` | storage-assistant — storage-target config, GitHub repo create, backend routing |
| `deck-builder-bot` | `oshal-local-deck-builder-bot` | deck-builder — presentation outlines / slide structure |
| `finance-bot` | `oshal-local-finance-bot` | finance-analyst — Plaid brief / net-worth / cashflow via `scripts/oshal-plaid.js` |
| `trading-bot` | `oshal-local-trading-bot` | trading-analyst — market-signal analysis + trade decisions (ADR-052/053) |
| `identity-bot` | `oshal-local-identity-bot` | identity-advisor — Identity Hub connection-inventory / access-health |
| `general-bot` | `oshal-local-general-bot` | ADR-083 low-confidence fallback / general doer (`everything-default.yaml`) |
| `home-bot` | `oshal-local-home-bot` | SmartThings device / scene control via `scripts/oshal-smartthings.js`; owns the per-user home store |
| `cloud-ops-bot` | `oshal-local-cloud-ops-bot` | GCP inventory / compute / IAM / cost audit via `scripts/oshal-gcp.js` |

### 2f. Profiled opt-in services add, they never subtract

The remaining 19 services in the compose file carry a `profiles:` key and start
**only** when their profile is explicitly requested. These are additive
specialist tiers, not a way to make the kernel smaller:

- `build` → `code-developer`, `code-reviewer`, `documentation-writer`,
  `test-engineer`, `system-architect`, `oshal-task-manager`, `queue-bot`
- `incident` → `oshal-task-manager`, `queue-bot`, `self-healing-bot`,
  `rca-specialist`, `incident-response-bot`, `incident-remediation-bot`
- `extras` → `devops-bot`, `self-healing-bot`, `research-bot`, `tester-bot`
- `local-llm` → `oshal-ollama`, `oshal-ollama-pull`
- `social-media` → `facebook-bot`
- `tunnel` → `cloudflared`

`self-healing-bot` (the only worker with the Docker socket) is the sole
container that can restart unhealthy containers. Requesting a profile is how you
*grow* a swarm for a job (a build run, an incident); it is never how you carve
the base down.

### 2g. The baseline bot identities

ADR-085 names three **baseline bots** that are Tier-0 routing/control identities,
not apps:

- `project-manager` (`a0000000-…-000000000001`) — the controller self-agent the
  loader force-keeps active; it *is* `oshal-api`, always up.
- `general-bot` (`…099`) — the routing fallback; its own always-on container.
- `queue-bot` — the cross-workflow reviewer identity. (Note: in local compose,
  `queue-bot`'s container is **profiled** under `build`/`incident`, so it is not
  default-on — but its identity is still a baseline one an app must never claim.)

An app must never declare any of these agentIds, and never an agentId owned by
another installed app.

---

## 3. Tier 2 — what an app package declares

An app (Tier 2) is a self-contained git repo/subdir bundling a manifest
(`oshal-app.yaml`) + personas + compiled `routes/*.js` + tools + UI +
`migrations/*.sql` + optional KB. Per [ADR-038](../adr/038-swarms-bundled-by-type.md)
it is a *category bundle* of {connectors per provider + provider CLIs + bot(s) +
cockpit surface}; per [ADR-036](../adr/036-bot-owned-application-architecture.md)
the bot owns its domain and the surface is a view over the bot's store. Tier 2 is
the only rippable tier: install is automatic and dependency-resolving, uninstall
is manual and reverse-dependency-checked.

### 3a. Manifest fields an app declares (its own additions only)

**Identity & catalog**

- `name` (**required**, slug `^[a-z0-9][a-z0-9-]{1,63}$`), `displayName`
  (**required**), `description`, `version` (semver; validator *warns* if missing)
- `status` (`active` | `inactive`), `scope` (`person` | `tenant` | `public` |
  `operator`; default `public`)
- `suite` ([ADR-097](../adr/097-app-suites-primary-categorization.md)) — the app's
  **one** primary catalog shelf (`ai-productivity` | `ai-knowledge` | `ai-finance`
  | `ai-creative` | `ai-home` | `ai-engineering` | `platform`). Grouping metadata
  only; never re-bundle packages by suite.
- `source` (`{type:'git-subdir', url, path, ref}`) — installer-stamped
  provenance, informational only

**The bots and tools it brings**

- `bots[]` — the app brings its **own** bots (`agentId`, `name`, `harnessType?`,
  `apiType?`, `persona?`, `role?`, `capabilities?`, `selectorDescriptor?`,
  `routingKeywords?`, `accessRoles?`)
- `foundation` (`{persona}`)
- `toolsDir` (dir of the app's compiled JS tools) + `tools[]` — the **new** tools
  this app *provides* to the Tool Registry

**UI & surface**

- `ui { static[], dynamic (per-user visibility endpoint/pattern), assistant
  (ADR-085 D9 floating bubble, same-origin iframe only) }`
- `surface` (`ops[]` — surface-bridge op allow-list, **fail-closed**; absent = the
  relay carries nothing)
- `theme` (a known `COCKPIT_THEMES` skin id or a bundled `ui/*.css`), `sharedCss`,
  `ribbon` (`focused`, `hideFrameworkItems`, `defaultView`, `hideChatPanel`,
  `hideAssistant`, `hideStatusBar` — the three `hide*` flags drop cockpit chrome
  while the app is focused: the right-rail chat panel, the global assistant orb,
  and the bottom bots/tickets/cost/queue status bar; each is off by default and
  restored automatically when a plain cockpit loads)

**Routes, data & how it rides the kernel queue**

- `routes[]` (`module`, `factory`, `mountPath`, `auth?`, `requiresAuth?`) — points
  at the package's **own** `routes/*.js`, dynamically mounted
- `migrations[]` — paths to the package's **own** `migrations/*.sql`, applied
  idempotently on install (this is how an app gets tables — *not* by owning
  Postgres)
- `ragCollections[]` — glob prefixes of the RAG collections **this app** owns
  (deleted only under a `dropData` opt-in)
- `ticketType` — how the app rides the kernel queue
- `workflow` (`name`, `pipeline`, `workerBot`, `reviewerBot?`, `phases?`,
  `maxRevisions?`, `stages?`, `processDefinition?`, `autoStart?`)
- `schedules[]` (`id`, `cron`, `prompt`, `targetAgent?`, `scope?`,
  `requiresConnection?`, `description?`, `enabled?`) — the app's default polls
- `chatBot` (explicit right-rail advisor bot)

**Dependencies, skills & policy**

- `dependencies { apps[], tools[], connectors[] }` (see §3b). Note
  `dependencies.connectors` **doubles** as the app's runtime connector allow-list
  (present = only those providers may be offered; `[]` = none; absent =
  unfiltered).
- `uses[]` — **kernel skill** ids (see §3c)
- `skillProfiles` — the app's domain *patterns* for profileable bot capabilities
  (`Partial<Record<SkillCapabilityId, SkillProfile>>`, resolved controller-side
  into the bot prompt — not kernel modules, so **not** `uses:`)
- `guestTier` (`full` | `readonly` | `blocked`) — a **request, not a grant**; does
  nothing until an operator approves it
- `settings` — appears in the ADR-085 §1 superset table and the `init` scaffold
  (`settings: {schema:{}}`) but is **not** yet modeled on the `SwarmAppManifest`
  TS interface. Scaffolded/documented, not yet typed.

**Validator note.** The JS CLI ([scripts/oshal-app.js](../../scripts/oshal-app.js))
hard-requires only `name` (slug) + `displayName`; missing `suite`/`version`/`source`
only *warn*. It shape-checks (`dependencies.{apps,tools,connectors}` must each be
arrays; `agentId`s present + unique within the package; no path field escaping the
package) and deliberately does **not** re-list enums. All fail-closed *value*
checks — the `suite` enum, route auth mode, bot `accessRoles`, `guestTier`, and the
`uses[]` skill ids — are server-side in `readManifest` (+ CI), so there is a single
non-drifting source of truth.

### 3b. What an app must NOT declare

Anything in Tier 0/Tier 1 is off-limits. Concretely, a manifest must never
declare, provide, require, or remove:

- The Tier-0 kernel ticket/queue system + `WorkflowPipelineRegistry` (ride via
  `ticketType`; never own or remove it)
- The app loader + App Registry + Tool Registry (the installer cannot be an
  installable app)
- Auth / OIDC; the connector broker; storage; the cockpit shell
- RAG / Redis-mesh / Postgres **core** wiring — bring your **own**
  `migrations`, never own the core databases or infra
- The baseline bots — `project-manager` (`a0000000-…-000000000001`), `queue-bot`,
  `general-bot` (`…099`) — and never an `agentId` owned by another installed app
- Tier-1 APM / monitoring (baseline infra, auto-covers every app — see §5)
- Paths into framework dirs `src/`, `ai-lab/`, `any-bot/`, `scripts/`,
  `config-seed/`, `swarm-apps/` (self-containment), and no absolute or
  `../`-traversal paths in any path field
- A **kernel skill** (e.g. `presentations`/deck-generation) under
  `dependencies.apps` — that belongs in `uses: [deck-generation]` (see §3c/§4)

### 3c. Cross-app dependencies (`dependencies.apps[]`) vs kernel skills (`uses[]`)

These two mechanisms look similar and are opposites. Getting them confused is the
single most common manifest error (§4).

**`dependencies.apps[]` — a Tier-2 package you depend on, ref-counted.**
Another *installable* app owns a capability you consume (its route, its surface,
its bot). Mechanics ([ADR-085](../adr/085-remote-app-packages-and-registries.md)
§3/§5/§7):

- **Install = forward resolution, fail-closed** (`resolveDependencies` in
  `oshal-app.js`). Each dep must resolve to one of: already installed in the
  deploy dir, framework-shipped (`swarm-apps/<dep>.yaml` → `core`), or installable
  from the same store (installed **recursively**). Anything unresolvable **fails
  closed** — nothing is partially enabled. A `seen` set breaks cycles; the
  resolution map is stamped into `.oshal-install.json`. The registry **increments
  a ref-count** on each satisfied dependency.
- **Uninstall = the asymmetric opposite** (`uninstallPackage`, §5): a
  **reverse-dependency** check runs first — if any installed app depends on X,
  removal is **blocked** unless `--force`. Now-orphaned deps (ref-count would reach
  0) are **reported but never auto-removed**; shared deps still referenced
  (ref-count > 0 after decrement) are **protected** and not offered. Nothing ever
  cascades automatically. Schema is kept by default (`migrations/uninstall.sql`
  runs only on explicit opt-in).
- **Shared capabilities** (§7) are ref-counted **external** packages installed
  **once** and shared — never a bundled copy vendored into each dependent.
  Worked hazard: uninstalling `world` while `trading` still depends on its feed
  would leave `trading` throwing errors, so the reverse-dep check blocks it.

**`uses[]` — a kernel skill you import, never installable.**
A **kernel skill** ([ADR-090](../adr/090-skills-as-first-class-packages.md) D8;
`@/shared/kernel-skills` — e.g. `deck-generation`, `rag`, `voice`) is a shared
capability the kernel **always** provides. It is fundamentally **not an app**: it
never installs, never ref-counts, and can never be uninstalled out from under a
dependent — the exact opposite of `dependencies.apps`. Declaring a skill in
`uses[]` is how a package says *"I import `@/features/<that-module>`"*; the CI
guard [scripts/check-kernel-skills.ts](../../scripts/check-kernel-skills.ts) then
keeps that module in the built image for as long as the skill is declared.
Validation is **fail-closed**: an unknown skill id is a **load-time** error
(server-side `readManifest` against `@/shared/kernel-skills`), not a mount-time
crash. The CLI only shape-checks (`uses` must be a `string[]`) and deliberately
does **not** re-list the ids — no second, drifting source of truth. The validator
specifically **warns** when `presentations` appears under `dependencies.apps`:
deck generation is a kernel *skill*, so it must be `uses: [deck-generation]`.

**Rule of thumb:** if the thing can be *installed and uninstalled*, it's a
`dependencies.apps` package (ref-counted). If it's *always there and can never be
removed*, it's a `uses[]` kernel skill.

---

## 4. Known violations to fix (from the store-manifest scan)

A full scan of the store repo (`c:/Projects/oshal-applications`) checked every
manifest's cross-app API references against who actually owns each route. **One
real under-declaration was found; all other apps declare their dependencies
correctly.**

### `little-monsters` — must add `presentations` to `dependencies.apps`

- **Symptom:** `little-monsters/oshal-app.yaml` declares
  `dependencies.apps: []` (line 93), yet its `ui.static` tile `lm-presentations`
  (line 187) iframes `iframeUrl: /api/presentations/sections/ui`. The manifest is
  **self-contradictory** — line 186's comment still reads *"Provided by the
  presentations dependency (see `dependencies.apps`)"* while the deps array is
  empty (the prior `dependencies.apps: [presentations]` was removed in favor of
  `uses: [deck-generation, …]`).
- **Why the removal was wrong:** `/api/presentations/sections/ui` is **not** the
  kernel `deck-generation` engine — it is the **presentations *package*'s** carved
  surface route (`presentations/oshal-app.yaml` `mountPath /api/presentations/sections`).
  Core confirms it is no longer kernel-mounted: `src/app/server.ts:110`
  *"Unmounted /api/presentations/sections: AI Office carved to the
  oshal-applications store"* (see also `server.ts:1351`, `1365`;
  `routes/index.ts:52,71`). The route that stays core is the bare
  `/api/presentations` Presentron proxy — **not** `/api/presentations/sections`.
- **Fix:** the surviving `lm-presentations` tile genuinely depends on the
  `presentations` *package* being installed. Restore
  `dependencies.apps: [presentations]` so the ref-count protects it — **and keep**
  `uses: [deck-generation]` for the kernel skill. They are different mechanisms
  (§3c): `deck-generation` is the always-present kernel engine; the
  `/sections/ui` surface belongs to the installable package.

Every other scanned manifest is clean. The scan verified that references to
`/api/apply-operator`, `/api/apply/ingest`, `/api/connect/*`,
`/api/linkedin-assistant`, `/api/files`, `/api/voice/*`, and `/utilities` are all
**kernel-resident** routes (correctly *used*, not *declared*), and that
`brand-graphics` / `creative-studio` (both `dependencies.apps: [vids]`) and
`job-apply` (`dependencies.apps: [career-hunter]`) declare their real cross-app
deps properly.

---

## 5. Open decision — the bot-container model (D1)

Tier 1 (APM/monitoring — a monitor baked into the bot image that auto-registers
every app's bots, routes, and schedules on activate) and the tier boundaries
above are **settled**. One design question is **explicitly undecided** and is
called out here so no one asserts a resolution:

- **D1 — the bot-container model needs its own ADR.** ADR-085's status/follow-on
  (lines 13–16) records that the ~39 baked-in apps' conversion is *"planned (not
  executed)"* in
  [docs/apps/swarm-store-migration-plan.md](../apps/swarm-store-migration-plan.md),
  *"incl. the Wave-0 bot-container-model decision (D1, needs its own ADR)."*
  **How an app's bot(s) are containerized / isolated is not yet decided** — do not
  build against a presumed answer.

Related items that are **proposed, not built** (state them as open, do not assert):

- **Six proposed kernel-resident apps** await operator sign-off — which apps, if
  any, get promoted from Tier 2 into the kernel is undecided.
- **Security posture / sidecar-node hardening is the hardening path, not the MVP.**
  Dynamic in-process route mounting runs installed-app code inside core — safe for
  The operator's own/audited apps behind the audit+quarantine gate. The
  sidecar-node model (an app as its own container, ADR-036's *"the bot owns its
  domain,"* like `gov-contracting`'s engine) is the natural next tier for
  untrusted third-party packages, and ties directly to D1.
- **Implementation phasing P1–P4 is design-only** (ADR-085, *"Implementation
  phasing (design; status Proposed)"*): routes/migrations honoring (P1),
  little-monsters extraction (P2), registries + dep graph (P3), uninstall UX (P4)
  sit behind feature flags (`APP_PACKAGE_DYNAMIC_ROUTES` /
  `APP_PACKAGE_MIGRATIONS`, default OFF) with a strangler-fig fallback. Core is
  BUILT + LIVE-PROVEN, but the full ~39-app carve-out is not executed.
- **ADR-038 is itself Status: Proposed** (2026-06-15). Its open dependency:
  privileged swarms (devops/hypervisor) need an ephemeral/isolated runtime +
  credential lifecycle (strong auth, ephemeral login, single-user isolation,
  tmpfs-scrubbed creds) that **does not exist yet** — this must be built **before**
  a privileged swarm goes multi-user, and is the one place the standard connector
  model is insufficient.

---

## 6. How to not drift — checklist

Before you commit a manifest or a compose change, confirm every line:

- [ ] **No database, queue, connector broker, auth, storage, or cockpit shell in
      the manifest.** Need data → ship your own `migrations/*.sql`. Need a graph →
      call `/api/graph`. Need the queue → declare a `ticketType` + `workflow`.
- [ ] **No baseline bot re-declared.** Not `project-manager`
      (`a0000000-…-000000000001`), not `queue-bot`, not `general-bot` (`…099`),
      and not any `agentId` another installed app owns. `agentId`s are unique
      within the package.
- [ ] **`uses[]` vs `dependencies.apps[]` is correct.** Kernel skill
      (always-present, e.g. `deck-generation`/`rag`/`voice`) → `uses[]`. Another
      *installable* package's route/surface/bot → `dependencies.apps[]` (it will
      be ref-counted). Never put a kernel skill under `dependencies.apps` — the
      validator warns, and little-monsters is the cautionary tale (§4).
- [ ] **Every cross-app `iframeUrl` / executor route maps to a declared owner.**
      If a tile points at `/api/<other-app>/…`, that other app is in
      `dependencies.apps`. If it points at a kernel route (`/api/connect`,
      `/api/files`, `/api/voice`, `/utilities`, `/api/apply-operator`, …), it's
      *used*, not declared.
- [ ] **No path escapes the package.** No paths into `src/`, `ai-lab/`,
      `any-bot/`, `scripts/`, `config-seed/`, `swarm-apps/`; no absolute or `../`
      paths in any path field.
- [ ] **Never invent a "minimal" swarm.** A bare `compose up` is the full 28-container
      kernel. Profiles (`build`/`incident`/`extras`/…) *add* specialist bots; they
      never carve the base down. If a task seems to need a smaller kernel, re-read §1.
- [ ] **`suite` is exactly one shelf, chosen by who the app serves** — grouping
      metadata only, never used to re-bundle packages.
- [ ] **`guestTier` and `public`/`requiresAuth:false` routes are requests, not
      grants** — they authorize nothing until an operator approves (guestTier) or
      the router self-guards (public routes).
- [ ] **Run the validator** ([scripts/oshal-app.js](../../scripts/oshal-app.js))
      and let the server-side `readManifest` + CI enforce the fail-closed enum and
      auth-mode checks. Don't hand-maintain a second copy of any enum.

---

**See also:** [ADR-085](../adr/085-remote-app-packages-and-registries.md) (3-tier
package model, ref-counted install/uninstall) ·
[ADR-036](../adr/036-bot-owned-application-architecture.md) (the bot owns its
domain, the surface is a view) ·
[ADR-038](../adr/038-swarms-bundled-by-type.md) (an app is a category bundle) ·
[ADR-090](../adr/090-skills-as-first-class-packages.md) (kernel skills / `uses[]`) ·
[ADR-097](../adr/097-app-suites-primary-categorization.md) (`suite`) ·
[docs/building-a-bot.md](../building-a-bot.md) ·
[docs/build-your-own-swarm-app.md](../build-your-own-swarm-app.md).
