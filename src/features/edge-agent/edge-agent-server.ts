/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Edge agent GUI server — local web UI for one-click swarm connection
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Full cockpit: activity feed, ticket submission, bot messaging, bidirectional swarm control
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: stop advertising or executing MCP tools from unauthenticated mesh payloads; discovery remains diagnostic until an owner-bound task broker is wired.
 */

/* eslint-disable no-console -- standalone process: operator-facing startup banner printed to the console */

import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import express from 'express';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  RedisMeshTransport,
  AgentRuntimeRegistryService,
  MeshCommunicationService,
  MESH_CHANNELS,
  type AgentRuntimeRegistration,
  type MeshEnvelope,
} from '@/features/agent-management';
import { SwarmAgentWorker, type EnvelopeExecutionResult } from '@/features/swarm-orchestration';
import { McpStdioClient } from '@/features/remote-client';
import { AgentProfileRepository } from '@/entities/agent';

const logger = createChildLogger({ module: 'edge-agent-server' });

const HEARTBEAT_MS = 30_000;
const UI_PORT = Number(process.env.EDGE_AGENT_PORT ?? 3099);
const UI_HOST = (process.env.EDGE_AGENT_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const EDGE_AGENT_TOKEN = (process.env.EDGE_AGENT_TOKEN ?? '').trim() || randomBytes(32).toString('base64url');
const PM_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';

if (UI_HOST !== '127.0.0.1' && UI_HOST !== '::1' && !(process.env.EDGE_AGENT_TOKEN ?? '').trim()) {
  throw new Error('EDGE_AGENT_TOKEN must be explicitly set when EDGE_AGENT_HOST is not loopback.');
}

// ── Persistent agent ID ────────────────────────────────────────────────────
const ID_FILE = path.join(os.homedir(), '.oshal-edge-agent-id');

function getOrCreateAgentId(): string {
  try {
    if (fs.existsSync(ID_FILE)) return fs.readFileSync(ID_FILE, 'utf8').trim();
  } catch { /* regenerate */ }
  const id = randomUUID();
  fs.writeFileSync(ID_FILE, id, 'utf8');
  return id;
}

// ── Activity log ───────────────────────────────────────────────────────────
interface ActivityEntry {
  id: string;
  ts: string;
  dir: 'in' | 'out';
  from: string;
  to: string;
  type: string;
  summary: string;
}

const MAX_ACTIVITY = 200;
const activity: ActivityEntry[] = [];

function pushActivity(entry: Omit<ActivityEntry, 'id' | 'ts'>) {
  activity.unshift({ id: randomUUID().slice(0, 8), ts: new Date().toISOString(), ...entry });
  if (activity.length > MAX_ACTIVITY) activity.pop();
}

// ── Runtime state ──────────────────────────────────────────────────────────
interface EdgeAgentState {
  status: 'disconnected' | 'connecting' | 'connected';
  agentId: string;
  agentName: string;
  role: string;
  redisUrl: string;
  capabilities: string[];
  messagesProcessed: number;
  tasksExecuted: number;
  connectedAt: number | null;
  databaseUrl: string;
  transport: RedisMeshTransport | null;
  registry: AgentRuntimeRegistryService | null;
  mesh: MeshCommunicationService | null;
  worker: SwarmAgentWorker | null;
  mcp: McpStdioClient | null;
  pool: Pool | null;
  heartbeatTimer: NodeJS.Timeout | null;
}

const state: EdgeAgentState = {
  status: 'disconnected',
  agentId: getOrCreateAgentId(),
  agentName: `edge-${os.hostname().split('.')[0]}`,
  role: 'edge/local-executor',
  redisUrl: '',
  databaseUrl: '',
  capabilities: [],
  messagesProcessed: 0,
  tasksExecuted: 0,
  connectedAt: null,
  transport: null, registry: null, mesh: null, worker: null, mcp: null, pool: null, heartbeatTimer: null,
};

// ── Connect ────────────────────────────────────────────────────────────────

async function connect(opts: {
  redisUrl: string;
  databaseUrl?: string;
  botName?: string;
  botRole?: string;
}): Promise<void> {
  if (state.status === 'connected') await disconnect();

  state.status = 'connecting';
  state.redisUrl = opts.redisUrl;
  state.databaseUrl = opts.databaseUrl || '';
  state.agentName = opts.botName || state.agentName;
  state.role = opts.botRole || state.role;
  state.messagesProcessed = 0;
  state.tasksExecuted = 0;

  // Redis transport + services
  state.transport = new RedisMeshTransport({ redisUrl: opts.redisUrl });
  state.registry = new AgentRuntimeRegistryService({ redisUrl: opts.redisUrl });
  state.mesh = new MeshCommunicationService(state.transport);

  // Postgres — same DB as the swarm (for agent profile, routing, tickets)
  if (opts.databaseUrl) {
    state.pool = new Pool({ connectionString: opts.databaseUrl, max: 5 });
    // Verify connection
    await state.pool.query('SELECT 1');
    logger.info('Connected to Postgres');
  }

  // MCP (optional)
  let mcpTools: string[] = [];
  const mcpCommand = (process.env.EDGE_AGENT_MCP_COMMAND ?? '').trim();
  if (mcpCommand) {
    const mcpArgs = parseConfiguredMcpArgs(process.env.EDGE_AGENT_MCP_ARGS);
    state.mcp = new McpStdioClient({ command: mcpCommand, args: mcpArgs });
    await state.mcp.connect();
    try {
      const result = await state.mcp.listTools() as { tools?: Array<{ name: string }> } | null;
      mcpTools = (result?.tools ?? []).map(t => t.name).filter(Boolean);
    } catch { /* empty */ }
    logger.info({ toolCount: mcpTools.length, tools: mcpTools }, 'MCP tools discovered');
    pushActivity({ dir: 'in', from: 'mcp', to: state.agentId, type: 'mcp-init', summary: `${mcpTools.length} tools: ${mcpTools.join(', ')}` });
  }

  // Mesh envelopes do not carry a durable owner-bound tool authorization record. Publishing
  // discovered names as executable capabilities would invite arbitrary payload.mcpTool calls.
  state.capabilities = ['edge-agent'];

  // Seed agent profile into Postgres agents table — same as every Docker bot
  if (state.pool) {
    await seedAgentProfile(state.pool, state.agentId, state.agentName, state.role, state.capabilities);
  }

  // Redis heartbeat (runtime registry)
  const startedAt = new Date().toISOString();
  const reg: AgentRuntimeRegistration = {
    agentId: state.agentId, agentName: state.agentName, role: state.role,
    capabilities: state.capabilities, status: 'online', startedAt, heartbeatAt: startedAt,
  };
  const publishHeartbeat = async () => {
    try { await state.registry!.upsertAgent({ ...reg, heartbeatAt: new Date().toISOString() }); } catch { /* non-fatal */ }
  };
  await publishHeartbeat();
  state.heartbeatTimer = setInterval(() => void publishHeartbeat(), HEARTBEAT_MS);

  // Worker — subscribes to direct channel + broadcast, same as Docker bots
  state.worker = new SwarmAgentWorker({
    transport: state.transport,
    channel: MESH_CHANNELS.agentDirect(state.agentId),
    consumerId: state.agentId,
    consumerGroup: 'swarm-execution',
    handler: buildHandler(),
    additionalChannels: [MESH_CHANNELS.broadcast, MESH_CHANNELS.capabilities],
    directHandler: buildDirectHandler(),
  });
  await state.worker.start();

  // Announce to all bots
  state.mesh.broadcast(state.agentId, {
    type: 'agent-announce', agentId: state.agentId, agentName: state.agentName,
    role: state.role, capabilities: state.capabilities, status: 'online', startedAt,
  }).catch(() => {});

  state.status = 'connected';
  state.connectedAt = Date.now();
  pushActivity({ dir: 'out', from: state.agentId, to: '*', type: 'connected', summary: `Connected to swarm (Redis + Postgres)` });
  logger.info({ agentId: state.agentId, agentName: state.agentName }, 'Edge agent connected to swarm');
}

// ── Seed agent profile into Postgres (identical to Docker bot boot) ────────

async function seedAgentProfile(
  pool: Pool, agentId: string, agentName: string, role: string, capabilities: string[],
): Promise<void> {
  const repo = new AgentProfileRepository(pool);
  try {
    const existing = await repo.getAgentProfile(agentId);
    if (existing) {
      logger.info({ agentId, agentName }, 'Agent profile already exists in Postgres');
      return;
    }
  } catch { /* not found — will create */ }

  try {
    await repo.createAgent({
      name: agentName,
      status: 'active',
      apiProviderId: 'auto',
      modelId: undefined,
      persona: { name: agentName, agentId, role },
      baseCapabilities: capabilities,
      baseSelectorDescriptor: `${agentName} — local edge agent with MCP tool execution`,
      baseRoutingKeywords: capabilities,
      metadata: { autoSeeded: true, edgeAgent: true, bootTime: new Date().toISOString(), hostname: os.hostname() },
    });
    logger.info({ agentId, agentName, capabilities }, 'Seeded edge agent profile into Postgres agents table');
    pushActivity({ dir: 'out', from: agentId, to: 'postgres', type: 'profile-seed', summary: `Registered in agents table with ${capabilities.length} capabilities` });
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to seed agent profile (non-fatal — agent will work via Redis only)');
  }
}

// ── Disconnect ─────────────────────────────────────────────────────────────

async function disconnect(): Promise<void> {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  if (state.worker) state.worker.stop();
  state.worker = null;
  if (state.mesh) {
    await state.mesh.broadcast(state.agentId, { type: 'agent-announce', agentId: state.agentId, agentName: state.agentName, status: 'offline' }).catch(() => {});
  }
  if (state.registry) {
    await state.registry.upsertAgent({
      agentId: state.agentId, agentName: state.agentName, role: state.role,
      capabilities: state.capabilities, status: 'offline', startedAt: '', heartbeatAt: new Date().toISOString(),
    }).catch(() => {});
  }
  if (state.mcp) await state.mcp.close().catch(() => {});
  if (state.pool) await state.pool.end().catch(() => {});
  state.mcp = null; state.transport = null; state.registry = null; state.mesh = null; state.pool = null;
  state.status = 'disconnected'; state.connectedAt = null;
  pushActivity({ dir: 'out', from: state.agentId, to: '*', type: 'disconnected', summary: 'Disconnected from swarm' });
}

// ── Execution handler (swarm dispatches task TO this agent) ────────────────

function buildHandler() {
  return async (envelope: MeshEnvelope): Promise<EnvelopeExecutionResult> => {
    state.messagesProcessed++;
    state.tasksExecuted++;
    const { payload } = envelope;

    pushActivity({
      dir: 'in', from: envelope.fromAgentId, to: state.agentId,
      type: payload.mcpTool ? `mcp:${payload.mcpTool}` : String(payload.type ?? payload.intent ?? 'task'),
      summary: payload.mcpTool ? `Tool call: ${payload.mcpTool}` : JSON.stringify(payload).slice(0, 120),
    });

    if (typeof payload.mcpTool === 'string') {
      return {
        success: false,
        error: 'Edge MCP execution requires an owner-bound remote-task authorization broker.',
      };
    }
    if (state.mcp && payload.intent === 'mcp.list-tools') {
      try { return { success: true, output: await state.mcp.listTools() }; } catch (err) { return { success: false, error: (err as Error).message }; }
    }
    return { success: true, output: { agentId: state.agentId, agentName: state.agentName, capabilities: state.capabilities } };
  };
}

// ── Direct/broadcast message handler (non-execution messages) ──────────────

function buildDirectHandler() {
  return async (envelope: MeshEnvelope, _entryId: string): Promise<void> => {
    state.messagesProcessed++;
    const pType = String(envelope.payload?.type ?? 'message');
    // Skip our own broadcasts
    if (envelope.fromAgentId === state.agentId) return;
    pushActivity({
      dir: 'in', from: envelope.fromAgentId, to: envelope.toAgentId,
      type: pType, summary: pType === 'agent-announce'
        ? `${envelope.payload?.agentName ?? envelope.fromAgentId} ${envelope.payload?.status ?? 'announced'}`
        : JSON.stringify(envelope.payload).slice(0, 120),
    });
  };
}

// ── List online bots ───────────────────────────────────────────────────────

async function listOnlineBots(): Promise<AgentRuntimeRegistration[]> {
  if (!state.registry) return [];
  try {
    const r = new Redis(state.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    await r.connect();
    const keys = await r.keys('oshal:runtime-agent:*');
    const bots: AgentRuntimeRegistration[] = [];
    for (const k of keys) {
      const raw = await r.get(k);
      if (raw) { try { bots.push(JSON.parse(raw)); } catch { /* skip */ } }
    }
    await r.quit();
    return bots.filter(b => b.status === 'online').sort((a, b) => a.agentName.localeCompare(b.agentName));
  } catch { return []; }
}

// ── Express app ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '64kb' }));
const uiDir = path.join(__dirname, 'ui');
app.use(express.static(uiDir));

function parseConfiguredMcpArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === 'string')) {
    throw new Error('EDGE_AGENT_MCP_ARGS must be a JSON array of strings.');
  }
  return parsed;
}

function tokenMatches(candidate: string): boolean {
  const actual = Buffer.from(EDGE_AGENT_TOKEN);
  const supplied = Buffer.from(candidate);
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

app.use('/api/edge-agent', (req, res, next) => {
  const candidate = req.header('x-edge-agent-token') ?? '';
  if (!tokenMatches(candidate)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="edge-agent"');
    return res.status(401).json({ error: 'Edge agent authentication required' });
  }
  return next();
});

// Info
app.get('/api/edge-agent/info', (_req, res) => {
  res.json({
    hostname: os.hostname().split('.')[0], platform: os.platform(),
    agentId: state.agentId, connected: state.status === 'connected',
    agentName: state.agentName, role: state.role, redisUrl: state.redisUrl,
    capabilities: state.capabilities,
    uptimeMs: state.connectedAt ? Date.now() - state.connectedAt : 0,
  });
});

// Connect
app.post('/api/edge-agent/connect', async (req, res) => {
  try {
    if ('mcpCommand' in req.body || 'mcpArgs' in req.body) {
      return res.status(400).json({
        error: 'MCP process configuration is not accepted over HTTP; configure EDGE_AGENT_MCP_COMMAND and EDGE_AGENT_MCP_ARGS before startup.',
      });
    }
    const { redisUrl, databaseUrl, botName, botRole } = req.body;
    if (!redisUrl) return res.status(400).json({ error: 'redisUrl is required' });
    await connect({ redisUrl, databaseUrl, botName, botRole });
    res.json({ agentId: state.agentId, agentName: state.agentName, role: state.role, redisUrl: state.redisUrl, capabilities: state.capabilities });
  } catch (err) {
    state.status = 'disconnected';
    res.status(500).json({ error: (err as Error).message });
  }
});

// Disconnect
app.post('/api/edge-agent/disconnect', async (_req, res) => { await disconnect(); res.json({ status: 'disconnected' }); });

// Status + bots
app.get('/api/edge-agent/status', async (_req, res) => {
  const bots = state.status === 'connected' ? await listOnlineBots() : [];
  res.json({
    status: state.status, agentId: state.agentId, agentName: state.agentName,
    role: state.role, redisUrl: state.redisUrl, capabilities: state.capabilities,
    messagesProcessed: state.messagesProcessed, tasksExecuted: state.tasksExecuted,
    uptimeMs: state.connectedAt ? Date.now() - state.connectedAt : 0, bots,
  });
});

// Activity feed
app.get('/api/edge-agent/activity', (req, res) => {
  const limit = Math.min(Number(req.query?.limit) || 50, MAX_ACTIVITY);
  res.json({ activity: activity.slice(0, limit) });
});

// Submit ticket to PM bot
app.post('/api/edge-agent/submit-ticket', async (req, res) => {
  if (!state.mesh || state.status !== 'connected') return res.status(400).json({ error: 'Not connected' });
  const { title, description, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    await state.mesh.sendDirect(PM_AGENT_ID, state.agentId, {
      type: 'ticket-request',
      title, description: description || '', priority: priority || 'medium',
      submittedBy: state.agentName, submittedAt: new Date().toISOString(),
    });
    pushActivity({ dir: 'out', from: state.agentId, to: PM_AGENT_ID, type: 'ticket-submit', summary: title });
    res.json({ success: true, sentTo: PM_AGENT_ID });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Send direct message to any bot
app.post('/api/edge-agent/send', async (req, res) => {
  if (!state.mesh || state.status !== 'connected') return res.status(400).json({ error: 'Not connected' });
  const { toAgentId, payload } = req.body;
  if (!toAgentId || !payload) return res.status(400).json({ error: 'toAgentId and payload required' });

  try {
    await state.mesh.sendDirect(toAgentId, state.agentId, payload);
    pushActivity({ dir: 'out', from: state.agentId, to: toAgentId, type: 'direct', summary: JSON.stringify(payload).slice(0, 120) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Start server ───────────────────────────────────────────────────────────

/**
 * @description Boots the edge agent's local web cockpit: starts the Express HTTP
 * server on the configured UI port so an operator can connect to the swarm,
 * submit tickets, message bots, and watch the activity feed from a browser. Also
 * wires SIGINT/SIGTERM handlers to gracefully disconnect from the swarm (Redis,
 * Postgres, MCP) before the process exits.
 * @returns {void}
 */
export function startEdgeAgentServer(): void {
  app.listen(UI_PORT, UI_HOST, () => {
    logger.info({ port: UI_PORT, host: UI_HOST }, 'Edge Agent UI running');
    console.log('');
    console.log(`  OSHAL Edge Agent`);
    const browserHost = UI_HOST === '0.0.0.0' || UI_HOST === '::' ? 'localhost' : UI_HOST;
    console.log(`  Open in browser: http://${browserHost}:${UI_PORT}/#token=${encodeURIComponent(EDGE_AGENT_TOKEN)}`);
    console.log('');
  });
  const shutdown = async (signal: string) => { await disconnect(); process.exit(0); };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
