# Experience shells

As-built notes for the ADR-164 experience layouts served under `src/experience/`. Everything here
describes what the shipped code does today; the design record and its open items stay in
[ADR-164](../adr/164-configurable-experience-skins-and-application-views.md).

## What ships

Eight selectable experiences over one unchanged backend:

| Experience | Route | Shape |
| --- | --- | --- |
| Studio | `/studio` | Workbench: suites and pinned apps beside one Jarvis conversation, selected app's summary or embedded surface alongside (hosted with the `company` view requested), its declared assistants and relationships |
| Jarvis | `/jarvis` | Warm assistant home: briefing from the real queue, recent work, an agenda from the overview calendar feed plus the caller's Little Monsters calendar, suites; hosts apps with the `family` view requested |
| Orbit | `/orbit` | Suites as connected worlds around Jarvis; drill into a suite, inspect an app with its declared assistants and relationships; hosts apps with the `company` view requested |
| Commons | `/commons` | Suite rooms (plus a Game room) with applications, declared assistants, a work board, one Jarvis thread per room and the swarm roster; hosts apps with the `company` view requested |
| Home · family homebase | `/homebase?preset=family` | Calendar, shopping list, Smart Home facts, people, personal finance; hosts Smart Home, Shopping, Money and Little Monsters in place with the `family` view requested |
| Little Monsters · classroom | `/homebase?preset=classroom` | Classwork, class calendar, teacher roster with each learner's activity (level, streak, quiz average, cards reviewed) or learner checklist by real role; teachers post classwork from the shell; the learner checklist opens My Day in place; the Little Monsters tools the caller is admitted to open in place |
| Business · company swarm | `/homebase?preset=company` | Open tickets as projects (a ticket awaiting a human approval can be approved from its dialog), team calendar, people, dense account table, and, where Finance is not installed, a personal workspace card whose "My drafts" lists the caller's saved Content Studio drafts and newest finished Jarvis task; hosts Presentations, Finance, Communications, Payroll, Payments, Identity and Engineering in place with the `company` view requested |
| Central assistant | `/nexus` | Intent composer with push-to-talk dictation, a "Request progress" ledger of observed phases, a typed answer workspace (answer, owner-checked visual, handoffs, background work, approval card, fallback provider), lifecycle states (running, ready, partial, failed, setup needed, stopped waiting, still running (poll limit)), speaking core |

`/portal` (also `/experience`) is the chooser. The cockpit header's **Experiences** menu links the
same eight entries, every shell carries an experience picker in its top bar, and `/little-monsters`
redirects to the classroom preset. Plain `/cockpit/` is unchanged: the experiences are opt-in.

## Where the data comes from

[live-data.js](../../src/experience/live-data.js) is the only data seam. It reads, in the caller's
own session:

| Screen element | Contract |
| --- | --- |
| Signed-in person | `GET /api/auth/user` (display name from the account handle, never the whole address) |
| Applications, suites, availability, summary probes, group members | `GET /api/swarm/apps/home-plan` (authorized facts lead) joined with `GET /api/swarm/apps?status=active` (package metadata) and `GET /api/ui/workspaces` (admitted navigation href, kept only when the same-origin guard `localHref` keeps it on this origin and otherwise replaced by the `/cockpit/?app=<name>` link; and skin) |
| Work items | `GET /api/tickets` (the caller's tickets) and `GET /api/jarvis/tasks` (the Jarvis shelf), attributed to apps by declared ticket type or title prefix |
| Assistants online, open count, swarm calendar feed | `GET /api/jarvis/overview` (`calendar.events` read as `{title, when}`, the shape the cockpit Jarvis page reads; empty on every current deployment) |
| Declared assistants and relationships (app panel, Studio's selected workspace, Orbit's inspector) | `GET /api/swarm/apps/:name`, viewer-scoped (404 = not visible), read lazily the first time a panel shows the app; a group also reads each installed member. Assistants are `manifest.bots[].name`, the explicit `manifest.chatBot` is marked Concierge, and online state appears only where the agentId joins the overview roster (otherwise "declared in the package"). Relationships: group members are "Member (required)"; app dependencies follow the two-form rule of `scripts/oshal-app-dependencies.js` (tiered `required`/`optional`, a legacy flat block is all required, a mixed block shows a neutral note and no tiers), labelled Required / Optional and "not in your catalog" when absent from the caller's catalog (the catalog lists the active apps this viewer can see, so absence is not proof an app is not installed). Connector tiers stay under Providers |
| Games (directory chip, Commons Game room) | One shared predicate in `shell.js` (`isGameApp`): a Creative & games suite member whose name reads like a game. No manifest field marks a game, so the chip reads "Looks like a game" and its title says "Creative apps that look like games" |
| Swarm roster (Commons room and People panel) | `GET /api/user-directory` (swarm admins): account name, source and sign-in status, never presence or room membership. A refusal (403) shows only the caller's own identity, and the route's code picks the sentence: `roster_scope_denied` says this session is not permitted to read the roster; `roster_administrator_required` (or any other 403) says only a swarm admin can list everyone |
| Jarvis agenda | the overview calendar feed plus, when Little Monsters is in the caller's catalog, the Little Monsters calendar (classes and personal events). The calendar route resolves the caller as a learner and can create or link a learner row, so it is never the first contact: the package's read-only summary probe (`GET /api/little-monsters/home-summary`, the path its manifest declares) is read first, and only a 200 there leads to `GET /api/education/calendar?month=` for this month and next. A 403/404 probe shows "Open Little Monsters once to see its calendar here." and sends no `/api/education/*` request; any other probe status says Little Monsters could not be checked. Each source and its empty, refused or not-in-your-catalog state is named on screen |
| Per-application facts | each app's own `home-summary` probe from the plan, with the Home view's ADR-145 caps |
| Conversation | `GET /api/jarvis/history`, `POST /api/jarvis/ask`, `GET /api/jarvis/ask/result` on the browser's shared `jarvisSessionId`; Commons rooms use `jarvis-room-<suite>-<sub>` |
| Classroom | Little Monsters `/api/education/me`, `/classes`, `/classes/:id/students` and `/teacher/classes/:id/analytics` (only classes the caller teaches), `/assignments`, `/calendar`; personal events are created through `POST /api/education/calendar`; a teacher's classwork is posted through `POST /api/education/assignments-with-events` (title, type from the package's allowed set, optional due date and description; a due date also writes the class calendar event), then the class data is re-read. The roster pill is activity from the analytics row (level, streak, quiz average when a quiz was taken, cards reviewed) with the class summary line; 403/404 show a note instead of pills |
| Ticket approval | The project dialog of a ticket reads `GET /api/tickets/:ticketId`: the state always, and Reason / Next action only when `metadata.lastStatusTransition` (written on every transition as `{ status, ...its metadata }`) has the ticket's current status, read from that transition itself. The row-level `metadata.reason` / `metadata.nextAction` fields are written at creation and by transitions that carry them, so after a later transition without metadata they can describe an older state; a ticket created in its state (a capture lead, an incident held at intake) has no mirror and shows State alone. Without a matching mirror the dialog shows State alone. Only a ticket in `approval_required` whose current next action is not `none_children_dispatch_independently` offers **Approve**, which sends `PUT /api/tickets/:ticketId/status` with `approved`; the route's refusal (404 for a non-owner, 400 for an invalid transition) is shown as text, and success reloads the work list |
| Personal drafts | `GET /api/content/drafts`, shown as the caller's saved Content Studio drafts (topic, take, the first lines of the draft, saved time) and the newest `done` row of `GET /api/jarvis/tasks` (title, finished time, files as download links); each has its own empty and failure state, and **Open Jarvis ↗** stays |
| Hosted tools | `GET /api/ui/profile?name=<host app>` per host: the same caller-scoped ribbon profile the cockpit renders, already filtered per caller by the app's own visibility answer. Each preset names the applications it hosts (`hosts` in `homebase-config.js`, with hidden tool prefixes that keep off-audience tiles out of the rails), lists their admitted tools grouped per host in its sidebar and tile row, and opens a tool in an iframe that follows the skin through the shared theme bootstrap, with the preset's audience view appended as `?audience=family|classroom|company` (a request the page may honour, never authority). The frame's navigation messages are the shapes the cockpit ribbon already honours (`app-navigate`, `app-tools-changed`, and the Little Monsters literals); only the frame the home opened is heard, same origin only, and only an admitted tool ever opens |
| Shopping list | Purchasing `/api/purchasing/lists` and `/lists/:id/items`; add and remove use the package's own routes |
| Money | Finance `/api/finance/summary` and `/api/finance/home-summary` |
| In-place frames (Studio, Jarvis, Orbit, Commons) | The application's `firstSurfaceUrl` with the layout's audience appended through one helper (`withAudience` in `shell.js`: existing query and hash kept, an audience the URL already names never overridden): `company` for Studio, Orbit and Commons, `family` for Jarvis. A Summary view / Full application switch (full = no audience parameter) is remembered per layout on this device; the hosted page decides whether it has that view and otherwise runs its full UI |
| Central assistant results | The done `GET /api/jarvis/ask/result` payload as returned: `answer` (escaped), `visual` (shown only when its URL is exactly the owner-checked `/api/jarvis/visuals/<artifactId>`, labelled by `kind`), `handoffs[].deepLink` (only same-origin paths become chips: one guard, `localHref` in `live-data.js`, resolves the link against the page origin the way the browser resolves an href, with tab/CR/LF stripped and a backslash read as a slash, and drops anything that leaves it, such as `//host/x`, `/\host` or a tab-split path; the path it hands back is checked again, so a dot-segment link that normalises to `//host` (`/..//host/x`, `/%2e%2e//host/x`) is dropped too; the same guard covers `/` answer links and file downloads in `shell.js` and the admitted workspace href in the catalog, while an absolute https answer link is outside it by design and opens in a new tab with `noopener noreferrer`), `dispatched[]`, `packageToolProposal` (an approval card that points at the Jarvis page, where the Approve button lives; the shell never approves or runs a tool) and `brainFallback` ("Answered by <providerUsed>"). Setup needed is the job code `NO_HOSTED_BRAIN` or the `/ask` 503 with `code: ai_disabled`. Stop, New and Home abort the poll and move a per-request generation on, so a late completion never reopens the workspace; "stopped waiting" never claims the job was cancelled, and a request stopped before the swarm answered the send says the page stopped before that reply arrived. When the page's poll limit is reached (`LIVE.ask` returns code `poll_limit`) the state is **Still running**: the page stopped checking, the job may still finish and its answer is saved to the conversation, so check Jarvis later; it is never shown as failed. Request progress counts its checks as "Checked N times without an outcome" and says the first check had the outcome only when the request reached one; while the first check is still out it reads "Checking now.", and after Stop "This page stopped before the first check answered." (pending, not done). No calendar, comparison, source or per-tool receipt card exists: the result contract carries no such fields |
| Background work | Each `dispatched[].workJobId` is followed on `GET /api/jarvis/tasks` (status, files, ticket) until it is done or failed. The central assistant never marks a result delivered (it sends no `POST /api/jarvis/tasks/:id/delivered`): the Jarvis page stays the one surface that announces and marks results. A row with a ticket can be cancelled through the owner-checked `PUT /api/tickets/:ticketId/cancel`, whose refusal is shown as returned |
| Voice | `POST /api/voice/synthesize`, falling back to the browser engine; the readback is offered on every terminal text (answer, failure, setup). The central assistant's push-to-talk records with `MediaRecorder` and posts field `audio` to `POST /api/voice/transcribe`: the words fill the composer without sending, and "not set up", "denied", "no words" and "failed" are said as such. The microphone never drives the core |

Apps the listing shows but the plan does not admit stay visible as "not available in your
workspace"; nothing is hidden and nothing is widened. A read that fails shows its HTTP status in the
provenance panel and the module renders its unavailable state. No module substitutes fixture data.

## What is deliberately absent

- No check-in, location or presence module: no application on the platform publishes such data.
- No household directory: people appear only where a package publishes membership (a classroom
  roster) or the user directory answers for the caller (company preset, Commons).
- No presence, room membership or shared room conversation in Commons: the roster is the swarm's
  account list and each room thread is the caller's own Jarvis conversation.
- No calendar beyond what Little Monsters contributes; the swarm overview's calendar feed is empty
  by design until an application contributes events (the Jarvis agenda says so when it is empty).
- No role switcher and no "Preview as" picker (ADR-164 D9). Teacher and learner views follow `/api/education/me`.
- No per-learner classwork completion or submission: Little Monsters has no route or field for it, so the roster shows activity only and the learner checklist is read-only (it opens My Day in place). Posted classwork cannot be edited or removed: the package has no route for either.
- No "reviewed" flag or lead role on projects: the only project action is the ticket's own approval transition.
- No blocking on work data: a homebase paints from identity and the catalog (`readyCore`) and fills tickets, tasks and the overview in when they answer (`ready`), so a slow queue never delays the first screen.

## Device-local preferences

Pins per layout, skin per layout, the in-place Summary view / Full application choice per layout
(`embed-view:<layout>`), homebase density and module toggles, the central assistant's
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
- `tests/unit/experience-full-swarm-gaps.spec.ts`: the adapter's app-detail, roster and agenda reads,
  then Chromium over the same fixture: audience-aware hosting and the remembered switch in all four
  full-swarm layouts, declared assistants and relationship tiers (group, flat, mixed, 404, failure),
  the shared games predicate, the Commons roster with its refusal states (admin required, scope denied, failure), and
  the Jarvis agenda's probe gate (no `/api/education` request unless the Little Monsters summary probe answers 200)
  with its empty, refused and not-in-your-catalog states.
- `tests/unit/experience-dependency-tiers.spec.ts`: the shell's dependency reader and
  `scripts/oshal-app-dependencies.js` give identical tiers over tiered, flat, empty and mixed manifests.
- `tests/unit/experience-nexus-gaps.spec.ts`: the central assistant's kit helpers (abortable ask, refusal
  code, poll-limit code, hand-off pass-through, transcription outcomes, the cancel call and no delivered marking) and,
  in Chromium over the same fixture, the typed result cards with hostile hand-offs never linked, partial background
  work with no delivered request sent, setup and failed states with readback, the still-running state at the poll
  limit, a stop before the send was answered, the stale-completion guard across Stop / New / Home, and push-to-talk
  dictation.
- `tests/unit/experience-homebase-gaps.spec.ts`: the same harness for learner activity pills and their refusal notes,
  teacher classwork (taught classes only, refusals rendered as text), the learner checklist opening My Day, the ticket
  approval transition with its refusal and no-approval states, Reason / Next action shown only for a transition mirror
  of the current state, the drafts dialog with empty and failure states, and
  "Configure home" hidden for guests.
- AI Test Lab card `experience-shells` (`test-lab-experience-scenarios.ts`): a read-only step over
  the entry pages and the feeds they join, classified as gap when the running image predates
  `src/experience`.

Run locally:

```sh
npx vitest run tests/unit/experience-live-data.spec.ts tests/unit/test-lab-experience-scenarios.spec.ts tests/unit/experience-layouts-browser.spec.ts tests/unit/experience-full-swarm-gaps.spec.ts tests/unit/experience-dependency-tiers.spec.ts tests/unit/experience-nexus-gaps.spec.ts tests/unit/experience-homebase-gaps.spec.ts tests/unit/app-view-kit-browser.spec.ts
```

## Audience views: what a hosted page renders for a shell (ADR-164 D6)

A preset hosts an assembly of applications and opens every hosted page with `?audience=<preset.audience>`
(`family` for Home, `company` for Business, `classroom` for the classroom). The full-swarm layouts do the same for
their in-place frames (`company` for Studio, Orbit and Commons, `family` for Jarvis) unless the viewer switches to the
full application. The parameter is a request, never
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
