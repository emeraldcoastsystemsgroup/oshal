# ADR-144: The guest-seed contract — apps own their guest demo data, core marries it to the identity

- Status: Accepted — stage 1 (core contract + orchestrator) BUILT 2026-09-08; career-hunter is the first app to declare a hook (store repo); finance + the core tickets demo migrate as fast-follows.
- Date: 2026-09-08
- Supersedes: the "kernel-side deliberately — guest sessions are a framework concern" note in `src/app/routes/guest-demo-seed.ts` (SEQ 3), for the DATA half.

## Context

Guest mode (`ENABLE_GUEST_MODE`) mints a fresh per-browser `guest-<uuid>` on `POST /api/guest/start` so an anonymous visitor can tour the public demo without a Google login. To make the tour show a working system rather than empty states, the guest needs seeded demo data.

Today that seeding lives in **core**: `src/app/routes/guest-demo-seed.ts` hardcodes a fake finance aggregate, demo tickets, and (added 2026-08-12) a fictional career-hunter resume. This is backwards. It couples core to individual apps' data models (finance tables, the career engine's `career_db.json`), it grows every time an app wants demo data, and it violates the platform's own rule that an app owns its domain and reaches core only by declared contract (ADR-036, ADR-085, Rule 0c). The operator's direction (2026-09-07): *"set it up in the application not in the core, and have core understand guest mode to marry guest profiles to guest data seeding."*

The platform already has the exact shape for "an app declares a route core calls": ADR-141's `smoke:` (service-auth probe) and `readiness:` (per-user, session-auth probe). A guest seed is their **mutation** sibling.

## Decision

A **guest-seed contract**. Guest-mode DATA seeding becomes the app developer's responsibility; core owns only the guest identity and the fan-out.

1. **Manifest field `guestSeed: { path }`** (`SwarmAppManifest`). `path` is a POST route below one of the app's own `routes[].mountPath`s. Validated fail-closed at load (`validateGuestSeedDeclaration`, `swarm-app-group.ts`) exactly like `readiness:`, but **inverted on auth**: the owning route must admit the **service secret** (`service` or `service-or-oidc`), because core — not a browser session — is the caller. A seed behind a session-only route is a load error, not a silent miss.

2. **Core orchestrator** (`src/app/routes/guest-seed-orchestrator.ts`). On guest-start, `runGuestSeeds` fans out to every installed, active app that declares `guestSeed:` and POSTs its hook on the loopback origin (`http://127.0.0.1:<port>`) with `x-service-secret` + `x-oshal-user-sub` = the fresh guest sub — the same "act as the caller over the service rail" idiom as `artifact-exchange/redeem.ts`. The call is **best-effort and per-app fenced**: a missing secret/port or one app's failure/timeout never blocks the redirect, aborts the other apps, or throws.

3. **The app owns the data.** Its hook plants demo data into its own store for that sub, keyed by `x-oshal-user-sub`. career-hunter copies a canonical, nightly-indexed demo profile into the guest's store dir; finance upserts its demo aggregate; etc. Core never learns an app's schema.

4. **Reset to defaults.** `/api/guest/start` already mints a fresh identity every call, so each guest begins from the apps' declared defaults. App hooks overwrite rather than accumulate.

5. **Admin control lives in the app.** Whether the demo profile is kept fresh (career-hunter's nightly indexing job) is an app-side, admin-toggleable setting — an install that does not want guests turns it off without touching core.

The wiring seam: guest routes mount before the app registry is constructed, so `createGuestRoutes` takes a **request-time** getter (`GuestRoutesDeps.getActiveManifests`) that reads the active manifests once boot has settled.

## Consequences

- **Additive and regression-free at stage 1.** No app declares `guestSeed:` yet, so the orchestrator is a no-op and `guest-demo-seed.ts` still owns finance/tickets/resume. The core career resume write is retired only after career-hunter's hook is live (avoiding a demo regression window).
- Core stops growing per app. A new app's guest demo is one manifest line + one route in that app's repo.
- The service secret never reaches app logic as data — it rides the loopback header exactly as the existing redeem rail does; the guest guard still blocks a guest's own forged `x-service-secret` (it keys on `req.oidc.user.is_guest`, never the header).
- Migration order (each its own PR): (a) **this** — core contract + orchestrator, additive; (b) career-hunter declares its hook + demo profile + nightly index + admin toggle; (c) retire the career resume write from core; (d) migrate finance (needs a service-auth mount added); (e) decide the tickets demo — keep as the framework's own guest demo (core's own surface) or move.
- Guards: `tests/unit/swarm-app-groups.spec.ts` (manifest validation fails closed on a bad/unowned/session-only/ non-canonical `guestSeed`), `tests/unit/guest-seed-orchestrator.spec.ts` (fans out only to declaring apps, sends the secret + guest sub, fences failures, no-ops without secret/port).
