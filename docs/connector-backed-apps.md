# Connector-Backed Apps — the recipe

How to give a bot the ability to act on a user's external account (Gmail, a
SmartThings hub, a Google Cloud project, …). This is the pattern behind the
**email**, **smart-home**, and **cloud** bundles — three working reference
implementations. Adding a new provider is a fill-in-the-blanks exercise, not new
architecture.

This complements two sibling docs:
- [partner-app-registration.md](partner-app-registration.md) — the **human** side
  (registering the OAuth/token app on the partner site).
- [build-your-own-swarm-app.md](build-your-own-swarm-app.md) — a basic
  persona+manifest app with **no** external account.

The rules it builds on: [ADR-036](adr/036-bot-owned-application-architecture.md) (the
bot owns its domain), [ADR-038](adr/038-swarms-bundled-by-type.md) (apps bundled by
type), [ADR-025](adr/025-dynamic-tool-executor-registry.md) (dynamic tools), and
[ADR-042](adr/042-iot-connector-tenancy.md) (multi-account + personal∪shared).

> **This recipe authorizes the CODE, not the PARTNER RELATIONSHIP.** Adding a connector mints a
> new partner credential (a new OAuth client / API key) gated by the partner's own registration and
> often review/approval — a **governance decision, not an auto-approved add**. Most non-trivial
> connectors carry a partner gate (Spotify dev-mode 5-user cap; Meta/Google/LinkedIn app review;
> Square/PayPal sandbox→production). Record each connector's gate in its
> [partner-app-registration.md](partner-app-registration.md) appendix entry. See
> [ADR-062](adr/062-media-concierge-apps-and-partner-credential-governance.md).

---

## The flow

```
  /utilities (Connect)                 cockpit surface (chat / dashboard)
        │ OAuth or token paste                     │
        ▼                                          ▼
  oshal_connections  ──broker──►  bot (codex)  ──shells──►  scripts/oshal-<provider>.js
  (per-user, encrypted,          .oshal-cred-<provider>      │ calls the provider's
   multi-account)                + OSHAL_USER_SUB            ▼ REST API with the token
                                                       provider REST API
```

**Auth and action are separate.** The connector handles auth (a token in
`oshal_connections`); the bot + CLI handle action (calling the provider's API). The
**controller never calls the provider API for reasoning** — that runs on the bot so
cost (`chat_tasks`) and per-bot settings apply (ADR-036).

---

## The six pieces

For a new provider `<x>`, you build these. The reference column shows where to copy from.

| # | Piece | File | Copy from |
|---|---|---|---|
| 1 | **Connector** (auth) | entry in [connectors-routes.ts](../src/app/routes/connectors-routes.ts) `PROVIDERS` | `smartthings` (token) or `gcp` (OAuth) |
| 2 | **CLI** (action) | `scripts/oshal-<x>.js` | [oshal-smartthings.js](../scripts/oshal-smartthings.js) / [oshal-gcp.js](../scripts/oshal-gcp.js) |
| 3 | **Tool kit** (discoverable) | `any-bot/server/services/tools/<bundle>/<x>ToolKit.js` | [smartthingsToolKit.js](../any-bot/server/services/tools/smart-home/smartthingsToolKit.js) |
| 4 | **Persona** | `ai-lab/bot-personas/<x>-bot.yaml` | [home-bot.yaml](../ai-lab/bot-personas/home-bot.yaml) / [cloud-ops-bot.yaml](../ai-lab/bot-personas/cloud-ops-bot.yaml) |
| 5 | **Manifest** | `swarm-apps/<bundle>.yaml` or a store-side package manifest | Smart Home / Cloud manifests in the app store |
| 6 | **Bot node** | registry (echo + full) + a compose service | the `home-bot` / `cloud-ops-bot` entries |

### 1. Connector (auth)

A `PROVIDERS` entry in `connectors-routes.ts`. Two shapes:
- **OAuth** (`gcp`, `google-home`): `authUrl`/`tokenUrl`/`scopes`/`redirectPath`. The
  `/utilities` card shows **Connect**; the redirect stores an access + refresh token.
- **Token paste** (`smartthings` fallback): `auth: 'token'` (or `allowTokenFallback`);
  the card shows a paste field; `POST /:provider/token` validates + stores it.

`providerCreds()` returns the OAuth client id/secret. Reuse an existing client where it
makes sense — `gcp` falls back to `OIDC_CLIENT_ID/SECRET` (one Google client serves
login + Gmail + GCP; scopes are requested per-flow). `CONNECTOR_CATEGORY` puts the card
in a `/utilities` section (`iot`, `devops`, `email`, …).

> **Gotcha:** the redirect is built from `APP_URL` unless you set
> `<X>_REDIRECT_URI`. `APP_URL` is `littlemonster.*`, so a connector registered on
> `oshal.*` **must** set `<X>_REDIRECT_URI` (and the api service must pass it through —
> see "deploy gotchas" below) or Google returns `redirect_uri_mismatch`.

### 2. CLI (`scripts/oshal-<x>.js`)

A self-contained Node script that resolves the user's token and calls the provider API.
Token resolution, in order (copy this verbatim — it's load-bearing):

1. **Brokered token** — `.oshal-cred-<x>` file or `OSHAL_CRED_<X>` env (the controller
   dropped a fresh token; no DB / `SESSION_SECRET` needed). Prefer this.
2. **DB fallback** — decrypt from `oshal_connections` for `OSHAL_USER_SUB`, refreshing an
   expired OAuth token via the refresh-token flow. **Refresh client creds must fall back
   to the OIDC client** when the connector reuses it (e.g. `GCP_CLIENT_ID || OIDC_CLIENT_ID`).
3. **Selector** — `OSHAL_CONNECTION_LABEL` / `_EMAIL` / `_ID` pick one of several
   connections (multi-account). **No selector → default** (the `is_default` row, else the
   most recent) — never error on "multiple."
4. An **`accounts`** verb lists the user's labeled connections (the catalog the bot
   selects from).

### 3. Tool kit (`toolsDir`)

`exports { 'tool-name': async (params) => {...} }` — thin wrappers that shell the CLI,
passing `params.userSub` → `OSHAL_USER_SUB` and `params.label` → `OSHAL_CONNECTION_LABEL`.
Auto-discovered by any-bot's `collectToolFiles` scan of `services/tools/` (ADR-025), and
declared in the manifest via `toolsDir:`. This is how the capability becomes a
**discoverable tool**, not bash prose.

### 4–5. Persona + manifest

The **persona** is a CODEX bot (codex can shell out; claude-code-as-root can't
auto-approve bash). It documents the CLI verbs and the **selection rule** ("if the user
names an account, pass the label; list `accounts` if unsure; ask only when genuinely
ambiguous; one account → just use it"). The **manifest** declares the bot, the
`toolsDir`, a `ticketType`, and the cockpit surface (`ui.static` / `defaultView`).

### 6. Bot node

The bot must be a **real heartbeating node**, not inline (ADR-036): an entry in **both**
registries (`swarm-bot-registry-local.ts` + `swarm-bot-registry.ts`) and a compose
service. The surface's fast loop reaches it via `BotNodeClient → http://<bot>:5000/api/swarm-execute`,
so the registry `container` must be the **bot's own container** (a recurring bug is
pointing it at the controller, which doesn't serve `/api/swarm-execute`).

---

## Multi-account + shared (ADR-042)

The token store is account-keyed: a user (or household/tenant) can hold **many**
connections per provider. `label` and `account_email` are **selectors**; `is_default`
is the fallback; `account_key` (the real account id/email) is the uniqueness key, so
re-connecting the same account updates in place while a different account adds a new one.
A connection is **personal** (`tenant_id IS NULL`) or **shared** (owned by a tenant; any
member may use it). Resolution is **personal ∪ shared, household-first**, all handled by
`resolveConnectionRow()` in [connector-tenancy.ts](../src/app/routes/connector-tenancy.ts)
— the CLI and the broker get it for free.

**"Same client, many connections":** one OAuth client + one redirect serves every
account; the user picks a different account at the consent screen (force the chooser with
`prompt: 'select_account consent'`), and each grant is a separate labeled connection.

---

## The token broker (why the bot never needs `SESSION_SECRET`)

`resolveBotCreds(pool, userSub, providers)` in
[connector-token-broker.ts](../src/app/routes/connector-token-broker.ts) decrypts (and
refreshes) the caller's tokens controller-side and hands the bot short-lived
`.oshal-cred-<provider>` files. **Add your provider to the broker's provider list at the
dispatch site** (`message-routes.ts` for the chat path; the app's own route for a custom
surface) or the bot won't receive the token (and the bot has no `SESSION_SECRET` to
decrypt it itself).

---

## Deploy gotchas (learned the hard way)

- **`<X>_REDIRECT_URI` must be passed to the api service** — `oshal-api` lists each
  connector's env explicitly; a missing `GCP_*`/`<X>_*` line means the connector never
  sees it. Mirror an existing `*_REDIRECT_URI` line.
- **Bind-mount `./scripts`** on the bot (`./scripts:/app/scripts:ro`) so CLI iterations
  apply without an image rebuild. (Docker can cache the `COPY scripts/` layer and ship a
  stale CLI.)
- **Unique published port** per bot service — collisions (`"NNNN:5000"` twice) fail the
  whole stack. Internal resolution uses `<container>:5000`, but the published port must
  be unique.
- A connect that fails at Google with **"hasn't verified this app"** is expected for
  restricted scopes (e.g. `cloud-platform`); the app owner + test users click through.
  A **403 "API has not been used / disabled"** means the provider API isn't enabled — a
  console toggle, not a code bug.

---

## New-connector checklist

```
[ ] PROVIDERS entry (OAuth or token) + providerCreds + CONNECTOR_CATEGORY
[ ] <X>_REDIRECT_URI in .env (oshal host) + passed through in the oshal-api compose env
[ ] /utilities icon + CAT_ORDER section (utilities.html)
[ ] scripts/oshal-<x>.js — broker→DB→refresh(OIDC-fallback)→selector→default, + `accounts`
[ ] any-bot/server/services/tools/<bundle>/<x>ToolKit.js (toolsDir handlers)
[ ] ai-lab/bot-personas/<x>-bot.yaml (codex; CLI verbs + selection rule)
[ ] swarm-apps/<bundle>.yaml (bot + toolsDir + ticketType + surface)
[ ] registry entries (echo + full) + compose service (unique port, ./scripts mount)
[ ] add the provider to resolveBotCreds at the dispatch site
[ ] human steps in partner-app-registration.md appendix
```

---

## More worked examples: acting on a *connected business account*

The email/smart-home/cloud trio above connect a user's **personal** account. Two newer
apps reuse the same connector → CLI/adapter → app recipe to act on a connected
**business** account (a merchant, an affiliate program). Both keep auth in
`oshal_connections` and keep the controller out of the reasoning path, exactly as the
recipe teaches.

### Purchasing ("Shopping") — Walmart I/O affiliate connector

A faithful instance of the full recipe. The connector stores a Walmart credential under
`provider='walmart'` in `oshal_connections`; the controller decrypts the operator's
credential and hands it to a node CLI, [oshal-walmart.js](../scripts/oshal-walmart.js),
which performs signed searches, pulls deal feeds, and builds a cart deep-link. The app
routes are under `/api/purchasing`; migration 036 (bot seed) stays core.

> **Carved to the store (ADR-085 Wave 2 #5, 2026-07-18):** the app (manifest + six
> route-backed tools, `/api/purchasing` routes, both surfaces + purchasing.css,
> migrations 035/037/038) ships as the `purchasing` package in oshal-applications. The
> shop-concierge bot-node (container, registries, personas, walmart toolkit,
> `oshal-walmart.js`) stays first-party core per ADR-093, so the tool chain above is
> unchanged.

As-built caveats:
- **Checkout is a tracked affiliate deep-link handoff** — the app never takes payment or
  places an order; it hands the shopper off to Walmart with affiliate tracking.
- **Amazon PA-API is the next planned rail and is NOT yet integrated.** Today the only
  wired provider is Walmart.

### Payments — charge through a connected *merchant* account

Payments follows the same auth/action split but the "action" side is a **deterministic
adapter, not a bot** — there is no reasoning step, so no persona/CLI is involved. Per-user
brokered tokens come from `oshal_connections`, and charges run **on the merchant's
behalf**. Routes are under `/api/payments`; the app self-creates the
`oshal_merchant_payments` table on its first call.

> **Carved to the store (ADR-085 Wave 1 #4, 2026-07-17):** the app (manifest, the
> `/api/payments` merchant route, surface) ships as the `payments` package in
> oshal-applications. `@/features/payments` itself (both adapter halves) deliberately
> STAYS core as a contracted kernel skill — the finance package imports the Stripe half
> and this package the merchant half, both resolved from the running dist (D8).

It is **provider-agnostic**: a `MerchantPaymentAdapter` interface plus a registry mean
adding a payment rail needs no app change. Two adapters ship:

- **Square** (`SquareMerchantAdapter`) — env `SQUARE_ENV` / `SQUARE_VERSION`; **defaults
  to sandbox**, and uses a sandbox test nonce. Charges directly.
- **PayPal** (`PayPalMerchantAdapter`) — uses the **Invoicing API v2**: it creates and
  sends a **hosted invoice** and does **not** charge the card directly. Env `PAYPAL_ENV`.

As-built caveats:
- Square **defaults to sandbox** — not live until `SQUARE_ENV` is set otherwise.
- PayPal is **hosted-invoice, not a direct charge**; the buyer pays via PayPal's invoice
  page.

These two diverge from the six-piece checklist where the recipe allows it: Purchasing is
bot-backed (persona + CLI), while Payments is a deterministic adapter app (registry +
adapters, no bot). Both now register `routes[]` and carry their migrations from their
store packages (see the carve notes above); the bot chain and the shared payments
feature slice remain framework-resident.

### Music ("Music") — Spotify Web API connector

The recipe applied to a provider with a **real consumer API** (unlike the deep-link-only
Walmart/Uber). Connector `spotify` (OAuth, `flavor: 'spotify'`, `tokenAuth: 'basic'` → the
generic exchange/refresh path; `tokenUrl` is `accounts.spotify.com/api/token`). The CLI
[oshal-spotify.js](../scripts/oshal-spotify.js) + [spotifyToolKit.js](../any-bot/server/services/tools/spotify/spotifyToolKit.js)
expose `music-search`, `now-playing`, `list-playlists`, `build-playlist`, `spotify-accounts`
(tool names match the `spotify-concierge` persona `authorizations` — a mismatch yields a stub,
not a tool). Migration 047 (bot seed) stays core; routes under `/api/spotify`.

> **Carved to the store (ADR-085 Wave 2 #2, 2026-07-18):** the app (manifest + five
> route-backed tools, `/api/spotify` routes + spotify-client, surface, migration 046)
> ships as the `spotify` package in oshal-applications — the first packaged
> `service-or-oidc` mount. The spotify-concierge bot-node (container, registries,
> personas, toolkit, `oshal-spotify.js`) stays first-party core per ADR-093.

As-built caveats:
- **Discovery + playlist-building are REAL** API calls on the user's own account; only
  **playback is a deep-link handoff** (`open.spotify.com`) — starting playback needs Premium +
  the Web Playback SDK, which OSHAL does not drive.
- **Spotify dev-mode gate (platform, not code):** a non-published app is capped at **5 Premium
  test users** on an owner-managed allowlist (Dashboard → User Management; the owner must add
  their OWN account too). A non-allowlisted account still gets a token but every Web API call
  returns **403** — the surface detects this (`/config` → `needs_allowlist`) and shows an "add
  your account" banner. Extended Quota Mode (the only lift past 5) now requires a registered org
  + 250k MAU + launched service (org-only since 2025-05) → not attainable for a demo, so Music
  is **demo-grade**. See [partner-app-registration.md](partner-app-registration.md).

### Movies & TV ("Movies & TV") — TMDB connector

What-to-watch over the **free TMDB API**. Connector `tmdb` (token-paste, `flavor: 'tmdb'`,
category `media`) — the operator pastes a **v3 API key OR a v4 read-access-token** (the
client/CLI detect which by shape: a `eyJ…` JWT → Bearer, else `?api_key=`). Key resolution adds
an **env fallback** (`TMDB_API_KEY` / `THEMOVIEDB_API_READ_ACCESS_TOKEN` / `THEMOVIEDB_API_KEY`)
since TMDB is a shared read-only catalog — one key serves everyone. CLI
[oshal-tmdb.js](../scripts/oshal-tmdb.js) + moviesToolKit.js expose `title-search`,
`where-to-watch`, `recommendations`, `find-showtimes`, `watchlist-add`, `tmdb-accounts`.
Migration 049 (bot seed) stays core; routes under `/api/movies`.

> **Carved to the store (ADR-085 Wave 2 #1, 2026-07-18):** the app (manifest, `/api/movies`
> routes + tmdb-client, surface, migration 048) ships as the `movies` package in
> oshal-applications. The movies-concierge bot-node (container, registries, personas,
> toolkit, `oshal-tmdb.js`) stays first-party core per ADR-093's interim tier, so the tool
> chain described above is unchanged.

As-built caveats:
- **Discovery is REAL**; **watching + tickets are deep-link handoffs** — "Where to watch" opens
  TMDB's JustWatch page (TMDB gives an aggregate link, not per-provider deep links), "Tickets"
  opens a Fandango search. OSHAL never streams or sells.
- **No per-user gate** (unlike Spotify) → Movies is **public-ready** as-is.

### Travel — Duffel connector (ADR-059)

The recipe applied to a provider with a **real consumer API** (like Spotify, unlike the
deep-link-only Walmart/Uber) **plus a swarm-wide intelligence layer**. Connector `duffel`
(token-paste, `flavor: 'duffel'`, category `travel`) — the traveller/operator pastes a Duffel
**access token** (`duffel_test_…` sandbox / `duffel_live_…` real); key resolution adds an env
fallback (`DUFFEL_ACCESS_TOKEN`). CLI [oshal-duffel.js](../scripts/oshal-duffel.js) verbs:
`status`, `flights` (real Duffel offer requests), `hotels`, `cars`, `deeplink`, `accounts`.
Bot `travel-concierge` (`b00c0000-…-001`); migrations 050–051; routes under `/api/travel`.

Two things distinguish it from the other connector apps:
- **A swarm-wide, ANONYMIZED price DB** (`travel_observations`, no `user_sub` on the row): every
  search + quote is recorded so the concierge can give an honest **"good / typical / high price —
  book now or wait"** read (computed from the route's recent p25/avg), improving for everyone with
  use. The personal layer (`travel_profile`/`travel_searches`/`travel_watches`) stays per-user.
- **A fare-watch cron** (`startTravelFareWatchCron`, mirrors `startFeedsIndexingCron`) re-prices
  each saved `travel_watches` route on an interval, grows the price DB, and flips a watch to
  `tripped` on a drop below the traveller's target.

As-built caveats:
- **Flights are REAL** (Duffel air API); **hotels + cars are demo + deep-link handoffs** — Duffel
  has no car product, and Duffel Stays needs geocoded coordinates, so both are flagged-demo in the
  UI with a Booking.com / Kayak handoff (a real Stays + car feed is a follow-up).
- **Booking is a deep-link handoff** — flights open a Google Flights search for the slice; the app
  **never takes payment or places an order**. Duffel *can* book via API (offer → order); that is
  intentionally **not wired** (demo). The flight link is a route+date search, not the exact offer.
- **Rewards / account-linking is deferred** to the ticketed data-access broker (ADR-056); the
  concierge never claims a loyalty balance it was not explicitly told.
- **No per-user gate** → flights are public-ready the moment a Duffel token is connected (or the
  env fallback is set).

### Per-app concierge persistence (Music + Movies + Travel)

All three keep a **per-app concierge surface** (their own "music dude" / "movie buff" /
"trip planner" chat), NOT folded into Jarvis — but they copy **Jarvis's durable-session pattern**
so the thread survives navigating away: the surface persists a stable conversation id client-side
(`localStorage`) and the route's `/conversation?id=` resumes that exact thread (user-scoped,
uuid-guarded), with turns saved in `{spotify,movies,travel}_messages`. Jarvis is the **reference**
for durable sessions, not a place to merge app concierges into.

> **Deploy gotcha (bit us):** `oshal-bot:latest` is built from **`Dockerfile.oshal`** (a
> separate `docker build`, NOT `compose up --build`), and the `COPY scripts/oshal-*.js` +
> `COPY any-bot/server/` layers are **Docker-cached** — a plain rebuild can ship a stale CLI /
> toolkit (the running image was even missing `oshal-uber.js`). Rebuild **cache-busting**
> (`--no-cache` or the `CLI_CACHE_BUST` build-arg) + recreate the containers, or the new CLIs/
> toolkits/personas never land. `.dockerignore` already allowlists `!scripts/oshal-*.js`.
