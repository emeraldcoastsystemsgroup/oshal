# Security incident: bot prompt-injection / credential misuse

Detection → containment → eradication → recovery for the case where a bot is suspected of
having been prompt-injected into crossing a trust boundary (minting or using another user's
credentials, running an unapproved tool, or reaching another user's data). The trust-boundary
model this defends is [ADR-122](../adr/122-model-is-untrusted-principal.md); the reference
incident is the PAT cross-user takeover closed by PR #83
([SECURITY-HARDENING.md](../security/SECURITY-HARDENING.md) item 10).

This runbook is deterministic-boundary-first: the model can always be talked into trying, so
detection and containment key off the **boundaries** (tokens, DB role, tool approval, route
auth), never off "was the persona convinced."

## 1. Detection — what a crossed boundary looks like

- **Anomalous PAT mints.** Query the token store for unexpected owners or long-lived tokens:
  ```sql
  SELECT id, user_sub, label, created_at, expires_at, last_used_at
    FROM oshal_cli_tokens
   WHERE revoked_at IS NULL
     AND (expires_at IS NULL OR created_at > NOW() - INTERVAL '2 days')
   ORDER BY created_at DESC;
  ```
  Signals: a **non-expiring** token minted recently (post-PR-#83, only a cockpit session mints
  those — a bootstrap/`--secret` mint should carry an `expires_at`); a token whose `user_sub`
  is a user who was not at a keyboard; a mint immediately followed by `last_used_at` activity
  from a bot container.
- **`whoami`-returns-victim signature.** The takeover tell is a request chain where a bot
  context resolves to a *different* user's `sub`. Grep the api logs for `cli token minted` with
  `bootstrap: true` and a `sub` that is not an operator.
- **Unexpected `POST /api/cli-tokens` from a bot.** Bots have no business minting tokens; a mint
  sourced from a bot container's network identity is the event.
- **Tool-approval denials that shouldn't happen.** A spike of "requires approval" on
  `execute_command` from the unattended path can indicate injected content trying to run shell
  (the gate is holding, but the *attempts* are the signal). Source: `tool-approval-policy.js`.
- **Route-auth 401s from inside the mesh** on `/api/content`, `/api/linkedin-assistant`,
  `/api/graph` — a bot probing routes it should reach only as a scoped caller.

## 2. Containment — stop the bleeding without a full teardown

1. **Revoke suspect tokens** immediately: `swarm-cli tokens revoke <id>` (or
   `UPDATE oshal_cli_tokens SET revoked_at = NOW() WHERE id = $1`). A revoked PAT authenticates
   on **no** route on its next use.
2. **If the fleet service secret may have been abused**, rotate `SWARM_SERVICE_SECRET`
   fleet-wide, then recreate the api and bots so every container picks up the new value
   (containers cache env at start — see the comms-bot note in memory). Old bootstrap logins
   will need a re-login.
3. **Quarantine the suspect bot** — scale its container to zero or stop it. Because bots run the
   least-privilege `oshal_bot` DB role (NOSUPERUSER/NOBYPASSRLS), a stopped bot cannot have
   reached another user's rows via SQL; the exposure to chase is what it did through *scoped API
   calls* while it held a bad token.
4. **Do not** "fix" a tripped guard by loosening it (e.g. renaming the `commandExecution`
   approval key to match callers) — that reopens the hole. See the key-mismatch note in
   `tool-approval-policy.js`.

## 3. Eradication — find how content reached the model

Identify the **injection vector**: which untrusted input did the bot consume before it
misbehaved? Candidates, in order of likelihood: a ticket title/body, a fetched web/news page,
a tool result, an email body, a RAG/`SwarmMemoryService` entry (memory is **wormable** —
a poisoned row re-injects into future tickets, so one incident can recur until the row is
purged). Purge the poisoned memory/RAG rows before recovery, or the next dispatch re-triggers.

## 4. Recovery + verify

- Confirm the boundary is closed by **re-running the relevant exploit** against the live stack,
  the same way PR #83 was verified: from a plain bot container, attempt the crossing and assert
  the deterministic denial (e.g. a bootstrap mint for a non-operator sub returns
  `403 operator_required`).
- Confirm no residual valid tokens for the affected user(s): the revoke query returns them
  `revoked`.
- File the incident with its vector and boundary in
  [operations/bug-log.md](../operations/bug-log.md), and add a regression guard if the crossing
  had none (guard-per-fix).

## 5. Preventable-by-design checklist (post-incident)

- New outward/irreversible bot action → gated by out-of-band env or operator identity, not by
  the persona.
- New route touching another user's data / running an LLM → behind `requiresAuth` (the route-auth
  inventory test catches omissions).
- New untrusted-content sink into a prompt → fenced (the still-open dispatch-path work, ADR-122):
  lift the `jarvis-orchestrator.ts` pattern (untrusted-data preamble + trust-split + cap +
  deterministic server-side re-binding).
