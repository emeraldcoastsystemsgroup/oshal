# Operator Benchmark Runbook

## Goal

Rerun the validated OSHAL dynamic insertion benchmark from a clean local Docker swarm.

## Prerequisites

- Docker Desktop running Linux containers.
- Repo checked out locally.
- `oshal-bot:latest` built from `Dockerfile.oshal`.
- `docker-compose.oshal-local.yml` stack running.
- API reachable at `http://127.0.0.1:35457`.

## Build Image

```powershell
docker build -f Dockerfile.oshal -t oshal-bot:latest .
```

## Start Or Recreate Stack

```powershell
$env:COMPOSE_PROFILES='build'
$env:SWARM_APPS_DIR='./swarm-apps-build'
$env:UI_PROFILE='oshal-framework'
$env:OSHAL_BOT_IMAGE='oshal-bot:latest'
docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --remove-orphans
```

## Verify Platform Health

```powershell
docker compose -f docker-compose.oshal-local.yml ps
Invoke-RestMethod http://127.0.0.1:35457/health
docker exec oshal-local-db pg_isready -U oshal -d oshal
docker exec oshal-local-redis redis-cli PING
```

Expected:

```text
API status ok
Postgres accepting connections
Redis PONG
Core containers healthy
```

## Verify Clean Benchmark State

```powershell
docker exec oshal-local-db psql -U oshal -d oshal -At -c "SELECT 'agents=' || count(*) FROM agents WHERE name LIKE 'e2e-dynamic-bot-%' OR name LIKE 'stress-dynamic-bot-%'; SELECT 'tools=' || count(*) FROM tools WHERE name LIKE 'e2e-runtime-tool-%' OR name LIKE 'stress-runtime-tool-%'; SELECT 'runtime_executors=' || count(*) FROM runtime_tool_executors WHERE tool_name LIKE 'e2e-runtime-tool-%' OR tool_name LIKE 'stress-runtime-tool-%';"
```

Expected:

```text
agents=0
tools=0
runtime_executors=0
```

## Run Repeatable Baseline E2E

```powershell
$env:RUN_DYNAMIC_AGENT_E2E='true'
$env:OSHAL_E2E_BASE_URL='http://127.0.0.1:35457'
$env:PLAYWRIGHT_REUSE_SERVER='true'
$env:PLAYWRIGHT_PORT='35457'
npx playwright test tests/dynamic-agent-live-e2e.spec.ts --reporter=line
```

Expected:

```text
1 passed
```

## Run Framework Contract Suite

```powershell
npm run test:framework-contracts
```

Expected:

```text
10 passed
```

This suite covers runtime tool execution, prompt exposure, dynamic compose generation, remote-client config/registry/task/heartbeat contracts, live stdio MCP task execution, Workflow Studio compile-preview boundaries, and manifest workflow registration/override protection.

## Aggressive Scripted Pass

The aggressive pass is now a repo script:

```powershell
$env:OSHAL_E2E_BASE_URL='http://127.0.0.1:35457'
$env:DYNAMIC_INSERTION_COUNT='18'
$env:DYNAMIC_INSERTION_CONCURRENCY='3'
npm run benchmark:dynamic-insertion
```

The latest aggressive validation used 18 dynamic tools and 18 dynamic bots.

Pass criteria:

- 18 runtime tools registered.
- 18 dynamic agents created.
- 18 persona files generated.
- 18 tool assignments persisted.
- 18 dynamic bot containers launched.
- 18 bot health endpoints returned OK.
- 18 profile-backed Redis heartbeats observed.
- 18 bot registry entries observed.
- 18 mesh subscription sets observed.
- Cleanup completed.

Observed result on latest run:

```text
runId=20260510032043
count=18
concurrency=3
durationMs=51845
status=PASS
```

Useful script options:

```text
DYNAMIC_INSERTION_COUNT=1..18
DYNAMIC_INSERTION_CONCURRENCY=1..18
DYNAMIC_INSERTION_MAX_COUNT=18
DYNAMIC_INSERTION_REQUEST_TIMEOUT_MS=30000
DYNAMIC_INSERTION_REQUEST_RETRY_ATTEMPTS=6
DYNAMIC_INSERTION_REQUEST_RETRY_DELAY_MS=2000
DYNAMIC_INSERTION_DEBUG_LOG_LIMIT=3
OSHAL_E2E_BASE_URL=http://127.0.0.1:35457
KEEP_DYNAMIC_AGENT_ARTIFACTS=true
ALLOW_EXISTING_DYNAMIC_COMPOSE=true
```

## Post-Run Cleanup Verification

```powershell
docker exec oshal-local-db psql -U oshal -d oshal -At -c "SELECT 'agents=' || count(*) FROM agents WHERE name LIKE 'e2e-dynamic-bot-%' OR name LIKE 'stress-dynamic-bot-%'; SELECT 'tools=' || count(*) FROM tools WHERE name LIKE 'e2e-runtime-tool-%' OR name LIKE 'stress-runtime-tool-%'; SELECT 'runtime_executors=' || count(*) FROM runtime_tool_executors WHERE tool_name LIKE 'e2e-runtime-tool-%' OR tool_name LIKE 'stress-runtime-tool-%';"

docker ps --format "{{.Names}}" | Select-String -Pattern "e2e-dynamic-bot|stress-dynamic-bot"

docker exec oshal-local-redis redis-cli KEYS "oshal:mesh:agent.*dynamic-bot*"

Test-Path docker-compose.dynamic.yml

Get-ChildItem ai-lab/bot-personas/e2e-dynamic-bot-*.yaml,ai-lab/bot-personas/stress-dynamic-bot-*.yaml -ErrorAction SilentlyContinue
```

Expected:

```text
agents=0
tools=0
runtime_executors=0
no dynamic containers
no dynamic mesh keys
False
no persona files
```

## Failure Recovery

If a dynamic run fails and keeps artifacts for debugging:

1. Inspect dynamic container logs:

```powershell
docker logs --tail 180 oshal-<dynamic-bot-name>
```

2. Remove dynamic containers:

```powershell
docker rm -f oshal-<dynamic-bot-name>
```

3. Remove generated compose and persona files:

```powershell
Remove-Item docker-compose.dynamic.yml -Force -ErrorAction SilentlyContinue
Remove-Item ai-lab/bot-personas/<dynamic-bot-name>.yaml -Force -ErrorAction SilentlyContinue
```

4. Delete test rows from Postgres if API cleanup failed:

```powershell
docker exec oshal-local-db psql -U oshal -d oshal -c "DELETE FROM runtime_tool_executors WHERE tool_name LIKE 'stress-runtime-tool-%' OR tool_name LIKE 'e2e-runtime-tool-%'; DELETE FROM tools WHERE name LIKE 'stress-runtime-tool-%' OR name LIKE 'e2e-runtime-tool-%'; DELETE FROM agents WHERE name LIKE 'stress-dynamic-bot-%' OR name LIKE 'e2e-dynamic-bot-%';"
```

5. Delete dynamic Redis keys:

```powershell
docker exec oshal-local-redis redis-cli KEYS "oshal:mesh:agent.*dynamic-bot*"
docker exec oshal-local-redis redis-cli KEYS "oshal:runtime-agent:*"
```

Delete only dynamic test keys, not baseline swarm keys.
