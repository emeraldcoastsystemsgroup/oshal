# ADR-118: Swarm-wide app access tiers — deny / viewer / editor / admin

Date: 2026-07-28
Status: Accepted. Phase 2 is implemented locally; protected-branch promotion, migration 121,
and a deployed enforcement canary remain operational gates.

## Context

ADR-117 gave a deployment a controlled front door (invited logins). The operator's follow-on
policy (2026-07-28): **every application must define its access in a standard vocabulary** —
"at least 4 levels: deny (explicit), read, change, admin" — so that adding a user to a box
never requires learning each app's private permission language.

That vocabulary already IS the industry standard. Azure RBAC (Reader / Contributor / Owner),
Google IAM (Viewer / Editor / Admin), Kubernetes (view / edit / admin) all converge on the same
ladder, and AWS contributes the fifth rule everyone copies: **an explicit deny beats any allow**.

What existed when this contract was chosen:

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

Baseline mappings considered by the decision:

- **intelligent-sales design**: `deny` = no rep row or `active=false` (an uninvited login sees
  nothing); `editor` = `rep`/`team_lead`/`manager` templates; `admin` = `app_admin`. It does
  not offer a `viewer` bundle in v1 — a read-only role is an allowed refinement gap. The
  package itself is not present in either current repository, so this is a historical mapping,
  not a claim that its manifest declaration has shipped.
- **Guest matrix**: `blocked`→`deny`, `readonly`→`viewer`, `full`→ the app default — the
  anonymous-user projection of the same ladder.

## Consequences

- The vocabulary is executable schema. Manifest loading and `oshal-app validate` reject unknown
  fields, unknown tier names, duplicate tiers, missing `deny`, unsupported defaults and mappings
  to unsupported tiers. A missing declaration still preserves the app's legacy behavior.
- Migration 121 provides the FORCE-RLS `oshal_app_access` store keyed by exact
  `(user_sub, app_name)`. Explicit assignments win over manifest defaults; an explicit `deny`
  always wins, and an assignment made stale by a later manifest fails closed to `deny`.
- The framework-owned operator API and Applications cockpit matrix list, assign and clear tiers.
  Apps cannot administer the platform doorway or self-promote.
- Both route shapes enforce the same decision after authentication and before app code: dynamic
  package routes in `ManifestRouteMounter`, and hard-mounted kernel routes in the global app gate.
  `deny` returns `app_access_denied`; viewer mutations return `app_readonly`; database or wiring
  failure returns 503. Verified delegated-user identities are evaluated as that user. Truly
  anonymous requests remain the guest capability matrix's responsibility.
- Ten kernel manifests now declare their behavior-preserving defaults. Store packages adopt the
  declaration as they are audited; the missing intelligent-sales source remains a catalog-recovery
  item rather than being fabricated in the kernel.
- Rollout order is migration 121 → `OSHAL_APP_ACCESS_MODE=shadow` observation → seed explicit
  assignments → `enforce` app by app. Enforcement is the default and the fail-closed fallback for
  an unknown mode. Merge, deployment and exact-SHA canary evidence are not implied by this ADR.
- The trade: a coarse ladder can never express "may edit leads but not export" — deliberately.
  That granularity lives (and stays) in the app's capability model; the ladder is what a
  platform admin can reason about across many apps at once.
