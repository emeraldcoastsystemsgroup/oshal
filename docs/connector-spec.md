# Connector spec — declaring a connector instead of hand-writing one

> Part of [ADR-065](adr/065-connector-runtime-and-spec.md). Phase 1 (the runtime) is built; the
> declarative `connector.yaml` + generator described here is Phase 2. This doc is the target shape so
> the runtime's API stays aligned with what the spec will generate.

## Why

Today a connector is bespoke code. We want it to be a **document** (`connector.yaml`) plus an optional
small `transform.ts` for weird response shapes. The generator turns the document into route handlers
(calling the shared `ConnectorClient`), bot tool definitions with JSON-Schema'd input/output, the
`PROVIDERS`/broker registry entries, and a doc-stub. That is what makes catalog depth a throughput
problem instead of an architecture problem.

## The runtime (Phase 1, available now)

Build a client and call it; you inherit auth, refresh-on-401, retry/backoff, rate-limiting, structured
errors, and pagination:

```ts
import { ConnectorClient, brokeredBearer } from '@/app/connectors/runtime';
import { getValidAccessToken } from '@/app/routes/connectors-routes';

const client = new ConnectorClient({
  provider: 'spotify',
  baseUrl: 'https://api.spotify.com/v1',
  auth: { type: 'bearer', token: brokeredBearer(getValidAccessToken, pool, userSub, 'spotify') },
  rateLimit: { burst: 10, perSecond: 5 },
  retry: { maxRetries: 3, honorRetryAfter: true },
});

const tracks = (await client.request<any>('/search', { query: { type: 'track', q, limit: 12 } }))
  .tracks.items.map(normTrack);
```

Auth modes: `bearer` (TokenProvider thunk, force-refreshed on 401), `basic`, `apiKeyHeader`,
`apiKeyQuery`, `none`. Errors are always `ConnectorError { provider, status, code, retriable,
bodySnippet, attempts }` with `code ∈ auth | rate_limited | not_found | bad_request | server | network
| unknown`. Pagination: `client.paginate(path, { type: 'cursor' | 'offset' | 'link', … })`.

## The spec (Phase 2 target)

```yaml
provider: spotify
displayName: Spotify
baseUrl: https://api.spotify.com/v1
metadata:
  tags: [music, media, playlists]
  icon: spotify
  iconTitle: Spotify
  iconSource: simple-icons
  iconVerified: true
  website: https://open.spotify.com
auth:
  type: oauth2
  tokenAuth: basic           # how the token endpoint authenticates the client
  scopes: [playlist-modify-private, user-top-read, user-read-currently-playing]
rateLimit: { burst: 10, perSecond: 5 }
retry: { maxRetries: 3, honorRetryAfter: true }
resources:
  - name: search-tracks
    tool: spotify-search       # auto-exposed as a bot tool
    method: GET
    path: /search
    query: { type: track, q: "{query}", limit: "{limit}" }
    output: TrackList          # references a JSON Schema (validated I/O)
  - name: create-playlist
    tool: spotify-create-playlist
    method: POST
    path: /users/{userId}/playlists
    retry: { maxRetries: 0 }   # resource-creating: never auto-retry (duplicate-write safe)
    safety:
      action: write
      requiresConfirmation: true
      supportsDryRun: true
pagination: { strategy: cursor, param: offset, nextField: next }
webhooks:
  - event: playback.changed
    verify: { type: hmac, header: X-Sig, secret: env:SPOTIFY_WEBHOOK_SECRET }
```

For any provider that publishes an **OpenAPI** document, the generator can draft the `resources` list
automatically; you then hand-tune auth, rate-limit, and webhooks. Use
`npm run connectors:import-openapi` for one spec, or `npm run connectors:import-openapi-catalog`
for an APIs.guru/local-manifest bulk pass. Generated tool names are provider-prefixed, generated
resources carry inferred action-safety hints, and the bulk importer writes an imported/skipped/failed
JSON report so partial imports are visible. By default bulk output lands in
`output/connectors/imported-openapi`; the marketplace, tool loader, and spec routes include that
directory when it exists. Set `CONNECTOR_SPEC_DIRS` to add explicit generated/private catalog dirs.
For a real breadth run, use `--target-imports 1000 --limit 2000 --concurrency 12` so skips do not
pretend to be imported connectors.

After a bulk run, enrich the generated catalog icons with:

```bash
npm run connectors:enrich-icons
```

The enrichment pass validates Simple Icons slugs from the live Simple Icons catalog, falls back to
provider favicons when no official slug exists, and writes
`output/connectors/icon-enrichment-report.json`. Icon metadata is still presentation-only; it does not
enable a connector or grant credentials.

## Best practices

Grounded in the runtime and the 2026-06-23 catalog expansion (56 → 306 connectors). The audit gate
(`auditConnectorCatalog`) enforces structure; these are the judgment calls it can't.

**Authoring**
- **Real APIs only.** Never invent an endpoint or auth scheme — a connector pointing at a path that
  doesn't exist is worse than no connector. If a provider is GraphQL- or POST-search-only (Linear,
  monday, Plaid, Pusher, …) it doesn't fit the GET runtime: substitute a real REST sibling or skip it,
  don't force it. Record the substitution in the file's top comment.
- **GET reads first.** Read-only resources are `risk: low/medium`, never destructive, and need no
  confirmation. Add a write only when needed and gate it: `safety: { action: write, requiresConfirmation:
  true }` plus `retry: { maxRetries: 0 }` (duplicate-write safe).
- **Per-tenant hosts use `${env:NAME:-default}`** in `baseUrl` — and in a path when the tenant id lives
  there (e.g. Sentinel's `/subscriptions/${env:AZURE_SUBSCRIPTION_ID}/…`). The loader interpolates at
  load time; the inline default keeps the audit/CI gate green when the env is unset. Document the var in
  `.env.example`. (Distinct token from the single-brace `{placeholder}` runtime binding — `${env:…}` is
  resolved once at load, `{…}` is bound per call.)
- **Tool names are `<provider>-<resource>`**, unique within the file (the audit errors on duplicates).
- **YAML gotcha:** quote any `path`/`query` value containing a `{placeholder}` — an unquoted `{` starts a
  flow mapping and breaks the parse (`path: "/items/{id}"`).
- **Prefer the OpenAPI importer** for any provider that publishes a spec (`connectors:import-openapi`):
  draft, then hand-tune auth/rate-limit/pagination. Don't reach for a third-party OpenAPI→MCP generator —
  it lands the integration as a per-bot MCP subprocess, the footprint ADR-067 deliberately moved off.

**Security**
- **Credentials never live in the spec.** The spec declares the auth *shape*
  (`oauth2`/`apiKeyHeader`/`apiKeyQuery`/`basic`/`none`); the token is supplied per-request by the ADR-056
  broker (per-user), with an operator `CONNECTOR_<PROVIDER>_TOKEN`/`_KEY` env fallback. No keys in git.
- **Header-prefix keys** (Dynatrace `Api-Token`, PagerDuty `Token token=`, Opsgenie `GenieKey`, Elastic
  `ApiKey`, Klaviyo `Klaviyo-API-Key`): the stored credential carries the prefix — say so in the top
  comment so the operator stores it correctly.
- **Keep the rate-limit governor on** (`rateLimit` always declared) so catalog depth can't DoS a provider
  or us.
- **Scope tools to bots by capability** — a bot only sees connectors whose capability group intersects its
  `capabilities[]` (ADR-067). Never expose all 300 connectors to every bot.
- **Lazy enable** — connectors are `available` until explicitly enabled in the marketplace, and only an
  audit-passing spec can be enabled.

**The validation ladder — don't overclaim**
1. `auditConnectorCatalog` 0/0 — structural: valid shape, declared auth, rate limit, unique tools,
   coherent pagination. The CI gate.
2. Mock-fetch wire test — confirms the built client issues the right URL + auth header/query per auth
   type.
3. **Live credentialed read** — the only proof the endpoint + auth are actually correct.

Steps (1) and (2) run with no credentials, so **passing them is "catalog-ready", not "verified".** A
connector authored from docs/knowledge is a high-quality *draft* until a live read confirms it — mark its
status honestly (the 306-connector catalog is at step 2, not step 3).

**Operations**
- The audit gate runs in CI; a non-green connector isn't in the catalog. Keep it green.
- Icon/category metadata is **presentation-only** — it never enables a connector or grants credentials.
  Enrich after a bulk run with `connectors:enrich-icons`.
- Graduate a bulk-authored connector to a per-connector conformance spec (recorded/mocked provider)
  before calling it "hardened".

## Conformance gate

A connector counts as "hardened" only when it passes the conformance suite
(`tests/unit/connectors/connector-runtime.spec.ts` is the runtime-level contract; per-connector specs
extend it against recorded/mocked providers). The suite asserts: auth injection, refresh-on-401,
retry/backoff honoring Retry-After, no-retry on 4xx, rate-limit governance, error classification, and
pagination — all without live credentials, so it runs in CI.

## New-connector checklist

1. Add/confirm the `PROVIDERS` registry entry + broker `CRED_ENV_KEYS` mapping (auth + token storage).
2. Build the client on `ConnectorClient` (or, Phase 2, write `connector.yaml` and generate it).
3. Map responses to small shapes (reuse normalizers; keep transport out of the mapping).
4. Add the per-connector conformance spec; it must be green.
5. Surface per the app-surfacing checklist (ribbon, `/applications`, utilities, identity, route mount).
6. Generated/authored doc page (auth steps, scopes, resources, rate limits, webhook events).
