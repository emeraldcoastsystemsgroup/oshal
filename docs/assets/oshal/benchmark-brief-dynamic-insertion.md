# Benchmark Brief: Dynamic Tool And Bot Insertion

## Benchmark Name

Dynamic Tool And Bot Insertion Benchmark

## Purpose

Prove that OSHAL can expand a running local swarm by adding executable tools and dynamic bot containers without rebuilding or restarting the platform.

This benchmark validates platform insertion, discovery, and cleanup. It is not a model-quality benchmark.

The script supports up to 18 dynamic bots by default. Use `DYNAMIC_INSERTION_CONCURRENCY` to control how many API/container operations run at once.

## Environment

- Stack: `docker-compose.oshal-local.yml`
- Image: `oshal-bot:latest`
- API base URL: `http://127.0.0.1:35457`
- Postgres container: `oshal-local-db`
- Redis container: `oshal-local-redis`
- Runtime: Docker Desktop Linux containers

## Baseline Test

Command:

```powershell
$env:RUN_DYNAMIC_AGENT_E2E='true'
$env:OSHAL_E2E_BASE_URL='http://127.0.0.1:35457'
$env:PLAYWRIGHT_REUSE_SERVER='true'
$env:PLAYWRIGHT_PORT='35457'
npx playwright test tests/dynamic-agent-live-e2e.spec.ts --reporter=line
```

Result:

```text
1 passed
```

## Aggressive Pass

Command:

```powershell
$env:OSHAL_E2E_BASE_URL='http://127.0.0.1:35457'
$env:DYNAMIC_INSERTION_COUNT='18'
$env:DYNAMIC_INSERTION_CONCURRENCY='3'
npm run benchmark:dynamic-insertion
```

Scenario:

- Register 18 runtime CLI tools.
- Create 18 dynamic agents.
- Persist 18 per-agent tool assignments.
- Generate 18 persona YAML files.
- Launch 18 dynamic bot-node containers.
- Verify container state and `/health`.
- Verify Redis runtime heartbeat metadata.
- Verify bot registry overlay.
- Verify mesh/direct-channel subscriptions.
- Clean all generated artifacts.

Observed result:

```text
runId=20260510032043
count=18
concurrency=3
durationMs=51845
status=PASS
```

## Pass Criteria

The benchmark passes only when all of the following are true:

- API `/health` returns OK.
- Runtime executor rows exist for all registered tools.
- Dynamic agent rows exist for all created bots.
- Tool assignments are persisted as `toolName:auto`.
- Persona YAML files exist and include expected capabilities.
- `docker-compose.dynamic.yml` includes every dynamic service.
- Every dynamic container reaches `running`.
- Every dynamic container returns OK from `http://127.0.0.1:5000/health`.
- Every dynamic agent publishes `oshal:runtime-agent:<agentId>`.
- Heartbeat includes correct `agentName`, `status`, `role`, `capabilities`, and `internalEndpointUrl`.
- `/api/swarm/bots/registry` includes every dynamic bot.
- Bot logs show subscriptions for direct ID channel, direct name channel, and `swarm.capabilities`.
- Cleanup leaves no stress/E2E agents, tools, runtime executor rows, dynamic compose file, persona files, mesh keys, or containers.

## Cleanup Verification

Post-run checks returned:

```text
agents=0
tools=0
runtime_executors=0
docker-compose.dynamic.yml=false
dynamic mesh keys=0
dynamic containers=0
```

## What This Proves

OSHAL can dynamically insert new agent runtime capacity into an already-running swarm:

- Tool metadata and executor registration are data-driven.
- Agent creation is API-driven.
- Bot personas are generated and mounted correctly.
- Dynamic compose services can launch bot-node workers.
- New bots publish routing metadata into Redis.
- New bots are visible to the runtime registry.
- New bots subscribe to the mesh channels needed for targeted work.
- The lifecycle can be tested repeatedly without residue.

## What This Does Not Prove Yet

This benchmark does not prove:

- Real LLM task quality.
- Multi-step work-item completion.
- Cost/token correctness.
- Workflow Studio publish-to-runtime.
- Generic node-pool hot-loading.
- Remote Cline/client production readiness.

Those require the full work-execution benchmark with valid provider credentials.

## Benchmark Claim

OSHAL dynamic platform insertion is benchmark-ready.
