# Four ways home — full swarm

## New: the central assistant

[Open the Jarvis concept](nexus.html): a luminous particle core, one intent composer, and a calendar/flight workspace assembled around the November Vegas example. Refine the results, inspect sources, open the Travel preview, save an example option, and rename the assistant in Preferences. All fares, calendar windows and execution are fixtures; no live tools or accounts are accessed. [Design and implementation notes](CENTRAL-ASSISTANT.md) explain the live integration boundary. Run `node docs/assets/experience-shells/check-nexus.cjs` for its browser checks.

Final central-assistant run: **59 assertions passed**, six viewport sizes, zero runtime errors or external HTTP requests. Homebase/gallery regression rerun: **202 passed**.

**Speaking core:** choose **Play readback** under the orb. Its particles scatter, drift and vibrate with the actual audio level of a bundled placeholder voice, then gather again. Stop/replay, a transcript and reduced-motion controls are included. No microphone or external speech service is used; this is a fixed sample, not a live answer. The new `check-readback.cjs` passed **44 assertions** using real local PCM playback/analyser output, plus isolated audio-failure fixtures. The existing 59 central-assistant checks passed again.

## New: configurable homebases

Three additional examples share one configuration-driven implementation:

- [Family Homebase](homebase.html) (`?preset=family`, the default): two parents, two kids, shared calendar/list, opt-in check-ins and personal finance/learning.
- [Little Monsters](homebase.html) (`?preset=classroom`): teacher/student views, published requirements and separate learner progress.
- [Company swarm](homebase.html) (`?preset=company`): projects, team calendar, lead review and capability-scoped finance.

Use **Preview as** to switch people and **Configure home** to publish/restore a visual configuration. This is fixture-only role preview, not authentication or access enforcement. Source: `homebase.html`, `homebase-config.js`, `homebase.js`, `homebase.css`. The mascot asset is copied unchanged from the Little Monsters package.

The [reskin impact study](RESKIN-IMPACT-STUDY.md) includes actual architecture seams, a 62-package/157-surface inventory, staged effort estimates, capability gaps, migration risks and acceptance requirements. [Homebase validation](HOMEBASE-VALIDATION.md) records prototype checks separately from the existing platform test baseline. Run `node docs/assets/experience-shells/check-homebase.cjs` for these three studies and `node docs/assets/experience-shells/inspect-reskin.cjs` for a read-only current source inventory.

## Original four directions

Open **index.html** in a browser. The four standalone prototypes work from a local file without a build or network connection.

For the in-app browser, run `node docs/assets/experience-shells/serve.cjs` from the project root and open http://127.0.0.1:4319/. The server exposes only this folder on loopback. Set `MOCKUP_PORT` to use another port.

## Actual application breadth

The default experience includes all **62 catalog entries across six suites** from the local application store: Finance 8, Engineering 11, Creative 13, Productivity 12, Home 13 and Knowledge 5. Games, Dungeon Master and Game Show belong to Creative; Games is also a convenient filter and shared room, not an additional suite.

Names, descriptions, package versions and suites come from the marketplace. Declared assistants and required/optional app dependencies come from package manifests. For example, Finance connects to trading, World Intelligence and Kalshi; CAD Studio connects to Scan to Print. Two entries display “Intelligent Career”; their distinct package IDs remain visible.

Snapshot revision: `42d1b826332a9bc937b15860ae81cdec1fc834fa`. Capture time and catalog hash are recorded in `catalog-data.js`. This is catalog coverage, not a claim that 62 applications are installed, connected or live-verified.

## Explore the four directions

| Direction | Theme | Full-swarm organization | Try |
| --- | --- | --- | --- |
| Studio | Graphite and mint | Suite navigation and pinned apps around a conversation, with work beside it | Pick CAD Studio, pin Circuit Lab, inspect Finance's connections. |
| Jarvis | Parchment and ember | One assistant filters a cross-domain briefing, with six worlds below | Compare priorities, browse all six suites, ask about games. |
| Orbit | Arctic and cobalt | Six suite hubs expand into application grids and real package relationships | Open Engineering, select Circuit Lab, follow its Animatronics connection. |
| Commons | Aubergine and lilac | Suite rooms bring people, application specialists and work together | Visit Engineering, open its 11 applications, then enter the Game room. |

Each design has:

- Search across all 62 applications with Ctrl/Cmd K; suite, Games and pinned filters.
- App detail panels, pinnable navigation, example artifacts and actual declared relationships.
- A **busy workday / evening at home** selector to compare work and personal contexts.
- Example conversations and cross-application work; room-scoped messages and drafts in Commons.
- A Workflow Studio preview: switch one approval workflow to automatic delivery, publish, and restore its prior version. Optional personal enrollment remains a separate choice.

The design picker switches layouts. Narrow layouts reflow navigation, panels and the graph. The original smaller prototypes remain available at `studio.html?scale=sample` (likewise Jarvis, Orbit and Commons).

## Prototype boundaries

People, membership, presence, work items, task statuses, private content, charts, game players, sources and replies are **fictional fixtures**. Catalog status “ready” is registry metadata, not feature acceptance. Opening an application shows a design preview; it does not install or launch that application.

State is local to this browser session and design. The prototypes do not synchronize with one another. No live model call, message, account connection, application install, scheduled job or permission change occurs. Shared/private labels illustrate intended boundaries, not implemented server enforcement.

This is a standalone home design study, not a production UI or backlog change.

## Files and verification

- `index.html`: comparison gallery; four named HTML pages are the direct entries.
- `full-swarm.js`, `full-swarm.css`: current full-catalog layouts and interactions.
- `catalog-data.js`: real store snapshot, bundled locally.
- `sync-catalog.cjs`: refreshes that snapshot from the sibling store and manifests; reads the store without modifying it. Run `node docs/assets/experience-shells/sync-catalog.cjs`. Requires the repository's `js-yaml` dependency. Suite counts and expected test totals describe this snapshot; review them if the catalog changes.
- `styles.css`, `app.js`: base styling and retained first-pass interactions.
- `check-full-swarm.cjs`: current browser checks and screenshot capture. Run `node docs/assets/experience-shells/check-full-swarm.cjs`; requires the repository's Playwright dependency.
- `check.cjs`: retained first-pass checks targeting `?scale=sample`; screenshots go into `previews/first-pass/`.
- `previews/`: current desktop, mobile, evening and catalog screenshots.
- `serve.cjs`: optional dependency-free preview server.
- `reference/`: recovered family-home and ten-interaction-model studies from the supplied visualization directory. Original files remain unchanged; recovered studies retain their original limitations.

The full-swarm browser run passed **373 assertions**, including opening all 62 entries. The retained first pass passed **165 assertions**. See `VALIDATION.md` for scope.

## Packaging (2026-09-27)

This collection moved from `mockups/swarm-home/` to `docs/assets/experience-shells/` so the links in [ADR-164](../../adr/164-configurable-experience-skins-and-application-views.md) resolve inside the repository. The example signed-in person and household are now the fictional Taylor Brooks and the Brooks home, in the prototypes, the `reference/` studies and the one check that asserts the name; that rename is the only content change to the `reference/` files. Every `.js`, `.cjs` and `.ps1` file gained the repository CHANGE LOG header, and `sync-catalog.cjs` and `inspect-reskin.cjs` resolve the core and store checkouts one directory higher.

Every preview was regenerated by rerunning the collection's own checks on the packaged copy: `check-nexus.cjs` **59** passed, `check-readback.cjs` **44**, `check-full-swarm.cjs` **373**, `check-homebase.cjs` **202** and `check.cjs` **170**. The unmodified `check.cjs` failed its gallery link check because the homebase links carry `?preset=`; it now drops the query before testing that the linked file exists. Previews that never showed the name came out byte-identical.
