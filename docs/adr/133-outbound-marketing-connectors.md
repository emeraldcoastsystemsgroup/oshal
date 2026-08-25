# ADR-133: Outbound marketing channels ride connector actions and fixed operations, broker-only

Status: Accepted (2026-08-23) — overnight decision recorded for operator review; companion to
[ADR-131](131-marketing-engine-package.md).

## Context

The marketing engine needs outbound rails (social posts, email) and metrics reads (Search
Console). House rules: connector credentials are consumed only inside schema-bounded deterministic
operations (ADR-036/038); write actions resolve credentials broker-only with a fail-closed audit
trail (the action executor); "no connectors to nowhere". As-built facts that bound the design:
declarative spec auth is static (bearer/basic/apiKey) — a token **exchange** (Bluesky's AT-proto
`createSession`) is not expressible; per-user pasted tokens require a `PROVIDERS` registry entry
plus an account-verification row/branch; OAuth scopes are fixed at connect time by the registry
(`GOOGLE_CONNECT_SCOPES` env-overridable), so new Google scopes mean reconnect.

## Decision

Channel by channel, smallest sanctioned mechanism that is real end-to-end:

| Channel | Mechanism | Core change |
|---|---|---|
| LinkedIn | existing `linkedin.yaml` `create-post` action via `runConnectorAction` | none |
| Mastodon | new `create-status` **action** on the existing spec (high risk, approval-required); instance URL stays the deployment-level `MASTODON_BASE_URL` | spec edit only |
| Bluesky | **fixed server operation** in the package (`createSession` → `createRecord`, strict `identifier:app-password` parse, 15s timeouts, secret never logged/env'd/returned — the twilio-sms-operation shape) | `bluesky` token `PROVIDERS` entry + bespoke verify branch (kalshi precedent: validation IS a real authenticated call) |
| Email (transactional/lifecycle) | new `resend.yaml` spec: read resources + `send-email` action (high risk, approval-required); sender address from `MARKETING_EMAIL_FROM`, no default | new spec + `resend` token `PROVIDERS` entry + `GENERIC_VERIFY` row |
| Search Console (read) | new `google-search-console.yaml` with `credProvider: google` — consumes the user's one Google connection | `GOOGLE_CONNECT_SCOPES` env gains `webmasters.readonly` (config, not code); users reconnect Google once |
| X / Facebook Pages | **not duplicated** — Switchboard/compose remains the desk (X posting additionally awaits the operator's pay-per-use API billing decision) | none |

Cross-cutting rules: every write is 428-confirm-gated at the executor **and** consent-gated by
ADR-131's channel authorization row before the executor is even called; package code invokes
actions in-process via `runConnectorAction` + `resolveConnectorActionCreds` (broker-only, no env
fallback, fail-closed audit rows in `connector_action_audit`); read-tier creds may fall back to
`CONNECTOR_*` operator env (metrics only, never writes).

## Consequences

- Two small core src edits (provider registry + account lookup) ship with this change and need a
  core deploy; connector spec YAMLs hot-load from the bind-mounted `swarm-apps/` tree.
- Morning setup per channel is: create/collect the credential, paste it on the connector card (or
  complete OAuth), flip the channel's consent toggle — the runbook walks each one.
- Bluesky/Resend verification performs a real authenticated call at paste time, so a bad credential
  is rejected immediately rather than failing at first publish.
- Per-user Mastodon instances (beyond the deployment default) and X pay-per-use posting are
  recorded follow-ups in BACKLOG, not silently absent.
- A future ads-operator (P3) extends this same pattern: ad-platform mutations as deterministic
  provider intents behind the budget-ledger approval flow — no new architecture required.
