/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the one-call create-and-start path: AgentFactoryService.createAndStartAgent must launch after create, ROLL BACK the creation on any launch failure (compose removal + profile deletion; inactive-mark fallback when deletion fails — never a silent zombie), return a clean error when creation itself fails, and the /create-and-start route must map those outcomes to 201/502/500/409/400. Would go red if create+launch went back to being two unrolled-back calls.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: exercise exact operator authorization on both globally trusted agent creation routes.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import type { Server } from 'http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AgentFactoryService,
  type AgentSpecification,
  type BotContainerSpawnerService,
  type DynamicComposeService,
  type MeshTransport,
} from '@/features/agent-management';
import type { AgentProfileRepository } from '@/entities/agent';
import { createAgentFactoryRoutes } from '@/app/extensions/swarm/routes/agent-factory-routes';

const SPEC: AgentSpecification = {
  name: 'unit-create-start-bot',
  systemPrompt: 'You are a unit-test bot.',
  role: 'executor',
  topology: 'swarm',
  constraints: [],
  capabilities: ['code-implementation'],
  routingKeywords: ['unit'],
  selectorDescriptor: 'unit-test create-and-start bot',
};

interface Fakes {
  service: AgentFactoryService;
  createAgent: ReturnType<typeof vi.fn>;
  deleteAgent: ReturnType<typeof vi.fn>;
  updateAgentStatus: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
  upsertService: ReturnType<typeof vi.fn>;
  removeService: ReturnType<typeof vi.fn>;
  startBot: ReturnType<typeof vi.fn>;
}

function buildService(personaDir: string): Fakes {
  const createAgent = vi.fn(async () => ({ agentId: 'agent-1', name: SPEC.name }));
  const deleteAgent = vi.fn(async () => true);
  const updateAgentStatus = vi.fn(async () => null);
  const listAgents = vi.fn(async () => [] as Array<{ name: string }>);
  const repo = { createAgent, deleteAgent, updateAgentStatus, listAgents } as unknown as AgentProfileRepository;

  const meshTransport: MeshTransport = {
    publish: vi.fn(async () => undefined),
    consume: vi.fn(async () => []),
    ack: vi.fn(async () => undefined),
    subscribe: vi.fn(() => ({ stop: () => undefined })),
  };

  const upsertService = vi.fn(() => ({ success: true, agentName: SPEC.name, operation: 'upsert' as const }));
  const removeService = vi.fn(() => ({ success: true, agentName: SPEC.name, operation: 'remove' as const }));
  const dynamicComposeService = { upsertService, removeService, filePath: join(personaDir, 'dynamic.yml'), listServices: () => [] } as unknown as DynamicComposeService;

  const startBot = vi.fn(async () => ({ success: true, serviceName: SPEC.name, operation: 'start' as const, output: 'started' }));
  const containerSpawner = { startBot } as unknown as BotContainerSpawnerService;

  const service = new AgentFactoryService({
    agentProfileRepository: repo,
    meshTransport,
    personaDir,
    dynamicComposeService,
    containerSpawner,
  });
  return { service, createAgent, deleteAgent, updateAgentStatus, listAgents, upsertService, removeService, startBot };
}

describe('AgentFactoryService.createAndStartAgent (rollback semantics)', () => {
  let personaDir: string;
  beforeAll(() => { personaDir = mkdtempSync(join(tmpdir(), 'oshal-create-start-')); });
  afterAll(() => { rmSync(personaDir, { recursive: true, force: true }); });

  it('happy path: creates, registers compose, starts the container — no rollback', async () => {
    const f = buildService(personaDir);
    const result = await f.service.createAndStartAgent(SPEC);
    expect(result.success).toBe(true);
    expect(result.agentId).toBe('agent-1');
    expect(result.containerStarted).toBe(true);
    expect(f.upsertService).toHaveBeenCalledOnce();
    expect(f.startBot).toHaveBeenCalledWith(SPEC.name);
    expect(f.deleteAgent).not.toHaveBeenCalled();
    expect(f.removeService).not.toHaveBeenCalled();
  });

  it('launch failure rolls the creation back (compose entry removed + profile deleted)', async () => {
    const f = buildService(personaDir);
    f.startBot.mockResolvedValueOnce({ success: false, serviceName: SPEC.name, operation: 'start', output: '', error: 'compose up exploded' });
    const result = await f.service.createAndStartAgent(SPEC);
    expect(result.success).toBe(false);
    expect(result.containerStarted).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('compose up exploded');
    expect(result.error).toContain('rolled back');
    expect(f.removeService).toHaveBeenCalledWith(SPEC.name);
    expect(f.deleteAgent).toHaveBeenCalledWith('agent-1');
  });

  it('compose registration failure also rolls back — the pre-start zombie window', async () => {
    const f = buildService(personaDir);
    f.upsertService.mockReturnValueOnce({ success: false, agentName: SPEC.name, operation: 'upsert', error: 'yaml write denied' });
    const result = await f.service.createAndStartAgent(SPEC);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('yaml write denied');
    expect(f.startBot).not.toHaveBeenCalled();
    expect(f.deleteAgent).toHaveBeenCalledWith('agent-1');
  });

  it('creation failure returns a clean error with nothing to roll back', async () => {
    const f = buildService(personaDir);
    f.createAgent.mockRejectedValueOnce(new Error('db down'));
    const result = await f.service.createAndStartAgent(SPEC);
    expect(result.success).toBe(false);
    expect(result.agentId).toBeUndefined();
    expect(result.error).toContain('db down');
    expect(f.upsertService).not.toHaveBeenCalled();
    expect(f.startBot).not.toHaveBeenCalled();
    expect(f.deleteAgent).not.toHaveBeenCalled();
  });

  it('duplicate name short-circuits before any launch machinery runs', async () => {
    const f = buildService(personaDir);
    f.listAgents.mockResolvedValueOnce([{ name: SPEC.name }]);
    const result = await f.service.createAndStartAgent(SPEC);
    expect(result.duplicate).toBe(true);
    expect(f.startBot).not.toHaveBeenCalled();
    expect(f.deleteAgent).not.toHaveBeenCalled();
  });

  it('when rollback deletion fails, the agent is marked inactive and the failure is surfaced (never silent)', async () => {
    const f = buildService(personaDir);
    f.startBot.mockResolvedValueOnce({ success: false, serviceName: SPEC.name, operation: 'start', output: '', error: 'boom' });
    f.deleteAgent.mockResolvedValueOnce(false);
    const result = await f.service.createAndStartAgent(SPEC);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackError).toBeTruthy();
    expect(result.error).toContain('ROLLBACK ALSO FAILED');
    expect(f.updateAgentStatus).toHaveBeenCalledWith('agent-1', 'inactive');
  });
});

// ── Route boundary: POST /api/swarm/agents/create-and-start over HTTP loopback ──

const PORT = 42311;
const API = `http://127.0.0.1:${PORT}`;
const originalOperatorSubs = process.env.OSHAL_OPERATOR_SUBS;

const routeOutcome = vi.fn();
const factoryStub = {
  createAndStartAgent: routeOutcome,
  deployPersonaOnly: vi.fn(),
  listAgentNames: vi.fn(async () => []),
  deleteAgent: vi.fn(async () => true),
} as unknown as AgentFactoryService;

async function post(
  path: string,
  body: unknown,
  subject = 'Operator-Exact',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-sub': subject },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/swarm/agents/create-and-start (route boundary)', () => {
  let server: Server;

  beforeAll(async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'Operator-Exact';
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const subject = req.header('x-test-sub');
      (req as unknown as { oidc: unknown }).oidc = {
        isAuthenticated: () => true,
        user: subject ? { sub: subject } : {},
      };
      next();
    });
    app.use('/api/swarm/agents', createAgentFactoryRoutes(factoryStub)); // requiresAuth wrapping is the swarm extension mount's job
    server = await new Promise<Server>((resolve) => { const s = app.listen(PORT, () => resolve(s)); });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (originalOperatorSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
    else process.env.OSHAL_OPERATOR_SUBS = originalOperatorSubs;
  });

  afterEach(() => { routeOutcome.mockReset(); });

  it('201s a successful create+launch', async () => {
    routeOutcome.mockResolvedValueOnce({ success: true, agentId: 'agent-1', name: SPEC.name, containerStarted: true });
    const r = await post('/api/swarm/agents/create-and-start', SPEC);
    expect(r.status).toBe(201);
    expect(r.body.agentId).toBe('agent-1');
    expect(r.body.containerStarted).toBe(true);
  });

  it('502s a launch failure and reports the rollback', async () => {
    routeOutcome.mockResolvedValueOnce({
      success: false, agentId: 'agent-1', name: SPEC.name,
      containerStarted: false, containerError: 'boom', rolledBack: true,
      error: 'Agent created but launch failed (boom) — creation rolled back',
    });
    const r = await post('/api/swarm/agents/create-and-start', SPEC);
    expect(r.status).toBe(502);
    expect(r.body.rolledBack).toBe(true);
  });

  it('500s a creation failure (clean error, no agentId)', async () => {
    routeOutcome.mockResolvedValueOnce({ success: false, name: SPEC.name, error: 'db down' });
    const r = await post('/api/swarm/agents/create-and-start', SPEC);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('db down');
  });

  it('409s a duplicate name', async () => {
    routeOutcome.mockResolvedValueOnce({ success: false, name: SPEC.name, duplicate: true, error: 'exists' });
    const r = await post('/api/swarm/agents/create-and-start', SPEC);
    expect(r.status).toBe(409);
  });

  it('400s an invalid specification without touching the service', async () => {
    const r = await post('/api/swarm/agents/create-and-start', { name: 'x' });
    expect(r.status).toBe(400);
    expect(routeOutcome).not.toHaveBeenCalled();
  });

  it('denies a non-operator on both persona-only and create-and-start paths', async () => {
    const deployPersonaOnly = factoryStub.deployPersonaOnly as unknown as ReturnType<typeof vi.fn>;
    deployPersonaOnly.mockClear();
    routeOutcome.mockClear();

    expect((await post('/api/swarm/agents', SPEC, 'ordinary-user')).status).toBe(403);
    expect((await post('/api/swarm/agents/create-and-start', SPEC, 'operator-exact')).status).toBe(403);
    expect(deployPersonaOnly).not.toHaveBeenCalled();
    expect(routeOutcome).not.toHaveBeenCalled();
  });
});
