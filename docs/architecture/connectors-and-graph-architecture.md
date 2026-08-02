# Connector runtime + personal knowledge graph — architecture

> This document covers two interlocking systems built under ADR-065 and ADR-066. It is written
> for an engineer or technical reviewer evaluating the design. Every claim is grounded in the
> referenced source files; follow the links to confirm them.

---

## Table of contents

1. [The problem and thesis](#1-the-problem-and-thesis)
2. [The connector runtime](#2-the-connector-runtime)
   - [ConnectorClient](#21-connectorclient)
   - [From spec to live client](#22-from-spec-to-live-client)
   - [OpenAPI import](#23-openapi-import)
   - [Audit gate](#24-audit-gate)
   - [Auto-generated docs](#25-auto-generated-docs)
3. [Connect and credentials](#3-connect-and-credentials)
   - [OAuth providers](#31-oauth-providers)
   - [Token-paste providers](#32-token-paste-providers-generic-flavor)
   - [credProvider sharing](#33-credprovider-sharing-gmailyoutube--google)
   - [The ADR-056 broker model](#34-the-adr-056-broker-model)
   - [Per-request credential resolution](#35-per-request-credential-resolution)
4. [Webhooks](#4-webhooks)
5. [The personal knowledge graph](#5-the-personal-knowledge-graph)
   - [Schema](#51-schema)
   - [GraphStore](#52-graphstore)
   - [Ingest mappers](#53-ingest-mappers)
   - [Reverberation pass](#54-reverberation-pass)
   - [End-to-end data flow](#55-end-to-end-data-flow)
6. [Status and feature flags](#6-status-and-feature-flags)
7. [How this was built](#7-how-this-was-built)

---

## 1. The problem and thesis

### The gap

Integration platforms (n8n, UiPath, Salesforce, Microsoft Power Automate) have wide connector
catalogs — n8n ships ~400. But "wide" and "acting on the user's own data" are different things.
Every one of those platforms is fundamentally a workflow-automation tool: it moves data between
services the operator configures. It does not give an individual user an AI that can reach into
*their* Gmail, *their* GitHub repos, *their* Strava activities, and act on their behalf.

The assistant incumbents (ChatGPT, Microsoft Copilot) swing the other way: they retrieve over
documents and answer questions, but they build no persistent cross-source model of the user's
world. Palantir and Glean build enterprise graphs, but those are company-owned, behind enterprise
contracts, and not self-hostable.

The gap this system targets: a self-hosted AI cockpit where each user's connectors are brokered
to *their* identity, the data they pull is turned into a graph *they own*, and bots act on that
graph. The moat compounds as more sources are connected, because the graph links the same person
or event across every source into a single entity.

### Why the architecture matters

Before ADR-065, ~20 bespoke connectors each hand-rolled their own `fetch`. Adding connector #21
cost as much as #1. Worse, each had a different error shape, no retries, no rate-limit governor,
and inconsistent or absent refresh-on-401 logic.

The thesis: *depth* stops trading against *reliability* when a connector is a document
(`connector.yaml`) plus at most a thin response transform, and a shared runtime handles all
transport concerns. The audit gate (`catalog-audit.ts`) makes "hardened" machine-enforced, not
aspirational.

The knowledge graph extends the thesis: *retrieval* stops being the ceiling when the same
connector data feeds a persistent, user-owned graph that deduplicates across sources and
accumulates edges over time.

---

## 2. The connector runtime

Source: `src/app/connectors/runtime/`

### 2.1 ConnectorClient

`connector-client.ts` is the shared HTTP middle layer. Every connector calls it instead of raw
`fetch`. One call flows through, in order:

```
token-bucket acquire  ->  applyAuth  ->  fetchOnce (AbortController timeout)
  -> on 401: force token refresh (TokenProvider { force:true }), retry (not charged)
  -> on 429/5xx/network: exponential backoff + full jitter, honoring Retry-After header
  -> ConnectorError normalization on all failure paths
  -> onCall telemetry emission (provider/method/path/status/ms/attempts/ok)
```

**Auth injection.** `applyAuth` handles five auth shapes via a single switch on `AuthSpec.type`:

| type | how it lands |
| --- | --- |
| `bearer` | `Authorization: Bearer <token>` (token from `TokenProvider` thunk) |
| `basic` | `Authorization: Basic <base64>` |
| `apiKeyHeader` | named header, e.g. `X-Figma-Token` |
| `apiKeyQuery` | query param appended to the URL, e.g. `?api_key=…` |
| `none` | no credential header added |

The `TokenProvider` thunk (`types.ts`) is called with `{ force: true }` on 401 so the runtime can
force a refresh without knowing whether the token came from an OAuth broker or a fixed value in a
test. This is how refresh-on-401 is centralized: the connector declares `auth.type: bearer` and
supplies a `TokenProvider`; the runtime owns the retry logic.

**Retries and backoff.** Default policy: `maxRetries: 3, baseDelayMs: 300, maxDelayMs: 10_000,
honorRetryAfter: true`. The backoff is `min(maxDelayMs, baseDelayMs * 2^n)` with full jitter
(uniform draw in `[0, expo]`, AWS-style). If the response carries a `Retry-After` header (seconds
or HTTP date), the wait is `max(retryAfterMs, jitter)`. Non-idempotent resources in `connector.yaml`
override this with `retry: { maxRetries: 0 }`.

**Rate-limit governor.** A per-`ConnectorClient` token bucket (`TokenBucket`, same file). Declared
as `{ burst, perSecond }` in the `ConnectorClientConfig`. Default is 0/0 (disabled). Refills at
`perSecond` tokens per second, capped at `burst`. Every `request()` call calls `bucket.acquire()`
first, sleeping if tokens are exhausted. This is the one place provider throttles are governed —
depth at catalog scale cannot manage this correctly per connector.

**Structured errors.** Every failure path normalizes to `ConnectorError` (`connector-error.ts`):

```ts
class ConnectorError extends Error {
  provider: string;
  status?: number;
  code: 'auth' | 'rate_limited' | 'not_found' | 'bad_request' | 'server' | 'network' | 'unknown';
  retriable: boolean;
  bodySnippet?: string;
  attempts: number;
}
```

`ConnectorError.fromStatus` is the single location where HTTP status codes are classified into
`code` and `retriable`. Callers (bots, surfaces, the AI Test Lab) branch on `code`, not string
messages.

**Pagination.** `paginate()` supports four strategies, declared per resource:

| strategy | how it works |
| --- | --- |
| `cursor` | extracts the next cursor from a dot-path in the response body; appends to a query param |
| `offset` | increments a numeric offset param by `pageSize` each page |
| `link-header` | follows the RFC-5988 `Link: <url>; rel="next"` response header (GitHub-style) |
| `link` | follows an absolute next-URL in the response body (Spotify `next`, or `@odata.nextLink`) |

The `link-header` parser (`parseNextLink`) is exported and tested independently. The `link`
strategy uses `dotGet` to handle literal-dot field names like `@odata.nextLink`. For bare-array
responses (GitHub `/user/repos`), the extract function detects `Array.isArray(page)` and returns
the page directly, rather than attempting to read `page.items`.

**Telemetry.** The `onCall` config hook is called on every request with `{ provider, method, path,
status, ms, attempts, ok }`. It is decoupled from any storage — the caller wires it to the
existing Prometheus/Alertmanager path, or leaves it as a no-op in tests. The runtime wraps the
call in a try/catch so a telemetry failure never interrupts a request.

### 2.2 From spec to live client

`spec.ts` contains `buildClientFromSpec(spec, opts)`: the generator that turns a validated
`connector.yaml` into a `SpecClient` — a `ConnectorClient` pre-configured from the spec, plus a
`call(resource, inputs)` method that dispatches to any declared resource by name.

The flow inside `buildClientFromSpec`:

1. `validateSpec` confirms the spec has a valid provider slug, an `https` base URL, a declared
   auth type, and at least one resource with a name, method, and path.
2. `toAuth` maps `spec.auth.type` to a concrete `AuthSpec`, pulling credentials from `opts`
   (supplied by the broker at call time, never from the spec file).
3. A `ConnectorClient` is constructed with the spec's rate limits, retry policy, headers, and
   timeout.
4. `call(resource, inputs)` resolves the resource by name, renders `{placeholders}` in the path
   (URL-encoded via `renderPath`) and in query/body values (whole-value bind for typed fields like
   arrays; string interpolation otherwise), and delegates to `client.request()` or
   `client.paginate()` when `resource.paginate: true`.

The `tools()` method returns the subset of resources that have a `tool:` name — these are the
entries the framework exposes as bot-callable tools.

**The live mount.** `connector-spec-routes.ts` auto-discovers every `swarm-apps/connectors/*.yaml`
at startup (when `CONNECTOR_SPEC_ROUTES=on`) and mounts a `createConnectorSpecRouter` per spec at
`/api/connectors/<provider>`. Each router exposes:

- `GET /_resources` — introspection: the resource/tool catalog for this connector
- `POST /:resource` — call a named resource; inputs come from the request body and query string

Credentials are resolved per-request via `resolveCreds` in `connector-spec-routes.ts`: the
authenticated user's broker-stored token wins; `CONNECTOR_<PROVIDER>_TOKEN` (or `_KEY`) is the
operator fallback. The TMDB fallback also checks `TMDB_API_KEY` for backward compatibility.

The GitHub spec (`swarm-apps/connectors/github.yaml`) is the reference example: it exercises
link-header pagination, global request headers (`Accept: application/vnd.github+json`,
`X-GitHub-Api-Version`), a write resource with `retry: { maxRetries: 0 }`, and a declared webhook.

### 2.3 OpenAPI import

`openapi-import.ts` implements `specFromOpenApi(provider, doc, opts?)`. Given an OpenAPI 3 document
(already parsed to an object), it returns a draft `ConnectorSpec` and a `warnings[]` list:

- `servers[0].url` becomes `baseUrl` (warns if absent).
- The first `securitySchemes` entry maps to an auth type: `http/bearer` or `oauth2` → `oauth2`;
  `http/basic` → `basic`; `apiKey/query` → `apiKeyQuery`; `apiKey/header` → `apiKeyHeader`.
  Multiple schemes produce a warning; an unrecognized type defaults to `none`.
- Each `paths[path][method]` becomes one resource: name from `operationId` (or a slug of
  `method + path`), query params wired from `parameters[in=query]` as `{name}` placeholders, body
  flagged with `retry: { maxRetries: 0 }` for non-GET methods. Opaque `requestBody` shapes emit
  a warning.
- The draft gets conservative defaults: `rateLimit: { burst: 10, perSecond: 10 }`,
  `retry: { maxRetries: 3, honorRetryAfter: true }`.

The output is a starting point that compiles and runs; rate limits, pagination, scopes, and webhook
declarations require human review.

### 2.4 Audit gate

`catalog-audit.ts` implements `auditConnectorCatalog(dir?)`, which loads every `.yaml` in
`swarm-apps/connectors/` and grades each against a checklist:

- **error** (blocks catalog entry): invalid spec shape, missing `provider` slug, non-`https`
  base URL, missing required resource fields, duplicate `tool` names.
- **warn** (logged, not blocking): `auth.type: none` without a note, no `rateLimit.perSecond`
  (governor disabled), no `retry` (defaults apply), a resource with no `tool` name, a paginating
  resource missing `spec.pagination`.

`auditSpec` also checks that non-GET resources with auto-retry are flagged (duplicate-write risk).
`formatAudit` renders a one-line-per-connector CI log summary (`[PASS] github — 0 error(s), 1
warning(s)`).

The audit is enforced by `tests/unit/connectors/openapi-and-catalog.spec.ts` — it calls
`auditConnectorCatalog()` in CI and fails the build if any connector has errors. Connector totals
are derived from the YAML catalog (307 specs in the 2026-07-23 public-trunk audit), rather than
maintained as a constant in this document.
currently pass with 0 errors.

### 2.5 Auto-generated docs

`spec-to-doc.ts` implements `specToMarkdown(spec)`. It derives a Markdown page from the spec
alone: a metadata table (provider, baseUrl, auth, rate limit, retry, pagination), a resources
table (name, tool, method, path, inputs), a webhooks table (event, verification type), and a
tools list. The generated pages live at `docs/connectors/<provider>.md` and are regenerated by
`scripts/connectors/gen-connector-docs.ts`. The file header states "do not edit by hand — change
the spec", so docs cannot drift from the running behavior.

---

## 3. Connect and credentials

Source: `src/app/routes/connectors-routes.ts`, `src/app/routes/connector-account-lookup.ts`,
`src/app/routes/connector-spec-routes.ts`

### 3.1 OAuth providers

The `PROVIDERS` registry in `connectors-routes.ts` defines every OAuth-capable provider. Each
entry declares `authUrl`, `tokenUrl`, `scopes`, `scopeSep`, `redirectPath`, `flavor`, and optional
flags:

- `pkce: true` — X/Twitter requires PKCE (S256). The verifier is generated at `/start`, encrypted
  with AES-256-GCM under `SESSION_SECRET`, and stored in a short-lived HttpOnly cookie
  (`oshalpkce_<provider>`, 10 min) — not in the `state` param (which was bloating X's authorize
  URL). The verifier is recovered at callback via `readPkceVerifier()`, then the cookie is cleared.
- `tokenAuth: 'basic'` — Twitter, Spotify, PayPal, and SmartThings require HTTP Basic on the
  token endpoint (client_id:client_secret base64), not a form body.
- `allowTokenFallback: true` — SmartThings accepts a pasted Personal Access Token when the OAuth
  app (`SMARTTHINGS_CLIENT_ID`) is not configured, so the connector is immediately usable without
  partner app registration.

The CSRF `state` is an HMAC-signed, time-boxed (10-minute) token — no server-side store needed.
`signState` encodes `{ provider, sub, ts }` as a base64url JSON body signed with
`HMAC-SHA256(SESSION_SECRET)`. `verifyState` rejects bad signatures and expired states.

Access and refresh tokens are stored in `oshal_connections` (Postgres), encrypted at rest with
AES-256-GCM. The key is `SHA-256(SESSION_SECRET)`. The `iv:authTag:ciphertext` blob format is
the envelope.

### 3.2 Token-paste providers (generic flavor)

Providers with `auth: 'token'` and `flavor: 'generic'` in `PROVIDERS` accept a Personal Access
Token pasted at `POST /api/connect/<provider>/token`. No OAuth app registration required. The
paste is validated before storage via the `GENERIC_VERIFY` table in `connector-account-lookup.ts`:

```ts
const GENERIC_VERIFY: Record<string, {
  url: string;      // the provider's whoami/identity endpoint
  header?: string;  // auth header name (default: Authorization)
  prefix?: string;  // token prefix (default: "Bearer "; empty string = raw value)
  idPath?: string;  // dot-path to the user id field in the response
  emailPath?: string;
  label: string;
}> = {
  gitlab:   { url: 'https://gitlab.com/api/v4/user',         header: 'PRIVATE-TOKEN', prefix: '' ... },
  zoom:     { url: 'https://api.zoom.us/v2/users/me', ... },
  figma:    { url: 'https://api.figma.com/v1/me',     header: 'X-Figma-Token', prefix: '' ... },
  pagerduty:{ url: 'https://api.pagerduty.com/abilities', header: 'Authorization', prefix: 'Token token=' ... },
  // ... 30+ more
};
```

The connect handler makes a live GET to `url` with the pasted token. A non-2xx response closes the
connect (400 returned to the UI). A 2xx extracts the account identity via the `idPath`/`emailPath`
dot-paths and stores the encrypted token in `oshal_connections`. Adding a new paste provider
requires only one entry in `PROVIDERS` (flavor `generic`) and one row in `GENERIC_VERIFY`.

### 3.3 credProvider sharing (gmail/youtube -> google)

Some `connector.yaml` files declare `credProvider: google` — this tells `connector-spec-routes.ts`
to resolve the broker token using the `google` provider key, not the spec's own provider slug.
This means a user who connects their Google account once (`/api/connect/google`) automatically
has that token available for the `gmail`, `google-calendar`, `google-drive`, and `youtube` specs
without separate connect flows.

### 3.4 The ADR-056 broker model

The design constraint from ADR-056: the reasoning layer (bots, Jarvis) holds no credentials. Every
data access is mediated by the broker via `getValidAccessToken(pool, userSub, provider)`, which
checks the token's expiry, refreshes if necessary, and returns the decrypted bearer token — or
`null` if the user has not connected that provider.

The `ConnectorClient` receives a `TokenProvider` thunk (`types.ts`), not the pool or the
`SESSION_SECRET`. The convenience wrapper `brokeredBearer` in `connector-client.ts` composes these:

```ts
export function brokeredBearer(
  getValidAccessToken: (pool, userSub, provider) => Promise<string | null>,
  pool, userSub, provider
): TokenProvider {
  return async () => getValidAccessToken(pool, userSub, provider);
}
```

This is the seam: in production, the `TokenProvider` wraps `getValidAccessToken`; in tests, it
returns a fixed string. The runtime never touches the database directly.

### 3.5 Per-request credential resolution

`connector-spec-routes.ts` → `resolveCreds(spec, pool, req)`:

1. Extracts the caller's OIDC `sub` from the session.
2. Uses `spec.credProvider || spec.provider` to call `getValidAccessToken(pool, sub, credProvider)`.
3. Falls back to `CONNECTOR_<PROVIDER>_TOKEN` / `CONNECTOR_<PROVIDER>_KEY` env vars (operator level).
4. For `apiKeyHeader` / `apiKeyQuery` specs, also checks the TMDB-specific env key
   (`TMDB_API_KEY`) as a named fallback.
5. Returns a `BuildSpecOptions` object that `buildClientFromSpec` and the spec route consume.

The broker token always wins over the env fallback. The env fallback means an operator can supply
one shared key and every authenticated user benefits without individual connect flows.

---

## 4. Webhooks

Source: `src/app/connectors/webhooks/`, `src/app/routes/connector-webhook-routes.ts`

The webhook system is a generic inbound events framework that replaces the one-off hardcoded
Alertmanager route.

**Mount.** `mountConnectorWebhookRoutes` (in `connector-webhook-routes.ts`) loads all
`webhooks:` declarations from every `connector.yaml`, collects them as `WebhookEventSpec[]`, and
mounts `POST /api/hooks/:provider/:event` via `createWebhookIngressRouter`. It is NOT behind OIDC
authentication — it self-guards via signature verification, exactly as the Alertmanager route does.
The route is gated by `CONNECTOR_WEBHOOKS=on`.

The raw body is captured via an `express.json` verify callback (`buf.toString('utf8')`) so HMAC
verification sees the exact bytes the provider signed, not a re-serialized JSON object.

**Verification.** `verifySignature` in `webhook-ingress.ts` handles three types:

| type | mechanism |
| --- | --- |
| `hmac` | `HMAC-SHA256(secret, rawBody)`, hex-encoded; strips `sha256=` prefix (GitHub-style). Configurable algo |
| `shared-secret` | constant-time compare of the raw header value against the secret |
| `jwt` | minimal HS256: `HMAC-SHA256(secret, header.payload)` → base64url, compared to the token's signature part |

All comparisons use `crypto.timingSafeEqual` on equal-length buffers to prevent timing attacks.
Secrets are never in the manifest: `verify.secret` uses `env:VAR_NAME` references, resolved at
mount time via `resolveSecret`.

**Dedup.** `dispatchWebhook` extracts the delivery id from a configured header (default
`x-delivery-id`). If absent, it SHA-256 hashes `provider:event:rawBody` — so replays of the
same body are deduplicated even without a provider-specific id header. It checks the `SeenStore`
before calling `onEvent`, and records the id after.

Two `SeenStore` implementations ship:

- `inMemorySeenStore(max)` — bounded LRU set; single-process only, not cross-replica.
- `dbSeenStore(queryFn, table)` in `webhook-handlers.ts` — uses
  `oshal_webhook_deliveries (delivery_id TEXT PRIMARY KEY)` with
  `INSERT ... ON CONFLICT DO NOTHING`. Two replicas racing the same delivery both stay correct.
  The `queryFn` injection keeps it testable without a live database.

**Dispatch.** Verified, non-duplicate events are passed to `onEvent`. Generic connector events use
`ticketingWebhookHandler` and its replaceable mapper. GitHub `issues` events take a specialized,
idempotent path: the synchronizer validates the payload, rejects pull-request-shaped issues and
repositories outside the trusted feed list, and uses `owner/repository#number` as the stable
external id. A first allowed `opened` event creates a `backlog` ticket; later issue events update
that projection instead of creating duplicates.

The GitHub `issues` declaration in `swarm-apps/connectors/github.yaml` verifies HMAC-SHA256 from
`X-Hub-Signature-256` using `env:GITHUB_WEBHOOK_SECRET`. These are native repository webhooks sent
directly to OSHAL. No GitHub Actions workflow or runner sits in the path, so webhook intake does not
consume Actions minutes.

**Trusted GitHub ticket feeds.** `github-ticket-provider-config.ts` defines three request-only defaults:

| Feed | Issue repository | Work repository | Release repository | Queue / type |
| --- | --- | --- | --- | --- |
| Applications | `emeraldcoastsystemsgroup/oshal-applications` | `emeraldcoastsystemsgroup/oshal-applications` | `emeraldcoastsystemsgroup/oshal-applications` | GitHub Application Requests / `build` |
| Core (preferred) | `emeraldcoastsystemsgroup/open-shal` | `emeraldcoastsystemsgroup/open-shal` | `emeraldcoastsystemsgroup/oshal` | GitHub Core Requests / `oshal-dev` |
| Core (release compatibility) | `emeraldcoastsystemsgroup/oshal` | `emeraldcoastsystemsgroup/open-shal` | `emeraldcoastsystemsgroup/oshal` | GitHub Core Requests / `oshal-dev` |

`GITHUB_TICKET_FEEDS` can replace the trusted server-side mappings. Configuration, rather than
issue prose or an inferred ADR, determines the queue and work/release routing metadata. Each feed
has an explicit bootstrap policy. The defaults use a fixed cutover, and both webhook projection and
REST reads reject issues created before it: this is intentionally a new request queue, not a GitHub
history import.

**Optional pull reconciliation.** `GitHubWorkItemFeedAdapter` can read the same feeds through the
GitHub REST API with `GITHUB_TICKET_TOKEN`. It reads issue updates, including missed close and
reopen transitions, filters pull requests, applies the same bootstrap boundary, and persists a composite per-repository cursor through
`oshal_intake_cursors` (migration 092). This is an operator-triggered recovery/reconciliation path;
native webhooks remain primary, and neither path requires GitHub Actions.

**Release-proof closure.** Intake and ordinary writeback never close a GitHub issue. At release
time, the pure `github-release-close-policy` permits a PR closing directive only for the exact
`code-write` label, vetoes `bug` and `defect`, and requires the configured release repository. The
core sanitized-snapshot script applies that decision to its `oshal` release PR; application work
uses a same-repository PR into `oshal-applications/main`. Direct pushes/tags and label-read failures
leave the request open. Both paths use GitHub's native PR merge behavior and need no Actions job.

---

## 5. The personal knowledge graph

Source: `src/features/personal-graph/`

### 5.1 Schema

`graph-types.ts` defines the typed schema.

**Node types:** `Person`, `Org`, `Event`, `Place`, `Activity`, `Document`, `Message`,
`Transaction`, `Repo`, `Media`.

Every node shares `GraphNodeBase`:
- `id` — stable, deterministic. Format: `<type-lower>:<natural-key>`. Examples:
  `person:alice@example.com`, `event:google-calendar:abc123`, `repo:github:octocat/hello-world`,
  `activity:strava:9871234`.
- `type` — `NodeType` discriminant.
- `label` — display string.
- `sources: SourceRef[]` — one entry per provider+externalId where this entity was observed.
  Accumulated across upserts.
- `props` — narrow, per-type fields (only what is needed for display and dedup; raw items are not
  stored on the node).

**Edge types:** `attended`, `organized`, `located-at`, `authored`, `mentions`, `related-to`,
`owns`, `paid`, `participated-in`. Directed (`from` → `to`).

Each `GraphEdge` has:
- `id` — `<type>:<from>->-<to>` (built by `edgeId()`).
- `sources: SourceRef[]` — accumulated on upsert.
- `props?` — optional metadata (e.g. `{ reason: 'same-person-merge' }`).

**Deterministic ids are the linchpin.** `ingest-helpers.ts` exports `personId`:
```ts
export function personId({ email, provider, handle }): string {
  const e = normalizeEmail(email);
  if (e) return `person:${e}`;
  if (provider && handle) return `person:${provider}:${handle.toLowerCase()}`;
  throw ...;
}
```
Email is the strong key: a person seen in Gmail and in Google Calendar with the same email
address produces the same node id before any reverberation pass runs.

### 5.2 GraphStore

`graph-store.ts` defines the `GraphStore` interface:

```ts
interface GraphStore {
  upsertNode(node: GraphNode): GraphNode;
  upsertEdge(edge: GraphEdge): GraphEdge;
  getNode(id: string): GraphNode | undefined;
  neighbors(id: string, opts?: { direction?: 'out' | 'in' | 'both' }): GraphEdge[];
  nodesByType(type: NodeType): GraphNode[];
  allNodes(): GraphNode[];
  allEdges(): GraphEdge[];
}
```

The trust contract is in the upsert semantics:

- **Node upsert:** if a node with the same `id` exists, sources are merged (deduped by
  `provider|externalId`), props are shallow-merged with new non-undefined values winning, and the
  label is updated only if the new label is non-empty. Re-ingesting the same event twice produces
  one node.
- **Edge upsert:** `(type, from, to)` is the identity (via the `id` field). Re-ingest merges
  sources; props shallow-merge.

`InMemoryGraphStore` is the shipped implementation: suitable for tests, development, and
single-process reverberation passes. A Postgres-backed implementation (the user's own store
per ADR-057) is defined as future work behind the same interface — the swap is a drop-in.

`applyFragment(store, { nodes, edges })` is a convenience: upsert nodes first, then edges (nodes
must exist before edges reference them).

### 5.3 Ingest mappers

Each mapper is a **pure function** with the signature `(rawItem, observedAt?) => GraphFragment`.
No I/O, no database access, no side effects. The raw item is the exact JSON an ADR-065 connector
resource returns.

**google-calendar** (`ingest/google-calendar-ingest.ts`):
- Input: one `gcal-list-events` event object.
- Nodes: `Event` (id `event:google-calendar:<id>`); `Person` per organizer and attendee (email-keyed);
  `Place` from `event.location` string.
- Edges: `organized` (organizer Person → Event); `attended` (attendee Person → Event);
  `located-at` (Event → Place).

**gmail** (`ingest/gmail-ingest.ts`):
- Input: one `gmail-get-message` message (format=metadata or full).
- Nodes: `Message` (id `message:gmail:<id>`); `Person` per From address; `Person` per To/Cc.
- Edges: `authored` (From Person → Message); `mentions` (Message → To/Cc Person).
- Header parsing handles `"Display Name <email>"` and bare `"email"`, comma-separated lists.

**github** (`ingest/github-ingest.ts`):
- Input: one repo object from `github-list-repos`.
- Nodes: `Repo` (id `repo:github:<owner>/<name>`); `Person` for the owner (email-keyed if
  `owner.email` is present, otherwise `person:github:<login>`).
- Edges: `owns` and `authored` (owner Person → Repo).
- Note: GitHub's repo payload usually lacks `owner.email`. The reverberation pass handles the
  subsequent merge when another source supplies the email.

**strava** (`ingest/strava-ingest.ts`):
- Input: one activity from `strava-activities`.
- Nodes: `Activity` (id `activity:strava:<id>`); `Place` from `start_latlng` coords or
  `location_city`; `Person` for the athlete.
- Edges: `located-at` (Activity → Place); `participated-in` (athlete Person → Activity).
- The athlete's email is not in the Strava activity payload; callers supply an optional
  `StravaOwner { email, name }` to key the person by email for cross-source merge. Without it,
  the person is keyed `person:strava:<athlete.id>` and merges later via reverberation.

### 5.4 Reverberation pass

`reverberate.ts` implements `reverberate(store)`: a mutating, idempotent pass over the whole store.
Running it twice produces the same graph.

**Pass 1 — people dedup across sources.**

Email-keyed person ids (`person:<email>`) are already unified by the store upsert, since `personId`
produces the same id for the same email regardless of source. The reverberation pass handles the
harder case: a handle-keyed person (`person:github:octocat`) that later learns an email, or an
email-keyed person who carries a provider handle that matches a handle-keyed person.

The algorithm:
1. Walk all `Person` nodes and build a `handleToCanonical: Map<handle, canonicalId>` from nodes
   that carry both a handle and an email.
2. Walk handle-keyed people (those whose `id` does not contain `@`). For each, resolve a
   canonical email-keyed id either from the node's own `props.email`, or via the handle bridge.
3. Ensure the canonical node exists (upsert with merged label/sources/props).
4. Re-point every incident edge from the handle id to the canonical id via `repoint(edge, oldId,
   newId)` — which reconstructs the edge id deterministically.
5. Leave a `related-to` breadcrumb edge (`person:github:octocat ->- person:octocat@example.com`)
   with `{ reason: 'same-person-merge' }` for auditability.

**Pass 2 — Org derivation from email domains.**

For every Person with a non-consumer email domain:
1. The domain becomes an Org id: `org:example.com`.
2. The Org node is created if absent.
3. A `related-to` edge (Person → Org, `{ reason: 'email-domain' }`) is upserted.

Consumer domains (gmail.com, outlook.com, icloud.com, etc.) are skipped via `isConsumerDomain`.
This seeds the org layer of the graph purely from the people already in it.

### 5.5 End-to-end data flow

```
External provider API
        |
        | (ADR-065 connector.yaml resource / bespoke connector route)
        v
  ConnectorClient.request() / paginate()
  [auth injected, retried, rate-limited, structured error on failure]
        |
        | normalized JSON item (e.g. GCalEvent, GmailMessage, GitHubRepo)
        v
  Ingest mapper (pure function, no I/O)
  [item -> { nodes[], edges[] }  (a GraphFragment)]
        |
        v
  applyFragment(store, fragment)
  [upsertNode / upsertEdge — merges by id, never duplicates]
        |
        v
  InMemoryGraphStore (dev/test) | PgGraphStore (future, ADR-057)
  [nodes: Map<id, GraphNode>, edges: Map<id, GraphEdge>]
        |
        | (after ingesting all items from all sources)
        v
  reverberate(store)
  [pass 1: handle-keyed people -> email-keyed canonical + edge re-pointing]
  [pass 2: Person email domains -> Org nodes + related-to edges]
        |
        v
  Unified personal knowledge graph (user-owned)
  [getNode, neighbors, nodesByType — queryable by bots/Jarvis]
```

```
Connect flow  ─────────────────────────────────────────────────────────
User → /api/connect/<provider>/start → OAuth consent → /callback
  → tokens encrypted (AES-256-GCM) → oshal_connections (Postgres)
  → subsequent pulls: getValidAccessToken(pool, sub, provider) → ConnectorClient
─────────────────────────────────────────────────────────────────────────
```

---

## 6. Status and feature flags

### Connector runtime (ADR-065) — live, behind flags

| Component | Flag | Default | State |
| --- | --- | --- | --- |
| `/api/connectors/<provider>` spec routes | `CONNECTOR_SPEC_ROUTES=on` | off | Built; mounts every validated catalog spec at startup |
| `/api/hooks/:provider/:event` webhook ingress | `CONNECTOR_WEBHOOKS=on` | off for a bare process; on in the local compose profile | Built; needs migration 056 (`oshal_webhook_deliveries`) |
| Existing bespoke routes (`/api/spotify`, etc.) | — | always on | Unaffected; parallel to spec routes |

The connector catalog lives in `swarm-apps/connectors/` (307 YAML specs in the 2026-07-23
public-trunk audit). The audit gate, rather than this snapshot count, is authoritative. The specs
span productivity (Gmail, Google Calendar, Google Drive, Notion, Airtable, Asana, Todoist,
ClickUp), communication (Slack, Discord, Outlook, Zoom, Intercom), dev/ops (GitHub, GitLab,
Bitbucket, Vercel, Netlify, Sentry, PagerDuty, WakaTime, OpenAI), finance (Stripe, Coinbase,
Monzo, Shippo, Postmark, SendGrid, Buttondown, Gumroad, Raindrop), media (Spotify, TMDB,
YouTube, Pinterest, Unsplash), and "your world" personal data (Strava, Oura Ring, Fitbit, WHOOP,
Figma).

The TMDB bespoke client (`movies-routes.ts`) was migrated onto the runtime as the canonical proof
that an existing client collapses to a spec without behavioral change. The Spotify spec
(`swarm-apps/connectors/spotify.yaml`) and TMDB spec (`swarm-apps/connectors/tmdb.yaml`) are the
two reference implementations showing different auth types (`oauth2` vs `apiKeyQuery`) and
different pagination strategies (`link` vs `offset`).

**What is proven live.** The runtime's correctness is covered by
`tests/unit/connectors/connector-runtime.spec.ts` with injected `fetchImpl`/`now`/`sleep`: auth
injection for all five types, refresh-on-401 (counted outside the retry budget), retry/backoff
with and without Retry-After, no-retry on 4xx, rate-limit governance (token bucket), and all four
pagination strategies. All four ingest mappers and the reverberation pass are covered by
`tests/unit/personal-graph/*.spec.ts` (16 tests, green). The audit gate test
(`tests/unit/connectors/openapi-and-catalog.spec.ts`) runs `auditConnectorCatalog()` against the
live catalog on every CI run.

**What is not yet proven in production.** The spec routes and webhook ingress are tested and
assembled. `CONNECTOR_SPEC_ROUTES` remains opt-in; the local compose profile enables
`CONNECTOR_WEBHOOKS`, while live GitHub delivery still requires migration 056, a shared secret, and
native webhooks registered in both issue repositories. The remaining ~20 bespoke connectors
(Spotify UI routes, Gmail routes, etc.) are not yet ported onto the runtime — they continue to call
the ADR-056 broker directly.

### Personal knowledge graph (ADR-066) — wired end-to-end, off by default

> **Corrected 2026-08-02.** The two paragraphs this replaces said *"the personal knowledge graph has
> no import in `server.ts` and no ingest scheduler; it is exercised only by unit tests"* and
> *"Nothing in `server.ts` imports this code. The next steps — a persistent `PgGraphStore` (ADR-057),
> an ingest scheduler …, and surfacing the graph to Jarvis — are not yet built."* The first sentence
> of each is **false against the tree** and had been for some time; this is the BUG-1 under-claim
> class (a shipped feature documented as roadmap costs the same credibility as the reverse). The
> corrected state is below, including what genuinely remains.

**Built and wired.** `src/app/server.ts` imports `InMemoryGraphStore`, `createPersonalGraphRoutes`
and `createPersonalGraphIngestRoutes`, and mounts both routers behind `requiresAuth` — the full
Connect → Pull → Ingest → Reverberate → Query loop, not a library sitting unused:

- Schema, the `GraphStore` interface, and `InMemoryGraphStore` — built and tested.
- Four ingest mappers (google-calendar, gmail, github, strava) and the `reverberate()`
  cross-source pass — built and tested (16 specs).
- `POST /api/personal-graph/ingest/:provider` pulls the provider's list through the **ADR-065 spec
  client** with credentials resolved per-caller through the ADR-056 broker, runs the mapper, folds
  fragments into the store, then reverberates. `GET /api/personal-graph/*` serves stats / nodes /
  neighbors.
- A persistent `PgGraphStore` (ADR-057) **is built** — migration `057-personal-graph.sql`, and
  ADR-076 Phase 2 threaded owner scoping through it (constructed for one required `ownerSub`,
  every query carries `user_sub`, composite `(user_sub, id)` PK from migration `094` with matching
  RLS policies).

**Off by default, and the honest remainder.** The routes mount only when `PERSONAL_GRAPH_ROUTES=on`.
Three things are genuinely still open, and none of them is "nothing imports it":

1. **`PgGraphStore` is built but not wired** — `server.ts` still constructs `InMemoryGraphStore`, so
   the graph is process-lifetime and does not survive a restart. Wiring the Postgres store is a
   composition change, not new code.
2. **No ingest scheduler** — ingest is caller-triggered by the route above; nothing pulls on a
   timer.
3. **Not surfaced to Jarvis** — no Jarvis route or orchestrator reads the graph.

---

## 7. How this was built

ADR-065 and ADR-066 were built in a single session on 2026-06-21 using a parallel multi-agent
workflow designed to avoid the git race conditions that occur when sub-agents share a single HEAD.

**Topology.** The work was divided into disjoint code slices: (a) the connector runtime and
catalog expansion (`connector-client.ts`, `types.ts`, `connector-error.ts`, `spec.ts`,
`catalog-audit.ts`, `spec-to-doc.ts`, `openapi-import.ts`, `spec-routes.ts`, the 45 YAML files);
(b) the webhook ingress (`webhook-ingress.ts`, `webhook-handlers.ts`, `connector-webhook-routes.ts`,
`connector-spec-routes.ts`); (c) the personal graph foundation (`graph-types.ts`, `graph-store.ts`,
the four ingest mappers, `reverberate.ts`); (d) doc generation (`gen-connector-docs.ts`,
`docs/connector-spec.md`, `docs/connectors/*.md`, ADR-065, ADR-066). Each sub-agent owned one
slice, wrote to non-overlapping file paths, and self-verified against its own quality gate before
handing off.

**Quality gates as the definition of done.** Each slice defined its own verification:
- Runtime: `connector-runtime.spec.ts` (auth, retry, pagination, errors, no live creds needed).
- Graph: `tests/unit/personal-graph/*.spec.ts` (mappers, store upsert semantics, reverberation).
- Catalog: `openapi-and-catalog.spec.ts` (audit gate on all 45 specs).
- Typechecks (`tsc --noEmit`) clean across all modules.

A sub-agent that could not pass its gate did not report complete.

**Commit discipline.** Sub-agents wrote and verified but did not commit. The orchestrator verified
the combined tree (type-checks, all tests), then committed each logical unit separately. This
avoids the documented failure mode where parallel agents check out different branches and move a
shared HEAD. The incremental structure (runtime first, then spec/audit, then graph, then wiring)
meant each commit was independently revertable.

**Trunk-based with off-by-default flags.** All of this landed on `main` behind
`CONNECTOR_SPEC_ROUTES` and `CONNECTOR_WEBHOOKS` flags, leaving the running stack unaffected.
The personal graph has no mount point at all. This is the standard OSHAL pattern: build and test
in the trunk, expose via a flag when the operator is ready, never maintain a long-lived feature
branch for completed work.
