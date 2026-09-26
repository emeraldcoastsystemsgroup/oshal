# Experience shells

As-built notes for the ADR-164 experience layouts served under `src/experience/`. Everything here
describes what the shipped code does today; the design record and its open items stay in
[ADR-164](../adr/164-configurable-experience-skins-and-application-views.md).

## What ships

Eight selectable experiences over one unchanged backend:

| Experience | Route | Shape |
| --- | --- | --- |
| Studio | `/studio` | Workbench: suites and pinned apps beside one Jarvis conversation, selected app's summary or embedded surface alongside |
| Jarvis | `/jarvis` | Warm assistant home: briefing from the real queue, recent work, suites |
| Orbit | `/orbit` | Suites as connected worlds around Jarvis; drill into a suite, inspect an app |
| Commons | `/commons` | Suite rooms with applications, declared assistants, a work board and one Jarvis thread per room |
| Home · family homebase | `/homebase?preset=family` | Calendar, shopping list, Smart Home facts, people, personal finance |
| Little Monsters · classroom | `/homebase?preset=classroom` | Classwork, class calendar, teacher roster or learner checklist by real role |
| Business · company swarm | `/homebase?preset=company` | Open tickets as projects, team calendar, people, dense account table |
| Central assistant | `/nexus` | Intent composer, real ask ledger, answer workspace with handoffs, speaking core |

`/portal` (also `/experience`) is the chooser. The cockpit header's **Experiences** menu links the
same eight entries, every shell carries an experience picker in its top bar, and `/little-monsters`
redirects to the classroom preset. Plain `/cockpit/` is unchanged: the experiences are opt-in.

## Where the data comes from

[live-data.js](../../src/experience/live-data.js) is the only data seam. It reads, in the caller's
own session:

| Screen element | Contract |
| --- | --- |
| Signed-in person | `GET /api/auth/user` (display name from the account handle, never the whole address) |
| Applications, suites, availability, summary probes, integration sources | `GET /api/swarm/apps/home-plan` (authorized facts lead) joined with `GET /api/swarm/apps?status=active` (package metadata) and `GET /api/ui/workspaces` (admitted navigation href and skin) |
| Work items | `GET /api/tickets` (the caller's tickets) and `GET /api/jarvis/tasks` (the Jarvis shelf), attributed to apps by declared ticket type or title prefix |
| Assistants online, open count | `GET /api/jarvis/overview` |
| Per-application facts | each app's own `home-summary` probe from the plan, with the Home view's ADR-145 caps |
| Conversation | `GET /api/jarvis/history`, `POST /api/jarvis/ask`, `GET /api/jarvis/ask/result` on the browser's shared `jarvisSessionId`; Commons rooms use `jarvis-room-<suite>-<sub>` |
| Classroom | Little Monsters `/api/education/me`, `/classes`, `/classes/:id/students` (only classes the caller teaches), `/assignments`, `/calendar`; personal events are created through `POST /api/education/calendar` |
| Shopping list | Purchasing `/api/purchasing/lists` and `/lists/:id/items`; add and remove use the package's own routes |
| Money | Finance `/api/finance/summary` and `/api/finance/home-summary` |
| Voice | `POST /api/voice/synthesize`, falling back to the browser engine |

Apps the listing shows but the plan does not admit stay visible as "not available in your
workspace"; nothing is hidden and nothing is widened. A read that fails shows its HTTP status in the
provenance panel and the module renders its unavailable state. No module substitutes fixture data.

## What is deliberately absent

- No check-in, location or presence module: no application on the platform publishes such data.
- No household directory: people appear only where a package publishes membership (a classroom
  roster) or the user directory answers for the caller (company preset).
- No calendar beyond what Little Monsters contributes; the swarm overview's calendar feed is empty
  by design until an application contributes events.
- No role switcher. Teacher and learner views follow `/api/education/me`.

## Device-local preferences

Pins per layout, skin per layout, homebase density and module toggles, the central assistant's
display name and auto-speak are stored in `localStorage` under `oshal-experience:*`. They are
visible as device-only choices in the UI and never reach a server setting or a permission.

## Packaging and serving

`registerCockpitStaticRoutes` mounts `/experience` and the named entry pages behind `requiresAuth`.
The directory resolves like the cockpit directory (`src/experience` under the working directory),
and `Dockerfile.oshal` copies it into the image. The pages load only same-origin scripts and
stylesheets under `/experience/…`, so the strict CSP applies unchanged.

## Verification

- `tests/unit/experience-live-data.spec.ts`: adapter joins, summary caps, identity, ask flow
  including the session roll and every terminal state.
- `tests/unit/experience-layouts-browser.spec.ts`: headless Chromium through the real route
  registration over an isolated synthetic swarm (`tests/fixtures/experience-browser.ts`): auth
  gating, live rendering without fixture text, directory and pins, app panel and embed, the ask
  flow, room threads, the three presets, honest finance states, the central assistant, the portal
  and per-layout skins.
- AI Test Lab card `experience-shells` (`test-lab-experience-scenarios.ts`): a read-only step over
  the entry pages and the feeds they join, classified as gap when the running image predates
  `src/experience`.

Run locally:

```sh
npx vitest run tests/unit/experience-live-data.spec.ts tests/unit/test-lab-experience-scenarios.spec.ts tests/unit/experience-layouts-browser.spec.ts
```
