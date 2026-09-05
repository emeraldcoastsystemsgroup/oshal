# Authoring an OSHAL app package

An **app package** is a self-contained folder that a swarm installs from git and hot-loads
— bots, UI, routes, migrations, a theme, and dependencies — with **nothing compiled into the
core image**. This is the developer guide. The architecture is [ADR-085](../adr/085-remote-app-packages-and-registries.md);
this page is how you actually build one.

## Mental model: it's npm, for swarm apps

If you know npm, you know this. The pieces map one-to-one:

| npm | OSHAL app package |
|---|---|
| `package.json` | **`oshal-app.yaml`** — the definition file |
| the package's code | `routes/*.js`, `tools/` |
| npm registry | a **store repo** (e.g. `oshal-applications`) + its `marketplace.json` |
| `node_modules/` | the swarm's `deployed-apps/` |
| `npm install <pkg>` | `POST /api/swarm/apps/install-remote` (+ dependency resolution) |
| node's module loader | the `ManifestRouteMounter` (dynamic in-process mount) |
| `npm publish` | push the package folder to the store repo |

A base swarm ships **empty of apps** — the kernel (ticket system, loader/registries, auth,
baseline bots, APM) is always present; you grow the swarm by installing packages.

## Package layout

```
my-app/
  oshal-app.yaml        # the definition file (required)
  personas/*.yaml       # the app's bots' personas (bundled)
  routes/*.js           # compiled-JS Express routes, mounted in-process (see "Routes")
  fixtures/*.json       # optional static request bodies for installation smokes
  tools/                # bundled tools discovered at load time
  ui/*.html, *.css      # surfaces + optional theme css
  migrations/*.sql      # the app's own schema, applied on install
  kb/                   # optional RAG corpus
  README.md
```

**The one hard rule: self-containment.** Every path in the manifest resolves *inside the
package*. No `src/`, `ai-lab/`, `any-bot/`, no absolute paths, no `../`. `oshal-app validate`
enforces this.

## The definition file (`oshal-app.yaml`)

| Field | Required | What it is |
|---|---|---|
| `name` | ✅ | slug (lowercase, digits, dashes) — the app id |
| `displayName` | ✅ | human name |
| `version` | ✱ | semver |
| `source` | ✱ | provenance: `{type: git-subdir, url, path, ref}` — installer pins `sha` |
| `scope` | | `person` (default owner = installer) / `public` / `tenant` |
| `access` | | platform doorway: `{supported: [deny, viewer, editor, admin], defaultTier, mappings?}` — see below |
| `dependencies` | | `{apps: [], tools: [], connectors: []}` — resolved + ref-counted on install |
| `settings` | | `{schema: {...}}` typed per-app settings |
| `bots` | | `[{agentId, name, persona, role, capabilities}]` — agentIds unique, **not** owned by another app |
| `foundation` | | `{persona}` layered under every bot |
| `toolsDir` | | dir of bundled tools (default `tools/`) |
| `ui.static` / `ui.dynamic` | | ribbon/toolbar surfaces |
| `ribbon` | | cockpit chrome policy while the app is focused: `hideFrameworkItems: []`, `defaultView`, and the opt-in `hideChatPanel` / `hideAssistant` / `hideStatusBar` flags (right-rail chat, global assistant orb, bottom bots/tickets/cost/queue bar). All default to shown; a CRM or trading surface that is not ticket/queue-shaped sets `hideStatusBar: true` |
| `routes` | | `[{module, factory, mountPath, auth, requiresAi?}]` — see below |
| `schedules` | | recurring prompt jobs or confined deterministic service-route handlers — see below |
| `takeout` | | package-owned Google Takeout slice declarations — see below |
| `smoke` | | executable HTTP probes run by the installer — see below |
| `migrations` | | `[path]` — applied idempotently on install |
| `ticketType` + `workflow` | | rides the kernel queue (the app doesn't own the queue) |
| `theme` | | a registered cockpit skin id, or a bundled `ui/*.css` |

## Routes: compiled JS, framework imports by alias

Routes are the only server code a package carries. Rules:

1. **Ship compiled JS** (`routes/*.js`), not TS — the loader `require()`s them in-process.
2. **Keep framework imports as `@/…`** (`require("@/features/...")`). They are *not*
   rewritten to relative paths, so they resolve to the **running framework** wherever the
   package sits on disk. The loader registers `@/` runtime resolution when dynamic routes are
   enabled.
3. A route module exports a factory (`createXRoutes(ctx)`) returning an Express router.
4. `auth` defaults to `oidc`. Declare one of `oidc`, `service-or-oidc`, `service`, `operator`,
   or `public`; use `public` only for an intentionally anonymous route that self-guards.
5. Set `requiresAi: true` when the route necessarily performs inference. A box declaring
   `OSHAL_NO_AI=true` then returns the kernel's canonical HTTP 503 `ai_disabled` response before
   package code executes.

Dynamic mounting is gated by **`APP_PACKAGE_DYNAMIC_ROUTES`** (default off). Off = the loader
never mounts package routes; nothing changes.

## Recurring jobs: prompts or deterministic handlers

A schedule must choose one execution model. The established form dispatches a prompt to an agent:

```yaml
schedules:
  - id: daily-digest
    cron: "0 13 * * *"
    scope: per-user
    requiresConnection: facebook
    targetAgent: b0000000-0000-0000-0000-000000000001
    prompt: Summarize my connected social signals from the last day.
```

A deterministic package worker uses `target: service-route`. It cannot also declare `prompt`,
`targetAgent`, a per-user scope, or connector activation:

```yaml
routes:
  - module: routes/example-worker.js
    factory: createExampleWorkerRoutes
    mountPath: /api/example-worker
    auth: service

schedules:
  - id: policy-tick
    cron: "7 * * * *"
    target: service-route
    route: /api/example-worker/tick
    handler: runScheduledPolicyTick
    body:
      execute: true
    scope: framework
```

The target path must be canonical and sit beneath this package's longest matching route whose auth
mode is exactly `service`. The kernel derives the compiled module from that owning route, confines
its real path (including symlinks) to the package, verifies the named export, and freezes the static
JSON body before calling `async (ctx, {scheduleId, scheduledAtIso, body})` in-process. Bodies are at
most 16 KiB, eight levels/256 entries, and cannot contain secret/environment interpolation.

The active manifest registry is execution authority. Toggle-off retracts the handler before Redis
schedule deletion, so a stale record cannot run. Handler registration is activation-critical and
never falls back to the generic prompt dispatcher. The in-process call is intentional: loopback
HTTP could fall through to an unrelated same-path kernel route when dynamic package mounting is
off. The separately exposed HTTP route still enforces its declared service authentication.

## Package-owned Takeout slices

An application can consume one product slice from a whole Google Takeout archive without adding
its name, path, or handler import to the kernel:

```yaml
takeout:
  - kind: product-activity
    label: Product activity
    pathSuffix: Takeout/Product/history.json
    htmlPathSuffix: Takeout/Product/history.html
    maxBytes: 67108864
    module: routes/product-routes.js
    handler: ingestTakeoutActivity
```

The handler is a named CommonJS export with the shape
`async (ctx, {userSub, content, fileName}) => ({summary?})`. It must use `userSub` as the data
owner; the route never accepts owner identity from the archive or request body. The module must be
compiled JavaScript that resolves beneath the package directory, including after symlink
resolution. `pathSuffix` and the optional HTML hint are literal case-insensitive archive paths,
not regexes; they begin with `Takeout/` and end in `.json` / `.html`, respectively. An entry
defaults to 64 MiB and can never request more than 128 MiB.

Registration is lifecycle-scoped. An active app atomically replaces its contributions on reload;
toggle-off and uninstall retract them immediately. A bad module/export or a collision with another
active app fails activation closed. Archive traversal names, duplicate logical slices, oversized
inflation, and excessive aggregate retention are rejected in the kernel before package code runs.
This handler rail is independent of `APP_PACKAGE_DYNAMIC_ROUTES`; the app still has to be active.

## Executable installation smokes

Each installable package should own at least one bounded probe that proves its real mounted route,
not merely its files or database record. The installer passes the exact selected app names to
`oshal-verify.sh --apps`; a missing, inactive, or smoke-less package fails by name.

```yaml
routes:
  - module: routes/example.js
    factory: createExampleRoutes
    mountPath: /api/example
    auth: service
    requiresAi: true

smoke:
  - name: structured-note
    method: POST
    path: /api/example/_smoke
    auth: service
    bodyFixture: fixtures/smoke.json
    expect:
      status: 200
      jsonPointer: /result/type
      rejectValues: [noop, stub, empty]
    requiresAi: true
```

Smoke declarations are validated by both the package CLI and the server loader:

- `path` must be a canonical `/api/...` path below a route declared by the same package. Prefer a
  dedicated read-only or otherwise idempotent `_smoke` handler.
- `auth` is exactly `service`, `pat`, or `public`; the verifier sends only that declared credential.
  Installer-driven probes normally use `service`. A `pat` probe requires the calling operator's PAT.
- `bodyFixture`, when present, is package-relative JSON, at most 64 KiB, and cannot escape through
  traversal or symlinks. Fixtures are static data: secret or environment interpolation is rejected.
- `expect.status` is exact. `jsonPointer` uses RFC 6901, and `rejectValues` prevents a placeholder
  such as `noop`, `stub`, or an empty result from reporting success.
- An AI smoke must also have `requiresAi: true` on its owning route. During pre-onboarding it is
  pending; on a declared no-AI box the verifier instead proves the real route returns
  HTTP 503 with `ai_disabled` without spending a generation.

## App access tiers

An app may opt into the platform-wide doorway with an `access:` declaration. This is deliberately
coarse: it decides whether a signed-in user enters the app and whether the request may mutate.
The app's own capabilities and row policies remain authoritative after entry.

```yaml
access:
  supported: [deny, viewer, editor, admin]
  defaultTier: editor
  mappings:                 # optional names understood by this package
    viewer: read_only
    editor: contributor
    admin: app_admin
```

The rules are fail-closed and validated by both the loader and `oshal-app validate`:

- `deny` must be supported and blocks every method with `app_access_denied`.
- `viewer` admits `GET`, `HEAD` and `OPTIONS`; mutations return `app_readonly`.
- `editor` and `admin` enter the app; internal authorization still decides each operation.
- `defaultTier` and every `mappings` key must appear in `supported`; unknown or duplicate tier
  names fail validation.
- Omitting `access` retains legacy behavior. Do that only while migrating an existing package,
  not as an implicit default for a new package.
- A verified machine request carrying a delegated user identity is evaluated for that exact user.
  Anonymous access remains governed by the guest capability matrix.

Operators manage explicit assignments in the framework-owned Applications matrix. Packages do
not write the assignment store. Deploy migration 121 before a declared app, observe with
`OSHAL_APP_ACCESS_MODE=shadow`, seed assignments, then switch to `enforce` (the default).

## Dependencies + lifecycle

- **Install is automatic.** The installer clones the pinned `source`, runs the audit gate,
  resolves `dependencies` (installs/enables missing apps, ref-counts them), then hot-loads.
- **Uninstall is manual + dependency-aware.** A reverse-dependency check runs first: removing
  an app that another installed app depends on is blocked; you get an impact list and only
  true orphans (ref-count → 0) are offered. Nothing auto-cascades.

Example: **little-monsters** surfaces a Presentations tab, so it declares
`dependencies.apps: [presentations]`. Installing it pulls presentations; presentations is
protected from removal while little-monsters remains.

## Package audit gate (APP-02)

Every official `marketplace.json` entry must bind an immutable record:

```json
"audit": {
  "record": "audits/my-app.json",
  "sourceSha": "40-lowercase-hex-characters"
}
```

The record binds the exact app name, semantic version, and source SHA under profile version 1.
Its fixed controls are `manifest`, `authz`, `rls`, `dependencies`, `installLifecycle`, and
`surface`; a passed record requires all six to be `passed` plus at least one named lowercase
SHA-256 evidence digest. Extra fields, missing/unsafe record paths, malformed profiles, and any
catalog/record binding mismatch block installation in every mode.

`OSHAL_PACKAGE_AUDIT_MODE=compatible` is the rollout default. It may install a structurally valid
`pending` or `failed` record from the mutable catalog ref, but prints **NOT AUDIT-VERIFIED**, grants
no audit SHA pin, and records `audit.verified: false` in `.oshal-install.json`. Set the mode to
`enforce` only after records pass: install, dependency resolution, codebase-free Bash/PowerShell
staging, and operator updates then check out the exact audited SHA and verify `HEAD` before files
replace the installed package. An unknown mode fails closed.

## The `oshal-app` CLI (the helpers)

```bash
# scaffold a new package (creates the folder + a starter oshal-app.yaml + dirs)
node scripts/oshal-app.js init my-app

# lint a package against the contract (self-contained, files present, agentId unique, deps ok)
node scripts/oshal-app.js validate ../oshal-applications/little-monsters
```

`validate` exits non-zero on any error, so it doubles as a **CI gate** for a store repo (run
it over every package folder on push). Missing compiled routes are warnings, not errors —
they're produced by the build, so a package can be validated before it's fully built.

## Publishing + installing

1. `oshal-app validate my-app` → clean.
2. Push the folder to the store repo (e.g. `oshal-applications/my-app/`), add an entry to the
   store's `marketplace.json`.
3. Install into a swarm: `POST /api/swarm/apps/install-remote {source: "my-app"}` (the
   installer + resolver is ADR-085 P3).

## Reference

- Architecture + rationale: [ADR-085](../adr/085-remote-app-packages-and-registries.md)
- The reference store repo: `github.com/emeraldcoastsystemsgroup/oshal-applications`
- The first package (carve-out in progress): `little-monsters/`
- The loader: [`src/app/composition/manifest-route-mounter.ts`](../../src/app/composition/manifest-route-mounter.ts)
- The CLI: [`scripts/oshal-app.js`](../../scripts/oshal-app.js)
