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

### Apps — needs code evidence before converting

| package | dependencies | working hypothesis | what to check |
|---|---|---|---|
| `create` | presentations, portrait-studio, video, lora, vids, creative-studio, scan-to-print | `presentations` required, the other six optional | its manifest says "`presentations` is deliberately an APP dependency here … Create embeds AI Office's SURFACE". Read `create/routes|src-routes|ui` for calls into each studio and whether a missing one degrades (hidden tile / empty state) or throws |
| `creative-studio` | vids, video, portrait-studio, lora | `vids` required, the other three optional | "The tile + the creative_* tools ride the 'vids' app's /api/vids surface and vids_jobs ledger"; the other three have no comment — find any code reference at all |
| `career-hunter` | portrait-studio | probably optional | no comment explains it; find where career-hunter calls or embeds portrait-studio and whether the board/resume tools work without it |

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

- Every store package's `oshal-app.yaml` uses the tiered form with the floor declared (groups
  excepted), comments intact, and `node scripts/oshal-app.js validate <dir>` clean for each.
- The launchers (`create`, `life`, `games`, `system`) declare under `required` only what they truly
  cannot run without; installing one no longer installs apps it merely routes to.
- The three "needs code evidence" rows are resolved with a file:line reference recorded here.
- `marketplace.json` mirrors each manifest's dependencies again (see the catalog-drift item below)
  and `node scripts/check-catalog.mjs` passes.
- A real install proves it end to end on the box: install a converted launcher and confirm the App
  Loader offers its optional apps as unchecked checkboxes, that declining them installs only the
  package, and that choosing one installs exactly that one.
- The Test Lab step `app-dependency-tiers` reports **pass** (not `gap`) against the deployed API.

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
