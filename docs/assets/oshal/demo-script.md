# OSHAL Demo Script

## Demo Goal

Show that OSHAL is a live swarm application framework, not a static starter repo.

The demo proves that new tools and new bot containers can be inserted into a running swarm and discovered by the platform without a rebuild.

## Setup

Start from a healthy local stack:

```powershell
docker compose -f docker-compose.oshal-local.yml ps
Invoke-RestMethod http://127.0.0.1:35457/health
docker exec oshal-local-db pg_isready -U oshal -d oshal
docker exec oshal-local-redis redis-cli PING
```

Expected:

- API healthy.
- Postgres accepting connections.
- Redis returns `PONG`.
- No leftover E2E/stress agents or tools.

## Opening Talk Track

"OSHAL is a swarm framework. I can define apps, register tools, create agents, launch runtime containers, and watch the swarm discover those workers live. This is not a chatbot script. This is runtime infrastructure for agent-backed applications."

## Moment 1: Establish The Platform

Show:

```powershell
docker compose -f docker-compose.oshal-local.yml ps
```

Say:

"These are the standing platform services: API, Postgres, Redis, Chroma, and the baseline bot-node swarm. The controller is separate from the workers. Workers communicate over Redis mesh and publish runtime heartbeats."

## Moment 2: Run The Repeatable Baseline

Command:

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

Say:

"This test registers a runtime tool, creates an agent, assigns the tool, launches a dynamic bot container, verifies health, verifies Redis heartbeat metadata, verifies registry visibility, verifies mesh subscriptions, and cleans itself up."

## Moment 3: Push It

Run the aggressive pass script:

```powershell
$env:OSHAL_E2E_BASE_URL='http://127.0.0.1:35457'
$env:DYNAMIC_INSERTION_COUNT='18'
$env:DYNAMIC_INSERTION_CONCURRENCY='3'
npm run benchmark:dynamic-insertion
```

Expected proof points:

```text
18 tools registered
18 agents created
18 launch calls returned success
18 containers healthy
18 heartbeats profile-backed
18 registry entries and mesh subscriptions verified
cleanup completed
```

Say:

"This is the money shot. Eighteen new executable tools. Eighteen new agents. Eighteen new containers. All inserted into a live swarm and discoverable in roughly 52 seconds."

## Moment 4: Show No Residue

Commands:

```powershell
docker exec oshal-local-db psql -U oshal -d oshal -At -c "SELECT 'agents=' || count(*) FROM agents WHERE name LIKE 'e2e-dynamic-bot-%' OR name LIKE 'stress-dynamic-bot-%'; SELECT 'tools=' || count(*) FROM tools WHERE name LIKE 'e2e-runtime-tool-%' OR name LIKE 'stress-runtime-tool-%'; SELECT 'runtime_executors=' || count(*) FROM runtime_tool_executors WHERE tool_name LIKE 'e2e-runtime-tool-%' OR tool_name LIKE 'stress-runtime-tool-%';"

Test-Path docker-compose.dynamic.yml

docker exec oshal-local-redis redis-cli KEYS "oshal:mesh:agent.*dynamic-bot*"
```

Expected:

```text
agents=0
tools=0
runtime_executors=0
False
```

Say:

"The lifecycle is repeatable. We are not leaving junk in the registry, database, Redis, file system, or Docker."

## Close

"The validated claim is not that every future feature is done. The validated claim is sharper: OSHAL can dynamically insert tool-backed bot runtime capacity into a live swarm and prove it through health, heartbeat, registry, mesh, and cleanup."

## Hard Questions

**Is this a full LLM benchmark?**

No. This is platform insertion and runtime discovery. Full task-execution benchmarking comes next and needs valid provider credentials.

**Is this just Docker Compose tricks?**

No. Compose is the local launch surface. The important platform behavior is the framework chain: API creation, tool assignment, persona generation, runtime launch, Redis heartbeat, registry overlay, and mesh subscription.

**Can Workflow Studio publish executable workflows?**

Not yet. Runtime workflows currently come from manifests.

**Is the one-call create-and-start flow done?**

Not yet. The validated path is two-step: create agent, then launch agent.

**Why should I care?**

Because runtime expansion is the bridge between an agent demo and an agent platform.
