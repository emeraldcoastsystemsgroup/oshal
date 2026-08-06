<!--
  CHANGE LOG
  =============================================================================
  SEQ                 | AUTHOR                      | DESCRIPTION
  =============================================================================
  1 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis scheduler report with live verification results, runtime status, and remaining risks
  2 | maintainer@emeraldcoastsystemsgroup.com   | Reconciled the report with owner-scoped schedule ids, manifest-owned job reservations, and the authenticated legacy-execute boundary; retained the dated live evidence unchanged.
-->

# Redis Report

## Scope

This report covers the Redis-backed self-scheduling path in `oshal`, the `agent-scheduler` tool toggle, and the current UI/reporting surface in the standalone chat settings flow.

## Current State

- Redis is part of the runtime stack through `docker-compose.yml` as `redis:7-alpine`.
- The scheduler persists schedule records and next-run indexes in Redis through `RedisScheduleStore`.
- The standalone chat settings modal now includes a **Redis Scheduler Report** block in the Tools panel.
- The `agent-scheduler` tool remains the switch-framework control for self-scheduling capability.
- Schedule execution is now blocked when the `agent-scheduler` tool is `off` for the target bot.
- User-created schedule ids are scoped by exact owner and exact task type. Reusing a task type in a
  second tenant creates a separate record instead of replacing the first tenant's job.
- Manifest-derived `app:` and `app-route:` schedules are lifecycle-owned by reviewed package
  manifests and are immutable through the user API. Workflow-ticket schedules are operator-only.
- The legacy execute callback enforces the same ownership check as the by-id trigger route.
- Bot profile pictures are now uploaded as files and stored in the agent profile record instead of requiring an external URL.

## Live Verification

Verification was rerun on **March 11, 2026** against local Redis on `127.0.0.1:6379`.

### Redis health

- `docker exec oshal-redis redis-cli ping`
- Result: `PONG`

### Scheduler persistence and dispatch

Executed the scheduler service directly against live Redis with a unique key prefix.

Observed result:

- `healthy: true`
- schedule record created in Redis
- schedule listed successfully
- due schedule dispatched successfully
- `executionCount: 1`
- `lastRunAt` populated
- schedule deleted successfully

### Regression tests

Passed:

- `tests/redis-self-scheduling.spec.ts`
- `tests/chat-tools-config-modal.spec.ts` on Playwright port `3460`
- `tests/agent-profile-persistence.spec.ts` on Playwright port `3460`

## Fix Applied During Verification

Live Redis verification exposed a startup race in `RedisScheduleStore`: commands could be issued before `ioredis` reached `ready`, which failed because `enableOfflineQueue` is disabled.

That is now fixed by waiting for Redis readiness before command dispatch.

## UI Coverage

- The chat Tools panel now shows Redis health, runner state, schedule counts, next run, and current `agent-scheduler` toggle state.
- The API runtime iframe copy was tightened so it reads like part of the same settings surface instead of a pasted-in standalone page.
- Bot avatar configuration now uses file upload with DB-backed persistence.

## Remaining Risks

- The `/api/v1/agent` scheduler surface is authenticated and owner-scoped, but any future task
  namespace that dispatches privileged system work must be added to the controller's reservation
  policy before it is exposed to user-authored schedules.
- Multi-replica scheduler locking is still not implemented; current polling is single-process safe, not distributed-safe.
- The report is diagnostic only. There is still no first-class schedule creation/edit UI comparable to the old any-bot scheduling screens.
