# ADR-024: Bot Container Lifecycle via Docker Compose

## Status
Accepted — 2026-03-27

## Context
Phase 12 Track B required that enabling/disabling a bot in the cockpit also start/stop its Docker container. Two options were considered:

1. **Docker Engine API directly** (`dockerode` or `docker` SDK) — richer control, ability to inspect container state at the image level, but requires the Docker socket to be mounted and adds a dependency.

2. **`docker compose` CLI subprocess** — thin wrapper over the existing `docker-compose.swarm-local.yml` file that already defines all bot services. No new dependency; compose handles network/volume attachment automatically; same tool operators use manually.

The swarm is already defined entirely in `docker-compose.swarm-local.yml`. The agentId slug (e.g. `project-manager`) is the same value as the Docker compose service name. There is no mapping layer needed.

## Decision

Use `docker compose` as a subprocess via Node.js `child_process.exec` (promisified). The `BotContainerSpawnerService` wraps three operations:

- `startBot(serviceName)` → `docker compose up -d --no-deps <serviceName>`
- `stopBot(serviceName)` → `docker compose stop <serviceName>`
- `getContainerStatus(serviceName)` → `docker compose ps --format json <serviceName>`

The compose file path resolves from the `COMPOSE_FILE` env var, falling back to `docker-compose.swarm-local.yml` at `process.cwd()`. The project name resolves from `COMPOSE_PROJECT_NAME`, defaulting to `oshal`. Both are overridable for test environments without code changes.

**Status/container decoupling:** Container operation failure does NOT roll back the DB status. The operator's intent (enable/disable) is always persisted. The container operation is best-effort and its result is surfaced in the API response `container` field. This avoids a confusing state where the DB and container disagree due to a transient Docker error.

**Timeout policy:** `up`/`stop` operations have a 90-second timeout. `ps` has a 10-second timeout. If exceeded, the operation returns `{ success: false }` and logs a warning.

## Consequences

- Requires Docker to be available on the host where the control-plane API runs (true in all deployment targets).
- The Docker socket does not need to be mounted — `docker compose` is a CLI call, not an API call.
- Test environments can override `COMPOSE_FILE` to point at a minimal test compose file without any real services.
- The `--no-deps` flag on `up` prevents accidentally starting dependency containers that are not part of the bot definition.
- Container drift (manual `docker compose stop` outside the API) will cause the DB status and actual container state to diverge. A future `sync-status` job can reconcile using `getContainerStatus()`.
