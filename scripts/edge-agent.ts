/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Edge agent: real swarm bot running outside Docker, connects to shared Redis over Headscale VPN, executes local MCP tools
 */

/**
 * Edge Agent — a real swarm member that runs on a local Mac or PC.
 *
 * Architecture:
 *   Local machine ──[Headscale VPN]──▶ Redis (AWS / any host)
 *   RedisMeshTransport subscribes directly to Redis Streams — same as any Docker bot.
 *   AgentRuntimeRegistryService writes oshal:runtime-agent:{agentId} with TTL 90s.
 *   SwarmAgentWorker polls agent.{AGENT_ID} direct channel + swarm.broadcast.
 *   Local MCP server (stdio) is the execution engine for tool calls.
 *
 * Required env vars:
 *   AGENT_ID        UUID for this edge agent (must be stable across restarts)
 *   REDIS_URL       Redis endpoint reachable via VPN, e.g. redis://10.x.x.x:6379
 *
 * Optional env vars:
 *   BOT_NAME        Human-readable name shown in cockpit (default: edge-agent)
 *   BOT_ROLE        Role string shown in cockpit (default: edge/local-executor)
 *   BOT_CAPABILITIES  Comma-separated capability tags (augmented by MCP tool names)
 *   MCP_COMMAND     Local MCP server binary (e.g. npx, node, python)
 *   MCP_ARGS        JSON array of args for MCP_COMMAND (e.g. '["@modelcontextprotocol/server-filesystem","/tmp"]')
 *   MCP_CWD         Working directory for the MCP process
 *
 * The agent appears in the cockpit dashboard automatically via the Redis-backed
 * AgentRuntimeRegistryService — no extra configuration needed on the control plane.
 */

import { createChildLogger } from '@/shared/logger';
import {
  RedisMeshTransport,
  AgentRuntimeRegistryService,
  MeshCommunicationService,
  MESH_CHANNELS,
  type AgentRuntimeRegistration,
} from '@/features/agent-management';
import { SwarmAgentWorker, type EnvelopeExecutionResult } from '@/features/swarm-orchestration';
import { McpStdioClient } from '@/features/remote-client/services/mcp-stdio-client';
import type { MeshEnvelope } from '@/features/agent-management';

const logger = createChildLogger({ module: 'edge-agent' });

const HEARTBEAT_INTERVAL_MS = 30_000;

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const agentId = process.env.AGENT_ID;
  if (!agentId) {
    throw new Error('AGENT_ID env var is required — assign a stable UUID to this edge agent');
  }

  const mcpArgs = (() => {
    const raw = process.env.MCP_ARGS;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('MCP_ARGS must be a JSON array');
      return parsed as string[];
    } catch (err) {
      throw new Error(`Invalid MCP_ARGS (must be JSON array of strings): ${(err as Error).message}`);
    }
  })();

  return {
    agentId,
    agentName: process.env.BOT_NAME ?? 'edge-agent',
    role: process.env.BOT_ROLE ?? 'edge/local-executor',
    staticCapabilities: (process.env.BOT_CAPABILITIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    mcpCommand: process.env.MCP_COMMAND,
    mcpArgs,
    mcpCwd: process.env.MCP_CWD,
  };
}

// ── MCP tool resolution ───────────────────────────────────────────────────────

async function resolveMcpTools(mcp: McpStdioClient): Promise<string[]> {
  try {
    const result = await mcp.listTools() as { tools?: Array<{ name: string }> } | null;
    return (result?.tools ?? []).map((t) => t.name).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, 'Failed to list MCP tools — capabilities will be empty');
    return [];
  }
}

// ── Execution handler ─────────────────────────────────────────────────────────

function buildMcpExecutionHandler(
  mcp: McpStdioClient,
  agentId: string,
  agentName: string,
  mcpTools: string[],
) {
  return async (envelope: MeshEnvelope): Promise<EnvelopeExecutionResult> => {
    const { payload } = envelope;

    // Direct tool call: { mcpTool: "tool_name", mcpArgs: { ... } }
    if (typeof payload.mcpTool === 'string') {
      const args = (payload.mcpArgs ?? {}) as Record<string, unknown>;
      logger.info({ agentId, tool: payload.mcpTool }, 'Executing MCP tool call');
      try {
        const output = await mcp.callTool(payload.mcpTool, args);
        return { success: true, output };
      } catch (err) {
        const error = (err as Error).message;
        logger.error({ err, tool: payload.mcpTool }, 'MCP tool call failed');
        return { success: false, error };
      }
    }

    // Tool discovery: { intent: "mcp.list-tools" }
    if (payload.intent === 'mcp.list-tools') {
      try {
        const output = await mcp.listTools();
        return { success: true, output };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }

    // Unknown payload — return agent card so the sender knows who they reached
    return {
      success: true,
      output: {
        agentId,
        agentName,
        note: 'Edge agent received envelope. Set payload.mcpTool to call a local tool.',
        availableTools: mcpTools,
      },
    };
  };
}

// ── No-op handler when MCP is not configured ─────────────────────────────────

function buildNoMcpHandler(agentId: string, agentName: string) {
  return async (envelope: MeshEnvelope): Promise<EnvelopeExecutionResult> => {
    logger.info({ agentId, channel: envelope.channel }, 'Edge agent received envelope (no MCP configured)');
    return {
      success: true,
      output: { agentId, agentName, note: 'No MCP_COMMAND configured on this edge agent.' },
    };
  };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(
  registry: AgentRuntimeRegistryService,
  registration: AgentRuntimeRegistration,
): NodeJS.Timeout {
  const publish = async () => {
    try {
      await registry.upsertAgent({ ...registration, heartbeatAt: new Date().toISOString() });
    } catch (err) {
      logger.warn({ err }, 'Heartbeat failed (non-fatal)');
    }
  };

  // Initial registration
  publish().catch((err) => logger.error({ err }, 'Initial heartbeat failed'));

  const timer = setInterval(() => void publish(), HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();

  logger.info(
    { agentId: cfg.agentId, agentName: cfg.agentName, redisUrl: cfg.redisUrl },
    'Edge agent starting — connecting to swarm Redis',
  );

  // Transport + services — all pointing at the same Redis as the swarm
  const meshTransport = new RedisMeshTransport({ redisUrl: cfg.redisUrl });
  const registry = new AgentRuntimeRegistryService({ redisUrl: cfg.redisUrl });
  const mesh = new MeshCommunicationService(meshTransport);

  // MCP local process (optional)
  let mcp: McpStdioClient | undefined;
  let mcpTools: string[] = [];

  if (cfg.mcpCommand) {
    mcp = new McpStdioClient({
      command: cfg.mcpCommand,
      args: cfg.mcpArgs,
      cwd: cfg.mcpCwd,
    });
    logger.info({ command: cfg.mcpCommand, args: cfg.mcpArgs }, 'Connecting to local MCP server');
    await mcp.connect();
    mcpTools = await resolveMcpTools(mcp);
    logger.info({ toolCount: mcpTools.length, tools: mcpTools }, 'MCP tools discovered');
  } else {
    logger.info('No MCP_COMMAND configured — edge agent joins swarm without local tooling');
  }

  // Merge static capabilities with MCP tool names
  const capabilities = [...new Set([...cfg.staticCapabilities, ...mcpTools, 'edge-agent'])];

  // Build runtime registration
  const startedAt = new Date().toISOString();
  const registration: AgentRuntimeRegistration = {
    agentId: cfg.agentId,
    agentName: cfg.agentName,
    role: cfg.role,
    capabilities,
    status: 'online',
    startedAt,
    heartbeatAt: startedAt,
  };

  // Start heartbeat (writes oshal:runtime-agent:{agentId} to Redis with 90s TTL)
  const heartbeatTimer = startHeartbeat(registry, registration);

  // Swarm worker — subscribes to direct channel + broadcast
  const executionHandler = mcp
    ? buildMcpExecutionHandler(mcp, cfg.agentId, cfg.agentName, mcpTools)
    : buildNoMcpHandler(cfg.agentId, cfg.agentName);

  const worker = new SwarmAgentWorker({
    transport: meshTransport,
    channel: MESH_CHANNELS.agentDirect(cfg.agentId),   // primary: agent.{agentId}
    consumerId: cfg.agentId,
    consumerGroup: 'swarm-execution',
    handler: executionHandler,
    additionalChannels: [MESH_CHANNELS.broadcast, MESH_CHANNELS.capabilities],
  });

  await worker.start();

  // Announce presence to the swarm
  mesh.broadcast(cfg.agentId, {
    type: 'agent-announce',
    agentId: cfg.agentId,
    agentName: cfg.agentName,
    role: cfg.role,
    capabilities,
    status: 'online',
    startedAt,
    tags: ['edge-agent', 'local', 'mcp'],
  }).catch((err) => logger.warn({ err }, 'Failed to broadcast agent-announce (non-fatal)'));

  logger.info(
    {
      agentId: cfg.agentId,
      agentName: cfg.agentName,
      capabilities,
      directChannel: MESH_CHANNELS.agentDirect(cfg.agentId),
    },
    'Edge agent online — registered in swarm, heartbeat running, worker polling',
  );

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal, agentId: cfg.agentId }, 'Edge agent shutdown requested');

    clearInterval(heartbeatTimer);
    worker.stop();

    // Broadcast offline so the cockpit knows immediately (Redis TTL is 90s, this is instant)
    try {
      await mesh.broadcast(cfg.agentId, {
        type: 'agent-announce',
        agentId: cfg.agentId,
        agentName: cfg.agentName,
        status: 'offline',
      });
      await registry.upsertAgent({ ...registration, status: 'offline', heartbeatAt: new Date().toISOString() });
    } catch {
      // best-effort
    }

    if (mcp) {
      await mcp.close().catch(() => undefined);
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Edge agent startup failed');
  process.exit(1);
});
