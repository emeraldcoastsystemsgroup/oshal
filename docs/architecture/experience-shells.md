# Experience shells

The approved package migration covers seven experiences: Studio, Jarvis, Orbit, Commons,
Home/Family, Classroom and Business. See [experience application integration](experience-application-integration.md)
for the source inventory, Finance/Education hosting baseline, composite-role contract and
delivery gates. Nexus and Simple chat retain their current behavior. Existing shells below
are not evidence that package discovery or composite-role assignments have shipped.

As-built notes for the ADR-164 experience layouts served under `src/experience/`. Everything here
describes what the shipped code does today; the design record and its open items stay in
[ADR-164](../adr/164-configurable-experience-skins-and-application-views.md).

The prototypes these shells were built from are packaged, with their checks and previews, as the [ADR-164 design collection](../assets/experience-shells/README.md); they are fixture-only studies, and [ADR-164](../adr/164-configurable-experience-skins-and-application-views.md) links each one.

## What ships

The selectable experiences, over one unchanged backend:

| Experience | Route | Shape |
| --- | --- | --- |
| Studio | `/studio` | Workbench: suites and pinned apps beside one Jarvis conversation, selected app's picture, summary or embedded surface alongside (hosted with the `company` view requested), its declared assistants and relationships (a related application becomes the context) |
| Jarvis | `/jarvis` | Warm assistant home: briefing from the real queue, recent work, an agenda from the overview calendar feed plus the caller's Little Monsters calendar, suites, and the Routines panel from its rail; hosts apps with the `family` view requested |
| Orbit | `/orbit` | Suites as connected worlds around Jarvis (six hubs at fixed positions, the day focus's suites ringed); drill into a suite, inspect an app with its picture, declared assistants and relationships (a related application opens its own suite); hosts apps with the `company` view requested |
| Commons | `/commons` | Suite rooms (plus a Game room) with applications (pinnable), declared assistants, a work board, one Jarvis thread per room, the caller's household or team by role (its name as the workspace) and the swarm roster; hosts apps with the `company` view requested |
| Home · family homebase | `/homebase?preset=family` | Front page: the shared calendar, then money (a parent) or school (a learner), Smart Home facts, the tools; the shopping list, a Recent documents card (AI Office's own summary) and the noticeboard beside; people; hosts Smart Home, Shopping, Money, Little Monsters, Movies & TV, Music and Travel (as Watch, Listen and Go) and AI Office in place with the `family` view requested; the caller's own opt-in check-in (ADR-169 location state: a place name and age, never coordinates, with the switch that stops this browser's reporting), the household group from `GET /api/tenants` naming the home and its people, a learner's own level and XP and unread Little Monsters notices (behind the read-only probe gate outside the classroom), Routines (briefing sources, the caller's schedules with pause and resume), search in this home, the Room / Tasks / Files tabs, the day-by-day agenda, the assistant bubble on the same Jarvis thread and the device-local "Make it yours" choices |
| Little Monsters · classroom | `/homebase?preset=classroom` | Classwork, class calendar, teacher roster with each learner's activity (level, streak, quiz average, cards reviewed) or learner checklist by real role; teachers post classwork from the shell; the learner checklist opens My Day in place; the Little Monsters tools the caller is admitted to open in place, beside AI Office (Make and share) and Circuit Lab (Build and test) with the `classroom` view requested |
| Business · company swarm | `/homebase?preset=company` | Front page: Today (Intelligent Communication's saved digest), Office calendar (the Calendar package's snapshot), Recent documents (AI Office) and Capture pipeline (Federal CRM) as summary cards, then open tickets as projects (six rows, tickets awaiting approval first and the rest newest first; a ticket awaiting a human approval can be approved from its dialog) and the tools; Payroll and Calls cards, lists, the personal card (the dense account table, or, where Finance is not installed, a personal workspace whose "My drafts" lists the caller's saved Content Studio drafts and newest finished Jarvis task) and the team feed beside; team calendar and people pages; hosts Presentations, Office (Intelligent Communication's My Day, Calendar, World Intelligence), Finance, Communications (Switchboard, Social's Composer, Calling Assistant), Growth (Marketing Engine, Venture Plan), Federal CRM (its pipeline surfaces), Payroll, Payments, Identity and Engineering in place with the `company` view requested |
| Central assistant | `/nexus` | Intent composer with push-to-talk dictation, a "Request progress" ledger of observed phases, a typed answer workspace (answer, owner-checked visual, handoffs, background work, approval card, fallback provider), lifecycle states (running, ready, partial, failed, setup needed, stopped waiting, still running (poll limit)), speaking core whose readback meter and progress follow the voice (the status keeps the outcome: complete, stopped, paused while away, audio did not start, no engine); Calendar and Travel open inside the conversation as in-context app previews: the caller's busy windows for a month (free Friday-to-Sunday weekends; unread days unknown, never free), a free weekend or typed dates into Travel's own flight search (admitted callers only), local filters and sort, a best-match line naming the weekend, fare, stops and the busy weekends left out, a comparison across every free weekend of the month (the cards filter it), typed dates checked against the calendar, a fare dialog, a device shortlist and fare watches through Travel; the request ledger adds the page's own Calendar, Travel and preferences rows |
| Simple chat | `/simple` | One plain text screen over the caller's Jarvis thread: a slim header, the conversation above, the box pinned at the bottom, first-run help with three example prompts that leaves after the first message. Same endpoints and device session as the shells (`POST /api/jarvis/ask`, `GET /api/jarvis/ask/result`, `GET /api/jarvis/history`), so it is the same conversation; an answer's application handoffs, files and visual show as links. No orb, pickers or panels. See [simple-chat.md](./simple-chat.md). |

`/portal` (also `/experience`) lists experience cards returned by the installed, caller-authorized
`GET /api/ui/experiences` catalog, beside recent work and the searchable application directory.
The cockpit **Experiences** menu and shell pickers consume that same catalog; each choice opens
through the checked package entry operation. A policy outage does not restore static choices.
Nexus and Simple retain their existing routes. Legacy seven-experience routes still serve
the authenticated shell documents; `/little-monsters` still redirects to the Classroom preset.
Retiring these aliases through the corresponding installed package open operation is pending E5.

These are source implementation details. The current deployed backend has not received E2;
its bind-mounted cockpit document stays aligned with that backend until coordinated rollout.
The route table above records renderer behavior and familiar aliases, not installed package
availability. [The integration contract](./experience-application-integration.md) tracks source,
release and installed evidence separately. Plain `/cockpit/` keeps the existing operator workspace.

**Kernel applications inside the shells.** The whole-portal shells frame an application's first surface with the audience
they request (`company` from Studio, Orbit and Commons; `family` from Jarvis). Seven kernel applications serve core
pages there, and each now boots the shared kit with both audiences (one builder): Security Center (`/api/security/`, its
own security status), Workflow Studio (`/workflow-studio/`, the caller's definitions and runs), DevOps + Vault
(`/api/devops/console`, the caller's access and the Vault health), Bot Forge (`/api/forge`, the caller's active
applications and pending imports), OSHAL Engineering's configuration page (`/config/`), Intelligent Processing
(`/intelligent-processing`) and Person model (`/api/jarvis/ambient/person/`, voices heard, open asks and the
projection status). Each card reads only GETs its page already makes, says every refusal with no figure in its place, and
offers the full page in the same frame; the page's own start is gated on the kit's decision, so without an audience the
page runs exactly as before. No route, authorization or data change.

**Front-page modules.** Each homebase preset declares its front page in
[homebase-config.js](../../src/experience/homebase-config.js) as two ordered columns (`modules.main`,
`modules.aside`) of three entry kinds: a core module by name (`calendar`, `shopping`, `home-facts`,
`finance`, `learning`, `requirements`, `roster`, `projects`, `personal`, `updates`, `apps`), a role pair
(`{ teacher, otherwise }`), or a package summary card (`{ card, title, kicker, action }`). A card is one
generic renderer over the application's own ADR-145 `home-summary` probe from the caller's plan (tiles,
the first three items, the probe's timestamp); it is rendered only for an application in the caller's
plan that declares a probe, so an application the caller is not admitted to renders nothing and is asked
nothing (ADR-164 D10), and a refusal is shown as its status with nothing assumed in its place. The
card's action opens the named hosted tool in place (with the preset's audience requested) when the
caller is admitted to it, otherwise it links to the application. No package-specific logic lives in
core: the package decides its tiles and items. Presets carry no data; the other navigation pages keep
their fixed pairs.

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
| Day focus (Studio, Jarvis, Orbit, Commons) | Device-local `oshal-experience:scene:<layout>` ('A workday' / 'An evening at home'; `live-views.js` `sceneOrder`). It orders work, briefings and streams with the focus's suites first (workday: finance, engineering, productivity, knowledge; evening: home, creative & games) and hides nothing; headings and the Jarvis briefing speak to the part of the day; the evening Jarvis prompt names the installed game-like applications; Orbit rings the focus's suites; Commons moves to the Game room (or Home & life) and back. Never sent to a server |
| Status fold | `LIVE.statusOf` names every canonical ticket state: `approved` (Approved), `approval_required` (Approval required), `customer_action` (Needs you), `dead_letter` (Blocked), every `in_process_*` phase (Working). `LIVE.STATUS_GROUPS` (attention / moving / done) places each label in the briefing and the Commons board columns |
| Work panels (four layouts) | A ticket, or the ticket behind a swarm task, reads `GET /api/v1/tickets/:id/workflow` (the registered definition's stages with each one's recorded run step state, progress only from a recorded run, approval-gate receipts, status history, child tickets; the definition is today's registration, not a run snapshot) and `GET /api/tickets/:id`. **Approve** (`PUT /api/tickets/:id/status` approved) only for `approval_required` whose current transition does not name `none_children_dispatch_independently` (the homebase rule); **Cancel** (`PUT /api/tickets/:id/cancel`) behind a confirmation while the ticket is open. A refusal is shown as returned; a success reloads the work. Working rows carry an indeterminate bar: the queue records no percentage |
| Routines panel (Jarvis rail, "Its routines" in any app panel) | `GET /api/v1/agent/schedules` (owner-scoped): what each asks, its cadence in words, next and last run, run count. Only the caller's own prompt schedules carry an "On for me" switch (`POST /api/v1/agent/schedules/:id/pause` / `resume`); an `app:` / `app-route:` schedule says its application manages it and a `workflow:` schedule an operator; a refusal puts the switch back. `GET /api/workflow-studio/definitions` lists the workflows by name, version and size with a link to Workflow Studio, where they are edited, published and restored |
| Visual cards (Studio's workspace, Orbit's inspector, app and work panels, the Game room) | The label is the suite and the newest work's state, the heading that work's title (or the application's name), the footer its source; engineering, game, home and document pictures are labelled illustrations. Only Finance draws data: monthly spend bars from `GET /api/finance/summary` (read once per page, only for a Finance the caller's plan admits), with its no-data, empty and failed states |
| Package facts (application panel) | The caller's catalog (id, version, kind, suite, listing status as registry metadata, plan admission, ticket type and queue, first surface, skin, declared tools and providers) plus the viewer-scoped `GET /api/swarm/apps/:name` record (scope, kernel skills used, registered agents, status), or why the record is not shown |
| Household or team, and the caller's own place | `GET /api/tenants` and the chosen tenant's `GET /api/tenants/:id/members` (an organisation first, else a household; subject and role only, so a member is named only where the Commons roster has the same subject) and `GET /api/location/state` (ADR-169 L3, the caller's own overview: "At <place> · 5 min ago", sharing on or off, or that this session cannot read it; no coordinates). Commons names the team or household as its workspace and seats up to three fellow members in the room header; every layout's People panel lists the members. Nobody else's place or availability is shown |
| Games (directory chip, Commons Game room) | One shared predicate in `shell.js` (`isGameApp`): a Creative & games suite member whose name reads like a game. No manifest field marks a game, so the chip reads "Looks like a game" and its title says "Creative apps that look like games" |
| Swarm roster (Commons room and People panel) | `GET /api/user-directory` (swarm admins): account name, source and sign-in status, never presence or room membership. A refusal (403) shows only the caller's own identity, and the route's code picks the sentence: `roster_scope_denied` says this session is not permitted to read the roster; `roster_administrator_required` (or any other 403) says only a swarm admin can list everyone |
| Jarvis agenda | the overview calendar feed plus, when Little Monsters is in the caller's catalog, the Little Monsters calendar (classes and personal events). The calendar route resolves the caller as a learner and can create or link a learner row, so it is never the first contact: the package's read-only summary probe (`GET /api/little-monsters/home-summary`, the path its manifest declares) is read first, and only a 200 there leads to `GET /api/education/calendar?month=` for this month and next. An entry the listing shows but the caller's plan does not admit is not available to them: neither the probe nor the calendar is read and the agenda says "Little Monsters is not available to you". A probe refusal is named from its `error` (`LIVE.littleMonstersRefusal`): an application-authorization code (403 `app_access_*` from the app-access gate, `authorization_*` from the catalog runtime) reads "not available to you", the package's own 403 "Open Little Monsters to complete school setup" (the caller has no school profile yet; the package sends no machine code, so that sentence is the contract) reads "Open Little Monsters once to set up your school profile; its calendar then shows here.", and any other status says Little Monsters could not be checked; none of them sends an `/api/education/*` request. Each source and its empty, refused or not-in-your-catalog state is named on screen |
| Little Monsters outside the classroom (Home and Business calendars, the family learning card) | Those homes are not Little Monsters, and its `/api/education/*` routes can create or link a learner row for a caller with no profile. So they read the same read-only probe first and call `/api/education/me`, `/classes`, `/assignments` and `/calendar` only when it answers 200; an entry outside the caller's plan gets no probe and no education request. The Home preset's Little Monsters ribbon profile (`GET /api/ui/profile?name=little-monsters`) waits for the same 200, because building it asks the package's visibility route (`/api/education/class-tool-keys`), which provisions a learner row as well; until then Home lists no Little Monsters tools. The calendar (and learning card) then says "Little Monsters is not available to you" for an authorization refusal or an entry outside the plan, "Open Little Monsters once to set up your school profile" for the no-profile refusal, and the status and message for anything else. The classroom preset is Little Monsters itself and keeps reading the education routes; an authorization refusal there reads the same "not available to you" and offers no Open link |
| Date-only fields | Little Monsters due dates, event dates and last-active dates arrive as `YYYY-MM-DD` or UTC midnight (`YYYY-MM-DDT00:00:00.000Z`, how a Postgres DATE reaches JSON from a UTC server); `LIVE.calendarDay` reads either as that local calendar day, so a reader west of Greenwich sees the day the record names, not the day before. A timed calendar event shows its time and, beneath it, its day (Today, or the weekday and date) |
| Per-application facts | each app's own `home-summary` probe from the plan, with the Home view's ADR-145 caps |
| Conversation | `GET /api/jarvis/history`, `POST /api/jarvis/ask`, `GET /api/jarvis/ask/result` on the browser's shared `jarvisSessionId`; Commons rooms use `jarvis-room-<suite>-<sub>` |
| Classroom | Little Monsters `/api/education/me`, `/classes`, `/classes/:id/students` and `/teacher/classes/:id/analytics` (only classes the caller teaches), `/assignments`, `/calendar`; personal events are created through `POST /api/education/calendar`; a teacher's classwork is posted through `POST /api/education/assignments-with-events` (title, type from the package's allowed set, optional due date and description; a due date also writes the class calendar event), then the class data is re-read. The roster pill is activity from the analytics row (level, streak, quiz average when a quiz was taken, cards reviewed) with the class summary line; 403/404 show a note instead of pills |
| Ticket approval | The project dialog of a ticket reads `GET /api/tickets/:ticketId`: the state always, and Reason / Next action only when `metadata.lastStatusTransition` (written on every transition as `{ status, ...its metadata }`) has the ticket's current status, read from that transition itself. The row-level `metadata.reason` / `metadata.nextAction` fields are written at creation and by transitions that carry them, so after a later transition without metadata they can describe an older state; a ticket created in its state (a capture lead, an incident held at intake) has no mirror and shows State alone. Without a matching mirror the dialog shows State alone. Only a ticket in `approval_required` whose current next action is not `none_children_dispatch_independently` offers **Approve**, which sends `PUT /api/tickets/:ticketId/status` with `approved`; the route's refusal (404 for a non-owner, 400 for an invalid transition) is shown as text, and success reloads the work list |
| Personal drafts | `GET /api/content/drafts`, shown as the caller's saved Content Studio drafts (topic, take, the first lines of the draft, saved time) and the newest `done` row of `GET /api/jarvis/tasks` (title, finished time, files as download links); each has its own empty and failure state, and **Open Jarvis ↗** stays |
| Hosted tools | `GET /api/ui/profile?name=<host app>` per host: the same caller-scoped ribbon profile the cockpit renders, already filtered per caller by the app's own visibility answer. Each preset names the applications it hosts (`hosts` in `homebase-config.js`, with hidden tool prefixes that keep off-audience tiles out of the rails; where a host's ribbon lists several surfaces, the ones that are not the page carrying the audience view are hidden: Intelligent Communication shows My Day only, Social its Composer, Marketing Engine its campaign page), lists their admitted tools grouped per host (one kicker per host: Office, Communications and Growth hosts sit beside the ones they belong with) in its sidebar and tile row (a host that is not in the caller's catalog is skipped; a host whose package declares `scope: person`, as Circuit Lab, Venture Plan and CAD Studio do, is listed only to its owner (and to operators), so it appears only for callers who have that package in their catalog, which is why a classroom learner may not see Circuit Lab until they add it), and opens a tool in an iframe that follows the skin through the shared theme bootstrap, scrolled so the tool starts at the top of the viewport (at once when the reader prefers reduced motion) before the frame takes focus, with the preset's audience view appended as `?audience=family|classroom|company` (a request the page may honour, never authority). The frame's navigation messages are the shapes the cockpit ribbon already honours (`app-navigate`, `app-tools-changed`, and the Little Monsters literals); only the frame the home opened is heard, same origin only, and only an admitted tool ever opens |
| Shopping list | Purchasing `/api/purchasing/lists` and `/lists/:id/items`; add and remove use the package's own routes |
| Money | Finance `/api/finance/summary` and `/api/finance/home-summary` |
| In-place frames (Studio, Jarvis, Orbit, Commons) | The application's `firstSurfaceUrl` with the layout's audience appended through one helper (`withAudience` in `shell.js`: existing query and hash kept, an audience the URL already names never overridden): `company` for Studio, Orbit and Commons, `family` for Jarvis. A Summary view / Full application switch (full = no audience parameter) is remembered per layout on this device; the hosted page decides whether it has that view and otherwise runs its full UI |
| Central assistant Calendar | `GET /api/experience/availability?timeMin&timeMax` (`requiresAuth`): the signed-in person's busy windows on the primary calendar of their personal Google connection for one window of at most 42 days, clamped and ordered, never event titles; `state` names why days are unknown (`not-connected`, `no-access`, `failed`, `invalid`, `signed-out`); the page treats unread and refused days as unknown, never free |
| Central assistant Travel | Travel's own routes under the caller's account, only when the plan admits Travel (ADR-164 D10): `GET /api/travel/config`, `GET`/`POST /api/travel/profile` (departure airport), `GET /api/travel/flights` (one search per free weekend in a comparison, at most five), `GET`/`POST /api/travel/watches`; the shortlist and budget stay on the device (D9); the destination city is the offer's `destinationCity` (Duffel `city_name`) when present |
| Home check-ins, household, learning, routines, search | `GET /api/location/state` and the caller's own `/api/location/devices/…` (ADR-169), `GET /api/tenants` and its members, `/api/education/student/…` and `/api/education/notifications` behind the probe gate, `/api/jarvis/briefings` (a source switched with the route's own header), `/api/v1/agent/schedules` (pause and resume), `GET /api/search?q=` |
| Central assistant results | The done `GET /api/jarvis/ask/result` payload as returned: `answer` (escaped), `visual` (shown only when its URL is exactly the owner-checked `/api/jarvis/visuals/<artifactId>`, labelled by `kind`), `handoffs[].deepLink` (only same-origin paths become chips: one guard, `localHref` in `live-data.js`, resolves the link against the page origin the way the browser resolves an href, with tab/CR/LF stripped and a backslash read as a slash, and drops anything that leaves it, such as `//host/x`, `/\host` or a tab-split path; the path it hands back is checked again, so a dot-segment link that normalises to `//host` (`/..//host/x`, `/%2e%2e//host/x`) is dropped too; the same guard covers `/` answer links and file downloads in `shell.js` and the admitted workspace href in the catalog, while an absolute https answer link is outside it by design and opens in a new tab with `noopener noreferrer`), `dispatched[]`, `packageToolProposal` (an approval card that points at the Jarvis page, where the Approve button lives; the shell never approves or runs a tool) and `brainFallback` ("Answered by <providerUsed>"). Setup needed is the job code `NO_HOSTED_BRAIN` or the `/ask` 503 with `code: ai_disabled`. Stop, New and Home abort the poll and move a per-request generation on, so a late completion never reopens the workspace; "stopped waiting" never claims the job was cancelled, and a request stopped before the swarm answered the send says the page stopped before that reply arrived. When the page's poll limit is reached (`LIVE.ask` returns code `poll_limit`) the state is **Still running**: the page stopped checking, the job may still finish and its answer is saved to the conversation, so check Jarvis later; it is never shown as failed. Request progress counts its checks as "Checked N times without an outcome" and says the first check had the outcome only when the request reached one; while the first check is still out it reads "Checking now.", and after Stop "This page stopped before the first check answered." (pending, not done). No calendar, comparison, source or per-tool receipt card exists: the result contract carries no such fields |
| Background work | Each `dispatched[].workJobId` is followed on `GET /api/jarvis/tasks` (status, files, ticket) until it is done or failed. The central assistant never marks a result delivered (it sends no `POST /api/jarvis/tasks/:id/delivered`): the Jarvis page stays the one surface that announces and marks results. A row with a ticket can be cancelled through the owner-checked `PUT /api/tickets/:ticketId/cancel`, whose refusal is shown as returned |
| Voice | `POST /api/voice/synthesize`, falling back to the browser engine; the readback is offered on every terminal text (answer, failure, setup). The central assistant's push-to-talk records with `MediaRecorder` and posts field `audio` to `POST /api/voice/transcribe`: the words fill the composer without sending, and "not set up", "denied", "no words" and "failed" are said as such. The microphone never drives the core |

Apps the listing shows but the plan does not admit stay visible as "not available in your
workspace"; nothing is hidden and nothing is widened. A read that fails shows its HTTP status in the
provenance panel and the module renders its unavailable state. No module substitutes fixture data.

## What is deliberately absent

- No check-in module and no one else's location or presence: the homebases show no place at all, and the full-swarm layouts show only the caller's own place from their ADR-169 overview. The ADR-169 grantee projection (a member share's place transitions for its group) is not on main, so no layout reads another person's place.
- No household directory in the homebases: people appear only where a package publishes membership (a classroom
  roster) or the user directory answers for the caller (company preset, Commons). The full-swarm layouts list the caller's
  own household or team from `GET /api/tenants` by role; the route publishes no names.
- No presence, room membership, person-to-person conversation or shared room messages in Commons: the members shown are
  the caller's household or team, the roster is the swarm's account list, and each room thread is the caller's own Jarvis
  conversation. No messaging service between people exists in core or the store.
- No workflow publishing or restoring outside Workflow Studio: its definitions are a swarm-wide design store with no
  per-caller owner, so the Routines panel lists them and links to Workflow Studio; the only change it makes is pausing or
  resuming the caller's own schedules.
- No players at a game table: game packages keep their own members (D&D's campaign `member_subs`) but publish no read of
  them to a shell; a game's panel lists the other games on the swarm instead.
- No calendar beyond what Little Monsters contributes; the swarm overview's calendar feed is empty
  by design until an application contributes events (the Jarvis agenda says so when it is empty).
- No role switcher and no "Preview as" picker (ADR-164 D9). Teacher and learner views follow `/api/education/me`.
- No per-learner classwork completion or submission: Little Monsters has no route or field for it, so the roster shows activity only, the learner card counts open classwork (with the next item and its due date) and shows no done/total count or progress bar (assignment status is class-wide), and the learner checklist is read-only (it opens My Day in place). Posted classwork cannot be edited or removed: the package has no route for either.
- No "reviewed" flag or lead role on projects: the only project action is the ticket's own approval transition.
- No blocking on work data: a homebase paints from identity and the catalog (`readyCore`) and fills tickets, tasks and the overview in when they answer (`ready`), so a slow queue never delays the first screen.

## Device-local preferences

Pins per layout, skin per layout, the day focus per layout (`scene:<layout>`), the in-place Summary view / Full application choice per layout
(`embed-view:<layout>`), homebase density and module toggles, the central assistant's
display name and auto-speak are stored in `localStorage` under `oshal-experience:*`. They are
visible as device-only choices in the UI and never reach a server setting or a permission. "Configure home" is not shown to a guest session (`/api/auth/user` `guestMode`).

## Packaging and serving

`registerCockpitStaticRoutes` mounts `/experience` and the named entry pages behind `requiresAuth`.
The directory resolves like the cockpit directory (`src/experience` under the working directory),
and `Dockerfile.oshal` copies it into the image. The pages load only same-origin scripts and
stylesheets under `/experience/…`, so the strict CSP applies unchanged.

**Shell lock (ADR-164 amendment, 2026-10-02).** On a deployment whose landing names an application
(`LANDING_PATH` or `HOST_APP_MAP` → `/cockpit/?app=<name>`), these entry pages and the plain
cockpit document are the operator's experiences: a signed-in non-operator who requests one is
redirected to the landing (`src/app/experience-shell-lock.ts`), and the focused rail withholds the
platform hub, returns the logo to the landing application and hides the header's Experiences menu
(inputs `landingApp` and `operator` on `GET /api/ui/profile`). Operators, focused `?app=` requests,
assets and deployments without a focused landing are unchanged.

## Verification

- `tests/unit/experience-simple-chat-browser.spec.ts` and `tests/unit/simple-chat-kit.spec.ts`: Simple chat (`/simple`)
  through the real routes over the same fixture: the sign-in gate, first-run help, the box at the bottom, the history on
  reload, the ask/poll round trip with its links, refusals and failed jobs as rows, the session roll, escape-first rendering,
  the link guard and phone width.
- `tests/unit/experience-live-data.spec.ts`: adapter joins, summary caps, identity, ask flow
  including the session roll and every terminal state.
- `tests/unit/experience-layouts-browser.spec.ts`: headless Chromium through the real route
  registration over an isolated synthetic swarm (`tests/fixtures/experience-browser.ts`): auth
  gating, live rendering without fixture text, directory and pins, app panel and embed, the ask
  flow, room threads, the three presets, honest finance states, the central assistant, the portal
  and per-layout skins; each preset's hosted assembly (`installAssemblyHosts` gives the added hosts ribbon
  profiles shaped like their manifests' surfaces): every host in its own group in the sidebar and tile row,
  only the view page of a host whose ribbon lists several surfaces, and the preset's audience on every hosted src.
- `tests/unit/experience-full-swarm-gaps.spec.ts`: the adapter's app-detail, roster and agenda reads,
  then Chromium over the same fixture: audience-aware hosting and the remembered switch in all four
  full-swarm layouts, declared assistants and relationship tiers (group, flat, mixed, 404, failure),
  the shared games predicate, the Commons roster with its refusal states (admin required, scope denied, failure), and
  the Jarvis agenda's probe gate (no `/api/education` request unless the Little Monsters summary probe answers 200)
  with its empty, refused, not-available (outside the plan, or refused by authorization) and not-in-your-catalog states;
  `calendarDay` and the agenda's class events under America/Chicago with UTC-midnight inputs, and the refusal
  classifier with the probe's carried code.
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
  of the current state, the drafts dialog with empty and failure states,
  "Configure home" hidden for guests, and the acceptance fixes: family and company send no `/api/education` request
  unless the probe answers 200 (none at all outside the plan) while the classroom still reads, the three refusal
  sentences, UTC-midnight due and event dates in America/Chicago, the learner card without a completion count, an
  `approval_required` ticket leading the six project rows, and a timed event's day; a tool opened from the bottom of
  a long sidebar opens with its frame in the viewport and focused, with and without reduced motion.
- `tests/unit/experience-portal-data.spec.ts`: the full-swarm build's pure readers (every canonical ticket state in exactly
  one status group; the day focus order; cron cadence words; routines with their switch rule; workflow definitions;
  membership with the chosen tenant; the caller's place; a ticket's workflow stages and progress; Finance spend bars),
  each with its refusal state.
- `tests/unit/experience-portal-build.spec.ts`: the same harness for the full-swarm build: canonical states on the board
  and in the briefing; work panels (recorded workflow, full workflow view, Approve with its refusal, Cancel behind a
  confirmation with its refusal, the indeterminate bar, invisible and unreadable workflows); the Routines panel (own
  switch, managed rows, somebody else's absent, pause/resume and the refusal that puts the switch back, an app's routines
  first, the ask-Jarvis empty state, refused reads); the day focus in all four layouts with device-only memory; visual
  cards (Finance's spend read once, no-data, outside the plan never read); package facts; Orbit's cross-suite follow and
  Studio's related context; pin focus; Orbit's hubs clear of the legend; household or team membership and the caller's
  place with each source read once and their refusals; the portal's sections with live facts; the demo's six-width layout
  check; the provenance of on-demand reads; entered markup staying text; and the demo's remaining interactions (the
  directory's empty state, drafts kept per room, keyboard tabs, Room details and the private space, Orbit's hub ask and
  its way back, a fresh conversation, the phone-width menu).
- `tests/unit/experience-homebase-build.spec.ts` and `experience-homebase-build-pages.spec.ts`: the Home build in Chromium over the
  same fixture: opt-in check-ins over ADR-169 location state (place and age, the reporting switch, a refusal), the household group,
  the learner and the classroom (probe gate kept), Routines with pause and resume and their refusals, search, the tabs, the agenda
  and event dialog, the existing calendar and display paths, the access and application dialogs, the assistant bubble and the
  device-local choices; `experience-homebase-data.spec.ts`: the data seam's pure helpers and its client's exact calls.
- `tests/unit/experience-availability-routes.spec.ts`: `GET /api/experience/availability` over real HTTP (signed-out refused, window
  validation, the session sub only, the personal connection only, clamped busy windows without titles, the refusals kept apart and
  never answered as free, the requiresAuth mount) and `GoogleCalendarService.freeBusy` against a stubbed endpoint.
- `tests/unit/experience-nexus-data.spec.ts`: the central assistant's data kit (month grid, free and busy weekends, typed ranges,
  offer views, the filters and the weekend filter, the comparison merge, refinements, connection status, the shortlist, the
  briefing, exact route calls).
- `tests/unit/experience-nexus-build.spec.ts`: the central assistant built to the demo in Chromium: frame parity, capabilities and
  the briefing, the Calendar over the caller's busy windows and its refusals, the opening month, the Travel view (search from a free
  weekend, local filters and sort, shortlist, fare dialog, watches, sample offers and refusals), refinements, preferences, the trip
  suggestion, keyboard tabs, and the Phase-8 corrections (readback states, meter and progress, pause while away, stop, completion,
  an engine that never started, the silent-audio watchdog; the best-match line and the busy weekend left out; the comparison across
  free weekends; typed dates against the calendar; the page's ledger rows; in-context titles; the destination city; six widths
  across the welcome and every tab; the fixture's fall-through before opt-in).
- `tests/unit/duffel-normalize-offer.spec.ts`: `scripts/oshal-duffel.js` flattens a Duffel offer and keeps each slice's city names.
- `tests/unit/experience-kernel-<app>-view.spec.ts` (security-center, workflow-studio, devops, codex-packer, oshal-engineering,
  intelligent-processing, person-model): the kernel applications' audience views. Each serves the real page at its real
  route with the real kit and synthetic answers for exactly the reads the page already makes, and proves the company and
  family cards, every refusal said with no figure, the in-frame action to the full page, and the full page starting
  unchanged without an audience or with one it does not provide.
- AI Test Lab card `experience-shells` (`test-lab-experience-scenarios.ts`): a read-only step over
  the entry pages and the feeds they join, classified as gap when the running image predates
  `src/experience`.

Run locally:

```sh
npx vitest run tests/unit/experience-live-data.spec.ts tests/unit/test-lab-experience-scenarios.spec.ts tests/unit/experience-layouts-browser.spec.ts tests/unit/experience-full-swarm-gaps.spec.ts tests/unit/experience-dependency-tiers.spec.ts tests/unit/experience-nexus-gaps.spec.ts tests/unit/experience-homebase-gaps.spec.ts tests/unit/app-view-kit-browser.spec.ts tests/unit/experience-portal-data.spec.ts tests/unit/experience-portal-build.spec.ts tests/unit/experience-homebase-build.spec.ts tests/unit/experience-homebase-build-pages.spec.ts tests/unit/experience-homebase-data.spec.ts tests/unit/experience-availability-routes.spec.ts tests/unit/experience-nexus-data.spec.ts tests/unit/experience-nexus-build.spec.ts tests/unit/duffel-normalize-offer.spec.ts
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
| `app-view.js` | `src/shared/ui/js/` | `AppView.boot({ app, escapeLabel, audiences: { family, company, classroom } })`. When `?audience=` names an audience the page provides, the builder's model (hero, stats, tiles, lists, tables, progress, timeline, custom) is painted from DOM text nodes only, the page's full UI is hidden, and one escape navigates the top window to `/cockpit/?app=<name>`. Otherwise the full page runs. A failed read becomes a retryable notice, never a blank frame. A clickable tile, list item or table row navigates the frame to its `href`, or, with `target: '_blank'`, opens it in a new tab with `noopener` while the frame stays put (hero and section actions already honoured `target`). Date-only strings are calendar days; `AppView.day(value)` also reads a DATE value sent as UTC midnight (`YYYY-MM-DDT00:00:00(.000)Z`) as that day. `AppView.when(value)` reads a timestamp within a minute either side of now as "just now" (a record saved this instant), a later time within the hour as "soon", and an earlier one within the hour as "just now". |
| `app-view.css` | `src/shared/ui/css/` | Three grammars over the framework theme tokens the skin sets: `[data-audience="family"]` (roomy, rounded, tile-forward), `[data-audience="company"]` (dense, squared, table-forward) and `[data-audience="classroom"]` (big, round and friendly: tiles, buttons, clickable rows and the escape at least 48px tall, a larger type scale, soft accent washes; at phone width tiles go one per row and hero buttons full width). No palette is hardcoded. |
| the page | store package | Right after the theme bootstrap: the kit stylesheet + script + one inline head block with the builders; the page's own start is gated on `AppView.active()`, so a core without the kit runs the full page. |

Guards: `tests/unit/app-view-kit-browser.spec.ts` (headless Chromium over the real mounts: the three grammars, the
classroom's 48px targets at desktop and phone width, a `target: '_blank'` item opening a new page without an opener
while the frame stays put, `AppView.when`'s "just now" / "soon" boundary) and, per store package,
`tests/audience-view.test.cjs` (static contract, registered in the package's Test Lab catalog) plus
`tests/audience-view.fixture.cjs`, consumed by the store's `scripts/audience-views.browser.cjs`
(`OSHAL_FRAMEWORK=<core checkout> node scripts/audience-views.browser.cjs [package]`: the real page at its declared
URL, the real kit, synthetic reads for the page's routes, no writes, the full page untouched without an audience).

Shipped audience views: Smart Home (family); Finance (family, company); AI Office, Switchboard Today, Payroll,
Payments, Identity Hub, CAD Studio (company). Little Monsters pages are the classroom rewrite themselves and ignore
the parameter.
