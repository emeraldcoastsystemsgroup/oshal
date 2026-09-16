# ADR-157: Scheduled application services run under an activated principal

Date: 2026-09-14
Status: **Accepted by the operator (2026-09-14); implementation in progress — see "Implementation" for what
is built. Amended 2026-09-16 — implementing S3 measured two claims in "Consequences" to be wrong (the service
class of three of the five schedules, and the RLS guarantee), and found that a protected application with no
imported permission catalog cannot run a system service at all. All three are recorded under "Amendment"; the
catalog-less finding is an open question for the operator, not a decision this ADR makes.**

Related: [ADR-149](149-enterprise-application-authorization.md) (application authorization — its §7 already
states the rule this ADR builds the mechanism for), [ADR-148](148-swarm-root.md) (swarm roles),
[ADR-145](145-app-status-contract.md) (setup dashboard and readiness), [ADR-141](141-application-groups.md),
[ADR-085](085-remote-app-packages-and-registries.md) (manifest schedules and the per-user instances),
[ADR-136](136-trading-surface-information-architecture-and-direct-trades.md) (the per-user `trading-events:<sub>` legs, the working precedent).

## Context

A package manifest may declare `schedules:` — a cron expression bound either to an agent prompt or, since
ADR-085's service-route target, to a deterministic handler in the package's own compiled routes. The
service-route runner (`src/app/manifest-service-route-schedule.ts`) executes every tick through
`runWithApplicationExecution({ app, kind: 'jobs', operation: scheduleId })`, which — when the application is
protected under ADR-149 enforce mode — requires an active authorization actor and refuses with
`authorization_execution_identity_required` when there is none.

A cron tick has no request and therefore no actor. Measured on the operator's box on 2026-09-14 (api log from
the 22:31Z recreate): every one of the five service-route schedules registered at boot belongs to a protected
application, and the three that came due were refused every time —
`intelligent-sales-email-auto-log`, `daily-trade-recap-recorded-reports`, `venture-plan-rebaseline-policy-tick`;
`marketing-engine-daily-metrics-ingest` and `marketing-engine-weekly-campaign-review` fail the same way when
due. The wrapper landed on 2026-09-10 (`0cfe4d9b`), so the jobs have been silently dead since, each failure a
single ERROR line nobody reads.

The refusal itself is correct. ADR-149 §7 says of a scheduled job: *run as an explicitly granted service
principal, or a recorded user delegation; missing user identity is never permission to become system.* What
was missing is the way to grant either — nothing in the kernel lets a job obtain a principal, and nothing shows
a person that a declared job is not running.

Two things already exist and are reused rather than replaced:

- **Per-user schedule instances.** `scope: 'per-user'` prompt schedules register one instance per person,
  `app:{name}-{scheduleId}:{sub}`, owner-scoped, torn down when the app is toggled off
  (`src/app/swarm-app-schedule-wiring.ts`); the trading package's `trading-events:<sub>` legs run this way
  today and dispatched normally in the same window the service-route jobs were refused.
- **The authorization contract.** An installed application imports a permission catalog (`permissions`,
  `roles`), assignments target a `(sub, issuer)` with a role or a single permission, and `authorize(actor,
  operation)` decides with current rights (`src/features/application-authorization`). Nothing here grants; it
  evaluates what an administrator assigned.

## Decision

**Every scheduled application service runs under a principal that a person activated, and nothing runs by
declaration alone.** A declared schedule is a *capability the package offers*; it executes only after an
activation, and an activation names exactly one of two principal classes.

### The two classes

| Class | Runs as | Who activates | Typical example |
|---|---|---|---|
| **System service** | the application's own **service principal** — one per application (per tenant), holding exactly the permissions the service declares | a **swarm administrator** (ADR-148 root or admin), who thereby classifies the service as a system service | marketing-engine daily metrics ingest, weekly campaign review |
| **User service** | the **person who activated it**, as themselves | **any user of the application**, for themselves only, from the application's configuration | "auto-log my sales email", "collect my recap briefings", "evaluate my rebaseline policies" |

A system service **acts as the application, never as a person**: its principal owns what it writes and, by
row-level security, cannot read or write person-owned rows (its `sub` matches no person). A job that needs a
person's data is a user service by construction. This is the rule that keeps "authorized for what it needs"
honest — the service principal's grant is the declared permission list and nothing else.

### Declaration (manifest)

A service-route schedule of a protected application declares its class and its needs:

```yaml
schedules:
  - id: daily-metrics-ingest
    target: service-route
    cron: "15 6 * * *"
    route: /api/marketing/ingest
    handler: runDailyIngest
    runsAs: system              # system | user  — the package's proposal; activation confirms it
    requires: [metrics:write]   # permission names from this app's imported authorization catalog
    description: Pull yesterday's channel metrics into the scorecard.
```

- `runsAs` is the package's **proposal**. A `user` service can only be activated by users; a `system` service
  only by swarm administrators. A manifest that omits `runsAs` still loads, but the schedule is
  *unclassified*: it cannot be activated until an administrator classifies it, and that classification is
  recorded with the activation. A package cannot escalate itself — declaring `system` grants nothing.
- `requires` names permissions from the application's own catalog (ADR-149 §4). The loader refuses a manifest
  whose `requires` names a permission the catalog does not define. For a user service the activating person
  must currently hold them; for a system service the activation grants exactly them to the service principal.
- The existing `scope: 'per-user'` (connector-triggered polls) keeps its meaning and is a user service whose
  activation happens on connect; `scope: 'framework'` is retired for service-route schedules of protected
  applications — the class comes from `runsAs`. Unprotected applications (ADR-149 legacy mode) are unchanged:
  their jobs run as framework jobs with no actor, exactly as today.

### Activation record and principals

- A new table, `oshal_application_service_activations`, holds one row per activation: `app`, `schedule_id`,
  `runs_as`, the target person for a user service (`target_sub`, `target_issuer`) or none for a system
  service, `tenant_id`, `requires` as recorded at activation, `catalog_revision`, who activated it and when,
  who revoked it and when, and a `suspended_reason` (below). Row-level security: swarm administrators and
  application administrators see an application's rows; a person sees their own.
- The **service principal** of an application is the actor `{ sub: 'service:<app>', issuer:
  'oshal:application-service' }` (per tenant when tenancy is in force). It is minted on first system
  activation, never holds `isOperator`, and receives its permissions as ordinary assignments in
  `oshal_authorization_assignments` tagged `grantSource = 'service-activation:<activation id>'`, so
  deactivation revokes exactly the assignments the activation created. (As built: the assignment's
  `source` column stays the application's installation source, because that is what binds an
  assignment to its registration in `matchingAssignments`; the activation tag is a separate field.
  The evaluator gains exactly one narrow rule for this shape — a non-deny assignment naming a single
  catalog permission grants that permission at scope `own` and raises the tier only to what the
  permission itself declares. The management API cannot create such a row, because a `grant` change
  requires a role, so the rule is inert for every assignment an administrator made.)
- A **user activation** creates the per-user schedule instance `app:{name}-{scheduleId}:{sub}` (the existing
  mechanism) and records the activator's `(sub, issuer)`; deactivation deletes the instance and closes the row.

### Execution

At each tick the runner resolves the activation for the schedule instance it is dispatching:

- **system** → one run, with the service principal as the authorization actor and as the request identity
  (`runWithRequestIdentity({ sub, principalIssuer, isOperator: false })`), through
  `runWithApplicationExecution({ app, kind: 'jobs', operation })` exactly as today.
- **user** → one run per per-user instance, with that person as the actor and `userSub` pinned, so a mismatch
  is refused by the existing guard.
- **no activation** → the tick is **skipped**, logged at INFO as `Manifest service-route schedule skipped:
  not activated`, and reported by the application's readiness (ADR-145) as a to-do — never an ERROR line.
- **denied at run time** (rights changed since activation) → the activation is marked
  `suspended` with the decision's reason, the tick logs it once, and the panel shows it, so a silent
  failure like the one that motivated this ADR cannot recur. Reactivation clears the suspension after a fresh
  authorization.

Current rights are rechecked on every tick — the activation records who asked for the job and under which
catalog revision; it never freezes a permission.

## How to activate

The operator's direction, verbatim in spirit: *the portal admin logs in and activates cron jobs; a system
service runs under an application service user authorized for what it needs; a front-end service like
"summarize my emails" runs as the user checking the box in the application config; swarm admins select the
services that are system services and activate them; any user can activate a user service to run under
their own auth.* The flows below are that, with the kernel doing the rendering so packages never hand-roll a
checkbox.

### One panel, rendered by the kernel

`GET /api/swarm/apps/<name>/services` returns the application's declared services with, for each: id,
description, cadence in words, class (proposed / classified), the `requires` list resolved against the
catalog (permission, resource, effect), and state — *not activated*, *active as system service since <date>
by <admin>*, *N users active*, *active for you*, *suspended: <reason>*. The **Scheduled services** panel of
the application's setup dashboard (ADR-141/145, `/api/swarm/apps/<name>/setup-dashboard`) renders it, and the
same JSON feeds a small shared component a package may embed in its own settings surface, so "the checkbox in
the application config" is the kernel's checkbox.

### A swarm administrator activates a system service

1. Open the application's setup dashboard (from the Applications console, the app's Home card, or `/access`,
   which links to it because activating a system service is an authorization act).
2. The panel lists each service with its proposed class and its required permissions. For an unclassified
   service the administrator first chooses the class; choosing **system** is only offered to swarm
   administrators.
3. **Activate as system service** opens a confirmation that states exactly what will be granted: "the
   `marketing-engine` service principal will hold `metrics:write` (resource `scorecard`, effect `write`) and
   nothing else; every run is audited under that principal." Confirming posts
   `POST /api/swarm/apps/<name>/services/<id>/activate { runsAs: 'system' }`.
4. The kernel checks the caller's swarm role, mints or reuses the application's service principal, writes the
   assignments (source-tagged to this activation), records the activation with the administrator's identity,
   registers the schedule instance, and returns the new state. The readiness to-do disappears.
5. **Deactivate** reverses every step and revokes exactly those assignments. The audit history under `/access`
   shows both actions with actor, time and the permission list.

### A user activates a user service

1. Open the application (its settings surface, or the setup dashboard's panel). User-class services appear
   with a checkbox: **Run for me** — e.g. "Auto-log my sales email every 10 minutes".
2. Checking it posts `POST /api/swarm/apps/<name>/services/<id>/activate { runsAs: 'user' }` under the
   caller's own session. The kernel authorizes the caller for the service's `requires` **now**; a person who
   lacks a permission gets the application's role-guidance page (the same 403 shape the rail uses), not a
   silent no-op.
3. On success the per-user instance `app:{name}-{id}:{sub}` is registered and the row records the person's
   `(sub, issuer)`. Unchecking deactivates it. A person can only ever activate for themselves; an
   administrator can see counts and deactivate a person's activation, and can never activate on someone's
   behalf — that would be acting as them.

### After installation, before anything runs

Installing an application imports its permission vocabulary and registers its declared services; it grants
nothing and starts nothing. The setup dashboard's readiness lists "N scheduled services awaiting
activation" until an administrator activates the system ones; user services are shown as available and are
never a readiness blocker. This is the "portal admin logs in and activates cron jobs" step, and it is visible
rather than assumed.

### Jarvis

"Turn on my email auto-log" and "which scheduled services are running for me?" go through the same route
under the asker's own authority, via the registered authorization tool (ADR-149 §9), in a later slice.
Jarvis never activates a system service.

## Consequences

- **Silent failure ends.** A declared-but-inactive service is a visible to-do; a refused run suspends its
  activation with the reason in the panel. The five schedules on the operator's box stop failing on the next
  deploy: they skip until activated, then run under the class their packages declare.
  *(The last clause does not hold today for a catalog-less application — see
  [Amendment C](#c--a-catalog-less-protected-application-cannot-run-a-system-service-at-all-open).)*
- **Packages classify their services.** The public-store packages carrying the five schedules declare
  `runsAs`/`requires` in a follow-up: `daily-trade-recap` recorded-reports → **user** (it collects per
  registered owner), `venture-plan` rebaseline tick → **user** (owner-scoped policies), `marketing-engine`
  daily ingest and weekly review → **system** (workspace metrics, a review ticket); the private
  `intelligent-sales` email auto-log → **user**. Until a package declares, an administrator classifies at
  activation.
  **Corrected 2026-09-16: three of those five predictions were wrong.** `daily-trade-recap`, `venture-plan`
  and `intelligent-sales` are **system** services, and S3 declared them so; only the two `marketing-engine`
  predictions held. The prediction is left standing above because it is what the decision was weighed
  against — what the handlers actually do, and the rule that generalises from it, is in
  [Amendment A](#a--three-of-the-five-are-system-services-not-user-services).
- **System services cannot touch person-owned rows.** That is enforced by RLS on the service principal's
  `sub`, not by convention; a package that needs person data for a job declares a user service.
  **Corrected 2026-09-16: this guarantee binds none of the five schedules.** Each handler calls
  `runWithSystemIdentity` itself, which blanks `oshal.current_sub` and stamps `oshal.is_operator='on'`, so the
  service principal's `sub` never reaches the connection RLS evaluates. What the service principal actually
  constrains, and what would have to change for the stronger guarantee to be real, is in
  [Amendment B](#b--the-rls-guarantee-binds-none-of-the-five-schedules).
- **Legacy mode is untouched.** Applications that are not protected run their framework jobs as before, so a
  box without ADR-149 enforce sees no change.
- **The authorization core grows by one concept** — the application service principal — expressed entirely
  through existing assignments and the existing evaluator. No new grant path, no bypass, no `isOperator`.
- **Cost:** activations are one more thing to set up after install. The readiness to-do and the one-screen
  confirmation are the mitigation; the alternative (running as the installer by default) is exactly the
  escalation ADR-149 §7 forbids.

## Amendment

*2026-09-16. Recorded while implementing this ADR's own slice S3. Nothing in "Context", "Decision" or "How to
activate" changes; the corrections below are to "Consequences", which predicted rather than measured. The
original predictions are left in place above so the record shows what the decision was made against.*

### A — Three of the five are system services, not user services

**Predicted:** `daily-trade-recap` recorded-reports → user, `venture-plan` rebaseline tick → user, the private
`intelligent-sales` email auto-log → user. **Measured:** all three are **system** services, and S3 declared
them `runsAs: system`. The two `marketing-engine` predictions (system) held.

What the handlers do, read 2026-09-16:

- `daily-trade-recap/src-routes/completed-report-briefings.ts` — `recordedRows()` selects
  `user_sub, et_day, summary FROM oshal_trading_strategy_journal WHERE kind='report' AND source='daily-report'`
  inside `runWithSystemIdentity`, bounded by time and a row limit and by **no owner predicate**; `admitRows()`
  then files each row to whichever owner the row itself names.
- `venture-plan/src-routes/venture-rebaseline-routes.ts` — `runDueRebaselineTick` runs its whole loop inside
  `deps.withSystemIdentity` (default `runWithSystemIdentity`), lists `listEnabledRebaselinePoliciesSystem(ctx.pool)`
  — every owner's enabled policy — and starts each one with `policy.ownerSub`.
- `intelligent-sales/lib/is-email-sync.js` — `runSync` selects
  `rep_id, user_sub, display_name FROM sales_reps WHERE tenant_id = $1 AND active = true AND user_sub IS NOT NULL`
  and calls `outlookMailSync({ userSub: rep.user_sub })` for **every active rep in the tenant**. The scheduler
  entry point `runEmailSync` wraps it in the package's `runWithIdentity`, which resolves to the kernel's
  `runWithSystemIdentity`. That is a roster sweep, not "my mailbox".

**The rule that generalises, and the reason this correction is worth the space: a `user` activation on a
handler like these would be a false claim.** The kernel does its half correctly — a user activation registers
a per-user instance and pins `userSub` — but the pin only constrains what the kernel passes *in*; it cannot
constrain what the handler *queries*. A handler that ignores the request identity and sweeps the table would
read person B's rows under person A's identity, with A's "run this for me" checkbox as the audit record of
why. So the class is a property of **what the handler reads**, not of who the output is for: these three
produce per-person output while reading across everyone, which makes them system services that fan out.

The practical test when classifying a schedule: if two people each activated it for themselves and the second
activation would do the same work over the same rows as the first, it is not a user service.

### B — The RLS guarantee binds none of the five schedules

**Predicted:** a system service "cannot read or write person-owned rows (its `sub` matches no person) …
enforced by RLS on the service principal's `sub`, not by convention". **Measured:** no handler among the five
is constrained that way, because each one opens system database scope for itself before it queries.

`runWithSystemIdentity` runs its callback under the frozen `SYSTEM_IDENTITY` sentinel —
`{ sub: null, principalIssuer: 'urn:oshal:system', isOperator: true, system: true }`
(`src/shared/services/database/request-identity.ts`) — and the GUC pool's system branch stamps the connection
`set_config('oshal.current_sub', '', false), set_config('oshal.is_operator', 'on', false)`
(`src/shared/services/database/guc-pool.ts`, the `isSystemIdentity(id)` branch). The service principal's `sub`
is not what reaches the connection: it is blanked, and the operator flag — the flag ownership policies test —
is on. All five handlers do this: the three in Amendment A, plus `marketing-engine`'s
`runMarketingDailyIngest` and `runMarketingWeeklyReview`, both of which open `runWithSystemIdentity` in
`src-routes/marketing-ops-routes.ts`.

**What actually holds today:** the service principal decides **whether the job may run, not what it may
read**. `authorize()` is consulted at every tick with the activation's principal and `kind: 'jobs'`; past that
gate the handler's database scope is whatever the handler opens. So `requires:` is admission control on the
job plus the audit record of what an administrator agreed to — it is a real check, and it is not a data fence.
The rest of the Decision is unaffected: activation is still required, rights are still rechecked every tick,
and a denial still suspends.

**What would have to change for the stronger guarantee to be real** (stated so the gap is legible, not
designed here): the connection would have to be stamped with `service:<app>` for the duration of the run
rather than with the system sentinel, which means the runner would have to establish that scope and the kernel
would have to **refuse** — not merely discourage — a handler that re-opens system scope inside an activated
run; and every table such a job touches would need a policy admitting `service:<app>` to exactly the rows its
declared permissions cover. That last part is not uniformly available: `intelligent-sales` records in its own
source that the `sales_*` tables it touches are not RLS-fenced at all, citing the public-launch isolation
audit. None of this is decided here.

### C — A catalog-less protected application cannot run a system service at all (open)

Measured 2026-09-16 against the real `ApplicationAuthorizationService` backed by `MemoryAuthorizationStore`.
An application registered `mode: 'enforce'` with no imported permission catalog takes the `!app.catalog` branch
of `authorize()` (`src/features/application-authorization/service.ts:159-163`), which admits only an actor
holding the `@app-admin` role at tier `admin`. A system activation grants the service principal the schedule's
declared permissions as ordinary assignments; it does not make that principal an application administrator. So
the principal falls to the branch's refusal:

```
service:venture-plan => { allowed: false, reason: 'authorization_app_admin_required', tier: 'deny' }
```

None of the four packages carrying the five schedules imports a permission catalog today. On such an
application a system activation therefore grants the principal nothing the evaluator will accept: the first
tick is denied and the activation suspends with that reason. That is visible rather than silent, which is what
this ADR bought — but it means "they skip until activated, then run" in the first Consequences bullet does not
hold for a catalog-less application, and the five schedules on the box do not start running on activation
alone.

**This is recorded as a known gap, not resolved.** It is an open decision for the operator; no resolution is
proposed or chosen here.

## Implementation

| Slice | Content | Proof |
|---|---|---|
| S1 — kernel contract | manifest `runsAs`/`requires` validation; migration 144 `oshal_application_service_activations`; service principal + source-tagged assignments; runner: skip-when-inactive, per-user instances with the person as actor, suspension on denial; routes `GET /api/swarm/apps/:name/services`, `POST …/services/:id/activate`, `DELETE …/services/:id/activation` (swarm-admin gate for system, self for user) | loader refuses an undefined permission; a real-Postgres spec activates a system service and proves the service principal passes `authorize()` for exactly the declared permission and fails another; a user activation runs as that person and a second user cannot deactivate it; a non-admin activating `system` gets 403; an inactive schedule logs `skipped` at INFO; a denied tick suspends |
| S2 — surfaces | the Scheduled services panel on the setup dashboard; the readiness to-do; the shared component; the `/access` link; operator guide "Activating scheduled services" | browser spec for the panel states; the signed-in click-through on the box |
| S3 — packages | `runsAs`/`requires` on the five schedules above (store, then private) | the packages' Test Lab catalogs register the activation cases |
| S4 — Jarvis | the authorization tool learns the two questions above | known-answer spec |

Status of each slice is recorded in [docs/BACKLOG.md](../BACKLOG.md) under "Every deterministic service-route
schedule on this box is refused under ADR-149 enforce".
