# ADR-122: The model is an untrusted principal — deterministic authority lives outside the LLM

## Status
Accepted — 2026-08-01. Related: ADR-056 (ticketed data-access broker), ADR-058 (life-graph
steward), ADR-076 (platform RLS tenancy), ADR-042 (connector token isolation).

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
graph + jarvis as confirmed instances, not an exhaustive list. This is inherent to the shared
fleet `SWARM_SERVICE_SECRET` + trusted-header design and is tracked as open below. State the
architecture truth, never a competitive absolute.

**Still open (tracked, not solved by this ADR).**

1. **Read-side confused deputy on the trusted-service routes.** Because every bot holds the
   fleet `SWARM_SERVICE_SECRET`, a prompt-injected bot can assert an *arbitrary* victim sub
   (not just the user it is serving) and read that user's data on `serviceSecretOr` read routes
   — confirmed live on `/api/graph` and `/api/jarvis` (`/history`, `/tasks`, `/overview`). This
   is a read-only exposure (no writes, no credential minting — the PAT takeover path is closed),
   and it is partly inherent to the trusted-service pattern that lets a bot serve a user. The
   durable mitigation is the one flagged during the pentest: **per-bot service secrets** plus
   tighter caller-scoping, so a given bot can only assert the sub(s) it is actually serving.
   This is a hardening item (per-bot secrets), not yet scheduled.
2. **No untrusted-content fencing on the ticket-dispatch path.** `assemblePromptForAnyBot` joins
   persona, org memory, handovers and the raw ticket body at one trust level, and
   `SwarmMemoryService` re-injects stored agent output into later prompts as authoritative
   guidance, so swarm memory is **wormable** (one injected run can seed future tickets). There
   are no adversarial-prompt regression tests yet. The in-tree fence pattern to lift is
   `jarvis-orchestrator.ts` (untrusted-data preamble + trust-split fencing + length cap +
   deterministic server-side re-binding). Tracked in
   [SECURITY-HARDENING.md](../security/SECURITY-HARDENING.md) §4.8, the single home for status.

**What becomes easier.** The security pitch is now demonstrable rather than aspirational — but
scoped to what was proven: *"a compromised bot can no longer mint another user's credentials — we
tested it by compromising one."* It cannot yet claim "cannot become another user": the read-side
confused deputy above is an open cross-user *read* on the trusted-service routes, so the honest
claim pairs the closed credential-takeover with the still-open read exposure. **What becomes
harder.** Every new bot capability must ask "what deterministic boundary bounds this if the model
is fully fooled?" before it ships, not after.
