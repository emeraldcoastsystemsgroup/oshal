# ADR-085 — Every app is a hot-loadable package: git-installed apps, an App + Tool registry, and dependency-aware uninstall (nothing baked into the swarm)

- **Status:** Accepted — **BUILT + LIVE-PROVEN 2026-07-10** (tags `appstore-v0.1.0` → `v0.5.0`).
  Everything this ADR decides is running: the store repo
  (`github.com/emeraldcoastsystemsgroup/oshal-applications`) with `little-monsters` (the full
  carve-out — core ships without it) + `hello-oshal` + `BUILDING-EXTENSIONS.md`; the `oshal-app`
  CLI (init/validate/build/install/uninstall); dynamic route mounting + `@/` runtime resolution;
  the package migration runner (`app_package_migrations`, idempotent); npm-style dependency
  resolution (fail-closed, provenance-stamped); schedule teardown on deactivate (the P0);
  dependency-aware uninstall (impact/409/orphans-never-cascade); the generic per-user
  dynamic-tool visibility hook; package-bundled cockpit skins. Flags
  `APP_PACKAGE_DYNAMIC_ROUTES` / `APP_PACKAGE_MIGRATIONS` default OFF (local api opts in).
  **Follow-on work:** converting the remaining ~39 baked-in apps is planned (not executed) in
  [docs/apps/swarm-store-migration-plan.md](../apps/swarm-store-migration-plan.md) — incl. the
  Wave-0 bot-container-model decision (D1, needs its own ADR) and six proposed kernel-resident
  apps awaiting operator sign-off.
- **Date:** 2026-07-09 (accepted 2026-07-10)
- **Author:** maintainer@emeraldcoastsystemsgroup.com
- **Related:**
  [ADR (2026-04-20) swarm application manifests](033b-swarm-application-manifests.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-039 (bot-driven workflow authoring)](039-bot-driven-workflow-authoring.md),
  [ADR-049 (OSHAL as aggregation platform)](049-oshal-as-aggregation-platform.md),
  [ADR-067 (connector marketplace + dynamic tool loading)](067-connector-marketplace-and-dynamic-tool-loading.md)

---

## Context

### The real problem: apps are embedded in the swarm, not packaged

An OSHAL "application" is supposed to be a hot-loadable unit. In practice **every app is smeared
across the monorepo and baked into the image** — the manifest is only a pointer to pieces that
live somewhere else. There is **no single artifact you can hand to the loader that IS the app.**

`little-monsters` — one app — proves it. Its pieces live in **six** top-level locations:

| Piece | Where it actually lives today |
|---|---|
| Manifest | `swarm-apps/little-monsters.yaml` |
| Personas (6 bots) | `ai-lab/bot-personas/*.yaml` |
| **Routes (11 files)** | `src/app/routes/education-*.ts` — **compiled into the image, hard-mounted in `server.ts`** |
| Tools + shared CSS | `any-bot/server/services/tools/education/` |
| Migrations | `scripts/migrations/019-…`, `020-…`, `026-education-identity.sql` |
| Theme | `src/pages/cockpit/css/themes/little-monsters.css` |

You cannot download the swarm and "install little-monsters from a store," because little-monsters
*is* the swarm — its code is welded into core. That is the gap this ADR closes.

### What already works, and the two fields that are ignored

The loader is real: `SwarmAppService.autoLoadAll()` hot-loads manifests from `swarm-apps/`
(in-repo) and `$CLINE_WORKSPACE_ROOT/deployed-apps/` (writable), activating bots, tools, UI
surfaces, a workflow, and schedules
([swarm-app-service.ts:584](../../src/features/swarm-apps/services/swarm-app-service.ts#L584)).
There's a full lifecycle API (`load`/`toggle`/`unload`/`export`/`import`/`publish`/`clone`).

But the manifest's two most important portability fields are **declared and ignored**:

- **`routes:`** — informational only; routers are hard-mounted in `server.ts`. gov-contracting.yaml
  says so in the file: *"the loader does not yet mount from manifests."* **This is the single
  reason a route-having app can't be a package.**
- **`migrations:`** — never applied by the loader; migrations live in `scripts/migrations/`.

Making the loader **honor these two fields** is the whole unlock.

### The distribution goal

Apps are authored in **their own git repos** and installed **from a store** into a swarm that
ships **empty of apps**. `swarm-apps/` in this repo stops being where apps live and becomes a
*publishing source*. Adding an app is a git install; the app is one self-contained folder.

ADR-067 already built and validated the git-subdir marketplace pattern (`source: {url,path,ref,
sha}` + install/discover + audit gate) for connectors; this ADR applies it to whole apps.

### The base swarm is a kernel; apps install on top (what must NOT be ripped)

Carving apps out does **not** mean gutting the swarm. There is a mandatory kernel that ships in
the image and can never be an app — the swarm can't boot without it — and apps install on top of
it. Three tiers:

| Tier | What's in it | Packaged / rippable? |
|---|---|---|
| **0 — Base Swarm (kernel)** | Ticket/queue system + `WorkflowPipelineRegistry`; the **app loader + App/Tool registries** (the installer cannot itself be an installable app); auth/OIDC; the connector broker; storage; the cockpit shell; RAG/Redis mesh/Postgres wiring; and the **baseline bots** — `project-manager` (`a0000000-…-000000000001`, the controller self-agent the loader force-keeps active), `queue-bot`, and `general-bot` (`…099`, the routing fallback). This is "it can't live without it." | **Never.** In the image. |
| **1 — APM / monitoring** | A monitor **baked into the bot image / bot-node** so every bot self-reports health/cost/latency, and the loader **auto-registers every app it activates** with it. Not opt-in, not per-app — infra that wraps every load (the k8s-DaemonSet/sidecar pattern). It is also the control that would have caught the runaway-schedule "$90". | **No** — baseline infra, auto-covers all apps. |
| **2 — Apps (packages)** | `little-monsters`, `presentations`, `trading`, `world`, `gov-contracting`, … | **Yes** — git-installed, dependency-resolved, rippable. |

An app **uses** the kernel (e.g. declares a `ticketType` to ride the queue) but never **owns** or
removes it. "Install an app" and "the swarm still boots with zero apps installed" are both true.

---

## Decision

### 1. A package is the complete, self-contained app

An app package is a git repo (or subdirectory) that contains **everything**, referenced relative
to the package — never `ai-lab/`, `src/`, `any-bot/`, or `scripts/`:

```
little-monsters/                 # its own repo / subdir — this IS the app
  oshal-app.yaml                 # manifest (superset below)
  personas/*.yaml                # the bots
  routes/*.js                    # COMPILED JS the loader mounts dynamically (see §2)
  tools/                         # api / cli / connector tool specs
  ui/*.html + ui/*.css           # surfaces + theme override
  migrations/*.sql               # applied by the loader on install
  kb/                            # optional RAG corpus
  README.md
```

**Manifest superset** (all additions optional, back-compatible with today's `SwarmAppManifest`):

| Field | Meaning |
|---|---|
| `source` | Provenance stamped at install: `{ type:'git-subdir', url, path, ref, sha }` (ADR-067 shape). |
| `theme` | Chosen from the existing `COCKPIT_THEMES` skins, or a bundled `ui/*.css`. |
| `toolbar` | Ribbon/toolbar config (today's `ribbon` + `ui.static`). |
| `settings` | App-scoped settings schema + defaults, surfaced in a per-app settings panel. |
| `provides.tools[]` | **New** tools this app contributes to the Tool Registry. |
| `uses.tools[]` | **Existing** tools it depends on, by registry id. |
| `dependencies` | `{ apps:[name@range], tools:[id], connectors:[id] }` — drives resolution (§3) and reverse-dep uninstall (§5). |
| `routes[]`, `migrations[]` | **Now honored by the loader** (§2), pointing at the package's own `routes/*.js` and `migrations/*.sql`. |
| `bots`, `workflow`, `ticketType`, `schedules` | As today — a package brings its own bots, workflow, ticket type. |

### 2. The loader honors `routes` and `migrations` — in-process dynamic mount

This is the core mechanism that makes a route-having app (little-monsters) installable with
**nothing compiled into the swarm**:

- **Routes → in-process dynamic mount.** On activate, the loader `require()`s each
  `routes/*.js` **bundled in the package** and mounts it at the manifest's `mountPath` (wrapping
  with `requiresAuth` per the manifest). On toggle-off/uninstall it unmounts. The `routes:` block
  finally does what it declares — no `server.ts` edit, no image rebuild. (This is the operator's
  own installed app running in the operator's own process; untrusted third-party packages are
  gated by the audit/quarantine step in §3, with the sidecar-node model in Consequences as the
  hardening path.)
- **Migrations → applied on install.** The loader runs the package's `migrations/*.sql`
  idempotently and records them in a per-app applied-migrations table, so an install brings its
  own schema instead of it living in `scripts/migrations/`.

### 3. Install is easy: automatic, forward-dependency-resolving ("bake it in")

New operator-gated `POST /api/swarm/apps/install-remote { source | name }`:

1. **Fetch** the git-subdir at the pinned `sha` into `deployed-apps/<name>/` — the writable dir
   the loader already auto-loads, so hot-load + boot-persistence are free.
2. **Audit + quarantine** through the existing connector audit gate (ClawHub supply-chain lesson).
3. **Forward-resolve dependencies** from `dependencies` — install/enable missing `apps`, verify
   `tools`/`connectors`, and **increment a ref-count** on each satisfied dependency. Fail closed on
   a missing hard dep.
4. **Activate:** dynamic-mount routes (§2), apply migrations (§2), register bots/tools/UI/workflow.
   No core change, no rebuild.

Adding an app is one call and it "just works" — the graph pulls in what it needs.

### 4. Two registries hold the dependency graph

- **App Registry** — extend the `swarm_applications` table (today's *installed* set) with an
  *available-apps catalog* (a remote `marketplace.json` of git-subdir sources) and the
  **inter-app dependency graph** with ref-counts.
- **Tool Registry** — extend the existing `tool-registry-service` so a package **`provides`** tools
  (namespaced by app) and **`uses`** existing ones by id; a `uses` that resolves to nothing fails
  the install. Tools carry ref-counts too.

### 5. Uninstall is hard: manual, dependency-aware, never auto-cascading

Removal is the opposite of install — it is **user-driven and blocked on a reverse-dependency
check**, because a shared dependency removed out from under another installed app breaks it (e.g.
uninstalling the market-intelligence/`world` app while the `trading` app still depends on its feed
→ trading starts throwing errors). The rules:

1. **Reverse-dependency check first.** Before removing app X, compute every installed app that
   depends on X or on tools/connectors X provides. If any exist, surface them:
   *"`trading` depends on `world` — removing it will break `trading`."* Do not proceed silently.
2. **Impact list + component picker.** Present what removing X *would* touch: X's own bots/routes/
   UI/tools/migrations, plus any **now-orphaned** shared dependencies (ref-count would reach 0).
   The user **selects** which components to actually remove.
3. **Protect shared deps.** A dependency still referenced by another installed app (ref-count > 0
   after decrement) is **not** offered for removal — only true orphans are.
4. **Never cascade automatically.** Uninstall removes exactly what the user selected; it decrements
   ref-counts and unmounts routes, deregisters UI/tools/bots, **tears down schedules**, and drops
   the app's migrations only on explicit opt-in (data-loss gate).

Schedule teardown belongs here specifically: `deactivate()` today has no counterpart to
`registerManifestSchedules()`, so a toggled-off app's polls keep running (and billing). Uninstall
and toggle-off must both stop an app's recurring work completely.

### 6. APM/monitoring is baseline infra — every app load is auto-covered

Monitoring is **Tier 1 kernel infra, not an app**. A monitor is baked into the bot image / bot-node
so every bot self-reports; the loader hooks every `activate()` to **auto-register the app's bots,
routes, and schedules** with APM — coverage is automatic on install, never opt-in per app. This is
also the standing guardrail against the runaway-schedule class of cost bug: an app whose poll
fan-out spikes is visible (and cap-enforceable) the moment it loads, not after a $90 bill.

### 7. Shared dependencies are ref-counted external packages, never bundled copies

A capability many apps need — e.g. deck generation from the **`presentations`** app, or the
market-intelligence feed from **`world`** — is its own installed package that dependents reference,
not a copy vendored into each app. `little-monsters` generating decks declares
`dependencies: { apps: [presentations] }` (or `uses.tools: [generate_pptx]`); the registry
ref-counts it so it installs once, is shared, and is protected from removal while any dependent
remains (§5). "It's external" is the correct read — that is what a dependency is.

---

## Consequences

- **Every app becomes a real package — including little-monsters.** The swarm ships empty of apps;
  `swarm-apps/` becomes a publishing source, not the place apps live; `deployed-apps/` is where
  installed packages sit. "Download the swarm, install little-monsters from the store" is literally
  true.
- **The two ignored manifest fields become the product.** Honoring `routes:` (dynamic mount) and
  `migrations:` (apply-on-install) is what lets a route-and-schema app be a package at all. Small
  loader change, large capability.
- **Install/uninstall asymmetry is by design.** Adds are automatic and cheap; removes require a
  human because dependency graphs make automatic removal unsafe. This matches every real package
  manager (apt/npm reverse-dependency + orphan checks).
- **Security posture.** Dynamic in-process route mounting runs installed-app code inside core — safe
  for the operator's own/audited apps behind the audit+quarantine gate; the **sidecar-node model**
  (an app as its own container, ADR-036 "the bot owns its domain," like gov-contracting's engine)
  is the hardening path for untrusted third-party packages and is the natural next tier, not the
  MVP.
- **Migration risk.** Dropping a package's migrations can destroy user data; uninstall keeps schema
  by default and requires an explicit opt-in to drop it.

---

## Implementation phasing (design; status Proposed)

Carve-out is **strangler-fig**: the working code stays until the packaged version is proven, so a
bootable swarm exists at every step.

- **P0 — earmark a fallback (done/ongoing).** Tag a known-good baseline before any rip
  (`baseline-pre-appstore-2026-07-09`, pushed) and pin the matching image
  (`oshal-bot:baseline-pre-appstore`). Rollback = checkout the tag or redeploy that image. Every
  later phase keeps its predecessor working behind a flag until the new path is verified.
- **P1 — the unlock.** Make the loader honor `routes:` (in-process dynamic import + mount/unmount
  of a package's compiled JS) and `migrations:` (idempotent apply + per-app tracking), **behind a
  feature flag** — the hard-mounts in `server.ts` remain the fallback. Nothing else is a package
  until this lands.
- **P2 — the proof: extract little-monsters.** Package it (personas + compiled routes + tools +
  migrations + theme bundled) and run it in **packaged mode behind a per-app switch**
  (`APP_LM_MODE=packaged|builtin`) alongside the still-present hard-mount. Verify end-to-end in a
  browser (human-testability gate). **Only after packaged-LM is proven** delete the hard-mounted
  `education-*.ts` and move its migrations — deletion is the last step, reversible via P0 until
  then. If little-monsters installs clean, the format is validated on the hardest real case.
- **APM baseline (parallel).** Bake the monitor into the bot image and auto-register apps on
  `activate()` — Tier 1 must cover the first packaged app, not trail it.
- **P3 — registries + dependency graph.** App + Tool registry catalog dimension, `provides`/`uses`
  resolution, ref-counting, `install-remote` git-subdir fetch + audit gate.
- **P4 — uninstall UX.** Reverse-dependency impact list + component picker + orphan detection; the
  cockpit "Apps" store/Discover surface (reuse the ADR-067 connector Discover shape); a
  `create-oshal-app` template repo.

---

## Files (anticipated)

**Extend:**
- `src/features/swarm-apps/services/swarm-app-loader.ts` / `swarm-app-service.ts` — dynamic route
  mount/unmount; migration apply/track; forward-dep resolution + ref-counting; reverse-dep check on
  uninstall; schedule teardown in `deactivate()`.
- `src/features/swarm-apps/types.ts` — manifest superset (`source`, `settings`, `provides`, `uses`,
  `dependencies`).
- `src/app/routes/swarm-app-routes.ts` — `install-remote`; catalog listing; uninstall impact endpoint.
- `src/features/tool-registry/services/tool-registry-service.ts` — `provides`/`uses` + ref-counts.

**Create:**
- The git-subdir fetcher (shallow-clone-at-sha into `deployed-apps/`).
- The package validator — **built:** [`scripts/oshal-app.js`](../../scripts/oshal-app.js) (`validate`
  enforces self-containment: no in-repo path refs; bundled files present; `routes/*.js` warned when
  not yet compiled; `agentId` unique within the package; deps well-formed; theme is a known skin.
  `init` scaffolds a new package). Doubles as a store-repo CI gate. **A package may not declare an
  `agentId` owned by another installed app** — bot upserts clobber `base_capabilities` whole-array,
  so re-declaring another app's bot lets load order decide its identity.
- Author guide: [docs/apps/authoring-app-packages.md](../apps/authoring-app-packages.md).
- The remote `marketplace.json` schema + the reference store repo `oshal-applications` (built:
  first package `little-monsters/`, declarative parts).
- `little-monsters` as the first standalone package repo (the P2 proof).
- The remote `marketplace.json` schema + an example apps repo.
