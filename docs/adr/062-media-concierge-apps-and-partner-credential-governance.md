# ADR-062 — Media concierge apps (Music + Movies & TV) and partner-credential governance

- **Status:** Accepted — BUILT 2026-06-20 (Spotify `spotify` connector + spotify-routes + spotify-concierge
  bot + CLI/tool kit + surface; TMDB `tmdb` connector + movies-routes + movies-concierge bot + CLI/tool kit +
  surface; full NEW-APP SURFACING wiring; per-app durable concierge sessions). LIVE for Movies (TMDB key);
  Music is demo-grade pending the Spotify partner gate (below).
- **Date:** 2026-06-20
- **Related:** [connector-backed-apps.md](../connector-backed-apps.md) (the recipe these follow),
  [partner-app-registration.md](../partner-app-registration.md) (the human registration steps),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-042 (multi-account + personal∪shared connector tenancy)](042-iot-connector-tenancy.md),
  [ADR-059 (travel concierge — sibling hybrid connector)](059-travel-booking-concierge.md),
  the swarm-application manifest standard (033b-swarm-application-manifests.md)

## Context

Two consumer-media apps were added: **Music** (the user's own Spotify) and **Movies & TV** (TMDB).
Mechanically they are textbook [connector-backed apps](../connector-backed-apps.md) — connector → CLI →
tool kit → persona → manifest, plus a per-app concierge surface. So *why an ADR rather than just "follow the
recipe"?*

**Because onboarding each one MINTS A NEW PARTNER CREDENTIAL that is gated by the partner's own
registration + review/approval — it is not an internal, auto-approvable change.** The connector-backed-apps
recipe documents the *code* (a fill-in-the-blanks exercise); it deliberately does **not** grant authority to
stand up a new partner relationship. Creating an app on a partner's developer console, accepting that
partner's terms, requesting scopes, and (often) submitting for the partner's review is a **governance
decision with real constraints and obligations** — exactly what an ADR is for. The recipe is the *how*; this
ADR is the *whether/under-what-terms*.

The two apps land on opposite ends of the partner-gate spectrum, which is the whole point:

- **Spotify (Music)** — a real OAuth app on the Spotify developer dashboard. A non-published app is hard-
  capped at **5 Premium test users** on an owner-managed allowlist; a non-allowlisted account still receives
  a token but every Web API call returns **403**. The only lift past 5 is **Extended Quota Mode**, which (as of
  2025-05) requires a **registered organization + 250k MAU + a launched service** and is **org-only** — not
  attainable for a demo. Spotify also prohibits using its content/data to train ML models. So the credential
  is **partner-review-gated and access-tier-constrained**, independent of our code.
- **TMDB (Movies & TV)** — a free, instant API key (v3 key or v4 read-access token), **no per-user gate**.
  The "credential" is operator-level; one key serves all users (shared read-only catalog). Low-friction, but
  still a partner account + terms acceptance under the business identity (Rule 0).

## Decision

1. **Ship both as connector-backed concierge apps** per the recipe + NEW-APP SURFACING CHECKLIST:
   - `spotify` connector (OAuth, `flavor:'spotify'`, `tokenAuth:'basic'`, category `music`) +
     `scripts/oshal-spotify.js` + `spotifyToolKit.js` + `spotify-concierge` (agent `b00a0000-…-001`) +
     `swarm-apps/spotify.yaml` + migrations 046–047; routes `/api/spotify`.
   - `tmdb` connector (token-paste, `flavor:'tmdb'`, category `media`) + `scripts/oshal-tmdb.js` +
     `moviesToolKit.js` + `movies-concierge` (agent `b00b0000-…-001`) + `swarm-apps/movies.yaml` +
     migrations 048–049; routes `/api/movies`. Key resolves broker→DB→env
     (`TMDB_API_KEY`/`THEMOVIEDB_API_READ_ACCESS_TOKEN`/`THEMOVIEDB_API_KEY`).

2. **Treat the partner credential as a governed, reviewed step — NOT auto-approved.** Adding a
   media/partner connector is allowed under the connector-backed-apps pattern, but the *credential* must be
   registered under the business identity (Rule 0), its access tier + terms understood and recorded, and any
   partner review/approval tracked. The code may ship ahead of the credential; the app simply stays in its
   pre-credential state (Spotify: the `needs_allowlist`/connect gate; Movies: "no TMDB key" state) until the
   reviewed credential is in place. **No connector to nowhere** (the repo's standing rule) still holds.

3. **Honest action vs. handoff boundary** (no-mock rule):
   - Spotify: discovery + playlist-building are REAL Web API actions on the user's own account; **playback is
     a deep-link handoff** (`open.spotify.com`) because in-app playback needs Premium + the Web Playback SDK,
     which OSHAL does not drive.
   - Movies: discovery is REAL; **watching + tickets are deep-link handoffs** (JustWatch where-to-watch /
     Fandango search). OSHAL never streams or sells.

4. **Per-app concierge with Jarvis-style durable sessions, NOT merged into Jarvis.** Each app keeps its own
   concierge surface; it copies Jarvis's persistence (a stable client-persisted conversation id resumed by
   `/conversation?id=`, turns in `{spotify,movies}_messages`) so the thread survives navigation. Jarvis is
   the *reference* for durable sessions, not a place to fold app concierges into.

## Consequences

- **Movies & TV** is live and **public-ready** the moment a TMDB key is present (no per-user gate).
- **Music** is **demo-grade**: fully functional for the owner + up to 4 added Premium Spotify accounts; the
  surface degrades cleanly (connect gate → dev-mode "add your account" banner → app) for anyone not on the
  allowlist. Going broadly public would require Spotify Extended Quota (org + 250k MAU) — out of reach for a
  demo, so it is **not** on the public-launch path.
- The connector-backed-apps recipe gains an explicit governance caveat: **the recipe authorizes the code, not
  the partner relationship.** Each new partner connector inherits a partner-specific review/approval gate that
  must be assessed per provider (see "What else" below) — this generalizes beyond media.

**Risks / sharp edges:**
1. **Spotify dev-mode 403 looks like a bug.** Mitigated by the `/config` `needs_allowlist` state + banner;
   document it (done in partner-app-registration.md) so it is never debugged as a code fault.
2. **Deploy gotcha:** `oshal-bot:latest` is built from `Dockerfile.oshal` (not `compose up --build`) and the
   `COPY scripts/oshal-*.js` + `COPY any-bot/server/` layers cache — a new CLI/tool kit needs a **cache-busted
   rebuild** (`--no-cache` / `CLI_CACHE_BUST`) or it ships stale (the running image was even missing
   `oshal-uber.js`).
3. **Terms drift.** Spotify's tiers/limits changed materially in 2025–2026 (25→5 users, Premium-only,
   org-only Extended Quota). Partner terms are not static; re-verify before relying on a tier.

## What else carries the same partner-review gate (assess per connector)

This ADR's principle — *adding the connector is patterned, but the credential is partner-gated and not auto-
approved* — applies to several connectors already in the registry whose review gate the recipe glosses over:

- **Slack** — OAuth app; broad/distributed use needs a Slack-reviewed app (and user-token scopes).
- **Meta / Facebook Pages (`meta-business`)** — `pages_manage_posts` etc. require **Meta App Review**.
- **Google restricted/sensitive scopes** (`gmail.*`, `cloud-platform`) — work for owner + test users; non-
  owner users need **Google OAuth app verification**.
- **LinkedIn** (`w_member_social`) — needs LinkedIn **product approval** on the app.
- **X/Twitter** — developer-account **tier** gates rate/limits.
- **Square / PayPal** — **sandbox→production** review before real charges.

**Recommendation:** when a new partner connector is requested, record its gate (tier, review, terms) in its
`partner-app-registration.md` appendix entry, and treat "is this auto-approvable?" as a checklist item — most
are not.
