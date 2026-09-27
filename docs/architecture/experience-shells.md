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
| Home · family homebase | `/homebase?preset=family` | Calendar, shopping list, Smart Home facts, people, personal finance; hosts Smart Home, Shopping, Money and Little Monsters in place with the `family` view requested |
| Little Monsters · classroom | `/homebase?preset=classroom` | Classwork, class calendar, teacher roster with each learner's activity (level, streak, quiz average, cards reviewed) or learner checklist by real role; teachers post classwork from the shell; the learner checklist opens My Day in place; the Little Monsters tools the caller is admitted to open in place |
| Business · company swarm | `/homebase?preset=company` | Open tickets as projects (a ticket awaiting a human approval can be approved from its dialog), team calendar, people, dense account table, and, where Finance is not installed, a personal workspace card whose "My drafts" lists the caller's saved drafts and newest finished Jarvis task; hosts Presentations, Finance, Communications, Payroll, Payments, Identity and Engineering in place with the `company` view requested |
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
| Classroom | Little Monsters `/api/education/me`, `/classes`, `/classes/:id/students` and `/teacher/classes/:id/analytics` (only classes the caller teaches), `/assignments`, `/calendar`; personal events are created through `POST /api/education/calendar`; a teacher's classwork is posted through `POST /api/education/assignments-with-events` (title, type from the package's allowed set, optional due date and description; a due date also writes the class calendar event), then the class data is re-read. The roster pill is activity from the analytics row (level, streak, quiz average when a quiz was taken, cards reviewed) with the class summary line; 403/404 show a note instead of pills |
| Ticket approval | The project dialog of a ticket reads `GET /api/tickets/:ticketId` (state, and the `metadata.reason` / `metadata.nextAction` mirror when present). Only a ticket in `approval_required` whose next action is not `none_children_dispatch_independently` offers **Approve and resume**, which sends `PUT /api/tickets/:ticketId/status` with `approved`; the route's refusal (404 for a non-owner, 400 for an invalid transition) is shown as text, and success reloads the work list |
| Personal drafts | `GET /api/content/drafts` (topic, take, the first lines of the draft, saved time) and the newest `done` row of `GET /api/jarvis/tasks` (title, finished time, files as download links); each has its own empty and failure state, and **Open Jarvis ↗** stays |
| Hosted tools | `GET /api/ui/profile?name=<host app>` per host: the same caller-scoped ribbon profile the cockpit renders, already filtered per caller by the app's own visibility answer. Each preset names the applications it hosts (`hosts` in `homebase-config.js`, with hidden tool prefixes that keep off-audience tiles out of the rails), lists their admitted tools grouped per host in its sidebar and tile row, and opens a tool in an iframe that follows the skin through the shared theme bootstrap, with the preset's audience view appended as `?audience=family|classroom|company` (a request the page may honour, never authority). The frame's navigation messages are the shapes the cockpit ribbon already honours (`app-navigate`, `app-tools-changed`, and the Little Monsters literals); only the frame the home opened is heard, same origin only, and only an admitted tool ever opens |
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
- No role switcher and no "Preview as" picker (ADR-164 D9). Teacher and learner views follow `/api/education/me`.
- No per-learner classwork completion or submission: Little Monsters has no route or field for it, so the roster shows activity only and the learner checklist is read-only (it opens My Day in place). Posted classwork cannot be edited or removed: the package has no route for either.
- No "reviewed" flag or lead role on projects: the only project action is the ticket's own approval transition.
- No blocking on work data: a homebase paints from identity and the catalog (`readyCore`) and fills tickets, tasks and the overview in when they answer (`ready`), so a slow queue never delays the first screen.

## Device-local preferences

Pins per layout, skin per layout, homebase density and module toggles, the central assistant's
display name and auto-speak are stored in `localStorage` under `oshal-experience:*`. They are
visible as device-only choices in the UI and never reach a server setting or a permission. "Configure home" is not shown to a guest session (`/api/auth/user` `guestMode`).

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
- `tests/unit/experience-homebase-gaps.spec.ts`: the same harness for learner activity pills and their refusal notes,
  teacher classwork (taught classes only, refusals rendered as text), the learner checklist opening My Day, the ticket
  approval transition with its refusal and no-approval states, the drafts dialog with empty and failure states, and
  "Configure home" hidden for guests.
- AI Test Lab card `experience-shells` (`test-lab-experience-scenarios.ts`): a read-only step over
  the entry pages and the feeds they join, classified as gap when the running image predates
  `src/experience`.

Run locally:

```sh
npx vitest run tests/unit/experience-live-data.spec.ts tests/unit/test-lab-experience-scenarios.spec.ts tests/unit/experience-layouts-browser.spec.ts tests/unit/experience-homebase-gaps.spec.ts
```

## Audience views: what a hosted page renders for a shell (ADR-164 D6)

A preset hosts an assembly of applications and opens every hosted page with `?audience=<preset.audience>`
(`family` for Home, `company` for Business, `classroom` for the classroom). The parameter is a request, never
authority (D5): the page decides whether it provides that audience, and every read still goes through the page's
own routes under the caller's session. The word is `audience`, not `view`: store pages (the purchasing dashboard)
and the cockpit ribbon already read `?view=` for their own tabs.

The shared kit, served by the existing `/shared/ui` mounts, is what makes the assembly read as one room:

| Piece | Where | What it does |
|---|---|---|
| `app-view.js` | `src/shared/ui/js/` | `AppView.boot({ app, escapeLabel, audiences: { family, company } })`. When `?audience=` names an audience the page provides, the builder's model (hero, stats, tiles, lists, tables, progress, timeline, custom) is painted from DOM text nodes only, the page's full UI is hidden, and one escape navigates the top window to `/cockpit/?app=<name>`. Otherwise the full page runs. A failed read becomes a retryable notice, never a blank frame. Date-only strings are calendar days. |
| `app-view.css` | `src/shared/ui/css/` | Two grammars over the framework theme tokens the skin sets: `[data-audience="family"]` (roomy, rounded, tile-forward) and `[data-audience="company"]` (dense, squared, table-forward). No palette is hardcoded. |
| the page | store package | Right after the theme bootstrap: the kit stylesheet + script + one inline head block with the builders; the page's own start is gated on `AppView.active()`, so a core without the kit runs the full page. |

Guards: `tests/unit/app-view-kit-browser.spec.ts` (headless Chromium over the real mounts) and, per store package,
`tests/audience-view.test.cjs` (static contract, registered in the package's Test Lab catalog) plus
`tests/audience-view.fixture.cjs`, consumed by the store's `scripts/audience-views.browser.cjs`
(`OSHAL_FRAMEWORK=<core checkout> node scripts/audience-views.browser.cjs [package]`: the real page at its declared
URL, the real kit, synthetic reads for the page's routes, no writes, the full page untouched without an audience).

Shipped audience views: Smart Home (family); Finance (family, company); AI Office, Switchboard Today, Payroll,
Payments, Identity Hub, CAD Studio (company). Little Monsters pages are the classroom rewrite themselves and ignore
the parameter.
