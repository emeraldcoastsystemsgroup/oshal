# Security Hardening — open-shal swarm

Status as of 2026-06-27. This document tracks the security posture of the multi-user
platform: what has been hardened, the configuration required to activate it, the FIPS
crypto posture, and the remaining backlog. It is the operator-facing companion to the
full audit findings.

**Deployment status:** the app-layer hardening below (RCE close, IDOR/object-level
authz, vault at-rest encryption, SSRF guard, schema-race advisory lock, fail-closed
webhooks, helmet + rate-limit, 127.0.0.1 port binding, TLS verification) is **live on
the running swarm as of 2026-06-22** — built into `oshal-bot:latest` and rolled across
the api + all bots; verified by an end-to-end ticket completion with the regression
signature (`no workspace deliverables`) at zero. The remaining open items are the
network-overlay hardening (see [hardening-backlog.md](../backlog/hardening.md) §Network
overlay) and the operator credential rotation (see root `HUMANTODO.md` §1).

**Database-enforced RLS (defense-in-depth, live 2026-06-27 — ADR-076).** The app-layer
object-level checks above are now backed by a database wall. Previously the runtime
connected as a `SUPERUSER` + `BYPASSRLS` role, which silently neutralized RLS; it now
connects as the least-privilege `oshal_app` role (NOSUPERUSER, NOBYPASSRLS) and
`FORCE ROW LEVEL SECURITY` policies are enforced on 84 tables across 3 tiers (migration
`060-platform-rls-tenancy.sql`). A forgotten owner predicate, an IDOR, or a stolen DB
connection can no longer cross users on any Tier-1/Tier-2 table. Deferred (still
app-layer only): `personal_graph_*`, `chat_messages`, `agent_memories`,
`knowledge_memory_documents`, `lm_*` student tables. See ADR-076 and
[governance/RLS-RUNBOOK.md](../governance/RLS-RUNBOOK.md).

---

## 1. What has been hardened (this pass)

### 1.1 Remote code execution (closed)
`codex` CLI spawns flipped from `shell: true` to `shell: false` so an attacker-influenced
prompt (LLM output / ticket title/body) can no longer break out into the host shell.
- `src/features/llm-provider/services/codex-cli-provider.ts`
- `src/shared/services/codex-quick-call.ts`

### 1.2 Network exposure (closed for LAN)
All non-public container host ports rebound from `0.0.0.0` to `127.0.0.1` in
`docker-compose.oshal-local.yml`: Postgres, TimescaleDB, Redis, ChromaDB, ArangoDB,
code-server, all 25 bot/worker ports (including the `self-healing` worker that mounts the
Docker socket), and the codex OAuth callback (`1455`).
Only the OIDC-gated application port remains reachable off-host. Service-to-service traffic
is unaffected (containers communicate over the internal `oshal` Docker network).

### 1.3 Transport (closed)
`NODE_TLS_REJECT_UNAUTHORIZED` set to `"1"` in `docker-compose.oshal-local.yml` so outbound
TLS certificates are verified (prevents a MITM on any outbound hop from impersonating an
OIDC issuer / connector / LLM provider and harvesting brokered tokens). The
`docker-compose.incident-lab.yml` override is intentionally left at `"0"` (it talks to a
self-signed internal OpenSearch).

### 1.4 Object-level authorization / IDOR (partially closed)
A new shared authorization layer — `src/shared/middleware/authz.ts` — provides:
- `getCaller(req)` — caller identity from the validated OIDC session only (never request body).
- `isOperator(req)` — operator/admin check against an env allowlist (no IdP role claim is wired).
- `canAccessResource(req, ownerSub)` — owner-or-operator object-level check.
- `requireOperator(req, res)` — 403 guard for operator-only routes.

Applied to:
- **Tickets** (`src/app/routes/ticket-routes.ts`): every by-id handler
  (get/patch/delete/status/state/pause/resume/cancel/chat/project/task-link/workspace-link)
  now enforces owner-or-operator and returns **404** on mismatch (so ids are not oracle-able).
  The list endpoint forces `ownerSub` to the caller for non-operators and ignores a
  client-supplied `ownerSub` unless the caller is an operator. Previously it returned all
  tickets and honored an arbitrary `ownerSub`.
- **Cockpit hierarchy** (`src/app/routes/cockpit-routes.ts`): `?scope=all` is now an
  operator-only override; non-operators are hard-scoped to their own tickets.
- **Connector chat conversation IDOR** (`eats`/`movies`/`spotify`/`travel`/`rides`/`purchasing`
  `-routes.ts`): `POST /chat` honored a client-supplied `conversationId` without checking it
  belonged to the caller, so a user could read another user's chat history (and inject messages
  into their thread) by supplying their conversation id — UUID-unguessability was the only barrier.
  Added an ownership guard to all six: a supplied `conversationId` is verified against
  `<app>_conversations WHERE conversation_id=$1 AND user_sub=$2`, and ignored (start a fresh
  conversation) if not owned. The GET resume endpoints already derived/verified ownership; this
  closes the POST path. (Found by an application security bot reviewing the Travel app; fixed
  across the whole house pattern, not just Travel.)
- **Memory listing** (`src/app/routes/memory-routes.ts`): the agent-memory and
  knowledge-document listing routes (which can expose other users' conversational context and
  ingested sources) are now operator-only.
- **Task workspace owner binding** (`ADR-060`, revised; `bot-node-execution-handler.ts`,
  `any-bot/server/controllers/TaskController.js`, `base-cli-harness-adapter.ts`). ADR-060's
  per-user *path* layout (`<root>/users/<owner>/<taskId>`) was **reverted** — the layout is still
  flat `<root>/<taskId>`, and an earlier revision of this section wrongly described the layout as
  shipped. A directory layout was never the boundary in any case: every bot container mounts the
  same workspace volume read-write (`oshal_workspace:/app/workspace-shared:rw`), so a nested path
  is reachable with `../..`. What actually enforces the isolation:
  - **Cross-owner directory reuse is rejected.** The workspace directory is keyed by the workspace
    folder id — the root ticket UUID on the swarm path, or a ticket `externalId` under a UNIQUE
    index — so two users cannot organically share one. Where an id could be reused across owners,
    `assertExistingTaskOwner` (before any task creation or execution) and `assertTaskOwnerBinding`
    (ticket-workspace reuse) throw `TASK_OWNER_MISMATCH`, failing closed across the owned /
    ownerless / anonymous boundaries.
  - **Brokered credentials cannot linger for the next occupant.** `.oshal-cred-*` /
    `.oshal-user-sub` are written at mode `0600` under a per-workspace exclusive lease and unlinked
    (stat-identity verified) in a `finally` — "issue → use → wipe" (ADR-040). This closes the
    cross-user credential-exposure path that motivated ADR-060, independently of the layout.

  Isolation therefore holds at the API and database layers, and on disk by owner binding rather
  than by path partitioning. Guards: `tests/unit/bot-node-workspace-owner-binding.spec.ts`,
  `tests/unit/any-bot-task-owner-scope.spec.ts`, `tests/cred-wipe.spec.ts`. See ADR-060's
  "Reverted: where the isolation actually lives" for the reader-migration and per-owner-mount
  done-when if partitioning is revisited.
- **Workspaces** (`src/app/routes/workspace-routes.ts` + store/schema/migration `052`): added an
  `owner_sub` column (schema auto-applies on boot; migration `052-workspace-owner-sub.sql` is the
  recorded form). Create stamps the owner from the session; get/update/delete/ensure-path enforce
  owner-or-operator (404 on mismatch); list is caller-scoped for non-operators. Previously any
  authenticated user could read, modify, or **delete** (including the on-disk directory via
  `fs.rmSync`) any tenant's workspace by guessing its id. The `ON CONFLICT (name)` reuse path
  deliberately does not overwrite `owner_sub`, so a name collision cannot silently re-own a row.

---

## 2. Required configuration to activate

These changes are the baseline posture; a few still need configuration and a container recreate to
take full effect:

| Setting | Where | Purpose |
|---|---|---|
| `OSHAL_OPERATOR_EMAILS` | `.env` (comma-separated) | Grants operator privilege (team dashboards, `?scope=all`, memory listing). **Set this to your own login email**, or operator dashboards return scoped/empty results. Also accepts `OSHAL_OPERATOR_SUBS` for OIDC subs. |
| `OSHAL_ALLOW_LEGACY_UNOWNED` | `.env` (default `false`) | Break-glass/backfill-only: temporarily allows access to pre-ownership rows that have no `owner_sub`. Leave unset/false for real users. |
| `OSHAL_DB_GUC` | `.env` (default `on`) | RLS identity stamping for pooled Postgres queries. **Required** for the now-enforced RLS (ADR-076). Set to `off` only as break-glass rollback (after repointing `DATABASE_URL` at the superuser role / disabling RLS). |
| Container recreate | `docker compose -f docker-compose.oshal-local.yml up -d` | Required for the port rebinds and the TLS flag. An image rebuild alone does not move host-port bindings. |
| Image rebuild | `oshal-api` | Required for the RCE fixes and the IDOR route changes (compiled TypeScript). |

Note: with no operators configured, `isOperator` is fail-closed (returns false), so
operator-only views degrade to per-user scope rather than leaking data.

---

## 3. FIPS posture (FIPS 140-3 / FedRAMP-High direction)

Goal: use FIPS-approved cryptography everywhere possible, and make full FIPS-module
enforcement a documented deployment step.

### 3.1 Algorithm posture (application layer — controllable in code)
- **Approved and in use:** AES-256-GCM (connector/credential at-rest encryption), SHA-256
  (hashing, per-user directory derivation). These are FIPS 140-approved primitives.
- **TLS:** outbound verification is now enforced (1.3). Require TLS 1.2+; do not disable
  certificate validation in any environment (the incident-lab override should not be promoted
  to production).
- **Gap to fix (tracked, §4):** the at-rest key is derived as `SHA256(SESSION_SECRET)`. A raw
  hash is not an approved key-derivation function. Move to **HKDF-SHA256** (approved) or
  **PBKDF2-HMAC-SHA256** when the connector-token crypto is revised. ~~and remove the
  dev-secret fallback~~ **Done 2026-07-31:** the hardcoded dev-key fallback is removed
  everywhere (src + every `scripts/oshal-*.js` CLI) — a missing `SESSION_SECRET` now fails
  loud in every mode, including the envelope-crypto-OFF break-glass. Guard:
  `tests/unit/no-dev-secret-fallback.spec.ts` (behavioral + tree scan). The per-user envelope
  encryption (`OSHAL_ENVELOPE_CRYPTO`) already uses per-user DEKs wrapped by a KEK — it is on
  by default; source the KEK from a KMS.
- **Forbidden:** do not use MD5, SHA-1, RC4, DES/3DES, or non-approved curves for any security
  purpose. Audit with a grep before each release.

### 3.2 Module enforcement (infrastructure — a deployment decision)
Running Node's crypto through a **FIPS 140-3 validated module** requires a Node build linked
against a validated OpenSSL 3 FIPS provider. The current `node:*-alpine` base is **not**
FIPS-validated. To enforce FIPS-high:
1. Build/run on a FIPS-validated base (e.g. RHEL UBI with the system OpenSSL FIPS provider, or
   a Node image built with the OpenSSL 3 FIPS provider enabled).
2. Enable the provider via `openssl.cnf` (`fips = yes` in the default section) or start Node
   with `--force-fips`. Verify at runtime with `crypto.getFips() === 1`.
3. Once enabled, the process will **throw** on any non-approved algorithm — this is the
   enforcement mechanism and also why §3.1's forbidden-algorithm audit must pass first.
4. For the data stores: enable FIPS mode on Postgres/Redis/Arango TLS and use FIPS-validated
   OS crypto on the host.

This pass enforces FIPS at the **algorithm** layer and documents the **module** layer as the
next infrastructure step; the application code does not depend on any non-approved primitive
except the KDF gap noted above.

---

## 4. Remaining backlog (not yet closed)

Ordered by exposure. None are LAN-reachable after §1.2; all require either a DB migration or
coordination with in-flight work.

2026-06-22 task/chat isolation update: `chat_tasks.owner_sub` is now the primary task owner;
linked ticket ownership is fallback; legacy unowned rows deny by default unless
`OSHAL_ALLOW_LEGACY_UNOWNED=true` is temporarily set during a controlled backfill window.

1. **IDOR on tables with no owner column (needs migrations):**
   - `workspaces` — **CLOSED** (§1.4, migration `052`).
   - `tasks` / chat messages (`message-routes.ts`) — **CLOSED**. GET `/:taskId/messages` and the
     send handlers now call `callerMayAccessTask` (owner = the task's ticket owner via
     `resolveTaskOwner`; fails SAFE so new/unowned threads are never blocked, only a clearly
     different owner is denied 404). Closes reading another user's chat history / injecting into
     their thread by supplying a taskId. (No migration needed — owner derived from the ticket.)
   - `agent_memories` — no owner column; still operator-gated (§1.4) as an interim control,
     and **deferred** in the ADR-076 DB-RLS rollout (needs a join-based policy via task→ticket
     owner). Note: as of 2026-06-27 all owner-bearing tables now have DB-enforced RLS as a
     backstop to these app-layer checks (ADR-076); only the listed no-owner-column tables
     (`agent_memories`, `chat_messages`, `knowledge_memory_documents`, `personal_graph_*`,
     `lm_*`) remain app-layer-only.
2. **Schedules** — **CLOSED**. `schedule-controller.ts` now runs `requireOwnedSchedule()` on
   get/update/pause/resume/delete/**trigger** (owner-or-operator, unowned/system schedules pass;
   404 on mismatch), and `?scope=all` is operator-only. Closes read/edit-cron/delete/run-on-demand
   of another user's job by guessing its (predictable) id.
3. **SSRF** in BYO-LLM `baseUrl` — **CLOSED**. `src/shared/security/ssrf-guard.ts`
   (`assertPublicHttpUrl`) is called before the `chatComplete` and `/models` fetches in
   `byo-llm-routes.ts`; it rejects internal hostnames and any host resolving to a
   private/loopback/link-local/CGNAT/metadata address (incl. `169.254.169.254`).
4. **Web hardening** — **PARTIAL**: `helmet` (headers only, CSP intentionally off pending a
   UI-tested pass) and a public-origin-only `express-rate-limit` (1000/min per external IP;
   internal/no-XFF traffic skipped so the swarm is never throttled) are wired in `server.ts`.
   Still open: a tested CSP, `express.json({ limit })`, and per-route throttles on `/login` /
   `/api/jarvis`.
5. **Webhooks** — **CLOSED (fail-closed)**: `alertmanager-routes.ts` and `world-routes.ts`
   now reject all requests when `ALERT_WEBHOOK_TOKEN` / `WORLD_INGEST_TOKEN` is unset (was
   fail-open). `ALERT_DEFAULT_INTAKE=backlog`. To re-enable the receivers, set the token and
   configure the feeder (Alertmanager / world cron) to send it. Signature verification is a
   future nicety.
6. **At-rest** — vault encryption **CLOSED**: `vault-crypto.ts` + `sqlite-vault-store.ts` now
   AES-256-GCM-encrypt the PII content fields (entity/edge `label` + `attrs`) and store the
   natural-key resolver index as a keyed HMAC (lookup-preserving, irreversible). Key is per-user
   HKDF-SHA256(`SESSION_SECRET`, salt=ownerSub) — derived, never written to the file. Existing
   plaintext rows migrate on first open (`user_version` guard). A leaked vault DB/volume/backup is
   now opaque without `SESSION_SECRET`. Still open: connector-token envelope crypto
   (`OSHAL_ENVELOPE_CRYPTO`) + the connector-token FIPS KDF (token loss = reconnect, so low-risk
   when wanted); `facts.value` numbers are left cleartext (metrics, lower PII than label/attrs).
7. **Secrets** — rotate the historically-committed AWS / GitLab / vendor credentials and remove
   `.env.gitlab` / `.env.bak` from disk; rotation is the only real fix for git-history exposure.
8. **Bot safety** — flip tool approval to fail-closed for unregistered tools, remove the
   blanket `use_mcp_tool` auto-approve on swarm dispatch, and fence external/tool-result content
   as untrusted to blunt prompt injection.
   **Partly addressed 2026-07-31** by the injection blast-radius audit. Corrections and status:
   - The blanket auto-approve on swarm dispatch is **already inert, by accident**.
     `AgenticController` read `autoApprove.commandExecution`; every caller
     (`AgentDispatchEngine`, `ClineCLIWrapper`, the front door) sends per-tool keys such as
     `execute_command`. Nothing is auto-approved on the unattended path. That is the right
     posture reached by a key-name mismatch, so **renaming the key to match the callers would
     silently enable shell + file writes + MCP for prompt-injectable bots.** The decision now
     lives in `any-bot/server/controllers/tool-approval-policy.js` with that history recorded,
     pinned by `tests/unit/tool-approval-policy.spec.ts` (behaviour unchanged).
   - **Still open:** unregistered *non-exec* tools graceful-allow unless
     `OSHAL_TOOL_AUTH_STRICT=true`, which no compose file sets; and `ToolAuthInterceptor` is
     wired only when `switchFrameworkService` is supplied — otherwise `task-orchestrator`
     returns the raw executor with no auth at all.
   - **Still open, and the largest one:** no fencing of untrusted content anywhere on the
     ticket-dispatch path. `assemblePromptForAnyBot` joins persona, org memory, handovers and
     the raw ticket body into a single string at one trust level. The pattern to lift is
     already in-tree at `jarvis-orchestrator.ts` (untrusted-data preamble + `<untrusted-…>`
     fencing + length cap + deterministic server-side re-binding); `a2a-rpc-service.ts` and
     `coder-bot/src/assistant.js` are smaller working examples. Note also that swarm memory is
     **wormable** — `SwarmMemoryService` re-injects stored agent output into later prompts as
     authoritative guidance, so one injected run seeds future tickets.
   - There are still **no adversarial-prompt tests** of any kind, and the three real defenses
     above have no regression tests, so a refactor can delete them silently.
10. ~~**Bootstrap PAT minting was a cross-user takeover path** — `POST /api/cli-tokens` honored
    the `x-oshal-user-sub` assertion for any sub behind the fleet-wide `SWARM_SERVICE_SECRET`
    and minted a **non-expiring** token. Every bot container carries that secret, and a PAT
    authenticates on every `requiresAuth` route (including `/api/content` and
    `/api/linkedin-assistant`, which the service secret alone cannot reach) — so a single
    prompt-injected bot could mint permanent credentials for an arbitrary user.~~
    **Done 2026-07-31:** session-less mints are operator-only via `isOperatorIdentity`
    (fail-closed on an empty allowlist) and time-boxed by `OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS`
    (default 30 days, reusing the existing `expires_at` column). Session mints are unchanged.
    `swarm-cli login --secret` still works for an operator. Guard:
    `tests/unit/cli-token-auth.spec.ts`. The prior rationale — "not an escalation, the secret
    already implies full impersonation" — assumed every secret-holder is trusted; bots are
    secret-holders and are injectable, which is what made per-request impersonation into a
    persistent credential.
9. ~~**Latent** — default `MOCK_OIDC=false` in code and remove the dev-secret fallback
   (both currently overridden by `.env`, harmless here, a footgun on a fresh deploy).~~
   **Done 2026-07-31:** the compose interpolation default is now `MOCK_OIDC:-false` (the
   installer writes `MOCK_OIDC=true` explicitly for dev boxes, so the sanctioned path is
   unchanged; a fresh `compose up` with no `.env` fails loud at boot instead of silently
   mocking auth), and the hardcoded dev-key fallback is removed tree-wide (see §3.1). Guards:
   `tests/unit/mock-oidc-failclosed.spec.ts` + `tests/unit/no-dev-secret-fallback.spec.ts`.
