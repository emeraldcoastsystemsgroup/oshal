# Guest mode (`ENABLE_GUEST_MODE`) — operator guide

Related: [ADR-144 — the guest-seed contract](../adr/144-guest-seed-contract.md) ·
[local-auth.md](local-auth.md) (the invited-user counterpart)

`ENABLE_GUEST_MODE=true` lets an anonymous visitor click "Continue as guest" on a public
deployment and look around without a Google login (or any credential at all). It is **off by
default** — [`isGuestModeEnabled()`](../../src/shared/middleware/guest-session.ts) reads
`ENABLE_GUEST_MODE` and fails closed on anything but `true`/`1`/`yes`. Every guest route,
including the landing page itself, 404s when the flag is off.

In one paragraph: a guest gets a fresh, isolated, throttled identity that can read almost
everything and write almost nothing. Two apps are fully interactive (Jarvis chat/voice being
the flagship demo); two are blocked outright even on GET; everything else is read-only —
mutations return 403. A guest can never see another guest's or another user's data (ordinary
RLS row isolation applies to the guest sub like any other sub), never holds a connector
credential (no Gmail, no trading account, no real external API), and a real login always wins
over a guest cookie on the same browser.

## Identity mechanics

- **Cookie**: `oshal_guest`, HttpOnly, `SameSite=Lax`, `Secure` in production. Self-contained —
  `<base64url payload>.<base64url HMAC-SHA256>`, no server-side session store. Signed with
  whichever of `SESSION_SECRET` / `AUTH_SESSION_SECRET` / `KEYCLOAK_CLIENT_SECRET` is set; if
  none is, minting fails closed (`mintGuestCookie()` returns `null`, `POST /api/guest/start`
  answers `503 guest_unavailable`). Default TTL is 12 hours (`GUEST_SESSION_TTL_HOURS`).
- **Sub**: a fresh `guest-<uuid>` minted on every `POST /api/guest/start` call — a new
  browser, a new device, or an expired/cleared cookie all get a brand-new identity. There is no
  cross-device or cross-session persistence; nothing links two guest subs together.
- **Issuer namespace**: `urn:oshal:guest` (`GUEST_PRINCIPAL_ISSUER` in
  [`principal-issuer.ts`](../../src/shared/middleware/principal-issuer.ts)), stamped onto the
  injected `req.oidc.user.iss` so a guest identity can never collide with a real OIDC or
  local-auth subject that happens to share the same text.
- **Injection point**: [`createGuestSessionInjector()`](../../src/shared/middleware/guest-session.ts)
  mirrors the TV-pairing token injector — it only populates `req.oidc` when there is **no**
  existing authenticated session and **no** valid service-secret call. A real login, a TV
  token, a PAT, or a service-secret call always wins; the guest cookie is simply ignored in
  those cases, so a guest can never shadow a real identity into the RLS GUC.
- **Row isolation**: the injector is mounted in `src/app/server.ts` *before* the RLS
  request-identity block that stamps `oshal.current_sub` for the GUC-aware pool wrapper, so a
  guest's sub flows into `oshal.current_sub` exactly like any other user's and is naturally
  row-isolated by the same RLS policies — no guest-specific carve-out in the database layer.

## The lockdown model

The tier list is a code constant in
[`guest-capability-matrix.ts`](../../src/shared/middleware/guest-capability-matrix.ts) — quoted
here as of today; treat that file as the source of truth going forward, not this doc.

| Tier | Segments (today) | Guest can... |
|---|---|---|
| **A — full** | `jarvis` | Read and write — a genuinely interactive demo app. |
| **C — blocked** | `workflow-studio`, `forge` (bots) | Nothing — even `GET` returns 403; the ribbon tile is grayed. |
| **Always-allow** | `guest`, `auth`, `branding`, `ui`, `health` | Any method — the plumbing the cockpit needs to render plus the guest session endpoints themselves (without this, `POST /api/guest/start` would itself be blocked as a mutation). |
| **B — default** | everything not listed above | `GET` only; every mutation 403s `guest_readonly`. |

`trading` deliberately sits in the Tier-B default rather than Tier C: guests see the
deployment's Alpaca **paper** account (env-resolved, no live keys configured on this box), which
is intended demo content — the desk exists to show the strategy running on paper, not private
data. If `ALPACA_LIVE_*` is ever configured, the trading read routes must force guests to
`mode=paper` before this stays true.

Tier resolution is by **route segment** (`/api/<segment>/...`, second path part), not by prefix
— `appSegmentForPath()` matches `trading` and `trading-charts` as distinct segments on purpose.
Resolution order, first match wins: always-allow → core's hardcoded Tier C → core's hardcoded
Tier A → an installed package's **operator-approved** tier → the Tier-B default.

### Anchored mutation grants (the Jarvis case)

A Tier-A app can depend on a route mounted under a *different*, Tier-B segment. Jarvis is Tier
A, but nothing it posts to lives under `/api/jarvis`: the mic posts to
`/api/voice/transcribe`/`/api/voice/synthesize`, and the actual turn posts to `/api/tasks` and
`/api/tasks/:id/messages` — segments that fall to the Tier-B default and would 403 every guest
turn. `GUEST_ALLOWED_MUTATIONS` is the fix: a short table of **anchored, single-method** grants
(`method` + a regex matched against the *whole* path), not a widened tier on `voice` or `tasks`.
Anchoring matters — an earlier literal-prefix form granting `/api/tasks` would also have
silently granted `DELETE /api/tasks/:id` and `POST /api/tasks/:id/workspace/bootstrap`. The four
grants today:

- `POST /api/voice/transcribe` — the mic (push-to-talk + wake word), spends a model call.
- `POST /api/voice/synthesize` — the spoken reply, spends a model call.
- `POST /api/tasks` — opening a conversation (a task row owned by the guest sub), no model call.
- `POST /api/tasks/:id/messages` — the Jarvis turn itself, spends a model call.

Grants are checked **only after** every denial above them, so a Tier-C app or an
operator-approved `blocked` package tier can never be widened by a grant, and the pattern can
never match more than the one route it names.

### Store-package `guestTier` and the D4 default

An installed store package can request a guest tier via its manifest's `guestTier` field
(`full` | `readonly` | `blocked`) — but a request is not a grant (ADR-085 D4, operator decision
2026-07-13). Guests are unauthenticated; if a package could set its own tier, installing one
would silently widen what an anonymous visitor reaches, including writes (`full`). The request
is stored and surfaced for review; **nothing widens until an operator approves it** and the
approved tier is registered (`registerAppGuestTier`). Until then — and for any package that
never asked — the segment falls to the same Tier-B default as everything else: read-only,
mutations blocked. Core's hardcoded Tier A/C lists are checked first and always win; a package
can only contribute a tier for a segment core doesn't already claim.

## Cost posture

An anonymous, credential-less caller can still reach a model on the four Jarvis grants above.
Why that's an acceptable, bounded exposure rather than an open tap:

- The voice routes resolve the **deployment's default** STT/TTS provider (`resolveForApp()`) —
  never a per-user connector token.
- A guest turn brokers connector credentials for the caller's own sub. A guest sub owns none, so
  credential resolution returns nothing — Jarvis answers from the model alone and never reaches
  the operator's Gmail, trading, or storage data.
- Guest turns are forced `chatOnly` in `handleSendMessage`: they answer and stop. No ticket is
  created and nothing dispatches into the swarm build pipeline.
- Two independent budgets apply on top, enforced in
  [`guest-guard.ts`](../../src/shared/middleware/guest-guard.ts):
  - A **per-sub sliding-window rate limit** on every mutating call — default 40 requests per 5
    minutes (`GUEST_RATE_LIMIT_MAX` / `GUEST_RATE_LIMIT_WINDOW_MS`), in-memory (no Redis; guest
    sessions are ephemeral anyway). Exceeding it returns `429 guest_rate_limited`.
  - A **per-sub lifetime model-turn cap** — default 25 (`GUEST_MODEL_TURN_CAP`), counted only
    against grants marked `spendsModel` so opening a conversation stays free. Exceeding it
    returns `429 guest_turn_cap`.

## Operational

**Enabling it**: set `ENABLE_GUEST_MODE=true` and ensure a signing secret is present
(`SESSION_SECRET`, or one of its fallbacks — see above); without one, guest-start answers `503`.

**Entry point**: `GET /guest` renders a landing card ("Continue as guest" / "Sign in with your
account instead"). `POST /api/guest/start` mints the cookie and redirects — to a sanitized
`?next=` deep link if one was carried through, else to the deployment's `HOST_APP_MAP` landing
for the requested host (so a themed subdomain like `career.oshal.ai/guest` lands on its own app
instead of the generic ribbon), else to `/cockpit/`. `next` is same-origin only: a single
leading `/`, no `//`, no `\`, no CR/LF, ≤300 chars, or it's ignored.

**Ending a session**: `POST /api/guest/end` clears the cookie. There is no server-side
invalidation beyond that — the cookie's own signed expiry (`GUEST_SESSION_TTL_HOURS`) is the
backstop if a client never calls it.

**What a fresh guest sees**: the onboarding gate is skipped entirely — `needsOnboarding` treats
every guest as not requiring onboarding, because onboarding exists to configure LLM providers
(a `PUT /api/user/onboarding` mutation the guest Tier-B default blocks) and every guest sub is a
throwaway UUID that would otherwise bounce to `/welcome` on every single visit. `GET
/api/auth/user` reports `mode: "guest"`, `guestMode: true`, and a `capabilities` snapshot
(`guestCapabilities()`) mirroring the same tier lists the server guard enforces, so the cockpit
ribbon grays Tier-C tiles using the identical source of truth as the 403s.

**Guest data seeding**: core no longer hardcodes what a guest sees inside each app. On
guest-start, the kernel fans out to every installed, active app that declares a `guestSeed:`
hook in its manifest and lets the app plant its own demo data for that fresh sub — see
[ADR-144](../adr/144-guest-seed-contract.md) for the full contract. The framework's own tickets
demo (and, until finance migrates, a fake finance aggregate) still seeds directly from
[`guest-demo-seed.ts`](../../src/app/routes/guest-demo-seed.ts) as a stage-1 holdover.

## Guards

`tests/unit/guest-welcome-mat.spec.ts` (the `/guest` redirect wrapper: guest-mode-off, non-GET,
and any existing session all fall through to `requiresAuth` unchanged), `guest-jarvis-turn.spec.ts`
(the anchored voice/task mutation grants, `spendsModel` metering, forced `chatOnly`),
`guest-app-owner-identity-redaction.spec.ts` (a guest session must never read an installed
package's owner subject off the app-store endpoints), `guest-next-links-and-seed.spec.ts`
(same-origin `?next=` sanitization, `HOST_APP_MAP` landing resolution, the transaction-scoped
demo seed under FORCE-RLS), `guest-seed-orchestrator.spec.ts` (the ADR-144 fan-out: only
declaring apps are called, the service secret + guest sub ride the request, one app's failure
never blocks another's or the redirect), and `app-guest-tier.spec.ts` (the D4 asymmetry: a
manifest's `guestTier` is inert until an operator-approved registration exists, core's hardcoded
lists always win, and deactivating a package retracts its grant).
