# ADR-067 — Connector marketplace + dynamic tool loading: from a fixed catalog to a lazy, scoped, mass-importable one

- **Status:** Accepted - Phase 1/2 and phase 3 marketplace core built 2026-06-22. Direction agreed after an architecture review of the existing
  connector runtime (ADR-065), the tool-execution paths, and the per-bot footprint. Phase 1/2 is now
  built: capability-scoped prompt/MCP exposure and connector-spec runtime tool registration are wired.
  This ADR records the corrected mental model (it is **not** an MCP-only framework) and the plan to
  reach "hundreds of connectors" without bloating bots off a laptop.
- **Date:** 2026-06-22
- **Implementation update:** 2026-06-22 Phase 1/2 built. Per-bot capability scoping now filters
  executable prompt tools and Cline MCP sessions; ADR-065 connector `tool:` resources are registered
  as framework tools with an in-process `connector` executor that resolves per-user broker tokens.
  Phase 3 is now built past the first slice: audited marketplace catalog, browse/enable/disable/remove
  API, audit-refresh quarantine, stable lazy connector route delegation, marketplace-gated tool
  loading, and a cockpit Connectors Discover surface. The read and declared-action HTTP routes now
  consult current deployment and per-user enablement on every request before loading a spec;
  disabled and unknown providers both return the same 404, and enablement changes need no restart.
  Authenticated Cockpit proof now renders the Discover surface and reaches `/api/connectors/marketplace`
  with 46 entries. OpenAPI draft import is available through `npm run connectors:import-openapi`;
  bulk OpenAPI catalog import is available through `npm run connectors:import-openapi-catalog`
  (APIs.guru default index, 1K candidate limit, skip/report logging, generated specs only - no auto-enable).
  Generated catalog icon enrichment is available through `npm run connectors:enrich-icons`; the latest
  1K run produced 614 verified Simple Icons, 377 reviewed favicon fallbacks, and 9 reviewed initials
  fallbacks for generated specs. The effective local target is 1,308/1,308 for reviewed icons,
  categories, and descriptions; this is local catalog evidence, not a deployment claim.
  Connector resources now carry action-safety metadata; mutating connector tools support dry-run previews
  and require explicit `confirm: true` before a provider write is attempted.
  Still pending: 5+ live credentialed connector reads preferably through brokered per-user credentials,
  Activepieces/Nango-reference import breadth, and operator audit export.
- **Related:** [ADR-065 (connector runtime + spec)](065-connector-runtime-and-spec.md),
  [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-042 (IoT connector tenancy / multi-account)](042-iot-connector-tenancy.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-049 (aggregation-platform thesis)](049-oshal-as-aggregation-platform.md),
  [docs/partner-app-registration.md](../partner-app-registration.md)

## Context

The comparison that started this: cloud dev platforms (Codex/OpenAI plugins, Claude Code plugins)
ship a large connector/plugin catalog with a *marketplace* — point a client at a manifest, browse,
install. OSHAL has ~46 hand-curated connectors and the production runtime to back them (ADR-065), but
no distribution/discovery layer: connectors are either hardcoded in the `PROVIDERS` registry
([connectors-routes.ts](../../src/app/routes/connectors-routes.ts)) or auto-discovered from local
`swarm-apps/connectors/*.yaml`. There is no catalog, no install/enable, no mass-import.

Two things were clarified during review and must be recorded, because earlier framing got them wrong:

**1. The framework is NOT MCP-only.** Three of five tool types execute **server-side today**:
- **CLI** — fully wired (`handleDynamicCliExecutor`, per-user `OSHAL_USER_SUB` + `.oshal-cred-<provider>`
  files) — [tool-executor-service.ts:220](../../src/features/chat-orchestration/services/tool-executor-service.ts).
  This is how the codex/Gmail bots shell out to `scripts/oshal-*.js`.
- **API / OpenAPI** — wired but default-off: `handleDynamicApiExecutor`
  ([tool-executor-service.ts:273](../../src/features/chat-orchestration/services/tool-executor-service.ts))
  + connector-spec HTTP routes mounted only when `CONNECTOR_SPEC_ROUTES=on`
  ([server.ts:1126](../../src/app/server.ts)).
- **RAG, Presentron** — fully wired server-side.
- **MCP** — the *most constrained* path, not the foundation. The server-side loop explicitly **rejects**
  `use_mcp_tool` ([tool-executor-service.ts:187](../../src/features/chat-orchestration/services/tool-executor-service.ts));
  MCP servers run **only inside the Cline/Claude CLI harness's own MCP client**. "We had MCPs running
  before" is true — they ran inside the harness subprocess.

**2. What made bots "the size of the api server" was MCP-per-bot, not connector count.** Every bot
writes the same `mcp_settings.json` and the harness spawns a **separate subprocess per configured MCP
server** at startup ([cline-runtime-config-sync-service.ts:598](../../src/features/llm-provider/services/cline-runtime-config-sync-service.ts)).
`@playwright/mcp` alone is ~80–100 MB (it ships a browser); 5 bots × ~6 servers ≈ 30 subprocesses ≈
~750 MB of pure MCP overhead. By contrast a connector spec is one in-memory `SpecClient` (~2–5 KB, no
subprocess) loaded into the **controller** process, not per-bot ([spec.ts:181](../../src/app/connectors/runtime/spec.ts)).
Bots call connectors over shared HTTP; they do not embed the runtime.

**3. Tool scoping is only partially real.** Framework tools are scoped per-agent (disabled via
`authMode='off'`), but the hardcoded `EXECUTABLE_REGISTRY_TOOL_NAMES` (9 tools) and the MCP server list
are **not** capability-filtered — every bot gets them in its prompt regardless of `capabilities[]`
([tool-runtime-context.ts:428](../../src/app/composition/tool-runtime-context.ts)). Declaring fewer
capabilities does not narrow them today.

The hard requirement: **the stack must stay laptop-runnable.** A naïve "auto-discover everything,
load every tool on every bot" approach is what previously capped us at a few bots.

## Decision

Build a connector **marketplace** as a lazy catalog + enable-on-demand layer on top of the ADR-065
runtime, ride the already-wired **API/CLI** execution paths for mass-imported connectors (not
per-bot MCP), and make per-bot tool scoping real so each bot sees only its handful.

### The reference pattern (validated against two real marketplaces)

Both [Anthropic's claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
(`.claude-plugin/plugin.json`, `source: git-subdir {url, path, ref, sha}`, `/plugin install x@marketplace`,
Discover UI) and [awesome-codex-plugins](https://github.com/hashgraph-online/awesome-codex-plugins)
(`.agents/plugins/marketplace.json`, ~200+ entries, a security-scanner gate) are the **same shape**: a
manifest-of-git-subdirs + install/discover + a quality gate. OSHAL already has the manifest loader
(`swarm-apps` + `POST /api/swarm/apps/load`) and the gate (`auditConnectorCatalog`). What's missing is
the **catalog index**, the **installer**, and a **Discover surface**.

### Principle 1 — Lazy catalog, never eager mount-everything

- A **catalog** = cheap metadata index of *available* connectors (id, label, category, auth type,
  icon, source) — JSON, nothing mounted, nothing spawned.
- `mountConnectorSpecRoutes()` registers two stable parameterized Express routes, independent of
  catalog size. It does not enumerate or parse connector specs while mounting.
- Every request first checks the marketplace's lightweight deployment-enabled set, then its audited
  provider gate and, when available, the authenticated caller's per-user gate before an exact
  `<provider>.yaml` / `<provider>.yml` lookup. A disabled request does not enumerate catalog metadata
  or parse a route spec. Disabled, user-disabled, malformed, and unknown provider routes use the same
  non-enumerating 404 response.
- The first allowed request parses and caches only that provider. A later disabled request evicts
  its cached spec; re-enabling works on the same Express process and reloads on the next request.
- The declared-action route applies the same ordering before spec, credential, audit, or provider
  work. A regression guard exercises the real Express/filesystem/marketplace-state boundary with a
  catalog larger than 200 and verifies zero route-spec parses or cached providers at mount.

### Principle 2 — Mass-import rides the API/CLI path, never per-bot MCP

Imported connectors execute over the shared connector runtime (HTTP) or as CLI tools — both of which
add **zero per-bot weight**. MCP stays available but is **opt-in per bot**, never the
default-everywhere model that caused the bloat. A marketplace entry may ship *either* a
`connector.yaml` (API/CLI) *or* an MCP descriptor; the API/CLI form is the default and the only one we
mass-import.

### Principle 3 — Per-bot capability scoping is the safety prerequisite

Make the executable-tool and MCP-server lists resolve against the bot's `capabilities[]` so each bot's
prompt (and any MCP subprocess set) is its declared subset, not the catalog. This is the first code
task — nothing else is safe at scale until it lands.

### Principle 4 — Auth tier decides what is cheap to mass-import

| Auth type | Operator action | Cost to add | Examples |
|---|---|---|---|
| **API key / PAT** | none — user pastes their own key into the per-user encrypted store | **free, mass-importable** | Stripe, SendGrid, OpenAI, Airtable, most long-tail SaaS/dev APIs |
| **Shared operator key** | paste one key once | one-time | TMDB, Duffel |
| **OAuth2** | **register a partner app per provider** (client_id/secret + redirect) under the business email per [partner-app-registration.md](../partner-app-registration.md); some need app review/verification | one registration project **each**, human-only, sometimes gated | Google, Slack, Microsoft, Meta |

Strategy: **mass-import the API-key/PAT bucket first** (zero operator infrastructure — the user brings
the credential), add OAuth providers one app-registration at a time. This matches the
"token or api based" instinct and the ADR-049 moat — we import *definitions*, never hand credentials
to a third-party runtime.

### Import accelerators (definitions only; never a third-party credential runtime)

- **OpenAPI** — `specFromOpenApi` exists ([openapi-import.ts](../../src/app/connectors/runtime/openapi-import.ts))
  and is exposed through `npm run connectors:import-openapi` for one spec and
  `npm run connectors:import-openapi-catalog` for APIs.guru/local-manifest bulk import. apis.guru
  lists thousands of specs; generated tool names are provider-prefixed, every imported resource gets
  action-safety hints, and every run writes a skip/failure report so partial imports are visible.
- **Nango `providers.yaml`** — config for 800+ APIs (auth URLs, token URLs, scopes) ≈ our `ConnectorSpec`
  shape. **License caveat: Elastic License 2.0** — use as a *reference data source* to generate our own
  specs; do not vendor their runtime (matters for OSS release).
- **Activepieces pieces** — MIT core, ~280 integrations; cleanest license to actually import.
- **Avoid Composio as a runtime dependency** — MIT SDK but closed credential runtime that suffered a
  May 2026 credential-exposure incident; wrong fit for a keys-and-data-ownership platform.

### Phasing

1. **Per-bot capability scoping** (BUILT 2026-06-22). Filter `EXECUTABLE_REGISTRY_TOOL_NAMES` + the
   MCP server list by `capabilities[]`. Proved with unit coverage and the live startup manifest check.
2. **Turn the API path on + wire spec tools** (BUILT 2026-06-22). ADR-065 connector `tool:` resources
   register into the tool framework and execute via the shared connector runtime with broker-resolved
   caller credentials.
3. **Marketplace index + installer + Discover surface** (BUILT 2026-06-22).
   The local spec catalog is exposed through `/api/connectors/marketplace`; enable/disable/remove
   persists deployment state, audit-refresh re-reads the spec and de-enables anything that fails the
   gate, connector routes consult stable lazy deployment-and-user gates, tools honor the enabled
   provider set, and cockpit has a native Connectors surface. Authenticated live evidence is captured by
   `tests/live/connector-marketplace.live.spec.ts`. Still pending: 5+ credentialed connector reads
   and operator audit export. Reuse `auditConnectorCatalog` as the install gate.
4. **Mass-import pipeline.** OpenAPI draft import is built via `npm run connectors:import-openapi`.
   Bulk OpenAPI catalog import is built via `npm run connectors:import-openapi-catalog`; it can target
   APIs.guru or a local manifest, writes generated specs under `output/connectors/imported-openapi`
   by default, supports `--limit 1000`, `--target-imports 1000`, `--concurrency`, `--auth-types`,
   `--provider-filter`, `--max-operations`, and
   writes a JSON report of imported/skipped/failed providers. The normal marketplace/tool scans
   include that generated import directory when it exists; the stable route delegate resolves only
   the exact allowed provider requested. `CONNECTOR_SPEC_DIRS` can add explicit generated or private
   catalog directories. `npm run connectors:enrich-icons` is the post-import polish
   step: it validates Simple Icons slugs, applies favicon fallbacks, and writes
   `output/connectors/icon-enrichment-report.json`. Next import lanes are Nango-reference
   and Activepieces-MIT into `connector.yaml`, prioritizing the API-key/PAT bucket. Each output passes
   the audit gate before catalog entry.

### Catalog curation invariants

`npm run connectors:curation-audit` audits the same default target shape as the marketplace: the
tracked `swarm-apps/connectors` directory, any `CONNECTOR_SPEC_DIRS`, and
`output/connectors/imported-openapi` when it exists. Repeated `--spec-dir` flags define an explicit
target set, and `--report <file>` preserves the complete JSON evidence. Shadowed duplicate providers
are reported; deterministic source-path ordering selects the same effective first entry as the
marketplace.

Icon review is deterministic:

- A Simple Icons asset is accepted only with a non-empty slug, `iconSource: simple-icons`,
  `iconVerified: true`, and no competing `iconUrl`. `npm run connectors:enrich-icons -- --dry-run`
  revalidates those slugs against the configured Simple Icons catalog without rewriting the specs.
  Imported specs match publisher identity only; generic API titles, documentation/repository sites,
  and third-party execution hosts cannot certify a brand icon, and an existing slug cannot validate
  itself.
- A favicon is never called "verified." It must use `iconSource: favicon-fallback`, explicitly set
  `iconVerified: false`, omit Simple Icons fields, and use the exact HTTPS DuckDuckGo favicon URL for
  either a normalized host declared by the spec or a provider/domain pair in
  [reviewed-favicon-fallbacks.json](../../scripts/connectors/reviewed-favicon-fallbacks.json). The
  enrichment CLI and curation gate consume the same reviewed exception registry.
- Placeholder, internal (`*.local`), reserved, malformed, and non-DNS hosts are not favicon domains.
  When no public declared or reviewed domain exists, the only accepted fallback is
  `iconSource: initials-fallback` with `iconVerified: false` and no icon slug/title/URL.
- Missing, contradictory, malformed, or untraceable icon metadata fails the icon/risk curation gate.

Connector-wide marketplace risk is **derived, never declared in connector YAML**. The single rule in
`deriveConnectorRiskLevel()` is: `high` when any resource is non-GET or explicitly write/destructive,
or when any declared `actions:` entry exists; otherwise `medium` for read-only OAuth2/basic
connectors; otherwise `low`. `auditSpec()` exposes the derived result and rejects top-level
`riskLevel` or `metadata.riskLevel`; the marketplace consumes that same result and bumps its disk
cache schema when the rule changes. `actions[].riskLevel` remains declared and validated because it
controls the confirmation requirement for that specific action, not the connector-wide shelf label.

The curation report also shows effective and declared category/description coverage separately. Those
figures do not weaken the icon/risk gate and do not get a plausible catch-all: an unresolved category
remains visibly `Uncategorized` and belongs in its own curation queue.

Generated OpenAPI categorization retains provenance instead of guessing from whichever common word
matches first. `specFromOpenApi()` preserves `info.x-apisguru-categories` as
`metadata.sourceCategories`, separate from operation `metadata.tags`. Effective category precedence is:
human `metadata.category`, exact provider identity, the reviewed APIs.guru vocabulary mapping, then
lower-confidence title/description/tag/host/operation signals. A multi-category source value is used
only when all tokens map to the same OSHAL shelf or the exact cross-shelf combination is reviewed;
unknown tokens and novel cross-shelf combinations remain unresolved. APIs.guru specs that declare no
source category use a small exact-provider review table grounded in their title, description, tags,
host, and operations. The local 1,000-spec generated target currently resolves 1,000/1,000 categories;
the audit records each effective category, its evidence lane, and its evidence value.

## Consequences

- **Positive:** connector count scales toward the incumbents without per-bot bloat; the laptop
  constraint is honored (lazy catalog + shared-path execution + scoped prompts); the keys-and-data moat
  is kept (definitions imported, credentials never leave the per-user store); MCP remains available but
  stops being the default footprint tax.
- **Cost / risk:** Phase 1 touches the prompt-assembly hot path — must be covered by tests before the
  catalog grows. Nango's Elastic License 2.0 constrains us to reference-only use. OAuth providers remain
  human-gated (registration + review), so the headline count grows fastest in the API-key bucket — set
  expectations accordingly.
- **No silent caps:** the mass-import CLI must `log()` what it skips (opaque OpenAPI bodies, multi-scheme
  auth, providers that fail the audit) — a partial import must not read as "imported everything."
- **Hot-swap note:** the runtime is compiled TS (served from `dist/`), so marketplace runtime changes
  reach deployment via merge-to-`main` + build + restart, not refresh-hot-swap; the cockpit Discover
  surface (`ui.static`) does hot-swap.
