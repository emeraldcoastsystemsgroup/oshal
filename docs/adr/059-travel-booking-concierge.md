# ADR-059 — Travel booking concierge: real flight search + swarm price intelligence + deep-link handoff

- **Status:** Accepted — BUILT 2026-06-20 (Duffel connector + travel-routes + travel-concierge bot +
  swarm price-observation DB + fare-watch cron + surface + surfacing). Rewards/account-linking layer
  DEFERRED to the data-access broker (ADR-056) once flight search + price intelligence are proven.
- **Date:** 2026-06-20
- **Related:** [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-057 (personal data schema)](057-personal-data-schema.md),
  [ADR-049 (OSHAL as aggregation platform)](049-oshal-as-aggregation-platform.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  the swarm-application manifest standard (033b-swarm-application-manifests.md)

## Context

Travel is the highest-value place to apply the swarm's intelligence layer because the *booking itself*
is mostly a handoff, but everything *around* the booking — knowing the going price, remembering the
traveller's home airport and preferred cabin, watching a saved route for a fare drop, maximizing
rewards — is where the swarm earns its keep.

Two facts shape the design:

1. **The data feed.** Amadeus for Developers self-service is being **decommissioned 2026-07-17**, so
   Amadeus is out for a self-service build. **Duffel** is the chosen provider: a free test mode, a real
   flight-search API, and — unusually — a real *booking* API (so the order step can become in-app later
   instead of only a deep link). Duffel covers **flights** and **stays (hotels)**; it has **no car
   product**, so cars are a deep-link handoff.

2. **The pattern.** This is a *hybrid connector*, exactly like the Spotify concierge (real Web API +
   handoff) and unlike the pure deep-link Eats/Rides apps: real read API for the intelligence, a
   deep-link (or, later, Duffel API) for the purchase. It must NOT be a mock — it must be a real signed
   connector with a clearly-flagged demo-catalog fallback so the surface always demos with zero keys and
   goes live the instant a token is connected (the LIVE Walmart pattern, ADR-036 / oshal-walmart.js).

## Decision

Ship a single **Travel** swarm app (Flights / Hotels / Cars in one surface — a trip is booked together)
following the canonical swarm-application manifest + NEW-APP SURFACING CHECKLIST, with four intelligence
layers built in dependency order.

### 1. Connector (Duffel) — real read, demo fallback

- A `duffel` connector (auth `'token'`, category `travel`) in the connector registry: the operator/user
  pastes a Duffel access token (`duffel_test_…` sandbox / `duffel_live_…` real) on /utilities, stored
  encrypted in `oshal_connections`; or the `DUFFEL_ACCESS_TOKEN` env fallback.
- `scripts/oshal-duffel.js` resolves the credential broker→DB→env (mirrors oshal-walmart.js), calls the
  Duffel API (Bearer + `Duffel-Version`), and **falls back to a flagged demo catalog** on no-token/error
  so search→cards→handoff always works. Flights are real (offer requests); hotels attempt Duffel Stays;
  cars are demo + deep link.

### 2. Swarm-wide price DB — every search written, anonymized

- `travel_observations` (swarm-wide, NOT per-user-private): every search + every quote we see is written
  here, **anonymized** — no `user_sub` on the price row. This is the moat: price intelligence ("this
  route normally runs $X; today's $Y is a Z% drop — book now / wait"), a network effect that improves for
  everyone the more the swarm searches, and the data the fare-watcher polls. Separate from the personal
  layer on purpose — the swarm DB holds *market* data, the personal store holds *you*.

### 3. Per-user preferences + search history + watches

- `travel_profile` (home airport, preferred airlines/alliance, cabin, seat, hotel brands, budget),
  `travel_searches` (the traveller's own history), `travel_watches` (saved route + a target price the
  fare-watch cron re-polls), `travel_conversations`/`travel_messages`/`travel_feedback` (chat + durable
  learned prefs) — all scoped by OIDC `sub`. The long-term home for the *rich* personal preference model
  is the tri-store personal vault (ADR-057); the per-user tables here are the app-local working set that
  feeds the concierge prompt today, the same way movies/purchasing do.

### 4. Rewards + account linking — via the broker (DEFERRED)

- Logging into the traveller's airline/hotel/card-portal accounts to read points balances and do the
  points-vs-cash math is the highest-value AND highest-sensitivity layer, so it is **deferred** and, when
  built, goes through the **data-access broker + vault (ADR-056)**: the reasoner holds no creds, every
  pull is logged/approvable, OAuth where it exists else a brokered consented session or manual balance
  entry. NOT in app tables, NOT in env. (See the 2026-06 security audit on credential handling.)

### 5. Brain + cron

- The **travel-concierge** bot (agent `b00c0000-…-001`, inline via `ctx.orchestrator` on the caller's
  configured provider) reasons over real candidates and returns a JSON envelope `{say, show[], watch[],
  remember[]}`; never invents a flight/price.
- A **fare-watch cron** (`startTravelFareWatchCron`, mirrors `startFeedsIndexingCron`) re-polls each
  saved `travel_watches` row on an interval, writes fresh observations, and flags drops below target.

### 6. Booking = handoff

- Today: a deep link (Google Flights for the slice / Booking.com for stays / a rental search for cars).
  Because Duffel supports API booking, the flight handoff can be upgraded to an in-app Duffel order later
  without re-architecting (the connector + offer IDs are already in hand).

## Consequences

- A live, demoable Travel app with zero external setup (demo fallback), going live for real flight search
  the moment the `DUFFEL_ACCESS_TOKEN` (already wired) or a /utilities Duffel connection is present.
- The swarm price DB starts accumulating real observations immediately on live search; its intelligence
  compounds with usage.
- Clean privacy story: anonymized market data in the swarm DB, the traveller's identity/preferences in
  the per-user (later: sovereign vault) layer, credentials only ever behind the broker.

**Risks / sharp edges:**
1. **Duffel Stays needs geographic coordinates** for hotel search — first cut leans on demo + deep-link
   for hotels; wiring real Stays (geocode a city → coords) is a follow-up.
2. **No car product on Duffel** — cars are demo + deep-link only; a real car feed is a future provider.
3. **Observation hygiene** — the price DB must stay anonymized (no `user_sub` on the row) or it becomes
   personal data; enforce at the write site.
4. **Rewards scope creep** — keep the deferred rewards layer behind the broker; do not shortcut creds
   into app tables/env.

## Deferred

- Rewards / account-linking + points-vs-cash optimization (ADR-056 broker).
- Real Duffel Stays (hotels) + a real car-rental feed.
- In-app Duffel booking (replacing the flight deep link).
- Migrating the rich personal preference model into the ADR-057 tri-store vault.
