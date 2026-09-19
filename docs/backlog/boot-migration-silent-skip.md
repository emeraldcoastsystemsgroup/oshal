# A healthy api can be serving a stale schema

**Observed live, 2026-09-19, on the operator box.** Not a hypothesis — the log line is below.

## What happened

The api container started while Postgres was still coming up. The container entrypoint's wait loop
passed, the app booted, and the boot bootstrap chain — the one that applies `scripts/migrations/*.sql`
— failed on its very first pool acquire:

```
15:51:00.612  level=50  module=composition-root
  msg="Failed to initialize tool registry database"
  err.message="timeout exceeded when trying to connect"   (pg-pool/index.js:45)
```

The chain is launched as `void runWithSystemIdentity(() => bootstrapService.applyMigrations()...)`
at `src/app/composition/app-runtime-factory.ts:314`, with a terminal `.catch` that logs the error
and then *deliberately* releases the gated boot consumers so they "proceed and self-heal".

They did proceed. The api reached **healthy**, answered `/health` with 200, completed swarm-app
auto-load (83 apps, 0 failed), and served traffic — with migration 148 never applied. `app_migrations`
stopped at `147-bot-provider-switch.sql`, and `oshal_bot_provider_switch.fallback_order` did not exist.

So the deploy's health gate passed, the parity check would pass, and the feature the deploy existed
to ship was silently absent. Nothing downstream of the catch says "the schema is behind".

## Why this is not just an operator mistake

The trigger here *was* a mistake — infra was stopped and restarted late, which is not what a normal
deploy does. But the trigger is incidental. Any transient inability to acquire a connection during
that one window produces the same end state: a container that is healthy, serving, and running
against a schema older than its own code. A Postgres failover, a pool exhaustion spike, or the
`restore-smoke pg_dump` that has blocked api boot on this box before would all do it.

The self-heal the comment promises covers the *consumers* (autoload, queue manager). It does not
cover the migrations: nothing retries `applyMigrations`, and nothing re-checks it later.

## Done when

1. **A failed migration pass is visible in health, not only in a log line.** `/health` (or the
   readiness surface the deploy gates on) reports degraded — or a named field says migrations did
   not complete — when `applyMigrations` rejected. A deploy must not be able to report success over
   a schema that did not apply. Proven by a spec that rejects the first pool acquire and asserts the
   surface says so.
2. **The pass retries rather than being one-shot.** Either the chain retries on a connection-class
   failure (the same class `pool-connection-errors.ts` already classifies), or a later tick
   re-attempts it. Proven by a spec whose fake pool fails once and succeeds on the retry, asserting
   the migration list is non-empty.
3. **The boot log says which migrations are outstanding when the pass fails**, so the operator sees
   `148-provider-fallback-order.sql` by name rather than having to query `app_migrations` by hand.

## Scope note

Do NOT make the api refuse to boot on a failed migration pass. The current behaviour — serve, log,
let consumers self-heal — is deliberate and is the right call for a box whose database may come back
a moment later. What is missing is that the *deploy* and the *operator* are told, rather than the
failure being visible only to whoever greps the log for `level=50`.
