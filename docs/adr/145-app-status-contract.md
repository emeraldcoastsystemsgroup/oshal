# ADR-145: The app summary contract — every app reports its own highlights and todos, and one page renders them

- Status: Accepted — BUILT 2026-09-09 (core: the `summary:` contract, the Home plan, and the cockpit Home view)
- **Amendment A (2026-09-09, recorded at build time): the manifest key is `summary:`, not `status:`.**
  `status` is already a field on `SwarmAppManifest` — the app's install state (`active` | `inactive`) —
  so the name in the original draft could not be used; TypeScript caught it as a duplicate identifier on
  the first compile. Everything else in D1–D9 stands as written; read `status:` below as `summary:` — the code is the authority.
  D9 (the global Home) was NOT deferred in the end — the operator asked for the landing page directly,
  so it shipped in the same change as the contract.
- Date: 2026-09-08
- Related: [ADR-141](141-application-groups.md) (application groups; `readiness:` is the contract this
  extends), [ADR-144](144-guest-seed-contract.md) (the mutation sibling — same declare-a-route shape),
  [ADR-036](036-bot-owned-application-architecture.md) (the bot owns its domain, the surface is a view),
  [ADR-085](085-remote-app-packages-and-registries.md) (one app, one package), [ADR-113](113-switchboard-aggregation-surface-and-workspaces.md)
  (an aggregation surface binds services, it does not add capability)

## Context

Operator direction, 2026-09-08: *"a dashboard page that wasn't Jarvis — just an update on the installed
apps, what's going on, highlights, todos … that should have more of a centralized used framework."*

The question was asked because the platform has answered it four times, separately, and none of the four
is a framework:

| surface | scope | state |
|---|---|---|
| `DashboardHomeView` ([src/pages/cockpit/js/views/DashboardHomeView.js](../../src/pages/cockpit/js/views/DashboardHomeView.js)) | platform-wide — config health, recent tickets, spend, work items, a static changelog | shipped; reads kernel endpoints only, knows nothing about installed apps |
| [src/pages/user-dashboard/](../../src/pages/user-dashboard/) | the same shape again — tickets, agents, cost, activity SSE | shipped and **orphaned**: mounted at `/user-dashboard`, referenced by nothing |
| Switchboard "Today" (ADR-113) | comms only | shipped; the right architecture, one domain |
| kalshi Scorecard / Alerts / Trends | one app | shipped; hand-built inside the package |

Four more live in the store (`career-hunter/engine/jobhunter/dashboard.py`, little-monsters'
`education-dashboard-routes`, `purchasing/tools/shopping-dashboard.html`, `youtube-kids-dashboard.html`).
Every one of them re-answers "what is going on in this app" from scratch.

**ADR-141 already proved the contract shape.** Its `readiness:` block has an app declare a route and two
RFC 6901 pointers; the kernel setup dashboard calls each one *in the signed-in user's own session* and
renders the result. One page, four apps, four unrelated schemas, and core holds no schema knowledge —
portrait-studio answers "42 portraits ready to use" from its own `ps_portraits` rows and the kernel only
ever sees `{"portrait":{"ready":true,…}}`.

What it does not do is scale, and it only answers half the question:

- **Coverage is 4 of 51 store packages** (career-hunter 3 probes, social 2, portrait-studio 1,
  print-ingest 1 — seven probes total) and **0 of 10 kernel manifests**, against **59 active apps** on the
  operator's box.
- **A group is the only renderer.** Exactly one group exists (`intelligent-career`). An installed app that
  belongs to no group has nowhere to report even if it declared a probe.
- **`readiness:` answers "what do you still need to set up", never "what happened."** There is no
  declaration for a headline number.

The "what happened" rail does exist, and it has exactly one consumer. `jarvis_tasks` rows written through
`saveTaskPending`/`finishTask` are grouped by the task title's `App: …` prefix (core #305) and rendered as
a spoken catch-up summary. Nothing else reads them, and an app cannot contribute a number that way — only
a task.

There is precedent for exactly this gap going unnoticed: ADR-085's manifest superset declares a
`settings:` block, `BUILDING-EXTENSIONS.md` says it is "rendered in a settings panel", and **nothing in
core reads it** — kalshi parses its own manifest and renders its own settings. A declaration nobody
consumes is worse than no declaration, and it is what this ADR is written to avoid repeating.

## Decision

An app reports about itself through a declared route, exactly as it already declares readiness. The kernel
renders. Core never learns an app's schema.

### D1 — A `summary:` manifest declaration, the reporting sibling of `readiness:`

```yaml
status:
  path: /api/portrait-studio/status
  tilesPointer: /tiles
  itemsPointer: /items
```

Validated at load by the same fail-closed rules as `readiness:`
([`validateReadinessDeclarations`](../../src/features/swarm-apps/services/swarm-app-group.ts)): the path
must sit below one of **this manifest's own** `routes[].mountPath`s, be canonical (no traversal, encoded
or otherwise), carry valid RFC 6901 pointers, and — the load-bearing half — its owning route must **admit
a browser session**. A `summary:` behind a service-only route is a load error, because status is a fact
about a *person* and the page asks it as that person. This is the mirror of ADR-144's `guestSeed:`, whose
route must instead admit the service secret.

One difference from `readiness:`, deliberately: `readiness:` is an *array* of named probes because a
group's `setup[]` references them individually. `summary:` is a **single declaration per app** — one app,
one card. An app that wants five numbers returns five tiles, not five probes.

### D2 — The response is tiles and items, bounded and fail-closed

```json
{
  "tiles": [ { "label": "Record", "value": "116W–215L", "tone": "warn" },
             { "label": "P&L",    "value": "−$18.24",   "tone": "warn" } ],
  "items": [ { "text": "Both strategies are failing their Brier gate", "tone": "warn" },
             { "text": "4 documents awaiting your approval", "tone": "neutral", "fix": "print-inbox" } ]
}
```

- **`tiles`** — at most **4**. `label` ≤ 24 chars, `value` ≤ 16 chars, optional `tone`.
- **`items`** — at most **5**. `text` ≤ 120 chars, optional `tone`, optional `fix` naming a surface
  (`ui.static[].toolName`) **in the same app**, which the card turns into a button exactly as the setup
  dashboard's `fix` already does.
- **`tone`** is a closed enum — `neutral` (default) | `good` | `warn`. An unrecognised value degrades to
  `neutral`; a wrong tone must never *escalate*, or a buggy app paints the page red.
- **Over-cap truncates, it does not reject.** A chatty app degrades to its first four tiles; it does not
  break the page for every other app.
- **A pointer that does not resolve, or resolves to the wrong type, renders "can't check"** — never as
  fact, and never as zero. This is the ADR-141 rule (`atPointer` reports whether the location exists at
  all) carried across unchanged.

`value` is a **string, not a number**. "116W–215L", "−$18.24", "6 of 9", "3 days" are all real answers.
Formatting is the app's job; core must not invent a unit, a locale, or a rounding rule it cannot know.

The caps are not only a rendering concern. Four tiles and five items force the app author to decide what
actually matters, which is the entire product value of the page.

### D3 — The kernel page grows a highlights section; it does not become a second page

[`src/pages/cockpit/tools/app-group-setup.html`](../../src/pages/cockpit/tools/app-group-setup.html)
gains a **What's going on** section above the existing steps, and its heading drops the "— setup" suffix.
The fetch discipline is unchanged and non-negotiable: the page asks every probe **itself, in the viewer's
own session** (`credentials: 'same-origin'`), never with a service secret and never with a PAT.

Rendering order is highlights, then "What still needs you" with the existing `N of M steps done` count.
An app with a `summary:` and no `readiness:` shows only the first section; the reverse shows only the
second; today's groups keep today's page until their members declare anything.

### D4 — The page addresses an app or a group, so an app in no group still reports

The route generalises from `GET /api/swarm/apps/:name/setup-dashboard` to a status dashboard that accepts
**either an active group or an active app**. When `:name` is a group, the plan fans out over its members
as today; when it is an app, the plan is that one app.

This is deliberately *not* solved by synthesising an implicit one-member group. A synthetic group would
leak into ribbon synthesis, the toolbar resolver, and `assertGroupResolvable`, and would put a second kind
of group in the loader for a rendering convenience. Resolving a name to `members: [name]` at plan time
costs one branch and touches nothing else.

### D5 — An app that declares nothing still gets a card, built from `jarvis_tasks`

With no `summary:` block, the kernel composes items from the app's own recent `jarvis_tasks` rows for this
user — the existing `App: …` title-prefix convention (core #305) — most recent three, each carrying its
age the way `buildOpenWorkBlock` already does.

This is the **only** data the kernel reads on an app's behalf, and it is kernel-owned data: `jarvis_tasks`
is a core table with a core schema, not an app's store. It is what keeps the page useful on day one
instead of empty until 51 packages ship an update, and it gives an app a zero-cost upgrade path — file
tasks titled `<App>: …` and you appear; declare `summary:` when you want numbers.

### D6 — What the kernel must never do

Stated as rules because each one is a design temptation that would work in a demo and rot in production:

1. **Never query an app's tables.** The reason one page renders four unrelated schemas today is that it
   cannot. A kernel that reads `ps_portraits` is a kernel that breaks when portrait-studio migrates.
2. **Never hold app schema knowledge** — no per-app formatter, no `if (app === 'kalshi')`.
3. **Never call a summary probe with the service secret or a PAT.** Per-user data is read in the user's own
   session or not at all; this is what makes RLS and ownership hold without core enforcing them.
4. **Never render an unresolvable pointer as fact.** "Can't check" is a legitimate, honest state; a green
   check an app did not assert is not.

### D7 — Bounds, because 59 apps land on one page

- **Per-probe timeout 3s** → that card renders "can't check" and the page moves on.
- **Concurrency cap** (6 in flight) so a full fan-out does not open 59 sockets at once.
- **One probe's failure never blocks another** — `allSettled`, the discipline `DashboardHomeView` already
  uses and the reason it degrades per-card today.
- **Probes are GET and must be side-effect free.** The kernel may call one on every page load, every
  refresh, and concurrently for the same user in two tabs. Declaring a `summary:` that mutates is a bug in
  the app.

### D8 — What this is not

- **Not a metrics or telemetry system.** No time series, no history, no retention. kalshi's Trends tab
  stays kalshi's; the card is the *summary*, the app's own surface is the depth.
- **Not a notification rail.** `jarvis_tasks` is that, and D5 reads it rather than competing with it.
- **Not automation.** The only action is the existing `fix` deep-link into a surface the same app owns.
- **Not a replacement for app-owned dashboards.** A rich app keeps its own screen and gains a card.

### D9 — A global Home is the natural second renderer, and it is not in this ADR

The same contract composed across every installed app — one card per app on one page — is what the
operator originally described, and it needs nothing this ADR does not already define: a second renderer
over the same plan. It is deferred on ADR-141's own staging lesson (ship the contract, prove it on one
page, then widen), and because it forces two decisions this ADR does not have to make — what supersedes
`DashboardHomeView`, and what happens to the orphaned `src/pages/user-dashboard/`. Tracked in
[BACKLOG](../BACKLOG.md) with done-when criteria.

## Consequences

**Good**

- The reporting mechanism becomes a declaration instead of a bespoke surface. The next app answers "what's
  going on" in one manifest block and one route, not a new page.
- It composes with what shipped: same page, same probe discipline, same fail-closed validation, same `fix`
  navigation. Nothing new to learn for anyone who has written a `readiness:` block.
- Honest by construction — an app can only claim what it will assert over its own route, in the caller's
  own session, and an unreachable probe says so.
- D5 means adoption is incremental with a useful floor, not a cliff.

**Costs / risks**

- A core change: one manifest field, its validation, a generalised plan route, a page section, and the
  `jarvis_tasks` fallback query. The core is load-bearing and this is a real edit to it.
- **A card is only as honest as its app.** ADR-141 accepted the same risk for readiness ("a probe that
  answers ready from a cached flag is a lie the dashboard will faithfully render") and it applies here with
  more surface area, because a number reads as more authoritative than a checkmark.
- Fan-out cost grows with installed apps. D7 bounds it; a global Home (D9) would need a harder bound and
  probably a cache, which is part of why it is deferred rather than assumed.
- One more manifest key to keep honest. The `settings:` precedent is the warning: **if this ships without
  a consumer, it should not ship.** The page and the field land together or not at all.

## What would be built

Core, one PR, additive — no app declares `summary:` on merge, so the page behaves exactly as it does today
until one does:

- `SwarmAppSummaryDeclaration` + `status?:` on `SwarmAppManifest` ([src/features/swarm-apps/types.ts](../../src/features/swarm-apps/types.ts))
- `validateSummaryDeclaration` beside the readiness validator ([swarm-app-group.ts](../../src/features/swarm-apps/services/swarm-app-group.ts)),
  plus the pure coercion for D2's caps/enums/truncation
- `buildHomePlan(manifests)` — resolves a group **or** an app to members + each one's status/readiness probes
  ([swarm-app-service.ts](../../src/features/swarm-apps/services/swarm-app-service.ts))
- the generalised dashboard route ([swarm-app-routes.ts](../../src/app/routes/swarm-app-routes.ts)) and the
  `jarvis_tasks` fallback read
- the highlights section in [app-group-setup.html](../../src/pages/cockpit/tools/app-group-setup.html)

Store, per app, independently: a `summary:` block and one session-authenticated GET. kalshi is the obvious
first adopter — it already computes every number this contract asks for.

**Guards** (per the guard-per-fix directive, in the same change):

- manifest validation fails closed on a `summary:` that is unowned, non-canonical, service-only, or carries
  a malformed pointer — extends `tests/unit/swarm-app-groups.spec.ts`, the file that already proves this
  for `readiness:` and `guestSeed:`
- a pure spec for D2: caps truncate, unknown tone degrades to `neutral` and never escalates, a wrong-typed
  pointer yields "can't check"
- **a real-boundary case** (integration-boundary corollary): the plan route against a live app probe over
  a real HTTP mount, not a mocked resolver — the boundary whose failure the contract exists to prevent is
  the app-declares/kernel-calls seam, so that seam is what the guard must cross. Recorded in the
  [real-boundary audit](../governance/real-boundary-regression-audit.md).

## Alternatives considered

**Let the kernel read app databases.** Rejected on D6.1. It is why the shipped page works across four
schemas, and it would convert every app migration into a core regression.

**A generic metrics/event bus every app publishes into.** Rejected: it inverts ownership (the app pushes
state core must then store, age, and evict), duplicates `jarvis_tasks`, and makes core responsible for
data it cannot interpret. The pull-from-a-declared-route shape is already proven here.

**Extend `readiness:` to carry numbers instead of adding `summary:`.** Rejected: `readiness:` is
boolean-by-contract (`readyPointer` resolves to `true` or the step is not done) and a group's `setup[]`
references entries by name. Overloading it would either break that contract or bolt an optional shape onto
every existing probe. Two declarations with one page is cleaner than one declaration with two meanings.

**Ship the `summary:` field now, render it later.** Rejected explicitly — that is the `settings:` outcome:
a documented manifest key that nothing consumes, which package authors then work around by re-implementing
it themselves.

**Build the global Home first.** Rejected as sequencing (D9), not as direction.
