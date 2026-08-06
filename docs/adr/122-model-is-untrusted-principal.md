# ADR-122: The model is an untrusted principal — deterministic authority lives outside the LLM

## Status
Accepted — 2026-08-01. Related: ADR-056 (ticketed data-access broker), ADR-058 (life-graph
steward), ADR-076 (platform RLS tenancy), ADR-042 (connector token isolation).

SEC-01 and SEC-05 have complete local implementations as of 2026-08-05. Operational closure is
still gated on migration, shadow/canary, key-rotation, and real-PostgreSQL evidence against the
deployed commit; local source and unit results are not deployment evidence.

## Context

OSHAL's pitch is that *any* application can run inside a secure AI environment. The question
that pitch lives or dies on is: what happens when a bot is talked into doing something it
shouldn't? Not "can it be talked into it" — an LLM can always be persuaded; that is not a
fixable property of the model — but "what can a fully-persuaded bot actually *do*?"

Two earlier ADRs stated the right instinct, but only for the data plane:

- **ADR-056** (data-access broker): "Intelligence lives in the reasoner … never in an LLM
  holding a DB connection," and named the confused deputy explicitly ("powerful in reach,
  near-zero in discretion").
- **ADR-058** (life-graph steward): "Registered bots are promptable, and therefore
  prompt-injectable. The component that reads and writes a person's whole life cannot be any
  of those."

Neither governs the rest of the platform: credential minting (`POST /api/cli-tokens`), the
ticket-dispatch prompt path, or swarm memory. A 2026-07-31 audit-plus-live-pentest exercised
exactly those, and the results forced this decision to be written down as a platform-wide
boundary rather than a data-plane footnote. Two of the audit's own alarms were disproved by
running against the live stack — a reminder that this ADR is grounded in what the deployed
system does, not in a static reading of source.

## Decision

**A bot is an untrusted principal.** It is simultaneously a *secret-holder* (every bot
container carries `SWARM_SERVICE_SECRET` and its own credentials) and *prompt-injectable*
(anything that can put text in front of it — a ticket body, a fetched page, a tool result,
an email, another agent's output — is an unauthenticated input). Therefore a persona's
guardrails, refusals, and instructions are **not** a security control, and no security
property may depend on the model choosing correctly.

Authority is enforced by **deterministic, non-model code** outside the LLM:

1. **Route auth** — `requiresAuth`; a live sweep confirms sensitive routes are default-deny.
2. **Caller-scoped DB roles** — the api runs `oshal_app`, bots run `oshal_bot`; both are
   NOSUPERUSER / NOBYPASSRLS under `FORCE ROW LEVEL SECURITY` (ADR-076, migration 099).
3. **Per-user token brokering** — connector tokens are decrypted only for the caller's own
   `sub`; a bot cannot decrypt another user's tokens (ADR-042).
4. **Out-of-band action gates** — e.g. live trading requires `TRADING_LIVE_ENABLED`, an env
   switch the model cannot set; privileged credential minting is operator-only.
5. **Fail-closed tool approval** — the unattended dispatch path does not auto-approve
   `execute_command` / file-write / MCP tools (`tool-approval-policy.js`).
6. **Owner binding** on task workspaces and resources.
7. **Request-bound workload delegation** — a controller-signed, short-lived bearer binds one
   registered workload and user to one task, method, canonical path, body digest, audience, and
   scope. Migration 119 records and atomically consumes the grant under forced RLS; a fleet secret
   or caller-supplied user header cannot establish the principal on delegated Graph/Jarvis routes.
8. **Prompt and memory containment** — server code separates policy and trusted configuration from
   bounded, escaped untrusted data, then rebinds the exact user, ticket, workload, tools, and scopes.
   Migration 117 preserves memory provenance; only deterministic validation or an exact-digest
   operator approval can promote content out of the untrusted class.

A finding is a vulnerability only when a bot **crosses one of those boundaries** — reads
another user's data, mints another user's credentials, runs an unapproved tool, or escapes
owner binding — regardless of how the model was persuaded to try. A bot merely *saying*
something off-policy, with no boundary crossed, is a quality issue, not a security one.

## Consequences

**Worked example (confirmed, then closed).** Pre-fix, `POST /api/cli-tokens` honored an
`x-oshal-user-sub` header behind the fleet-wide service secret and minted a **non-expiring**
PAT for any asserted sub. In a live pentest a plain bot minted a token as a victim and
`whoami` returned the victim — per-request impersonation became permanent account takeover.
PR #83 made the session-less bootstrap operator-only (`isOperatorIdentity`, fail-closed) and
time-boxed (`OSHAL_CLI_TOKEN_BOOTSTRAP_TTL_DAYS`, default 30d); re-running the exploit on the
deployed stack now returns `403 operator_required`. Guard: `tests/unit/cli-token-auth.spec.ts`.

**Corrected blast-radius (what the live pentest proved).** The audit over-stated one thing and
under-stated another; this ADR records both. (a) Bots do **not** run as the Postgres superuser —
they run `oshal_bot`, non-superuser, so they do not bypass RLS. (b) The read-side confused deputy
is **real** and broader than a first probe suggested: a service-secret caller asserting an
arbitrary `x-oshal-user-sub` reads that user's data on the trusted-service read routes — confirmed
on `/api/graph` and on `/api/jarvis` (`/history`, `/tasks`, `/overview` all return 200 as the
asserted victim) — though not everywhere (`/api/messages` returns 401). Any route mounted
`serviceSecretOr(requiresAuth)` that resolves the asserted sub is exposed the same way; treat
graph + jarvis as confirmed instances, not an exhaustive list. That remains the historical live
finding until the remediation is promoted; the current source replaces shared-secret-only identity
on those routes with the scoped delegation described below. State the architecture truth, never a
competitive absolute.

**Implemented locally; operational proof remains.**

1. **Read-side confused deputy remediation.** Migration 119, the hash-only workload registry,
   issuer/verifier, route policy, and Graph/Jarvis middleware now require a one-time signed grant
   for machine-to-user-data calls. The verifier derives the user from signed claims, rejects victim
   headers, and binds method, path, body, task, audience, scope, expiry, workload lifecycle,
   revocation, and replay. `legacy` remains the rollout default so deployment cannot silently strand
   callers. The remaining work is the documented migration 119 rollout: register callers, observe
   shadow traffic, canary `enforce`, rotate the fleet secret, and retain the mandatory live
   PostgreSQL proof. See [workload delegation](../security/workload-delegation.md).
2. **Prompt and memory containment remediation.** `prompt-containment.ts` now fences ticket,
   handover, tool/page, prior-agent, and unreviewed-memory content as bounded data and appends a
   deterministic server authority binding. The local and bot-node paths share that builder; the
   any-bot runtime also refuses tools outside the server-resolved allowlist. Migration 117 and the
   memory lifecycle preserve provenance and exact-digest operator promotion, with adversarial
   regression coverage in `prompt-memory-containment.spec.ts` and its companion runtime/lifecycle
   suites. Deployment must apply migration 117, and the real/wrapped-PostgreSQL two-owner proof in
   the regression audit remains required before that database boundary is called operationally
   closed. [SECURITY-HARDENING.md](../security/SECURITY-HARDENING.md) §4.8 remains the status home.

**What becomes easier.** The deployed credential-minting claim is demonstrable rather than
aspirational: *"a compromised bot can no longer mint another user's credentials — we tested it by
compromising one."* The stronger claim — that a machine caller cannot become another user on the
delegated read paths — remains a source-level result until the migration 119 enforcement rollout
and adversarial live proof are recorded. **What becomes harder.** Every new bot capability must ask
"what deterministic boundary bounds this if the model is fully fooled?" before it ships, not after.
