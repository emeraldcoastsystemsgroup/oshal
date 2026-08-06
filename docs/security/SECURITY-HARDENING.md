# Security Hardening — open-shal swarm

Status reconciled 2026-08-05. This document tracks the security posture of the multi-user
platform: what has been hardened, the configuration required to activate it, the FIPS
crypto posture, and the remaining backlog. It is the operator-facing companion to the
full audit findings.

**Deployment status:** the 2026-06-22 app-layer baseline below (RCE close, IDOR/object-level
authz, vault at-rest encryption, SSRF guard, schema-race advisory lock, fail-closed
webhooks, helmet + rate-limit, 127.0.0.1 port binding, TLS verification) is **live on
the running swarm as of 2026-06-22** — built into `oshal-bot:latest` and rolled across
the api + all bots; verified by an end-to-end ticket completion with the regression
signature (`no workspace deliverables`) at zero. Later entries explicitly marked local code still
require promotion and live proof; they are not covered by that historical deployment claim. The remaining open items include the
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

**Worker bots are non-superuser too (K5, 2026-08-01).** Bot-node containers previously
inherited the operator's `DATABASE_URL`, which on legacy `.env`s was the RLS-bypassing
superuser — so a prompt-injected bot was itself an RLS bypass around the per-user isolation
the platform is sold on. As of migration `099-bot-db-role.sql` (wave PR #85), bots read
their own `BOT_DATABASE_URL` and connect as a dedicated `oshal_bot` role (NOSUPERUSER,
NOBYPASSRLS, DML-only, owns nothing), so **no production runtime identity — api or bot — is a superuser
or RLS-exempt**. Verified live 2026-08-01 (bot containers report `oshal_bot`). Guard:
`tests/unit/bot-db-least-privilege.spec.ts`. (Residual: `docker-compose.incident-lab.yml`
still hands throwaway LAB bots a lab-DB superuser — tracked in BACKLOG K5.)

---

## 1. What has been hardened (this pass)

### 1.1 Remote code execution (closed)
Before autonomous CLI execution was disabled, `codex` CLI spawns flipped from `shell: true` to
`shell: false` so an attacker-influenced prompt could not break out through an intermediate host
shell. The current stronger boundary rejects unattended Cline/Claude Code/Codex/Gemini execution
before task/workspace setup; the historical spawn hardening remains defense in depth.
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

### 1.4a Worker-plane (remote-client) auth: per-node tokens (2026-08-01)
The desktop/worker plane authenticated with `REMOTE_CLIENT_SHARED_SECRET` — ONE value shared by
every node, and MACHINE TRUST, so a request bearing it skipped the per-device ownership gate
entirely. One leaked copy therefore reached every person's computer, and it could not be rotated for
a single machine. It is now replaced by per-node tokens (issue, verify, rotate, revoke) with the
shared secret kept as a loudly-deprecated compatibility path and a fail-closed switch
(`REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true`) to retire it. Full description, including the deliberate
scope limits, in [hardening-backlog #7](../backlog/hardening.md).

### 1.4b Execute-time entitlement now covers the OTHER bot endpoint (2026-08-01)
`POST /api/send-message` (and its `/api/tasks/:taskId/messages` alias) honoured a caller-supplied
`agentId` verbatim and called the orchestrator directly, bypassing `executeBotOrInline` — so the
entitlement gate that defaults to ENFORCE covered `/api/swarm-execute` and the controller chokepoint
but not this route. Its IDOR guard checks the THREAD, not the BOT, so a signed-in non-operator could
reach the ADR-087 operator+swarm machinery (`oshal-developer`, `devops-bot`, `vault-bot`,
`security-analyst`, `code-developer`, …) by naming its agentId on a task they legitimately own. The
resolved agentId now runs through `assertExecuteEntitlement` before any ticket is created or any LLM
work starts; service-secret (swarm/queue dispatch) callers are unchanged. Guard:
`tests/unit/send-message-entitlement.spec.ts`.

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
  - **Generic credentials never enter the workspace.** `.oshal-cred-*` files and `OSHAL_CRED_*`
    child-environment carriers are rejected. The scoped writer permits only the non-secret
    `.oshal-user-sub` / `.oshal-user-key` identity markers at mode `0600`, under a per-workspace
    exclusive lease, and unlinks them with stat-identity verification in `finally`. Connector
    credentials remain inside exact server-side operations, so there is no model/CLI credential file
    for a later workspace occupant to recover.

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
- **Connector KDF closed in local code:** new shared connector blobs (`k2:`) and DEK wrappers
  (`hkdf1:`) use domain-separated **HKDF-SHA256**. Unprefixed `SHA256(SESSION_SECRET)` blobs and
  wrappers are read-only migration compatibility; legacy wrappers compare-and-set rewrap on read.
  **Done 2026-07-31:** the hardcoded dev-key fallback is removed
  everywhere (src + every `scripts/oshal-*.js` CLI) — a missing `SESSION_SECRET` now fails
  loud in every mode, including the envelope-crypto-OFF break-glass. Guard:
  `tests/unit/no-dev-secret-fallback.spec.ts` (behavioral + tree scan). The per-user envelope
  encryption (`OSHAL_ENVELOPE_CRYPTO`) uses per-user DEKs wrapped by the versioned HKDF KEK and is
  on by default. DEK-store errors deny by default; only the explicit logged
  `OSHAL_ENVELOPE_DEK_FAILURE=shared-hkdf` incident break-glass writes k2. Production still needs
  KMS/HSM-backed master-key custody plus rotation and recovery evidence.
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
2. **Schedules** — **CLOSED**. `schedule-controller.ts` runs `requireOwnedSchedule()` on
   get/update/pause/resume/delete/**trigger** (owner-or-operator; unowned records deny by default;
   404 on mismatch), and `?scope=all` is operator-only. The legacy execute-by-id callback now uses
   the same ownership boundary. New user-owned records use an exact-owner/exact-task digest in the
   Redis id, so create-or-replace cannot collide across tenants or through lossy task-type
   normalization; an existing legacy id is reused only for the same exact owner and task type.
   Manifest-derived `app:` / `app-route:` jobs cannot be created, mutated, or synthesized through
   the public API, while `workflow:` ticket producers require operator authority. Request logs keep
   task metadata but no longer record prompt-bearing bodies.
3. **SSRF** in BYO-LLM `baseUrl` — **CLOSED**. `src/shared/security/ssrf-guard.ts`
   (`assertPublicHttpUrl`) is called before the `chatComplete` and `/models` fetches in
   `byo-llm-routes.ts`; it rejects internal hostnames and any host resolving to a
   private/loopback/link-local/CGNAT/metadata address (incl. `169.254.169.254`).
4. **Web hardening** — **LOCAL IMPLEMENTATION CLOSED; ENFORCEMENT ROLLOUT PARTIAL.** `helmet` + the public-origin-only
   `express-rate-limit` (1000/min per external IP; internal/no-XFF traffic skipped so the swarm is
   never throttled) were already wired in `server.ts`. The three named residuals:
   - **A tested CSP.** `cspFromEnv()` no longer returns `false`. The strict policy now ships by
     DEFAULT on the non-blocking `Content-Security-Policy-Report-Only` header, so every response
     carries a real policy and the `/api/security/csp-report` collector learns the actual allowlist
     — a report-only policy cannot break a surface, which is why the previous "CSP off pending a
     UI-tested pass" caution was costing observability for nothing. `OSHAL_STRICT_CSP=on` enforces
     (blocking header); `OSHAL_CSP=off` is the kill switch. Directives pinned: `default-src 'self'`,
     `object-src 'none'`, `base-uri`/`form-action`/`frame-ancestors`/`frame-src` `'self'`,
     `worker-src 'self' blob:`, `upgrade-insecure-requests`, and `script-src` WITHOUT
     `'unsafe-inline'` unless a nonce is supplied. Inline `style=` is still permitted (styles cannot
     exfiltrate the way scripts can — the documented pragmatic step). The collector dedupes by
     `directive|blockedUri|documentUri` so report-only on a cockpit full of inline scripts cannot
     bury real faults. **Remaining, and it is now measurable:** nonce/externalise the cockpit's
     inline `<script>` blocks until the report-only log is clean, then flip to enforce.
   - **`express.json({ limit })`.** The global parser is now `createGlobalJsonParser()`
     (`features/security/hardening/body-limits.ts`): an explicit, env-tunable limit
     (`OSHAL_JSON_BODY_LIMIT`, default `100kb` — the same bound express applied implicitly, now
     stated and tested) plus the four reserved prefixes that own their own parsers
     (`/api/remote-clients` screenshots, `/api/vision` base64 images, `/api/hooks` — which must keep
     the EXACT bytes for its HMAC verifier — and `/api/alerts/alertmanager`, whose route-local
     bounded parser captures exact bytes for its own HMAC guard).
   - **Per-route throttles.** `expensiveOpLimiter` now mounts on `/api/jarvis` as well as
     `/api/intake` — every Jarvis turn is an LLM call and the route is reachable by any signed-in
     user. `/login` needed nothing: the credential-checking endpoint is
     `POST /api/local-auth/login`, which already has its own attempt lockout (429).
   Guard: `tests/unit/web-hardening-csp-body.spec.ts` — asserts the PARSED directive map and which
   header carries it (not a header string), and that an oversized body 413s while a reserved prefix
   passes through unparsed.
5. **Webhooks** — **PARTIAL (bearer fail-closed; HMAC rollout remains)**: `alertmanager-routes.ts` and `world-routes.ts`
   now reject all requests when `ALERT_WEBHOOK_TOKEN` / `WORLD_INGEST_TOKEN` is unset (was
   fail-open). `ALERT_DEFAULT_INTAKE=backlog`. To re-enable the receivers, set the token and
   configure the feeder (Alertmanager / world cron) to send it. Alertmanager now has an exact-byte,
   fail-closed HMAC guard wired after its bearer guard; set `ALERT_WEBHOOK_HMAC_SECRET` and configure
   the sender's `x-alert-signature-256` before claiming body-integrity enforcement. World ingestion
   remains bearer/header authenticated; query-string credentials are rejected.
6. **At-rest** — vault encryption **CLOSED**: `vault-crypto.ts` + `sqlite-vault-store.ts` now
   AES-256-GCM-encrypt the PII content fields (entity/edge `label` + `attrs`) and store the
   natural-key resolver index as a keyed HMAC (lookup-preserving, irreversible). Key is per-user
   HKDF-SHA256(`SESSION_SECRET`, salt=ownerSub) — derived, never written to the file. Existing
   plaintext rows migrate on first open (`user_version` guard). A leaked vault DB/volume/backup is
   now opaque without `SESSION_SECRET`. Connector-token per-user envelope crypto is ON by default;
   versioned HKDF (`hkdf1:`/`k2:`), legacy-read migration, default-deny DEK-store handling, and the
   explicit logged shared-HKDF break-glass are closed in local code. Still open are KMS/HSM master
   custody, operator rotation/recovery tooling, and mixed-format live database/provider proof.
   `facts.value` numbers are left cleartext (metrics, lower PII than label/attrs).
7. **Secrets** — rotate the historically-committed AWS / GitLab / vendor credentials and remove
   `.env.gitlab` / `.env.bak` from disk; rotation is the only real fix for git-history exposure.
8. **Bot safety** — fail closed on unregistered/unauthorized tools, keep external/tool-result
   content untrusted, and prevent model-visible runtimes from receiving connector or platform
   credentials. Current controls and history:
   - **Historical control, superseded by the CLI preflight below:** the blanket auto-approve on
     swarm dispatch was inert because
     `AgenticController` read `autoApprove.commandExecution`; every caller
     (`AgentDispatchEngine`, `ClineCLIWrapper`, the front door) sends per-tool keys such as
     `execute_command`. Nothing is auto-approved on the unattended path. That is the right
     posture reached by a key-name mismatch, so **renaming the key to match the callers would
     silently enable shell + file writes + MCP for prompt-injectable bots.** The decision now
     lives in `any-bot/server/controllers/tool-approval-policy.js` with that history recorded,
     pinned by `tests/unit/tool-approval-policy.spec.ts` (behaviour unchanged).
   - **Fail-closed tool/MCP behavior is closed in local code (2026-08-06):** every unregistered
     tool is denied and a missing `ToolAuthInterceptor` makes `task-orchestrator` return a denial
     executor. Both legacy HTTP/stdio transports are private behind the immutable `ToolRegistry`
     snapshot and its module-private execution attestation; execution additionally requires exact
     user, agent, task, tool-allowlist, and operation-scope context plus server-owned approval.
     The internal tool bridge permits only exact AUTO grants bound to a stable non-system executor.
     Remote stdio calls bind to the claimed task and discovered-tool snapshot, while both edge-agent
     launch surfaces reject unbrokered mesh execution. The fixed-name private Chroma memory adapter
     remains an internal backend operation, not an arbitrary tool dispatcher. Inventory and mutation
     guards live in `tests/unit/mcp-tool-authorization-boundary.spec.ts` and the blocking policy gate.
   - **SEC-05 closed in code 2026-08-05:** the ticket-dispatch path now uses
     `prompt-containment.ts` to separate policy and server configuration from ticket, handover,
     tool/page, prior-agent, and unreviewed-memory data. Untrusted values are JSON escaped inside
     explicit `UNTRUSTED_CONTENT` records, capped at 24k characters, and followed by a final
     hashed server binding for the exact user, ticket, workload, allowed tools, and scopes.
     Both local and bot-node handlers use the same builder. Any-bot filters the advertised tool
     list and refuses a model-selected tool that is not in the server-resolved dispatch allowlist;
     tool/error output and persisted prior messages are fenced before later model turns.
   - **Swarm-memory poisoning closed in code:** migration
     `117-swarm-memory-provenance.sql` adds durable trust/source/creator/approver/validation
     evidence with forced RLS. Raw/API writes and task-manager-agent review remain `untrusted`;
     only deterministic structural verification or explicit authenticated operator approval can
     promote a record. Prompt assembly injects validated/approved and untrusted records as
     separate trust classes. Deployments must apply migration 117 before using the durable ledger.
   - Adversarial regression coverage now pins user/ticket rebinding, secret requests,
     delimiter breakout, length caps, unauthorized tools, tool-result injection, exact operator
     approval, and later-memory poisoning in `tests/unit/prompt-memory-containment.spec.ts`,
     `tests/unit/any-bot-runtime-containment.spec.ts`,
     `tests/unit/swarm-memory-lifecycle-promotion.spec.ts`, and
     `tests/unit/swarm-memory-approval-route.spec.ts`.
   - **Autonomous CLI containment (2026-08-06):** unattended Cline, Claude Code, Codex, and Gemini
     CLI execution is operationally disabled. Public adapters, controller-direct providers,
     quick-call/intake helpers, and the bot-node preflight reject before task lookup, persona/memory
     assembly, or workspace creation. An OAuth file or successful auth status is credential presence,
     not authorization for autonomous work. Generic `creds`, `credentials`, `.oshal-cred-*`, and
     `OSHAL_CRED_*` carriers are refused rather than copied into a model process or workspace.
   - A schema-bounded deterministic provider intent consumes the minimum caller-owned credential in
     its exact server operation and completes before model/task side effects. Reasoning uses a
     hosted/BYO inference rail. Re-enable a local CLI only after an audited oshal-brokered sandbox
     enforces immutable request-start handler generations and exact operation scopes while keeping
     authentication and connector credentials outside the model-visible process/workspace. Guards:
     `tests/unit/any-bot-cli-security-boundary.spec.ts`,
     `tests/unit/bot-node-provider-intent.spec.ts`, and
     `tests/unit/brokered-cli-tool-context.spec.ts`.
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
    **Deployed + re-verified 2026-08-01:** PR #83 (commit `d75ef87`) is merged to main and
    live (image rebuilt 2026-08-01). The exploit was re-run against the running stack — a plain
    bot minting a PAT for an arbitrary victim now returns `403 operator_required` where it
    previously minted a non-expiring token. The generalized trust-boundary decision is recorded
    in [ADR-122](../adr/122-model-is-untrusted-principal.md).
    **Operator note (30-day re-login):** because bootstrap PATs now expire, a `swarm-cli login
    --secret` session must re-authenticate roughly every `OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS`
    (default 30) days; raise that env var for a longer-lived automation token, or use a session
    (cockpit) mint, which stays non-expiring. See
    [runbooks/headless-swarm-cli.md](../runbooks/headless-swarm-cli.md).
9. ~~**Latent** — default `MOCK_OIDC=false` in code and remove the dev-secret fallback
   (both currently overridden by `.env`, harmless here, a footgun on a fresh deploy).~~
   **Done 2026-07-31:** the compose interpolation default is now `MOCK_OIDC:-false` (the
   installer writes `MOCK_OIDC=true` explicitly for dev boxes, so the sanctioned path is
   unchanged; a fresh `compose up` with no `.env` fails loud at boot instead of silently
   mocking auth), and the hardcoded dev-key fallback is removed tree-wide (see §3.1). Guards:
   `tests/unit/mock-oidc-failclosed.spec.ts` + `tests/unit/no-dev-secret-fallback.spec.ts`.
