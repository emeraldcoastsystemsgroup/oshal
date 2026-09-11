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
| `kind` | | `app` (default) or `group` — a group carries no code and binds installed apps into one front door (ADR-141, see below) |
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
| `readiness` | | per-user readiness probes a group's setup dashboard asks in the signed-in user's session — see below |
| `summary` | | the app's dashboard tile on the cockpit Home view: bounded `tiles` + `items` from one session-authenticated GET — see below |
| `toolbar` / `setup` | | group-only: surfaces borrowed from members by reference, and the setup-dashboard steps — see "Application groups" |
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
  Installer-driven probes normally use `service`. A `pat` probe uses the caller's own PAT.
- Set `requiresUser: true` for a protected read-only probe that needs an authenticated user.
  It is valid only with `method: GET` or `HEAD`, `auth: pat`, and a closest owning route whose
  `auth` is `oidc` or `service-or-oidc`. Without a caller PAT the result is **pending**, including
  during installation with a service secret. A malformed supplied token fails; a correctly shaped
  `Bearer oshal_pat_<48 lowercase hexadecimal characters>` is sent to the actual route, which
  checks the user's current permissions. HTTP 401/403 remains a failure. Service credentials
  cannot satisfy this prerequisite or substitute for application access.
- `bodyFixture`, when present, is package-relative JSON, at most 64 KiB, and cannot escape through
  traversal or symlinks. Fixtures are static data: secret or environment interpolation is rejected.
- `expect.status` is exact. `jsonPointer` uses RFC 6901, and `rejectValues` prevents a placeholder
  such as `noop`, `stub`, or an empty result from reporting success.
- An AI smoke must also have `requiresAi: true` on its owning route. During pre-onboarding it is
  pending; on a declared no-AI box the verifier instead proves the real route returns
  HTTP 503 with `ai_disabled` without spending a generation.

## Per-user readiness (`readiness:`)

`smoke:` verifies the package's declared route and assertions; a `requiresUser` smoke waits for a
caller PAT when installation has no user context. `readiness:` is
its per-user sibling: it answers "what does this *person* still have to set up" — "your resume is
indexed", "your Facebook is connected" — and a group's setup dashboard (below) asks it **in the
signed-in user's own session**, never with the service secret and never with a PAT.

```yaml
routes:
  - module: routes/example.js
    factory: createExampleRoutes
    mountPath: /api/example
    auth: service-or-oidc

readiness:
  - name: resume                      # what a group's setup[].readiness refers to
    path: /api/example/resume/state   # GET, below one of THIS package's routes
    readyPointer: /hasResume          # RFC 6901; the step is done only when this is boolean true
    detailPointer: /summary           # optional one-line status shown under the step
```

The loader validates it fail-closed exactly like `smoke:`: a canonical path below a route the same
manifest declares, an owning route that admits a browser session (`oidc` or `service-or-oidc` —
never service-only, operator or public), and valid pointers. Keep the probe honest: it must read the
same store the fix surface writes, because a probe that answers from cached state lies to the
dashboard. Anything other than boolean `true` at `readyPointer` is *not done*; an HTTP error or a
missing pointer renders as "can't check", never as done.

## Dashboard tile (`summary:`)

For app-owned actions across loaded applications, see [Home integration contracts](app-home-integrations.md). Declare both the source offer and receiver; Home resolves compatible loaded partners and opens a draft with bounded context. File handoffs continue to use artifact exchange.

### Selectable data points on Home

Home supports per-user box and suite visibility/order, compact boxes, selected metric order,
updates/setup switches, and restore-default controls. Everything starts visible. Preferences are
stored in the owner-scoped `user_preferences.home_dashboard` column (migration 126), with revision
checks for concurrent edits. Hiding a box changes presentation, not authorization or installation.

Add `metricsPointer: /metrics` beside the existing pointers to expose a selectable catalog:

```yaml
summary:
  path: /api/my-app/summary
  tilesPointer: /tiles
  itemsPointer: /items
  metricsPointer: /metrics
```

```json
{
  "tiles": [{ "label": "Awaiting review", "value": "3", "tone": "warn" }],
  "metrics": [{ "id": "awaiting-review", "label": "Awaiting review", "value": "3", "tone": "warn" }],
  "items": [{ "metricId": "awaiting-review", "text": "Three documents need review.", "tone": "warn", "fix": "my-home" }]
}
```

The catalog is capped at 24 entries. Each requires a stable package-local `id` (1–64 characters,
starting alphanumeric; remaining characters alphanumeric, `_`, `.`, or `-`), label, and **string**
value. Duplicate or malformed ids are not selectable. Label/value limits and tones remain the same
as legacy tiles. Optional `defaultVisible: false` leaves a metric available in Edit without selecting
it initially. Saved choices namespace ids by package; changing a label does not change a choice.
Changing a metric's meaning requires a new id. Continue returning the four legacy `tiles` for older
Home/group renderers. Legacy tiles without a catalog still render but are not individually editable.

Optional item `metricId` associates an update with a catalog fact so hiding that fact also removes
its related prose from highlights. `fix` must name a static surface of the declaring app. Home
selects one highlight per visible app, warning facts before ordinary updates, then bounds suite and
page highlights. It does not call a model or calculate cross-app totals. Missing source pointers are
shown as unavailable even when another pointer returns data.

Time-window controls and semantic deduplication across different apps are planned separately; do
not invent new manifest keys for them. Put the supported window in a metric label or item today.
See [the implementation plan](configurable-app-home-plan.md) for the rollout and acceptance gates.

`readiness:` answers "what does this *person* still have to set up". `summary:` is its **reporting**
sibling — "what is going on in this app right now" — and it is what the cockpit **Home** view renders
as your app's tile ([ADR-145](../adr/145-app-status-contract.md)). One declaration per app: an app is
one tile.

```yaml
routes:
  - module: routes/example.js
    factory: createExampleRoutes
    mountPath: /api/example
    auth: service-or-oidc

summary:
  path: /api/example/summary      # GET, below one of THIS package's routes
  tilesPointer: /tiles            # RFC 6901 -> the headline numbers
  itemsPointer: /items            # RFC 6901 -> the line items
```

The route answers from the caller's own rows, in the caller's own session:

```js
router.get('/summary', async (req, res) => {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'sign in to see your summary' }); return; }
  const { rows } = await ctx.pool.query(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*)::int AS total
       FROM example_things WHERE user_sub = $1`,
    [sub],
  );
  const { open, total } = rows[0];
  res.json({
    tiles: [
      { label: 'Open', value: String(open), tone: open ? 'warn' : 'good' },
      { label: 'Total', value: String(total) },
    ],
    items: open ? [{ text: `${open} need your attention`, tone: 'warn', fix: 'example-inbox' }] : [],
  });
});
```

### The shape

| field | rule |
|---|---|
| `tiles` | at most **4**. `label` <= 24 chars, `value` <= 16 chars, optional `tone` |
| `items` | at most **5**. `text` <= 120 chars, optional `tone`, optional `fix` |
| `tone`  | closed enum — `neutral` (default) / `good` / `warn` |
| `fix`   | a `ui.static[].toolName` **in the same app**, rendered as a button that opens that surface |

**`value` is a string, never a number.** "116W-215L", "-$18.24", "6 of 9" and "3 days" are all real
answers, and core cannot know your unit, locale or rounding rule. A numeric `value` is dropped rather
than guessed at.

The caps are not only a layout concern: four tiles and five items force you to decide what actually
matters, which is the whole product value of the page.

### What the loader and the page enforce

- Validated fail-closed at load, exactly like `readiness:` — a canonical path below a route this same
  manifest declares, an owning route that **admits a browser session** (`oidc` or `service-or-oidc`,
  never service-only/operator/public), valid RFC 6901 pointers, and at least one of
  `tilesPointer` / `itemsPointer`. A declaration that can yield neither is a load error.
- Over-cap **truncates**; it does not reject. A chatty app degrades to its first four tiles instead of
  breaking the page for every other app.
- An unknown `tone` degrades to `neutral`. It can never **escalate** — one buggy package must not be
  able to paint the whole page red.
- A pointer that is missing, or resolves to the wrong type, renders **"can't check"** — never a fact,
  and never a zero.
- The probe is a **GET and must be side-effect free**. The page calls it on every load, on every
  refresh, and concurrently from two tabs.
- It is asked with a 3s timeout, at most 6 in flight across the page. A slow app shows "can't check"
  and never delays another app's tile.

### Where the tile lands

On the shelf named by your `suite:` — nothing else decides placement. A `kind: group` collapses to
**one** tile that aggregates its members, so a grouped app is never also listed loose.

An app that declares no `summary:` still gets a tile, built from its recent `jarvis_tasks` rows whose
titles carry the `<App>: ...` prefix. Filing tasks that way is the zero-cost version of this contract;
`summary:` is how you report a *number* rather than a task.

### Keep it honest

Report what the user's own store says, and answer "unavailable" rather than `0` when a source read
fails. The card renders faithfully whatever you return, and a wrong number here looks more
authoritative than a wrong number anywhere else in your app — it is the first thing on the screen.

## Application groups (`kind: group`, ADR-141)

A group is a manifest that carries **no code** and binds installed apps into one themed front door
with one toolbar and a setup dashboard — the meta-manifest [ADR-097](../adr/097-app-suites-primary-categorization.md)
named instead of a re-bundle. It ships, installs, catalogues and gates like any package.

```yaml
name: intelligent-career
kind: group
suite: ai-knowledge
displayName: Intelligent Career
theme: daylight
dependencies:
  apps: [career-hunter, portrait-studio, social, print-ingest]   # the members — all must be active
toolbar:                                   # BORROWED by app + surface name; never a copied URL
  - { app: career-hunter, surface: career-board }
  - { app: career-hunter, surface: career-resume-studio, group: Resume }
  - { app: portrait-studio, surface: portrait-studio, group: Presence }
  - { app: career-hunter, surface: career-settings, section: bottom }
setup:                                     # the kernel setup dashboard is rendered from this
  - { label: Upload your resume, app: career-hunter, readiness: resume, fix: career-resume-studio }
  - { label: Profile picture, app: portrait-studio, readiness: portrait, fix: portrait-studio }
```

What the loader enforces, fail-closed:

- **No code.** `bots`, `tools`, `routes`, `migrations`, `schedules`, `workflow`, `ticketType`,
  `takeout`, `smoke`, `readiness`, `ui`, `uses`, `artifacts`, `surface` all fail the load. A group
  may bundle one thing of its own — a `ui/<theme>.css` skin.
- **Members are `dependencies.apps`** (non-empty). The installer resolves them npm-style; the
  reverse-dependency guard blocks a member's uninstall while the group is active.
- **Toolbar tiles are references.** Each entry names a member and one of its `ui.static[].toolName`s;
  the loader copies the member's label, icon and `iframeUrl` at activation and again at every
  profile synthesis, so a member that moves a surface is followed. A tile whose member is not
  active, or whose surface no longer exists, fails the group's activation with both names — it never
  renders a dead tile. `group:` and `section:` mean what they mean on `ui.static`. A `label`,
  `icon` or `iframeUrl` on a toolbar entry is rejected: that is the copied-URL launcher defect this
  kind exists to remove.
- **Setup steps** name a member, one of that member's `readiness` entries, and (optionally) a
  toolbar surface as `fix`. A step whose member does not declare the readiness fails activation.
- **Verification runs through the members.** `oshal-verify --apps <group>` executes every member's
  own smokes (reported as `<member>/<smoke>`); a missing, inactive or smoke-less member fails the
  group by name.

What the kernel provides for free:

- **The ribbon**: the group's first tile is the shared **Setup** dashboard
  (`/api/swarm/apps/<group>/setup-dashboard`), followed by the borrowed tiles; `ribbon.defaultView`
  may pick another tile. The cockpit needs no change — a group is rendered from the same profile an
  app is.
- **The setup / connection-status page**: one kernel page for every group. It reads the plan from
  `GET /api/swarm/apps/<group>/setup` (manifest data only), asks each member probe itself in the
  viewer's session, and shows done / not done / can't check with the detail line and a **Fix**
  button that opens the member surface inside the same ribbon. No group writes its own dashboard; a
  group that wants a different order changes `setup:`.
- **A hostname**: point `HOST_APP_MAP` at the group (`career.oshal.ai=intelligent-career`) and the
  subdomain lands on the group instead of one primary app.

Groups do not nest: a group cannot list another group as a member.

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

The CLI resolves the catalog name to `source.path` before fetching package files. A package
named `intelligent-trades` can therefore live in `trading/`; its audit remains bound to
`intelligent-trades`. The CLI also accepts an unambiguous source-folder alias (`install trading`)
to update an existing installation at that folder. The requested CLI name determines the
destination folder. Ambiguous names and paths outside the checkout are refused.

## Reference

- Architecture + rationale: [ADR-085](../adr/085-remote-app-packages-and-registries.md)
- The reference store repo: `github.com/emeraldcoastsystemsgroup/oshal-applications`
- The first package (carve-out in progress): `little-monsters/`
- The loader: [`src/app/composition/manifest-route-mounter.ts`](../../src/app/composition/manifest-route-mounter.ts)
- The CLI: [`scripts/oshal-app.js`](../../scripts/oshal-app.js)
