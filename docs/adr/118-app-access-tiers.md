# ADR-118: Swarm-wide app access tiers — deny / viewer / editor / admin

Date: 2026-07-28
Status: Accepted (the contract). Platform enforcement is Phase 2 — see Consequences.

## Context

ADR-117 gave a deployment a controlled front door (invited logins). The operator's follow-on
policy (2026-07-28): **every application must define its access in a standard vocabulary** —
"at least 4 levels: deny (explicit), read, change, admin" — so that adding a user to a box
never requires learning each app's private permission language.

That vocabulary already IS the industry standard. Azure RBAC (Reader / Contributor / Owner),
Google IAM (Viewer / Editor / Admin), Kubernetes (view / edit / admin) all converge on the same
ladder, and AWS contributes the fifth rule everyone copies: **an explicit deny beats any allow**.

What exists in this codebase today:

- The **guest capability matrix** is this exact ladder for anonymous users, per app:
  `blocked` / `readonly` / `full` — but it is global per app, not assignable per user.
- **intelligent-sales** has a full capability model (17 capabilities, 4 role templates,
  overrides, delegation) that happens to map cleanly onto the ladder.
- Most personal apps have **no roles at all** and rely on per-user data isolation (RLS by sub),
  which is correct for them — a single-user app's ladder collapses to deny/admin.
- There is **no platform contract** requiring an app to declare any of this, and no per-user
  per-app tier assignment.

## Decision

**The ladder is the contract.** Four tiers, fixed names, fixed semantics:

| Tier | Meaning | Industry twin |
|---|---|---|
| `deny` | No access to the app's surfaces or APIs. **Explicit deny always wins** over anything else that would grant access | AWS explicit deny |
| `viewer` | Read everything the app would show this user; change nothing | Reader / Viewer / view |
| `editor` | Viewer + create and change the app's records; no app administration | Contributor / Editor / edit |
| `admin` | Editor + the app's own administration: its users, settings, destructive operations | Owner / Admin / admin |

Rules of the contract:

1. **Every packaged app declares its mapping** in its manifest (`access:` block): which tiers it
   supports, what its default tier for a signed-in user is, and — when it has an internal
   capability model — which internal bundle each tier resolves to. Apps refine WITHIN tiers,
   never across them: intelligent-sales' BDO vs Leads administrator are both `editor`-class
   (different scope and extras); its `app_admin` is `admin`. A personal app may declare only
   `deny`/`admin` (owner-only) — the collapse is legitimate and must be explicit.
2. **Deny is always available** on every app, whatever else the app supports.
3. **Tier is coarse platform vocabulary; capability stays app truth.** The platform ladder gates
   the door per user per app; inside the door, the app's own model (capabilities, RLS, record
   visibility) keeps authorizing exactly as it does today. This preserves the ADR-036 boundary:
   the platform authenticates and doors; apps authorize.
4. **A missing declaration means the app's current behavior**, unchanged — this is opt-in per
   app, rolling out with each app's next release, not a flag-day break.

Conformance of what already shipped (by construction, no code change):

- **intelligent-sales**: `deny` = no rep row or `active=false` (an uninvited login sees
  nothing); `editor` = `rep`/`team_lead`/`manager` templates; `admin` = `app_admin`. It does
  not offer a `viewer` bundle in v1 — a read-only role is an allowed refinement gap, declared
  as unsupported rather than faked.
- **Guest matrix**: `blocked`→`deny`, `readonly`→`viewer`, `full`→ the app default — the
  anonymous-user projection of the same ladder.

## Consequences

- Phase 1 (this ADR): the vocabulary and the conformance mapping are binding on every future
  app and every manifest review. A new app that invents a fifth access word fails review.
- **Phase 2 (BACKLOG, with done-when): the platform primitive** — an `oshal_app_access` store
  (user_sub × app × tier, explicit-deny-wins), an operator/admin API + cockpit surface to set
  tiers, and an enforcement middleware at the app-route boundary (deny → 403 everywhere;
  viewer → read-only enforcement in the shape the guest Tier-B lockdown already proves out).
  Until Phase 2 lands, tier changes are made in each app's own admin (the CRM's Users screen),
  which is why nothing here blocks the client-box install.
- Phase 3: kernel apps' manifests grow their `access:` declarations at their next touch.
- The trade: a coarse ladder can never express "may edit leads but not export" — deliberately.
  That granularity lives (and stays) in the app's capability model; the ladder is what a
  platform admin can reason about across twenty apps at once.
