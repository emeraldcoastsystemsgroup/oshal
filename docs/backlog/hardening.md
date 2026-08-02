# Hardening Backlog

A prioritized, tracked list from the 2026-06-13 hardening audit (security, reliability/defaults,
code-health). Goal: production-readiness for the seed→platform vision ([ADR 035](../adr/035-multi-tenant-saas-foundation.md)).

## Still open — re-baseline 2026-07-19

The numbered list below is kept as the audit record; items marked ✅/[DONE]/[COVERED] inline are
closed. What is **genuinely still open** as security-net work:

- ~~**#4 Migration transactionality**~~ — **CLOSED, and this line was STALE.** Each migration and
  its `app_migrations` history INSERT already run `BEGIN` / sql / INSERT / `COMMIT` on ONE pooled
  client, with `ROLLBACK` + a loud filename error on failure and the run stopped before later files
  (`database-bootstrap-service.ts`). A `-- oshal:no-transaction` pragma is the escape hatch for
  CONCURRENTLY/VACUUM-class files, and the four legacy self-wrapping migrations are auto-detected so
  the runner never double-wraps them. Guard: `tests/unit/migration-transactionality.spec.ts` — nine
  behavioural cases plus a STATIC gate over the real `scripts/migrations` tree (a new file with a
  non-transaction-safe statement and no pragma fails the build). Mutation-checked 2026-08-01:
  turning the `ROLLBACK` into a `COMMIT` goes red.
- **#7 Remote-client auth** — **CLOSED 2026-08-01 (per-node tokens), with the swarm-wide secret kept
  as a loudly-deprecated compatibility path until every field node is re-enrolled.** What shipped:
  - **Issuance.** `POST /api/join/enroll` with a `clientId` mints an `oshal_pat_` token BOUND to that
    device (`oshal_cli_tokens.node_client_id`, migration `102`). Non-expiring by default, because it
    is the node's steady-state credential — its bounds are scope, rotation and revocation.
  - **Verification.** The global CLI-token middleware admits a bound token ONLY on paths
    `decideNodeTokenScope` allows: its own `/api/remote-clients/<clientId>/**` plus the two
    enrollment-handshake paths. Everywhere else the request stays unauthenticated and hits the
    normal 401 — so a credential lifted off an edge machine is NOT the account credential an
    unbound PAT is (no `/api/content`, no token minting, no sibling device). `POST /register`
    carries the device in the body, so the router checks it against the binding separately.
  - **Rotation.** `POST /api/remote-clients/:clientId/token/rotate` revokes EVERY live generation
    for the device and mints its successor in one call. The deprecated shared secret may not rotate
    (`shared_secret_cannot_rotate`) — the credential being retired cannot mint its replacement.
  - **Retirement.** `REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true` makes the shared-secret branch answer
    401 `shared_secret_retired`. Default `false` so field nodes keep working; while accepted the
    branch warns once per boot and stamps `x-oshal-shared-secret-deprecated`, which is the
    observable that tells an operator when the flip is safe.
  - Constant-time compare + the per-caller rate limiter (2026-07-24) are unchanged.
  Guard: `tests/unit/remote-client-node-token.spec.ts`. **Honest scope:** this is a per-node hashed
  bearer credential with binding + rotation + revocation, not mTLS; the audit line asked for
  "HMAC/JWT/mTLS", and the security property delivered — one credential per device, revocable
  independently — is the one that mattered. mTLS remains a separate deployment decision.
  **Still open:** re-enrolling the nodes in the field and then flipping the switch (a live-stack act,
  see the deploy-time verification in the PR body).
- **#15 Headscale hardened ACL** — authored, still not applied (live overlay ACL remains allow-all).
- **#16 Headscale pre-auth key rotation** — plaintext key still in `scripts/start-local-agent.bat`.
- **#17 Legacy credential rotation** — provider-side hygiene, NOT a repo exposure. ⚠ Re-verified
  2026-07-24: this public repo is scan-clean (the credential patterns match zero actual secret
  values across the tree + all 81 commits/refs). The only open question is whether the 6 old creds'
  VALUES were ever rotated at their providers; operator-only.

### Code-health list — re-baselined 2026-08-02 (four of six were already closed)

The previous version of this paragraph listed **#2, #6, #8, #10 and #14 as open**. All five had in
fact been closed by the 2026-07-24 non-human burn-down (PRs #20/#21/#22, see
[non-human-checklist.md](./non-human-checklist.md) Waves 1–2) and the follow-on lint burn-down. A
stale open-list is not harmless here: it is an instruction to a bot to re-do finished work, which is
exactly what this file exists to prevent. Re-verified against the tree, not against the PR titles:

- ~~**#2 ESLint + blocking CI lint**~~ — **CLOSED.** `gate_lint` in
  [ci-local.sh](../../scripts/ci-local.sh) is **blocking** (change-log entry 3 records the flip and
  the 324-warning burn-down: 272 deep imports rewritten onto slice barrels via 141 new barrel
  re-exports, 51 console calls converted or justified-disabled) and entry 15 widened its scope from
  `src` alone to `src tests scripts`. Verified 2026-08-02: `npx eslint src tests scripts
  --max-warnings 0` exits **0** with no output. Residual, deliberate: `.github/workflows/ci.yml`
  still carries the advisory `|| echo` on its lint step — that workflow is manual-dispatch-only
  (Actions is retired for this repo, ci-local.sh entry 9), so it is not the gate that governs merges.
- ~~**#6 Deep-import FSD violations**~~ — **CLOSED as a NO-OP; the premise was stale.** The
  barrel-boundary rule reports **0** active violations. The deep imports that remain are the
  documented controller→LLM-runtime boundary exceptions that keep the harness runtime off the
  controller graph; routing them through the barrel would go red in
  `tests/unit/controller-runtime-boundary.spec.ts`. There is nothing to clean up.
- ~~**#8 Graceful-degradation sweep**~~ — **CLOSED (PR #20), and it found a real bug.** With
  `ARANGO_URL` set but the engine unreachable, the rejection inside the async graph route was
  unhandled → 500 / hung request; it now logs at ERROR and returns `503 graph_engine_unreachable`,
  matching the unset-URL shape (`graph-routes.ts` change-log entry 3). Harness error-logging and the
  RAG BM25 fallback were swept in the same pass. Guards: `tests/unit/graph-route-degradation.spec.ts`
  and `tests/unit/rag-chroma-degradation.spec.ts`.
- ~~**#10 Unit tests for critical paths**~~ — **CLOSED (PR #21).** All three named seams have direct
  specs, 26 cases total, counted 2026-08-02: `harness-resolution.spec.ts` (8, `resolveHarnessForAgent`),
  `dispatch-path-routing.spec.ts` (8, `chooseDispatchPath`), `swarm-app-manifest-load.spec.ts` (10,
  the swarm-app loader). They are no longer covered only by noop-mode e2e.
- ~~**#14 JSDoc coverage on the large orchestration files**~~ — **CLOSED (PR #22)**, comments-only:
  `dispatchTicket` had no JSDoc and two `@param`s had drifted from the signature.
- **#1 Tenant scoping — still genuinely open (the only survivor).** Platform-wide RLS is enforced,
  but the tables with no owner column still rely on app-layer scoping and need owner columns or
  join-based policies (`personal_graph_*`, `chat_messages`, `agent_memories`,
  `knowledge_memory_documents`, the `lm_*` student tables), plus per-request tenant context in the
  client APIs. See the numbered item below.

The numbered audit list further down is the **historical record of the 2026-06-13 audit**, not a work
queue. Where an item has since closed, its entry says so inline — read the inline note, not the
original 2026-06-13 wording.

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
2. ✅ **[DONE — ESLint with FSD rules + blocking lint gate]** `eslint.config.mjs` (flat config) +
   the `lint` npm script carry the FSD barrel-boundary rule rejecting `@/features/*/services/*` deep
   imports, plus no-console / no-empty-catch / the 1000-code-line cap. The 2026-07-19 "remaining"
   clause is **closed**: the warning counts were driven to zero and `gate_lint` in `ci-local.sh` is
   blocking over `src tests scripts` (see the re-baseline at the top of this file for the
   verification). `ci.yml`'s advisory `|| echo` survives on a manual-dispatch-only workflow and is
   not the merge gate.
3. ✅ **[DONE 2026-06-22]** **Bot-node DB connect retry.** `bot-node-server.ts` did a single `SELECT 1`;
   a transient timeout during a 20-container cold start left the bot DB-less (no profile seeding, no
   cost tracking) with no retry. Now retries the probe (`BOT_DB_CONNECT_ATTEMPTS`, default 10×2s) and
   degrades to no-DB only after retries are exhausted.
4. ✅ **[DONE — and the 2026-06-13 premise below was already false when written]** Migration
   transactionality. The original wording — *"`database-bootstrap-service.ts` applies each migration
   without a `BEGIN/COMMIT/ROLLBACK`; a mid-migration failure can leave partial state that re-runs
   differently"* — does not describe the code: each migration and its `app_migrations` INSERT run
   `BEGIN` / sql / INSERT / `COMMIT` on one pooled client, with `ROLLBACK` and a loud filename error
   on failure. Guard + mutation check are recorded in the still-open section at the top.

## Backlog — MEDIUM

5. **Oversized files (1000-line hard cap violations).** ✅ Resolved 2026-07-11: `app.js`,
   `QueueManagerService.js`, and `queue-manager-service.ts` were decomposed behind their existing
   interfaces (see BACKLOG.md → Code governance for the full 11-file burn-through);
   the retired platform's graph view no longer exists (removed in that carve-out). Residual: `jarvis-routes.ts`
   (blocked on in-flight work) + 16 files in the 800–1000 code-line warning band.
6. ✅ **[DONE — NO-OP, stale premise]** Deep-import FSD violations. The audit counted ~40 files
   (e.g. `@/features/llm-provider/services/codex-cli-provider` instead of the barrel); the rule from
   #2 now reports **0**, and the deep imports that remain are the sanctioned controller→LLM-runtime
   boundary exceptions. See the re-baseline at the top.
7. ✅ **[DONE 2026-08-01 — per-node tokens]** Remote-client auth. The shared-secret header compare
   described here was replaced by device-bound `oshal_pat_` tokens with scope, rotation and
   revocation; the shared secret is a loudly-deprecated compatibility path behind
   `REMOTE_CLIENT_REQUIRE_NODE_TOKEN`. Full shipped scope, honest limits (this is not mTLS) and the
   one live residual are in the still-open section at the top of this file.
8. ✅ **[DONE — PR #20]** Graceful degradation sweep. Every external call (ChromaDB, the graph
   engine) degrades rather than 500-ing when the service is down; the sweep found and fixed a real
   unhandled-rejection 500 on the graph route. Guards named in the re-baseline at the top.
9. ✅ **[DONE 2026-06-22]** **RedisMeshTransport** poll loop had no max-failure backoff/give-up. Now
   counts consecutive failures, backs off exponentially to a 30s cap, and emits one distinct
   `unhealthy:true` line past `MESH_SUBSCRIBE_UNHEALTHY_AFTER` (default 10) instead of spinning forever.
10. ✅ **[DONE — PR #21]** Unit tests for critical paths. Harness selection
    (`resolveHarnessForAgent`), the swarm-app loader, and dispatcher routing (`chooseDispatchPath`)
    each have direct isolated specs now — 26 cases, no longer noop-mode e2e only. Spec files and
    per-file counts are in the re-baseline at the top.

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
14. ✅ **[DONE — PR #22]** JSDoc coverage on the large orchestration files
    (`queue-manager-service.ts`, `llm-execution-handler.ts`). Comments-only: `dispatchTicket` had no
    JSDoc and two `@param`s had drifted from the signature. (A *lint gate* enforcing 100% header +
    JSDoc coverage going forward is a separate, still-open ROADMAP item — not this one.)

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
    own ports are already bound to `127.0.0.1` (the overlay is the optional VPN/A2A surface). The
    metrics listener was already moved off the wire (`0.0.0.0:9090` → `127.0.0.1:9090`).
    <sub>Corrected 2026-08-02: this line used to say ADRs
    [013](../adr/013-headscale-self-hosted-overlay-network.md)/[014](../adr/014-any-bot-k8s-headscale-gateway.md)
    are "still *Proposed*". Both were reconciled to **Accepted — implemented** on 2026-07-31; the
    overlay ships under `infra/headscale/` and the k8s workspace under `ops/any-bot-k8s/`. What is
    open is this ACL *application*, not the decisions.</sub>
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
