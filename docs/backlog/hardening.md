# Hardening Backlog

A prioritized, tracked list from the 2026-06-13 hardening audit (security, reliability/defaults,
code-health). Goal: production-readiness for the seed→platform vision ([ADR 035](../adr/035-multi-tenant-saas-foundation.md)).

## Still open — re-baseline 2026-07-19

The numbered list below is kept as the audit record; items marked ✅/[DONE]/[COVERED] inline are
closed. What is **genuinely still open** as security-net work:

- **#4 Migration transactionality** — migrations still apply without BEGIN/COMMIT/ROLLBACK.
- **#7 Remote-client auth** — still a shared-secret header compare; HMAC/JWT/mTLS before the A2A
  surface goes public.
- **#15 Headscale hardened ACL** — authored, still not applied (live overlay ACL remains allow-all).
- **#16 Headscale pre-auth key rotation** — plaintext key still in `scripts/start-local-agent.bat`.
- **#17 Legacy credential rotation** — provider-side hygiene, NOT a repo exposure. ⚠ Re-verified
  2026-07-24: this public repo is scan-clean (the credential patterns match zero actual secret
  values across the tree + all 81 commits/refs). The only open question is whether the 6 old creds'
  VALUES were ever rotated at their providers; operator-only.

Open but code-health rather than security-net: #1's remaining no-owner-column tables, #2's
warning-count burn-down + making CI lint blocking (config + rule now exist — see the item), #6
deep-import cleanup (now surfaced by the #2 lint rule), #8 graceful-degradation sweep, #10 unit
tests for critical paths, #14 JSDoc coverage.

## Fixed in this pass

- **Control-plane crash on aborted static request (2026-06-22).** A client aborting a static
  education file fetch (e.g. `little-monsters-logo.png`) fired `res.sendFile`'s error callback
  AFTER the response was finished; the handler then called `res.status(404).send()`, throwing an
  uncaught `ERR_HTTP_HEADERS_SENT` that exited the entire `oshal-api` process (observed live as a
  Cloudflare 502 at the tunnel). `education-routes.ts serveFile` now guards on
  `res.headersSent`/`res.writableEnded` before responding. Regression test:
  `tests/unit/education-serve-file.spec.ts`. Found by the live headed-E2E sweep.
- **Broken default provider/model** — a fresh install no longer defaults to the unauthenticated
  Codex path. `docker-compose.oshal-local.yml` now defaults `FORCE_LLM_PROVIDER`/`LLM_PROVIDER`
  to `claude-code` (works out of the box via mounted `~/.claude`); `provider-runtime.ts`
  `DEFAULT_MODEL` fallback → `claude-sonnet-4-6`; Haven's direct-OpenAI fallback → `gpt-4o`
  (was the invalid-for-chat-API `gpt-5.3-codex`). Codex-specific adapters keep their own gpt default.
- **Secret-leaking logs** — routes that logged raw `req.body` (task, the legacy graph view, presentation,
  legacy-engineering) now log `bodyKeys` only, so credentials in request bodies never hit the logs.
- **Manifest-loader path traversal** — `POST /api/swarm/apps/load` now confines the operator-supplied
  path to `swarm-apps/` (rejects absolute paths, `..`, non-YAML).
- **Health probes** (earlier) — Presentron + Google Search MCP report `unreachable` instead of 500.
- **Boot-storm resilience** (earlier) — `autoLoadAllWithRetry`; pg connect timeout 2s→10s.

Verified safe by js-yaml version check: `yaml.load` is safe in js-yaml 4.x (no PyYAML-style RCE),
so no schema change needed there.

## Backlog — HIGH (gate the platform vision)

1. **Tenant scoping (ADR-035 Phase 1) — PARTIALLY DONE (ADR-076, 2026-06-27).** Postgres RLS is
   now enforced platform-wide on 84 tables (user-private + tenant-shared tiers) via migration
   `060-platform-rls-tenancy.sql`, with the runtime on the non-superuser `oshal_app` role — so
   the platform is multi-user-isolated at the database layer. **Remaining:** tables with no owner
   column still rely on app-layer scoping and need owner columns / join-based policies
   (`personal_graph_*`, `chat_messages`, `agent_memories`, `knowledge_memory_documents`, the
   `lm_*` student tables); plus per-request tenant context in client APIs and tenant-aware UI flows.
2. **ESLint with FSD rules + make CI lint blocking — PARTIALLY DONE (re-baselined 2026-07-19).**
   `eslint.config.mjs` (flat config) + the `lint` npm script now exist, including the FSD
   barrel-boundary rule rejecting `@/features/*/services/*` deep imports (warnings-first, plus
   no-console / no-empty-catch / the 1000-code-line cap). **Remaining:** drive the warning counts
   to zero and remove CI's advisory `|| echo` (`ci.yml` still runs
   `npx eslint src --max-warnings 0 || echo …`) so lint actually gates merges.
3. ✅ **[DONE 2026-06-22]** **Bot-node DB connect retry.** `bot-node-server.ts` did a single `SELECT 1`;
   a transient timeout during a 20-container cold start left the bot DB-less (no profile seeding, no
   cost tracking) with no retry. Now retries the probe (`BOT_DB_CONNECT_ATTEMPTS`, default 10×2s) and
   degrades to no-DB only after retries are exhausted.
4. **Migration transactionality.** `database-bootstrap-service.ts` applies each migration without a
   `BEGIN/COMMIT/ROLLBACK`; a mid-migration failure can leave partial state that re-runs differently.

## Backlog — MEDIUM

5. **Oversized files (1000-line hard cap violations).** ✅ Resolved 2026-07-11: `app.js`,
   `QueueManagerService.js`, and `queue-manager-service.ts` were decomposed behind their existing
   interfaces (see BACKLOG.md → Code governance for the full 11-file burn-through);
   the retired platform's graph view no longer exists (removed in that carve-out). Residual: `jarvis-routes.ts`
   (blocked on in-flight work) + 16 files in the 800–1000 code-line warning band.
6. **Deep-import FSD violations** (~40 files) — e.g. `@/features/llm-provider/services/codex-cli-provider`
   instead of the barrel. Enforce via the eslint rule in #2.
7. **Remote-client auth** (`remote-client-routes.ts`) uses a shared-secret header compare; move to
   HMAC/JWT (or mTLS) before exposing the A2A surface publicly.
8. **Graceful degradation sweep** — finish the pattern from the health-probe fix: any external call
   (ChromaDB, Memgraph/legacy graph routes) should degrade, not 500/crash, when the service is down.
9. ✅ **[DONE 2026-06-22]** **RedisMeshTransport** poll loop had no max-failure backoff/give-up. Now
   counts consecutive failures, backs off exponentially to a 30s cap, and emits one distinct
   `unhealthy:true` line past `MESH_SUBSCRIBE_UNHEALTHY_AFTER` (default 10) instead of spinning forever.
10. **Unit tests for critical paths** — harness selection (`resolveHarnessForAgent`), the swarm-app
    loader, and dispatcher routing (`chooseDispatchPath`) are only covered via noop-mode e2e. Add
    isolated unit tests (these are exactly the bits that broke this month — the codex-default bug).

## Backlog — LOW

11. ✅ **[COVERED 2026-06-22]** Rate-limiting on public endpoints (`/health`, `/api/branding`). The
    global limiter (1000/min/IP, `server.ts`) already bounds external XFF-bearing traffic to these;
    `/health` is the internal Docker healthcheck (no XFF, intentionally skipped). A dedicated tighter
    per-route limit is marginal — left as optional polish, not a gap.
12. ✅ **[DONE 2026-06-22]** `CODEX_SANDBOX_MODE` code default `danger-full-access` → `read-only`
    (`codex-cli-harness-adapter.ts` `DEFAULT_SANDBOX_MODE`, `bot-node-server.ts` fallback). Full
    access is now opt-in. (Corrected from an earlier over-cautious "deferred": the swarm's explicit
    opt-in already exists — `docker-compose.oshal-local.yml:135` sets `CODEX_SANDBOX_MODE` for every
    container — so the live deployment is unchanged; only an unconfigured/fresh run loses silent
    host-write access, which is the intended least-privilege default.)
13. ✅ **[DONE 2026-06-22]** Remove `gpt-5.3-codex` where it's offered without working codex auth. The
    per-provider catalogs already scope codex models correctly under `openai-codex`; the residual was
    `SettingsView.js` hardcoding it as the no-metadata last-resort fallback (would fail under a
    non-codex provider). Fallback now `''` → backend uses the provider's own default.
14. JSDoc coverage on the large orchestration files (`queue-manager-service.ts`, `llm-execution-handler.ts`).

## Backlog — Network overlay (added 2026-06-22)

These came out of the 2026-06-21/22 internet-facing hardening + deploy pass. The app-layer
items from that pass (IDOR/object-level authz, vault at-rest encryption, SSRF guard,
schema-race advisory lock, fail-closed webhooks, helmet + rate-limit, 127.0.0.1 binding,
TLS verification) are **deployed live** (see [SECURITY-HARDENING.md](../security/SECURITY-HARDENING.md));
what remains is the Headscale/WireGuard overlay and operator credential rotation.

15. **Apply the staged Headscale hardened ACL.** A deny-by-default tag policy is authored at
    `infra/headscale/config/policy.hardened.hujson` (tag:admin full; tag:worker → tag:controller:5000
    only) but **not yet applied** — it needs: (a) nodes tagged (`tag:admin`/`tag:worker`/`tag:controller`),
    (b) the real controller port substituted for the `5000` placeholder, then (c) `headscale policy set`.
    Until applied, the live ACL is still allow-all between nodes. Lower urgency because the swarm's
    own ports are already bound to `127.0.0.1` (the overlay is the optional VPN/A2A surface, ADRs
    [013](../adr/013-headscale-self-hosted-overlay-network.md)/[014](../adr/014-any-bot-k8s-headscale-gateway.md)
    still *Proposed*). The metrics listener was already moved off the wire (`0.0.0.0:9090` → `127.0.0.1:9090`).
16. **Rotate the plaintext Headscale pre-auth key** in `scripts/start-local-agent.bat`, and add a
    frictionless enrollment path (web-login → ephemeral pre-auth key) so keys are short-lived, not
    baked into a checked-in script. (Cross-refs the existing note in [BACKLOG.md](../BACKLOG.md).)
17. **Legacy credential rotation — provider-side hygiene, NOT a repo exposure.** ⚠ Re-verified
    2026-07-24: **this public repo is scan-clean.** A full scan of the tree AND all 81 commits/refs
    with the publish-gate credential patterns (`AKIA`/`ghp_`/`glpat-`/private-key/GCP-SA/secret-shaped)
    matched ZERO actual secret values — the only hits are a Python env-var *reference* (a JSON key
    populated from an env variable, no value) and a test string assertion. The "REQUIRED before
    public push" framing is stale: the public repo shipped from a clean root (first commit
    `be2c250 "Initial public release"`), so no dirty history was ever published here. The 6 creds
    (GitHub PAT, two GitLab PATs, AWS key, a vendor API secret, GCP SA key, Plane token) were once in the
    OLD **private** repos' history — a different repo, not this one. The only genuinely-open,
    repo-independent question is whether their VALUES were ever rotated at their providers (a
    pushed-anywhere secret must be assumed compromised until revoked at the source). Operator-only;
    if they're already rotated/dead this closes. Root `HUMANTODO.md` §1 (internal-only, not in this repo).

## Notable: already solid

- **Route auth gating** — the audit found sensitive routes (`/api/config`, `/api/agents`, `/api/tasks`,
  `/api/rag`, `/api/swarm/*`) correctly behind `requiresAuth`. No unguarded sensitive surfaces found.
- **Process-level crash safety** — `server.ts` handles `uncaughtException`/`unhandledRejection`.
- **Change-log + file-header discipline** — strong and consistent.
