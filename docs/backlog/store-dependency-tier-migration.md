# Store dependency-tier migration (ADR-085 addendum, 2026-09-14)

The core now reads a manifest's `dependencies` as two tiers — `required` and `optional` — and the
installer, the loader and the App Loader all honour the difference ([ADR-085](../adr/085-remote-app-packages-and-registries.md) "Addendum — dependency
tiers", `scripts/oshal-app-dependencies.js`, `@/shared/app-dependencies`; the author-facing contract
is in [the authoring guide](../apps/authoring-app-packages.md)). **No published package
has been converted yet.** The legacy flat form still loads and means *all required*, which is why
nothing broke on the day the core change landed — and also why the store still over-declares:
`create`, `life`, `games` and `system` list up to eight apps they merely route to, so installing
one drags its whole shelf in, while apps that hand work to a partner app declare nothing at all.

Operator decision (2026-09-14): **migrate every store manifest to the tiered form and reclassify,
after a core carrying the tiers is deployed.**

## Status (2026-09-14)

| | where | state |
|---|---|---|
| the core contract, installer, loader and App Loader | `main` `b8de2099` (PR #431 merged 2026-09-14) | **merged AND deployed.** The running image's `swarm-app-loader` validates “required/optional tiers or the legacy flat form… fail-closed at load” |
| the store authoring guide | `oshal-applications` `main` (PR #185 merged 2026-09-14) | merged |
| every published package manifest | `oshal-applications` `feat/store-dependency-tiers` | **converted 2026-09-14** — all 61 tiered, the floor declared on all 59 non-group packages, membership unchanged |
| the App Loader page | bind-mounted `src/pages/app-loader` | live, and the API half it was waiting for is now deployed |
| Test Lab scenario `app-dependency-tiers` | registered | its precondition is now met (the core is deployed); **not re-run yet** — that is step 2 and needs a signed-in session |

## Next steps, in order

Each step is gated by the one before it. Step 1 is done; step 2 is the next action and needs a
signed-in browser session. Steps 3-6 are an ordinary branch of work in the store repo.

1. ~~**Deploy a core that carries the tiers.**~~ **DONE 2026-09-14.** PR #431 merged to `main` as
   `b8de2099` and deployed with `bash scripts/oshal-deploy.sh` (image `1fe73566ae87`, api + 34 bots,
   parity clean, 0 unhealthy). The blocker this whole plan was gated on is cleared.

2. **Prove the deployed API speaks tiers.** Run the AI Test Lab scenario `app-dependency-tiers`; it
   must report **pass**, not `gap`. By hand, as a signed-in operator:
   `GET /api/swarm/registries/<slug>/preview/<package>` - `impact.dependencies.required` and
   `impact.dependencies.optional` must both be objects. An array means the running image predates
   the change, and converting a manifest now would break installs.
3. ~~**Resolve the three unverified classifications**~~ **DONE 2026-09-14.** All three read at the
   source; the file:line evidence is in the table below, which replaces the "needs code evidence"
   one. One hypothesis did not survive: `presentations` is **not** required by `create`.
4. ~~**Convert the manifests**~~ **DONE 2026-09-14** on `oshal-applications` branch
   `feat/store-dependency-tiers`. All 61 manifests carry the tiered form, comments intact and
   re-indented in place (no YAML round-trip); the floor is declared on the 59 non-group packages
   and withheld from the two groups (`intelligent-career`, `marketing-suite`). Connector tiers
   follow the classification below. `node scripts/oshal-app.js validate <dir>` is clean for all 61,
   and `check-catalog.mjs`, `check-store-test-discovery.mjs` and `check-store-separation.mjs` pass.
   Versions were **not** bumped: the catalog mirrors identity/version/suite/displayName, not
   dependencies, so nothing in `marketplace.json` moved — that is step 5.
5. **Regenerate the catalog mirror** so `marketplace.json` carries each package's new dependency
   shape; today it drifts unguarded (see the follow-ups at the end).
6. **Prove it on the box.** Install a converted launcher through the App Loader: its optional apps
   must appear as unchecked checkboxes, declining them must install only the package, and choosing
   one must install exactly that one. Record the result in `COLLABORATE.md`.

## Where the code is

| what | file |
|---|---|
| the one contract both the CLI and the runtime read | `scripts/oshal-app-dependencies.js` |
| typed runtime view (`requiredAppDependencies`, `optionalAppDependencies`, `connectorAllowList`) | `src/shared/app-dependencies/index.ts` |
| CLI: validate / install (`--with`, `--with-optional`) / uninstall / init | `scripts/oshal-app.js` |
| App Loader preview, the dependency gate and the install route | `src/app/routes/app-registry-routes.ts` |
| hot-loading what an install pulled in (both install routes) | `src/app/routes/app-install-dependencies.ts` |
| the confirm screen's required rows and optional checkboxes | `src/pages/app-loader/index.html` |
| guards (all mutation-proven) | `tests/unit/app-dependencies-{contract,installer,loader-browser}.spec.ts` |
| Test Lab registration | `src/app/routes/test-lab-app-registry-scenarios.ts` |

**Never read `manifest.dependencies.apps` directly again** - the two forms differ; go through
`@/shared/app-dependencies` (or `require('./oshal-app-dependencies')` on the CLI side).

## Why the deploy has to come first

A tiered manifest declares `uses: [app-dependencies]`, a [kernel-skill](../apps/kernel-skills.md) floor. A core that predates
the tiers does not know that id, so it **refuses the whole package** — deliberately, because the
alternative is installing it with neither its required dependencies nor its connector allow-list
(the kids' app would offer Facebook again). Publish a converted manifest before the deploy and
every box still on the old core stops being able to install it.

Order: core deploy → verify the Test Lab step `app-dependency-tiers` reports **pass** rather than
`gap` (it reads one install preview and checks both tiers come back) → then convert the store.

## How to convert a manifest

The manifests are heavily commented and the comments are load-bearing documentation, so **do not
round-trip them through a YAML writer** — it will strip every comment. Edit the `dependencies:`
block in place (surgical text replacement), keep the surrounding comments, and add the floor to the
package's existing `uses:` list (or add `uses: [app-dependencies]` when it has none).

```yaml
# before
dependencies:
  apps: [vids]
  tools: []
  connectors: []

# after
uses: [app-dependencies]        # add to the EXISTING uses list when the package has one
dependencies:
  required:
    apps: [vids]                # cannot run without it
    tools: []
    connectors: []
  optional:
    apps: []                    # offered at install; never installed unasked
    tools: []
    connectors: []
```

Rules the contract enforces (all fail-closed at `oshal-app validate` and at load):

- the two forms may not be mixed; unknown keys are refused; a name may not appear in both tiers;
  a package may not depend on itself; app names must be installable slugs (2–64 chars);
- a **group** (`kind: group`) is exempt from the floor — ADR-141 forbids `uses:` on a group, and an
  older core already refuses a tiered group. A group's members are its **required** apps; an app
  listed under `optional` is not a member and cannot be borrowed from in `toolbar:`;
- the connector allow-list is the union of both tiers. Declaring `connectors` in neither tier means
  *unfiltered*, which is not the same as `[]` (offer none). Preserve whichever the package meant.

Verify each converted package with `node scripts/oshal-app.js validate <dir>` before publishing,
and re-run `node scripts/check-catalog.mjs` in the store.

## Proposed classification

Evidence below is the manifest's own comments, quoted from the package. Three groups still need
code-level verification before they are converted — the subagents that were reading the surfaces
for it did not finish, so nothing here should be treated as proven.

### Apps — evidence is the manifest comment

| package | dependency | proposed | evidence |
|---|---|---|---|
| `brand-graphics` | `vids` | **required** | "the brand_graphic CLI enqueues jobs through the LOCAL /api/vids API, and the render runs on the vids-operator worker" |
| `job-apply` | `career-hunter` | **required** | "The workerBot (career-hunter) is registered by the career-hunter app" — the workflow has no worker without it |
| `intelligent-career` (group) | all 4 members | **required** | group members must be required; the toolbar borrows their surfaces by reference |
| `games` | `dnd`, `game-show` | **optional** | "The launcher owns no runtime or data. Its surfaces route to the installed games." |
| `life` | 8 apps | **optional** | "The launcher owns no runtime or data. Its surfaces route to the installed apps." |
| `system` | `identity`, `storage`, `cloud` | **optional** | same launcher text |
| `intelligent-processing` (core `swarm-apps/`) | `intelligent-operations` | leave legacy | a kernel manifest, not a store package; all-required semantics are already correct |

### Apps — resolved at the source (2026-09-14)

These are the three rows that were unverified. Each was decided by reading the package, and the
evidence is the file:line that proves the app either does or does not need the dependency to run.

| package | dependency | verdict | evidence |
|---|---|---|---|
| `create` | `presentations` | **optional** (hypothesis said required) | `create/tools/create-new.html:416-422` — the AI Office starter fetch has its own `.catch` that toasts *"AI Office starters could not be loaded — the studios still open."* `create/tools/create-home.html:448` renders *"No studio is installed yet…"* when none is present. No file under `create/routes/` or `create/src-routes/` references `presentations` at all; Create owns its runtime (`create/migrations/001-create-projects.sql`, `002-create-brand-kits.sql`) |
| `create` | `portrait-studio`, `video`, `lora`, `vids`, `creative-studio`, `scan-to-print` | **optional** | each appears only as a `ui.static` tile with a raw partner `iframeUrl` (`create/oshal-app.yaml` ui block) and as a catalog row in `create/tools/create-home.html:252-258`; the same empty state at `:448` covers all of them |
| `creative-studio` | `vids` | **required** | `creative-studio/routes/home-summary.js:19-20` queries `vids_jobs`, the table the vids package creates (`vids/migrations/059-vids-platform.sql:10`); the app's primary tile IS the vids job-queue surface (`creative-studio/oshal-app.yaml:184-191`) |
| `creative-studio` | `video`, `portrait-studio`, `lora` | **optional** | referenced only as sibling `ui.static` tiles at `creative-studio/oshal-app.yaml:197-210` (`/api/video/ui`, `/api/portrait-studio/app`, `/api/lora/ui`); no route, tool or query touches them |
| `career-hunter` | `portrait-studio` | **optional** | `career-hunter/tools/career-profile-studio.html:243` states it in the code — *"If the app isn't installed (404) the button never appears and upload still works"* — and `:247` is the probe that hides it. The other reference is the cross-app ribbon tile at `career-hunter/oshal-app.yaml:476-479` |

`career-hunter` keeps its **absent** `connectors:` key (unfiltered) — it is declared in neither tier,
as its own manifest comment requires.

### Connectors

Connector tiers change no runtime behaviour today (the allow-list is the union either way); they
drive the preview's "needs" vs "can use" text and tell an author what the app cannot work without.

- **required** — the connector *is* the app's data source or actuator: `cloud` [gcp], `eats` [uber],
  `movies` [tmdb], `spotify` [spotify], `kalshi` [kalshi], `travel` [duffel], `purchasing` [walmart],
  `feeds` [slack].
- **optional** — enrichment, or one of several alternatives: `rides` [uber-rides] ("optional operator
  config via broker"), `sports-edge` [espn-fantasy] ("ONE connector, and only for a private fantasy
  league. Every other read … is an unauthenticated public GET"), `home` [smartthings, google-home],
  `email-summarizer`, `switchboard`, `social`, `marketing-engine`, `presentations`, `portrait-studio`,
  `storage`, `payments`.
- Everything else declares `connectors: []` — keep it `[]` **inside `required`** so the app still
  offers no connector catalog.

## Done when

- **[met 2026-09-14]** Every store package's `oshal-app.yaml` uses the tiered form with the floor declared (groups
  excepted), comments intact, and `node scripts/oshal-app.js validate <dir>` clean for each.
- **[met 2026-09-14]** The launchers (`create`, `life`, `games`, `system`) declare under `required` only what they truly
  cannot run without; installing one no longer installs apps it merely routes to.
- **[met 2026-09-14]** The three "needs code evidence" rows are resolved with a file:line reference recorded here.
- **[open]** `marketplace.json` mirrors each manifest's dependencies again (see the catalog-drift item below)
  and `node scripts/check-catalog.mjs` passes.
- **[open]** A real install proves it end to end on the box: install a converted launcher and confirm the App
  Loader offers its optional apps as unchecked checkboxes, that declining them installs only the
  package, and that choosing one installs exactly that one.
- **[open]** The Test Lab step `app-dependency-tiers` reports **pass** (not `gap`) against the deployed API.

## Related open items this surfaced

### No "one of these connectors" semantics (not started)

`home` needs SmartThings **or** Google Nest; `email-summarizer` needs Gmail **or** Outlook;
`payments` needs Square **or** PayPal. The schema can only say required (all of them) or optional
(none of them), so every such app must use `optional` and lose the "you need at least one of these"
signal. **Done when:** an app can express a choice-of set that the preview and the setup screens
render as "connect one of…", without turning it into a hard install-time requirement.

### An app cannot ask whether its optional partner is installed (not started)

Optional dependencies are an install-time concept only. A package that tiles a partner app's
surface still has to discover at runtime whether it is there — today it either 404s or hand-rolls a
probe. **Done when:** a package can ask the kernel whether a named app is installed and active
(read-only, no new route per package) so its surface can hide a tile instead of rendering a dead
one, with a guard proving the answer follows an uninstall.

### `marketplace.json` dependency mirror has drifted (not started)

The catalog entry for `creative-studio` lists `dependencies.apps: [vids]` while its manifest lists
four; `scripts/check-catalog.mjs` mirrors identity/version/suite/displayName/source but **not**
dependencies, so the drift is invisible. **Done when:** the catalog's dependency block is generated
from the manifest (tiered shape included) and the catalog gate fails on drift, with a mutation
proving it goes red.

### The one-click installer still hard-codes bundle dependencies (not started)

`scripts/oshal-install.sh` carries `BUNDLE_PACKAGES=([little-monsters]="little-monsters
presentations" …)` — "dependencies BOUND" by hand. With required dependencies declared, a bundle
only needs to name its top package; and `--apps` has no way to pull a package's optional extras.
**Done when:** bundles name only their top packages (the installer resolves the rest), a
`--with-optional` passthrough exists for `--apps`, and the installer-scripts parse spec covers both.
