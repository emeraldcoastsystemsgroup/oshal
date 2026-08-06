# Connectors hub and caller isolation (as built)

OSHAL keeps concurrent callers from selecting or decrypting each other's external
accounts across two independent boundaries:

- **Connector identity** answers which external account an operation may use.
- **Task context** answers which conversation and workspace an operation may use.

A bot is normally a shared process, so process separation is not the control. The
caller subject, tenant membership, selected connection, task owner, database role,
and bounded credential consumer are the controls. The SaaS tenant layer in
[ADR-035](../adr/035-multi-tenant-saas-foundation.md) builds on this model.

Documentation status: reconciled with executable behavior on 2026-08-05 by
`maintainer@emeraldcoastsystemsgroup.com`.

## Independent isolation keys

| Boundary | Authoritative keys | Protects |
|---|---|---|
| Connector identity | exact OIDC `user_sub`, tenant membership, `connection_id` | whose Google, Microsoft, social, home, finance, or other account acts |
| Task context | exact task owner plus `taskId` | whose messages, task state, and workspace a request sees |

Both boundaries must hold. Possessing a task ID does not authorize a connector,
and possessing a connector grant does not authorize another caller's task.

## Connector identity and account selection

[connectors-routes.ts](../../src/app/routes/connectors-routes.ts) implements signed-in
incremental connector authorization separately from login.

- Caller identity comes from the validated session subject. A client-supplied
  `user_sub` is not an ownership source.
- A personal connection has `tenant_id IS NULL` and is owned by `user_sub`. A
  shared connection has a tenant ID, records the grantor in `connected_by_sub`,
  and is usable only by a current tenant member.
- A caller may connect several accounts for one provider. Migration
  [101-connections-multi-account.sql](../../scripts/migrations/101-connections-multi-account.sql)
  uses per-account partial unique indexes rather than the retired
  `UNIQUE (user_sub, provider)` constraint.
- Resolution first applies an explicit connection, label, email, or ownership-scope
  selector. A named selector that misses returns no credential. Without a selector,
  the marked default wins; the final fallback is stable and never depends on token
  refresh recency.
- Personal disconnects are constrained by both connection ID and the session
  subject. Shared-connection administration separately checks tenant membership
  and role.

The lookup path is `getValidAccessToken` -> `resolveConnectionRow` ->
`accessibleConnections`. Its personal arm binds the exact caller subject, and its
shared arm is limited to tenant IDs read from that caller's memberships. The same
selected row supplies the DEK owner used for decryption.

### Encryption and database enforcement

Connector tokens use AES-256-GCM. Per-user envelope encryption is **on by default**;
`OSHAL_ENVELOPE_CRYPTO=false` is an explicit rollback. Each owner has a wrapped DEK,
legacy blobs remain format-readable during migration, and every encryption mode
without `SESSION_SECRET` fails loudly instead of deriving a repository-known key.

Envelope encryption limits key compromise, but it does not repair a bad ownership
query: the selected row determines whose DEK is unwrapped. The SQL predicate and
database policy are therefore both load-bearing. Migration
[060-platform-rls-tenancy.sql](../../scripts/migrations/060-platform-rls-tenancy.sql)
enables and forces RLS for `oshal_connections`; deployments must run the application
with the least-privilege `oshal_app` role so a query regression cannot bypass the
policy through owner or superuser privilege.

## Bounded credential broker

[connector-token-broker.ts](../../src/app/routes/connector-token-broker.ts) may
resolve a credential only for an authenticated owner's selected account and an
explicit fixed server operation or validated provider intent. The consumer must use
the value at that deterministic operation boundary.

Raw connector values must never enter a model prompt, generic CLI environment,
generic bot request, or task workspace. There is no supported bot-side database
decryption fallback. A disabled, missing, expired, selector-mismatched, or
unrefreshable connection produces an unavailable/not-connected result rather than
silently selecting another user's account. Multi-account calls should supply an
explicit selector; an omitted selector uses the marked default and emits an
ambiguity warning when several accounts exist.

The controller carries the initiating task owner into dispatch. On the reviewed
provider-intent lane, the target validates the schema-bounded intent and consumes
the matching credential before any persona, memory, task, or model input is built.
Generic prompts cannot ask the broker for arbitrary providers.

## Task and workspace context

Conversation and task stores scope reads and writes by task ID plus the persisted
owner. The bot-node execution boundary verifies that an existing task's owner matches
the delegated caller before reuse; a new task is stamped with that caller. Workspaces
are task-scoped, but directory naming alone is not treated as authorization.

Multi-agent ticket work intentionally shares one ticket workspace among collaborating
agents. That is not permission for another human subject to reuse the task. Any future
human shared-conversation feature must introduce an explicit membership model and
serialized shared-state behavior before relaxing owner equality.

## Executable guards

The current regression evidence includes:

- [connector-token-lookup-scope.spec.ts](../../tests/unit/connector-token-lookup-scope.spec.ts)
  pins the caller-bound personal/shared SQL inputs and real legacy/v2 decrypt paths.
- [connector-multi-account.spec.ts](../../tests/unit/connector-multi-account.spec.ts)
  proves account coexistence, deterministic selection, exact selector misses, and
  owner-scoped disconnect behavior.
- [connector-token-crypto.spec.ts](../../tests/connector-token-crypto.spec.ts)
  proves default-on envelopes, per-user DEKs, legacy compatibility, and fail-loud
  master-key handling.
- [task-message-isolation-routes.spec.ts](../../tests/unit/task-message-isolation-routes.spec.ts)
  guards task-owner routing and the bounded manifest-worker connector scope.
- [prompt-memory-containment.spec.ts](../../tests/unit/prompt-memory-containment.spec.ts)
  guards the provider-intent-before-prompt boundary and exact owner propagation.
- [rls-two-role-isolation-live.spec.ts](../../tests/rls-two-role-isolation-live.spec.ts)
  and [rls-core-table-coverage-live.spec.ts](../../tests/rls-core-table-coverage-live.spec.ts)
  are the real-role release gates for enforced RLS posture.

Unit tests that use a fake pool establish query and routing behavior; they do not
replace the real Postgres-role proof. A release claiming database isolation must run
the live RLS gates against the deployment role.
