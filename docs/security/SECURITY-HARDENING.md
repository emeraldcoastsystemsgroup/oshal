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
- **Per-user task storage on disk** (`ADR-060`; `tool-executor-service.ts`,
  `workspace-service.ts`, `user-scoped-workspace-path.ts`): a bot's working directory for a NEW
  task is now placed under the owning user's namespace — `<root>/users/<owner>/<taskId>` (or
  `<root>/_shared/<taskId>` for ownerless system/swarm tasks) — instead of a flat shared root.
  The owner is resolved from the task's ticket. Brokered credential drops (`.oshal-cred-*`) and
  deliverables therefore land in the owner's directory, closing the shared-filesystem exposure.
  Pre-existing flat task dirs are detected and preserved (no orphaned work). This makes isolation
  hold at all three layers: API, database, and filesystem.
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
  **PBKDF2-HMAC-SHA256** when the connector-token crypto is revised, and remove the
  `'oshal-dev-secret'` fallback. The per-user envelope encryption (`OSHAL_ENVELOPE_CRYPTO`)
  already uses per-user DEKs wrapped by a KEK — turn it on and source the KEK from a KMS.
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
9. **Latent** — default `MOCK_OIDC=false` in code and remove the `'oshal-dev-secret'` fallback
   (both currently overridden by `.env`, harmless here, a footgun on a fresh deploy).
