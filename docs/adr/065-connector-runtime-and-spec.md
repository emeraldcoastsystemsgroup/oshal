# ADR-065 — Connector runtime + declarative connector spec: from artisanal to manufactured integrations

- **Status:** Accepted — BUILT 2026-06-21. The runtime (`ConnectorClient`: retries/backoff,
  rate-limit governor, refresh-on-401, structured errors, cursor/offset/link/link-header pagination),
  the declarative `connector.yaml` generator (`buildClientFromSpec` + loader + validator), OpenAPI
  import (`specFromOpenApi`), the audit gate (`auditConnectorCatalog`), the doc generator
  (`specToMarkdown` → `docs/connectors/*.md`), and the webhook ingress + dedup + ticket wiring.
  **Live wiring:** `/api/connectors/<provider>` is mounted in `server.ts` (auto-discovers every
  `connector.yaml`, broker-resolved creds) behind `CONNECTOR_SPEC_ROUTES`; the webhook ingress
  (`/api/hooks/:provider/:event`, migration 056) is wired in `connector-webhook-routes.ts` behind
  `CONNECTOR_WEBHOOKS` (both mounted in server.ts). **Catalog: 45 connectors** across productivity,
  comms, dev/ops, files, finance, media, and personal "your-world" data (Strava/Oura/Fitbit/WHOOP) —
  all passing the audit gate; see [docs/connectors/README.md](../connectors/README.md) (auto-generated).
  Per-user paste-connect is wired for the non-OAuth providers via a `generic` token-paste flavor
  (validated against each provider's whoami). The runtime also supports `credProvider` (share one OAuth
  token across APIs, e.g. gmail/youtube→google) and configurable body-`link` pagination
  (`@odata.nextLink`). ADR-067 now exposes `tool:` resources as framework tools through an in-process
  connector executor that resolves the caller's brokered credentials. The TMDB bespoke client was
  migrated onto the runtime as the canonical-path proof. Additive + off-by-default: the existing
  bespoke routes (`/api/spotify` etc.) are unaffected.
  Unit tests green, typechecks clean.
- **Date:** 2026-06-21
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-042 (IoT connector tenancy)](042-iot-connector-tenancy.md),
  [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-062 (media concierge + partner credential governance)](062-media-concierge-apps-and-partner-credential-governance.md),
  [ADR-063 (AI Test Lab)](063-ai-test-lab.md)

## Context

We have ~20 real connectors (Google, Outlook, Slack, Spotify, TMDB, Duffel, Walmart, Uber Eats/Rides,
GCP, SmartThings, Square, PayPal, GitHub, Dropbox, LinkedIn, Twitter, …). Each is genuinely valuable —
they **act** on the user's own data through the ADR-056 broker, which the incumbents (n8n, UiPath,
Salesforce, Microsoft) don't do. But each is also an artisanal snowflake:

- A bespoke `call()` per client (`spotify-client.ts`, `tmdb-client.ts`, `slack-client.ts`, …), each a
  single `fetch` with **no retries, no backoff, no rate-limit governor**.
- A **different error shape** per connector — a bare `Error` with an ad-hoc message and an optional
  `.status` — so bots, surfaces, and the AI Test Lab (ADR-063) each branch on string-matching.
- Refresh-on-401, pagination, and schema validation done differently (or not at all) per connector.

The honest gap, stated by the team: *"valuable custom connectors, but not hundreds of hardened
integrations with consistent auth, retries, schemas, webhooks, and docs."*

The wrong fix is to hand-write more snowflakes — adding connector #21 costs as much as #1, and we will
never out-count n8n's ~400 by hand. The defect to fix is the **unit cost and consistency** of a
connector, so depth stops trading off against reliability.

## Decision

Introduce a connector **runtime** (the shared middle layer between "token in DB" and "provider API")
and, on top of it, a **declarative connector spec** so a connector becomes a document plus a thin
mapping, not a fresh HTTP client.

### Phase 1 — Connector runtime (this PoC)

`src/app/connectors/runtime/` — one `ConnectorClient` every connector uses instead of raw `fetch`:

- **Auth injection** — one switch over `bearer | basic | apiKeyHeader | apiKeyQuery | none`, instead
  of 20 bespoke header blocks. Bearer takes a `TokenProvider` thunk so it composes with the ADR-056
  broker (`brokeredBearer(getValidAccessToken, …)`) on the controller path and a fixed token in tests.
- **Refresh-on-401** — on a 401 the runtime calls the `TokenProvider` once with `{ force: true }` and
  retries with the new token (not charged against the retry budget). Centralizes logic that was
  scattered across each `oshal-*.js`.
- **Retries with exponential backoff + full jitter**, honoring `Retry-After`. Per-call override so a
  resource-creating POST can opt out (`retry: { maxRetries: 0 }`) to avoid duplicate writes.
- **Rate-limit governor** — a per-client token bucket (`burst` + `perSecond`). The one thing that
  genuinely breaks at "hundreds of integrations" scale, so it lives in the shared layer.
- **Structured errors** — every failure normalizes to one `ConnectorError { provider, status, code,
  retriable, bodySnippet, attempts }`, classified in exactly one place (`fromStatus`/`fromNetwork`).
- **Pagination** — `paginate()` with `cursor | offset | link` strategies, instead of per-connector loops.
- **Telemetry** — one `onCall` record per request (provider/method/status/latency/attempts/ok) for the
  catalog health dashboard, wired to the existing Prometheus path.

### Phase 2 — declarative spec + generator + webhook ingress (BUILT)

- A declarative `connector.yaml` (see [docs/connector-spec.md](../connector-spec.md) +
  [swarm-apps/connector.schema.json](../../swarm-apps/connector.schema.json)): provider, auth,
  baseUrl, rateLimit, pagination, resources (→ bot tools), webhooks. `buildClientFromSpec(spec, creds)`
  (in `runtime/spec.ts`) turns it into a callable client — credentials supplied at build time by the
  broker, never baked into the manifest. Real specs shipped for **Spotify** (oauth2 bearer, link
  pagination) and **TMDB** (apiKeyQuery, offset pagination) — two different auth + pagination shapes
  driven by the one generator with zero bespoke client code, proving breadth.
- A **webhook ingress framework** (`connectors/webhooks/webhook-ingress.ts`): `verifySignature`
  (hmac/shared-secret/jwt, constant-time), `dispatchWebhook` (404 unknown / 401 bad-sig / dedup / →
  `onEvent`), an in-memory `SeenStore`, and `createWebhookIngressRouter` for
  `POST /api/hooks/:provider/:event` — generalizing the one hardcoded Alertmanager webhook. Not mounted
  by default.

### Phase 3 — breadth + quality machine (BUILT)

- **OpenAPI import** (`runtime/openapi-import.ts`): `specFromOpenApi(provider, doc)` drafts a
  ConnectorSpec from an OpenAPI 3 document — baseUrl from `servers`, auth from the first
  `securityScheme`, one resource per operation with path/query placeholders wired and bot tools named
  from `operationId`. Emits `warnings` for everything a human must confirm (opaque bodies, multiple
  schemes). This is the breadth multiplier toward "hundreds".
- **Catalog audit gate** (`runtime/catalog-audit.ts`): `auditConnectorCatalog()` loads every
  `connector.yaml` and grades it (valid shape, declared auth, rate limit present, well-formed
  resources, unique tool names, coherent pagination). A connector that isn't green isn't in the
  catalog — "hardened" becomes machine-enforced. The shipped Spotify + TMDB specs pass with 0 errors.
- **Doc generator** (`runtime/spec-to-doc.ts` + `scripts/connectors/gen-connector-docs.ts`):
  `specToMarkdown(spec)` derives a doc page (auth, scopes, rate limits, resources + bound inputs,
  webhook events, tools) straight from the spec, so docs can't drift. Generated pages live at
  `docs/connectors/*.md`.
- **Production webhook wiring** (`webhooks/webhook-handlers.ts`): `ticketingWebhookHandler` turns a
  verified event into a swarm ticket (generic over provider/event via a mapper); `dbSeenStore`
  provides cross-replica dedup (INSERT ... ON CONFLICT DO NOTHING) via an injectable `query` fn.

### Phase 4+ (planned)

- Port the remaining ~19 connectors onto the runtime/spec.
- ~~Mount the webhook router + wire `dbSeenStore` and the delivery table migration in `server.ts`.~~
  **DONE — and it had been done for a while.** `server.ts` mounts `mountConnectorWebhookRoutes`
  behind `CONNECTOR_WEBHOOKS`, with `dbSeenStore` wired and migration 056 in place; this line stayed
  in the "planned" list because nothing guarded either side, so nobody noticed the doc had drifted.
  The env comparison is now the exported `connectorWebhookIngressEnabled()` and the guard
  (`tests/unit/connectors/connector-webhook-mount.spec.ts`) pins both halves: the gate, and that a
  mounted ingress REFUSES an unsigned, wrongly-signed, or undeclared delivery — the signature is the
  only reason a route outside the OIDC wall is safe.
- Per-connector conformance specs (recorded/mocked providers) extending the runtime suite —
  **still open.** The shared runtime behaviours (auth, refresh-on-401, retry/backoff/Retry-After,
  rate limiting, error classification, pagination) are covered once in
  `tests/unit/connectors/connector-runtime.spec.ts`; what is missing is a per-connector pass over the
  catalog. Done when a table-driven suite drives every declared resource of every spec against a
  stubbed transport and fails on the first connector whose declared shape does not round-trip.
- ICP-first mass production (productivity/comms/storage/dev backbone) then community-contributed
  `connector.yaml` PRs, with governance + docs flowing through the broker (ADR-056).

## Consequences

- **Positive:** new connectors collapse to a thin mapping; reliability (retry/rate-limit/refresh) is
  inherited, not reimplemented; callers get one error shape; catalog health becomes observable; the
  conformance suite gates quality so depth doesn't erode trust. The acting-on-own-data moat is kept.
- **Cost / migration:** existing connectors must be ported to realize the benefit. Migration is
  **incremental and additive** — each client is ported behind its existing function signature, proven
  by the conformance suite, then swapped at its call site. Nothing is rewired in this PoC; the Spotify
  port is parallel/opt-in (`spotify-runtime-client.ts`), leaving `routes/spotify-client.ts` live.
- **Hot-swap note:** the runtime is TypeScript served from compiled `dist/`, so it does **not**
  hot-swap into a running container on refresh (unlike static surfaces). It reaches the shared
  deployment via the normal path — merge to `main`, build `dist/`, restart — which is also the
  isolation boundary that keeps one dev's branch from stomping another's deployed code.

## Status of the PoC

Built on branch `feature/connector-runtime` (isolated git worktree off `main`):
`connector-error.ts`, `types.ts`, `connector-client.ts`, `index.ts`, the Spotify port
(`connectors/spotify/spotify-runtime-client.ts`), and `tests/unit/connectors/connector-runtime.spec.ts`.
Validates the abstraction: Spotify's ~115-line bespoke transport collapses to declarations + per-resource
maps, and the conformance suite proves auth, refresh-on-401, retry/backoff/Retry-After, rate-limiting,
error classification, and pagination — all with no live credentials.
