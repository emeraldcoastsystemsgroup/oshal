# ADR-048 — Finance: read-only money-aggregation swarm (Plaid)

- **Status:** Proposed
- **Date:** 2026-06-17
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-037 (communications swarm — reference app)](037-communications-swarm.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md)

## Context

The operator wanted a finance app and reached for "a single connection like a Quicken API."
Quicken has no real third-party API. The thing that actually delivers one-connection coverage is
an **account aggregator: Plaid** — a single integration that reaches ~12,000 banks and brokerages.
The user links their own institutions; OSHAL holds one Plaid app. That is exactly the
bundled-by-type model (ADR-038): an app = {connector + the data-access CLI + a bot + a surface},
and adding "another bank" is not a new connector — Plaid already covers it.

Two scoping decisions, made with the operator:

1. **Read-only aggregation only.** v1 reads balances, investment holdings, and transactions and
   reasons over them (net worth, portfolio concentration/drift, spend trends, watch-outs). It does
   **not** place trades or move money — trade execution (SnapTrade / broker APIs) is broker-dealer
   territory, a separately-regulated later bundle. Read-only is ~90% of the value at ~10% of the
   risk.
2. **No crypto** ("no bitcoin"). No exchange connector is wired; Plaid Investments returns brokerage
   holdings without touching crypto rails.

Two facts forced the implementation shape away from the comms/home reference (a codex bot that
shells out to its CLI):

- **Plaid does not use a redirect OAuth handshake.** It uses **Link** — a JS widget yields a
  `public_token`, which is exchanged server-side for a long-lived (non-expiring) `access_token`.
  So Plaid is intentionally **not** a generic `connectors-routes` provider (no `authUrl`/`/callback`),
  and connecting happens on the Finance surface, not `/utilities`.
- **On this host codex is broken and claude-code-as-root cannot shell out**, so a dedicated bot-node
  can't be the data fetcher. But the Plaid data fetch is plain HTTPS — it needs no shell.

## Decision

Build Finance on the **kid-lens inline pattern** (ADR-036's "raw reads = cheap I/O the controller
caches; reasoning = LLM work that always runs on the bot"), not the home/codex shell-out pattern:

- **The controller does the deterministic Plaid I/O.** `finance-plaid.ts` is the Plaid client +
  aggregate builder; `finance-routes.ts` (mounted `/api/finance`, `requiresAuth`) links accounts
  (Plaid Link `exchange`, plus a Sandbox `link-sandbox` path for localhost testing), and on `sync`
  folds balances + holdings + transactions into one compact `FinanceAggregate`. Each Plaid product
  is wrapped so an unready product (common right after a sandbox link) degrades to a note instead of
  failing the whole sync.
- **Finance owns its own stores**, user_sub-keyed: `oshal_finance_items` (per-Item access tokens,
  AES-256-GCM at rest — same scheme as connector tokens) and `oshal_finance_data` (the aggregate +
  the cached brief). Not the generic `oshal_connections` table, because the connect flow is
  Link-specific.
- **Reasoning always runs on the accountable bot.** `finance-analyst` is **reason-only, inline on
  the api container** (claude-code, agentId `…0044`), invoked via `BotNodeClient.execute` with
  `direct:true` so per-call cost lands in `chat_tasks` under its own id. Same path as kid-lens /
  deck-builder / social-writer. The output contract is embedded in the route prompt
  (`buildBriefPrompt`) for deterministic behavior; the persona documents the bot.
- **`scripts/oshal-plaid.js`** is the canonical data-access CLI **and** the localhost test harness:
  `link-sandbox <user_sub>` seeds a Plaid Sandbox item with no Link widget or real bank
  credentials, so the whole pipeline is exercisable from a shell, satisfying the human-testability
  gate before Plaid production access is approved.
- **Surface** `src/api/finance.html` (manifest `swarm-apps/finance.yaml`, `?app=finance`): connect
  (real Link + a Sandbox demo-connect), net-worth / accounts / holdings / spending dashboard, and
  the rendered brief. Cockpit theme-sync. Read-only — nothing is traded or moved.

## Consequences

- **One connector, thousands of institutions.** Adding a bank/brokerage is a user action in Plaid
  Link, never an OSHAL code change.
- **Cost + ownership accounting hold** despite the controller doing the fetch: the only LLM work
  (the brief) runs on the bot, and every store is user_sub-keyed and auth-gated.
- **Deviation from the bundle reference is deliberate and documented**: Plaid's Link model + the
  host's harness constraints make "the bot shells out to its CLI" impossible here; the controller
  does the HTTPS I/O exactly as `home-routes` already does direct SmartThings calls.
- **Operator gating remains.** The app cannot run until the operator creates the Plaid app (under
  the business email, per the partner-app rule) and sets `PLAID_CLIENT_ID`/`PLAID_SECRET`. Sandbox
  keys are instant (no review); production access needs Plaid's one-time use-case review.
- **Deferred** (see BACKLOG): trade execution, real-bank production verification, multi-account
  labels/tenancy, scheduled re-sync + alerts, bill/cash-flow forecasting. None are in v1.

## Addendum (2026-06-17) — money movement via a provider-agnostic payment adapter

The read-only line was relaxed by one capability at the operator's request ("we need at least a
pay"): the finance app can now **move the user's money**. The shape mirrors `harness-adapter.ts` —
the rest of OSHAL depends on a rail-neutral `PaymentAdapter` interface
([src/features/payments/](../../src/features/payments/): `createTransfer` / `getTransfer` /
`configured` / `isTestMode`), and `getPaymentAdapter()` selects the concrete rail from
`PAYMENT_PROVIDER`. Adding a rail = a sibling adapter, nothing else.

- **First rail = Stripe** (`stripe-payment-adapter.ts`), `fetch`-based (no SDK), an ACH debit of the
  user's own linked bank account via a `us_bank_account` PaymentIntent. A `sk_test_…` key targets
  Stripe test mode (fake banks, no real money), surfaced as `isTestMode()` so the UI warns.
- **Routes** (`finance-routes.ts`, all `requiresAuth` at mount): `GET /pay-status`, `POST /pay`
  (idempotency-keyed on `user_sub:requestId` so a retry never double-pays), `GET /pay/:transferId`
  (owner-scoped status refresh), `GET /payments` (history). Deterministic I/O — **no LLM**; the
  finance-analyst bot is untouched. New owner-scoped `oshal_finance_payments` audit table.
- **Surface**: a Send-money panel on the dashboard, disabled until a rail is configured, with an
  explicit confirm and a test-mode banner.
- **Honest v1 limit** (BACKLOG): the Stripe rail debits the user's bank into the platform Stripe
  balance — true account-to-account routing to an arbitrary biller is a **Plaid Transfer / Dwolla**
  rail (registered as not-yet-implemented in `payment-provider.ts`, fails loudly if selected).
  Money movement is money-transmitter territory; production use needs the corresponding compliance
  review, exactly like Plaid production access.

## Amendment (2026-07-18) — Plaid is a hub connector (`auth:'link'`), not an app-private store

The original decision above ("Plaid is intentionally **not** a generic `connectors-routes` provider …
connecting happens on the Finance surface" and "Finance owns its own stores … `oshal_finance_items`")
is **superseded on the connector/identity axis.** The operator called the app-private token store the
anti-pattern:

> An app should **reference** the connector hub (declare a connector requirement + a default,
> optionally select a second) and may **register** a new connection into the hub — but it must
> **not** fork its own connection flow + token store. It *can*, but it *shouldn't*.

The premise that forced the app-private store — "Plaid's Link model doesn't fit the hub" — was wrong.
The hub is not a two-shape (OAuth-redirect / PAT) thing; `connectors-routes.ts` is a pluggable
`ProviderDef` registry that has already absorbed OAuth-code, PKCE, HTTP-Basic token endpoints, **and**
token-paste (SmartThings/Twilio/Uber). Plaid Link is therefore just **one more auth mode**, sibling to
`auth:'token'`.

**Decision (hub half shipped `main` 3855949e):**

- New `auth:'link'` mode + a `plaid` entry in the hub's `PROVIDERS` registry (finance category).
- New [`src/app/routes/connector-plaid-link.ts`](../../src/app/routes/connector-plaid-link.ts):
  `POST /api/connect/plaid/link-token` (create the Link token) + `POST /api/connect/plaid/exchange`
  (widget `public_token` → `access_token`, institution-labeled). The Link **widget** may still render
  on the Finance surface, but the connection **identity + token live in the hub**: the surface POSTs
  the `public_token` to the hub route.
- Tokens land in `oshal_connections` (per-user AES-256-GCM, the same store + tenancy as every other
  connector) and read back via the standard broker — `getValidAccessToken`'s no-`refresh_token` branch
  (Plaid tokens are long-lived/non-expiring) and `resolveBotCreds('plaid')` → `OSHAL_CRED_PLAID` for the
  ADR-083 `oshal-plaid.js` bot fallback. **Multiple banks are native**: each Plaid Item is its own token
  + `item_id`, so `upsertConnection` (keyed on `account_key` = the item_id) adds one row per institution.
- Verified: 5 Playwright specs ([`tests/plaid-link-connector.spec.ts`](../../tests/plaid-link-connector.spec.ts))
  — list surfacing, `configured`-gating, 401/503/400 guards, Chase+Fidelity multi-bank storage, and
  routing safety (the generic `/plaid/start` 503s instead of redirecting to an empty OAuth URL).

**Store-repo Finance half — still TODO** (Finance was carved to the app-store repo per ADR-085, so it is
NOT in this repo): `finance.yaml` `dependencies.connectors: [plaid]`; `finance-plaid.ts` reads tokens via
the hub broker (enumerate **all** `plaid` rows via `accessibleConnections` + `decryptToken` — one
`access_token` per Item — instead of `oshal_finance_items`); the surface calls `/plaid/link-token` +
`/plaid/exchange`; then **retire `oshal_finance_items`** (the aggregate cache `oshal_finance_data` stays).
Cheap now — Finance holds only Plaid Sandbox creds, so there are no real-bank tokens to migrate; the cost
of deferring rises once production access lands.

**Unchanged by this amendment:** the *fetch/reasoning* split (the controller does the deterministic Plaid
HTTPS I/O; the reason-only `finance-analyst` bot does the LLM brief). Who owns the connection changed; who
does the work did not.
