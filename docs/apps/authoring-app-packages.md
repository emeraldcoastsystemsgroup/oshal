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
| `dependencies` | | `{apps: [], tools: [], connectors: []}` — resolved + ref-counted on install |
| `settings` | | `{schema: {...}}` typed per-app settings |
| `bots` | | `[{agentId, name, persona, role, capabilities}]` — agentIds unique, **not** owned by another app |
| `foundation` | | `{persona}` layered under every bot |
| `toolsDir` | | dir of bundled tools (default `tools/`) |
| `ui.static` / `ui.dynamic` | | ribbon/toolbar surfaces |
| `routes` | | `[{module, factory, mountPath, requiresAuth, requiresContext}]` — see below |
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
4. `requiresAuth` defaults on — a package route is auth-gated unless it declares
   `requiresAuth: false`.

Dynamic mounting is gated by **`APP_PACKAGE_DYNAMIC_ROUTES`** (default off). Off = the loader
never mounts package routes; nothing changes.

## Dependencies + lifecycle

- **Install is automatic.** The installer clones the pinned `source`, runs the audit gate,
  resolves `dependencies` (installs/enables missing apps, ref-counts them), then hot-loads.
- **Uninstall is manual + dependency-aware.** A reverse-dependency check runs first: removing
  an app that another installed app depends on is blocked; you get an impact list and only
  true orphans (ref-count → 0) are offered. Nothing auto-cascades.

Example: **little-monsters** surfaces a Presentations tab, so it declares
`dependencies.apps: [presentations]`. Installing it pulls presentations; presentations is
protected from removal while little-monsters remains.

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
