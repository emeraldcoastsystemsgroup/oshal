# ADR-097 — App suites: one primary catalog category per application

- **Status:** Accepted — BUILT 2026-07-17 (suite field + loader validation + grouped catalog +
  all 40 in-repo manifests stamped + all three manifest generators emit it).
- **Date:** 2026-07-17
- **Author:** maintainer@emeraldcoastsystemsgroup.com
- **Related:**
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-085 (remote app packages and registries)](085-remote-app-packages-and-registries.md),
  [ADR-089 (skill-import adapter)](089-skill-import-adapter.md)

## Context

The catalog reached 40 in-repo applications rendered as one flat grid
(`src/pages/applications/index.html` deliberately had "no category sections" when the count was
small). Operator direction (2026-07-17): organize apps into recognizable suites — AI
Productivity, AI Knowledge, AI Finance, and so on — **without** disturbing the ADR-085 store
carve-out, whose entire migration plan (waves, dependency resolver, rollback) is built around
*one app = one package*.

The layering that makes this safe was already latent in the manifests:

- **Tools are ingredients.** Each tool declares its own `category:` (media, commerce,
  communication, devops…) and is reusable by any app.
- **Applications are jobs.** An app bundles bots + tools + a surface to do one job for a
  person, and may borrow tools from *any* category — `daily-trade-recap` bundles two media
  tools and a communication tool, yet it is unmistakably a finance app.
- What was missing was the third layer: **the shelf** — where a user *browses* for the app.

## Decision

1. **`suite:` is a new top-level manifest field — the app's ONE primary catalog shelf.**
   Closed enum (`SWARM_APP_SUITES` in `src/features/swarm-apps/types.ts`):
   `ai-productivity`, `ai-knowledge`, `ai-finance`, `ai-creative`, `ai-home`
   (displayed "AI Home & Lifestyle"), `ai-engineering`, plus `platform` — the pinned
   framework row (jarvis), not a browsable suite. Adding a suite is a deliberate schema
   change here + an update to this ADR, never a manifest-side invention.
2. **A suite is never derived from tool categories.** Tools keep their independent
   `category:`; the suite is chosen by who the app serves. The two axes are orthogonal on
   purpose — collapsing them would misfile every app that borrows cross-category tools.
3. **Validation is value-fail-closed, presence-warn-only** (`swarm-app-loader.ts`): an unknown
   suite fails the load (a typo must not invent a shelf); a *missing* suite only warns, so
   pre-097 store-installed packages (little-monsters, portrait-studio, brand-graphics,
   hello-oshal) keep booting and list under "More" until their next release adds the field.
4. **Suite is metadata, not the package unit.** One app = one package stands (ADR-085); the
   carve-out waves are untouched. If suite-level install is ever wanted, it is a future
   meta-manifest listing app packages — not a re-bundle.
5. **Every manifest producer stamps it**: all 40 in-repo manifests carry it now; codex-packer's
   template + rules require it; the skill-import mapper defaults to `ai-productivity`
   (operator re-shelves during the inactive-review pass); both workflow-publish compile paths
   emit `ai-productivity`. Generated apps must never land unshelved — one unstamped generator
   and the flat pile returns.
6. **The catalog groups by suite** (`/api/swarm/apps` now returns `suite` per app): Platform
   pinned first, then the six suites, then "More"; the working-first ordering still applies
   within each group.
7. **"No suite fits" is a scope smell.** Per ADR-038, adding a provider is a connector + CLI
   inside an existing app — if a proposed app fits no suite, it is probably a provider for an
   existing one, not a new app.

## Consequences

**Positive** — the catalog is browsable at 40+ apps and stays that way structurally: the closed
enum plus generator stamping means categorization cannot silently decay. Store packages carry
the field as ordinary manifest data (no store-side changes needed).

**Negative / accepted** — suite assignments are editorial judgment calls (is spotify creative
or lifestyle?); the tie-break rule is *who reaches for it*, and moving an app is a one-line
manifest edit. Pre-097 installed packages warn at every boot until re-released with a suite —
that warning is the intended upgrade prompt.

**Follow-ups** — add `suite` to the store scaffold (`oshal-app init`) and
`BUILDING-EXTENSIONS.md` in the oshal-applications repo at the next store release; stamp the
four already-carved packages then.
