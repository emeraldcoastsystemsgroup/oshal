# ADR-105: Write-capable connector actions tier

**Status:** Accepted (2026-07-16) — BUILT + DEPLOYED in the 2026-07-15/16 gap-list build.
Extends `swarm-apps/connector.schema.json` (`actions[]`) + the connector runtime executor;
migration `083-connector-action-audit.sql` (`connector_action_audit`);
route `POST /api/connectors/:id/actions/:action`. Builds on [ADR-065](065-connector-runtime-and-spec.md)
(connector runtime) and [ADR-067](067-connector-marketplace-and-dynamic-tool-loading.md).

## Context

The 306-connector catalog was deliberately **GET-only** (ADR-065) — connectors read your accounts,
they don't act on them. That kept the catalog safe but capped its value at "dashboard over your
data." The single biggest capability multiplier available was turning reads into *audited, gated
writes* — but only if it reused the existing safety rails rather than inventing a parallel
write path per app:

- **Per-user token isolation** (ADR-042) — a write must use the caller's own broker token, never a
  shared or raw secret.
- **Approval doctrine** — the Content Studio ("nothing posts without approval") and the risky-write
  guards (shipped 2026-07-15) already define how a dangerous action gets human sign-off.
- **No connectors to nowhere** — a write action must hit a real, documented partner endpoint.

## Decision

1. **Additive `actions[]` on the connector spec.** Each action declares `{name, method
   (POST/PUT/PATCH/DELETE), urlTemplate, paramsSchema (JSON Schema), riskLevel, approvalRequired,
   description}`. Additive — existing GET-only connectors are untouched and unaffected.
2. **One executor, not per-app writes.** The connector runtime validates params against
   `paramsSchema`, resolves the caller's per-user broker token, and executes the real HTTP call.
   Apps never hand-roll a write.
3. **Gate + audit every write.** `riskLevel ≥ medium` or `approvalRequired` routes through the
   existing tool-approval / risky-write guards; **every** attempt (allowed or blocked) writes a
   `connector_action_audit` row (`user_sub`, connector, action, params hash, status, http status).
4. **Auth-gated, caller-scoped route** `POST /api/connectors/:id/actions/:action`.

## Consequences

- The catalog can now *act* (create a GitHub issue, etc.), not just read — the largest single
  capability jump available, reusing token-broker + approval + audit rather than new machinery.
- **Not yet fully adopted:** the LinkedIn publish path (and its `social-routes` sibling) still uses a
  bespoke `fetch()` rather than routing through this executor — a known follow-up (BACKLOG) so all
  writes share one gate + audit trail.
- Deferred: marketplace surfacing of which connectors expose actions, an audit *read* endpoint, and
  the interactive (428-style) approval UX (BACKLOG).
- Actions are declared per real endpoint only — the "no connectors to nowhere" rule extends to
  "no actions to nowhere."
