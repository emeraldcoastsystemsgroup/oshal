<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Edge agent architecture — real swarm bot running outside Docker via Headscale VPN
-->

# Edge Agent Architecture

## The Model

The edge agent is a **real swarm bot** that runs on a local Mac or PC, outside of Docker.
It connects directly to the same Redis the swarm uses, via a private VPN (Headscale/Tailscale).
It is indistinguishable from a Docker bot from the swarm's perspective.

```
 Local Machine (Mac/PC)                        AWS (or any host)
 ─────────────────────────────                 ─────────────────────────────
 scripts/edge-agent.ts                         OSHAL swarm (Docker)
   │                                              │
   ├── RedisMeshTransport                         ├── Redis
   │     └──[Headscale VPN]──────────────────────▶│   oshal:mesh:*
   │                                              │   oshal:runtime-agent:*
   ├── AgentRuntimeRegistryService                │
   │     └──[same Redis]────────────────────────▶ │
   │                                              │
   └── McpStdioClient                            Cockpit dashboard shows
         └── local MCP process (stdio)           edge agent automatically
               (filesystem, browser, etc.)       via AgentRuntimeRegistryService
```

## What Headscale/Tailscale Provides

Headscale is the self-hosted version of the Tailscale coordination server.
Once the local machine joins the Headscale network, it gets a VPN IP (e.g. `100.x.x.x`).
Redis on AWS is exposed on its VPN IP. The edge agent sets `REDIS_URL=redis://100.x.x.x:6379`.

**Bot-to-bot messaging** also uses this network — Redis Streams are the transport layer for
the mesh, so bot-to-bot comms go through the same Redis.

## How It Registers

1. `AgentRuntimeRegistryService.upsertAgent()` writes `oshal:runtime-agent:{agentId}` with 90s TTL
2. Every 30s, the heartbeat renews the TTL
3. The cockpit's `bot-registry-routes.ts` merges dynamic runtime entries with static bot definitions
4. The edge agent appears in the bot list with `isDynamic: true`

## How the Swarm Reaches the Edge Agent

The swarm (PM bot, orchestrator) can route tasks to the edge agent by writing to
`oshal:mesh:agent.{AGENT_ID}`. The edge agent's `SwarmAgentWorker` polls that channel
every 1s via XREADGROUP.

Payload convention for MCP tool calls:
```json
{
  "mcpTool": "read_file",
  "mcpArgs": { "path": "/Users/me/project/file.txt" }
}
```

For tool discovery:
```json
{ "intent": "mcp.list-tools" }
```

## Running the Edge Agent

```bash
# Point at the remote swarm Redis over VPN
export REDIS_URL=redis://100.64.0.2:6379
export AGENT_ID=<stable-uuid>          # generate once with: node -e "console.log(require('crypto').randomUUID())"
export BOT_NAME=my-macbook
export BOT_ROLE=edge/local-executor

# Optional: attach a local MCP server (filesystem example)
export MCP_COMMAND=npx
export MCP_ARGS='["@modelcontextprotocol/server-filesystem", "/Users/me/projects"]'

npm run edge-agent:start
```

The optional local web cockpit binds to `127.0.0.1` by default and generates a fresh
high-entropy access token at startup. Open the complete URL printed in the terminal. Its MCP
process, if needed, must be configured before cockpit startup with `EDGE_AGENT_MCP_COMMAND` and
the JSON-array `EDGE_AGENT_MCP_ARGS`; the HTTP API cannot select an executable. To expose the
cockpit on a trusted private network, set both `EDGE_AGENT_HOST` and an explicit
`EDGE_AGENT_TOKEN`; startup fails closed when a non-loopback host has no configured token.

## Relationship to `remote-client` (Codex work)

The `src/features/remote-client/` directory contains an HTTP-polling approach built by
Codex on 2026-03-28. It is NOT the canonical edge agent pattern — it uses an in-memory
task queue and HTTP polling instead of direct Redis.

The `scripts/edge-agent.ts` (written 2026-03-28) is the correct implementation.
The Codex remote-client code remains in place as a bridge option for restricted networks
where direct Redis TCP is not possible.

## Local Cockpit (optional)

If you want a local cockpit pointing at the remote swarm, run OSHAL locally with:
```bash
REDIS_URL=redis://100.64.0.2:6379 \
DATABASE_URL=postgresql://... \   # or skip for Redis-only mode
npm run start:local
```

All swarm state lives in Redis and Postgres, so a local OSHAL instance sees the same data.
