/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for build-lane planning running in-process (docs/security/http-delegation.md, "Build-lane planning runs in-process"). Drives the real MultiRoundDispatchService, the real project-manager round executor, the real swarm execution handler and the governed hosted provider against a real local OpenAI-compatible endpoint, with round output on real Postgres work_items. Covers the run, every named refusal, skipped rounds under signing, the unchanged mesh path without signing, and the controller worker refusing an unsigned mesh envelope.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The endpoint can wall the next request with HTTP 503 "high demand"; a walled round is replayed on the same endpoint and completes with one cost row.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { WorkItemRepository } from '../../src/entities/work-item';
import {
  MESH_CHANNELS,
  MeshCommunicationService,
  type ConsumedEnvelope,
  type MeshEnvelope,
  type MeshSubscription,
  type MeshTransport,
} from '../../src/features/agent-management';
import {
  MultiRoundDispatchService,
  type CostRecordFn,
  type LLMExecutionHandlerDeps,
  type RoundOwner,
} from '../../src/features/swarm-orchestration';
import type { DecomposedWorkUnit } from '../../src/features/swarm-orchestration/services/ticket-decomposition-service';
import { createChildLogger } from '../../src/shared/logger';
import {
  PM_PLANNING_AGENT_ID,
  TOOL_LESS_PLANNING_NOTE,
  createControllerPmRoundExecutor,
  type ControllerPmRoundExecutorDeps,
} from '../../src/app/extensions/swarm/controller-pm-round-executor';
import { createControllerSwarmWorker } from '../../src/app/extensions/swarm/controller-swarm-worker';

const OPERATOR = 'pm-hosted-operator-sub';
const OTHER_OWNER = 'pm-hosted-other-sub';
const ISSUER = 'https://issuer.fixture.invalid';
const REVIEWER_ID = 'a0000000-0000-0000-0000-000000000003';
const ARCHITECT_ID = 'a0000000-0000-0000-0000-000000000018';
const MODEL = 'fixture-planning-model';
/** Bearer key the fixture endpoint demands. Invented here; never an environment value. */
const ENDPOINT_KEY = 'fixture-planning-key';
const PLAN = [
  '## Project Plan', '', 'Two modules.', '', '## SUBTASK DECOMPOSITION', '',
  '### Subtask 1: Build the CSV parser module', 'Parse rows. Suggested agent role: code-developer', '',
  '### Subtask 2: Build the schema validator module', 'Validate rows. Suggested agent role: code-developer',
].join('\n');
const PERSONA_FILE = resolve(__dirname, '../../ai-lab/bot-personas/project-manager.yaml');
const SIGNING_ENV = ['OSHAL_DELEGATION_SIGNING_KID', 'OSHAL_DELEGATION_SIGNING_PRIVATE_KEY'] as const;

interface RecordedRequest { authorization: string | null; body: Record<string, unknown> }

const wireRequests: RecordedRequest[] = [];
const costEvents: Array<Parameters<CostRecordFn>[0]> = [];
let endpoint: Server;
let baseUrl: string;
/** How many of the next requests the endpoint refuses with a 503 high-demand wall. */
let wallNext = 0;
let fixturePg: DisposablePostgres;
let pool: Pool;
let workItems: WorkItemRepository;
let ticketSeq = 0;
const savedEnv: Record<string, string | undefined> = {};

/**
 * @description A mesh transport that really queues: publish appends to a channel, consume drains it.
 * Redis is the production transport; the boundary under guard is what the controller does with a
 * round, not how Redis delivers it. onPublish lets a case stand in for a worker on the mesh path.
 */
class QueueMeshTransport implements MeshTransport {
  readonly published: MeshEnvelope[] = [];
  private readonly queues = new Map<string, ConsumedEnvelope[]>();
  private seq = 0;
  onPublish?: (envelope: MeshEnvelope) => Promise<void>;

  async publish(envelope: MeshEnvelope): Promise<void> {
    this.published.push(envelope);
    const queue = this.queues.get(envelope.channel) ?? [];
    queue.push({ entryId: `e-${++this.seq}`, envelope });
    this.queues.set(envelope.channel, queue);
    await this.onPublish?.(envelope);
  }

  async consume(channel: string): Promise<ConsumedEnvelope[]> {
    const queue = this.queues.get(channel) ?? [];
    this.queues.set(channel, []);
    return queue;
  }

  async ack(): Promise<void> {}

  subscribe(): MeshSubscription {
    return { stop: () => undefined };
  }
}

/**
 * @description The planning endpoint as a real local HTTP server, so the governed hosted provider
 * crosses fetch exactly as it does in production. It records every request it receives.
 * @returns A started server; `baseUrl` is set to its `/v1` root.
 */
async function startEndpoint(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const authorization = req.headers.authorization ?? null;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      wireRequests.push({ authorization, body });
      if (authorization !== `Bearer ${ENDPOINT_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (wallNext > 0) {
        wallNext -= 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: MODEL,
        usage: { prompt_tokens: 900, completion_tokens: 300 },
        choices: [{ index: 0, message: { role: 'assistant', content: PLAN }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return server;
}

/** The worker's handler deps, with collaborators outside this boundary doubled or absent. */
function handlerDeps(): LLMExecutionHandlerDeps {
  return {
    resolveProvider: () => { throw new Error('the registry provider must not run a planning round'); },
    agentProfileRepository: { getAgentProfile: async () => null } as unknown as LLMExecutionHandlerDeps['agentProfileRepository'],
    recordCost: async (event) => { costEvents.push(event); },
  };
}

/**
 * @description The real executor with fixture seams for the brain and the operator list; the
 * registry check stays the production one.
 * @param overrides - Seams a case replaces.
 * @returns The executor deps.
 */
function executorDeps(overrides: Partial<ControllerPmRoundExecutorDeps> = {}): ControllerPmRoundExecutorDeps {
  return {
    pool,
    handlerDeps: handlerDeps(),
    resolveConnection: async () => ({ baseUrl, apiKey: ENDPOINT_KEY, model: MODEL }),
    isOperator: (sub) => sub === OPERATOR,
    isProtected: async () => false,
    ...overrides,
  };
}

/**
 * @description A multi-round service over the queue transport and real work items.
 * @param transport - The mesh transport.
 * @param enforced - Whether delegation signing is configured.
 * @param deps - Executor deps; undefined installs no executor.
 * @returns The service.
 */
function dispatchService(transport: QueueMeshTransport, enforced: boolean, deps?: ControllerPmRoundExecutorDeps) {
  const service = new MultiRoundDispatchService({
    meshService: new MeshCommunicationService(transport),
    workItemRepository: workItems,
    selectAgent: async () => REVIEWER_ID,
    isDelegationEnforced: () => enforced,
  });
  if (deps) service.setLocalRoundExecutor(createControllerPmRoundExecutor(deps));
  return service;
}

function planningUnit(ticketId: string): DecomposedWorkUnit {
  return {
    unitId: `${ticketId}-planning`, title: 'Plan and decompose: a two-module CLI',
    description: 'Plan the two modules and include a ## SUBTASK DECOMPOSITION section.',
    acceptanceCriteria: ['Two subtasks'], labels: [], priority: 'low', workType: 'analysis', parentUnitId: null, depth: 0,
  };
}

const policy = { maxRetries: 1, verificationTimeoutMs: 1000 } as never;

function freshTicketId(): string {
  ticketSeq += 1;
  return `00000000-0000-4000-8000-${String(ticketSeq).padStart(12, '0')}`;
}

async function roundItems(ticketId: string) {
  const items = await workItems.findByExternalIdAnyProvider(ticketId);
  return new Map(items.map((item) => [(item as { unitId?: string }).unitId ?? '', item]));
}

function planningRound(service: MultiRoundDispatchService, ticketId: string, owner: RoundOwner) {
  return service.executePhaseWithRounds('run-1', ticketId, 2, [planningUnit(ticketId)], PM_PLANNING_AGENT_ID, policy, ticketId, owner);
}

beforeAll(async () => {
  endpoint = await startEndpoint();
  fixturePg = new DisposablePostgres({ purpose: 'controller-pm-hosted-brain' });
  pool = await fixturePg.start();
  workItems = new WorkItemRepository(pool);
  for (const key of [...SIGNING_ENV, 'BOT_PERSONA_FILE', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS']) savedEnv[key] = process.env[key];
}, 180_000);

beforeEach(() => {
  wireRequests.length = 0;
  costEvents.length = 0;
  process.env.BOT_PERSONA_FILE = PERSONA_FILE;
  for (const key of SIGNING_ENV) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

afterAll(async () => {
  if (fixturePg) await fixturePg.stop();
  if (endpoint) await new Promise<void>((done) => endpoint.close(() => done()));
}, 60_000);

describe('build-lane planning runs in-process on the root owner hosted brain (real endpoint, real handler, real Postgres)', () => {
  it('runs project-manager round 1 in-process with the planning budget and an embedded persona, records it, and skips the reviewer round under signing', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const result = await planningRound(dispatchService(transport, true, executorDeps()), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });

    expect(wireRequests).toHaveLength(1);
    const [request] = wireRequests;
    expect(request.authorization).toBe(`Bearer ${ENDPOINT_KEY}`);
    expect(request.body.model).toBe(MODEL);
    expect(request.body.max_tokens).toBe(16384);
    expect(request.body.tools).toBeUndefined();
    const wire = JSON.stringify(request.body.messages);
    // The persona is embedded; the context-file instruction a tool-less brain cannot obey is not sent.
    expect(wire).toContain('## Bot Identity:');
    expect(wire).not.toContain('MUST first read the file');
    expect(wire).not.toContain('-context.md');
    expect(wire).toContain('SUBTASK DECOMPOSITION');
    const messages = request.body.messages as Array<{ role: string; content: string }>;
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user' });
    expect(messages[messages.length - 1].content.endsWith(TOOL_LESS_PLANNING_NOTE)).toBe(true);

    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]).toMatchObject({ agentId: PM_PLANNING_AGENT_ID, round: 1, executedInProcess: true });
    expect(result.finalOutput).toMatchObject({ agentId: PM_PLANNING_AGENT_ID, content: PLAN });
    expect(transport.published).toHaveLength(0);

    const items = await roundItems(ticketId);
    const round1 = items.get(`${ticketId}-phase-2-round-1`);
    expect(round1?.status).toBe('completed');
    expect(round1?.assignedAgentId).toBe(PM_PLANNING_AGENT_ID);
    expect((round1?.executionOutput as { content?: string })?.content).toBe(PLAN);
    expect(items.has(`${ticketId}-phase-2-round-2`)).toBe(false);

    expect(costEvents).toHaveLength(1);
    expect(costEvents[0]).toMatchObject({
      agentId: PM_PLANNING_AGENT_ID, providerId: `byo-hosted:${MODEL}`, modelId: MODEL, ownerSub: OPERATOR,
      taskId: `${ticketId}::${PM_PLANNING_AGENT_ID}`, inputTokens: 900, outputTokens: 300,
    });
  }, 60_000);

  it('replays one 503 high-demand wall on the same endpoint and still completes the round with one cost row', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    wallNext = 1;
    const result = await planningRound(dispatchService(transport, true, executorDeps()), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });

    expect(wireRequests).toHaveLength(2);
    expect(wireRequests.every((request) => request.authorization === `Bearer ${ENDPOINT_KEY}`)).toBe(true);
    expect(result.finalOutput).toMatchObject({ agentId: PM_PLANNING_AGENT_ID, content: PLAN });
    expect((await roundItems(ticketId)).get(`${ticketId}-phase-2-round-1`)?.status).toBe('completed');
    expect(costEvents).toHaveLength(1);
    expect(transport.published).toHaveLength(0);
  }, 60_000);

  it.each([
    ['a root with no verified issuer', { ownerSub: OPERATOR, principalIssuer: null }, 'the root ticket carries no verified principal issuer'],
    ['an ownerless root', { ownerSub: null, principalIssuer: ISSUER }, 'the root ticket has no owner'],
    ['a root owned by someone who is not an operator', { ownerSub: OTHER_OWNER, principalIssuer: ISSUER }, 'the root ticket owner is not a deployment operator'],
  ])('refuses %s by name and calls no model', async (_label, owner, reason) => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const result = await planningRound(dispatchService(transport, true, executorDeps()), ticketId, owner as RoundOwner);

    expect(wireRequests).toHaveLength(0);
    expect(result.finalOutput).toMatchObject({ status: 'failed' });
    expect((result.finalOutput as { error?: string }).error).toBe(`pm_hosted_brain_refused: ${reason}`);
    expect((await roundItems(ticketId)).get(`${ticketId}-phase-2-round-1`)?.status).toBe('failed');
    expect(transport.published).toHaveLength(0);
  }, 30_000);

  it('refuses when project-manager is bound to a protected application, and when that check fails', async () => {
    for (const isProtected of [async () => true, async () => { throw new Error('authorization store down'); }]) {
      const ticketId = freshTicketId();
      const result = await planningRound(dispatchService(new QueueMeshTransport(), true, executorDeps({ isProtected })), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });
      expect(String((result.finalOutput as { error?: string }).error)).toMatch(/^pm_hosted_brain_refused: (project-manager is bound to a protected application|the protected-application check failed)$/);
    }
    expect(wireRequests).toHaveLength(0);
  }, 30_000);

  it('names an unavailable brain when no rung resolves, when the ladder throws, and on the default ladder with nothing configured', async () => {
    process.env.DEMO_MODE = 'false';
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
    const variants: Array<Partial<ControllerPmRoundExecutorDeps>> = [
      { resolveConnection: async () => undefined },
      { resolveConnection: async () => { throw new Error('ladder down'); } },
      { resolveConnection: undefined },
    ];
    for (const overrides of variants) {
      const ticketId = freshTicketId();
      const result = await planningRound(dispatchService(new QueueMeshTransport(), true, executorDeps(overrides)), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });
      expect(String((result.finalOutput as { error?: string }).error)).toMatch(/^pm_hosted_brain_unavailable: /);
    }
    expect(wireRequests).toHaveLength(0);
  }, 60_000);

  it('under signing, a round no in-process executor owns publishes nothing and creates no work item', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const service = dispatchService(transport, true, executorDeps());
    const result = await service.executePhaseWithRounds('run-1', ticketId, 8, [planningUnit(ticketId)], ARCHITECT_ID, policy, ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });

    expect(result).toMatchObject({ rounds: [], finalOutput: undefined, allRoundsComplete: false });
    expect(transport.published).toHaveLength(0);
    expect((await roundItems(ticketId)).size).toBe(0);
    expect(wireRequests).toHaveLength(0);
  }, 30_000);

  it('without signing, the reviewer round still crosses the mesh and its stored output becomes the phase output', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    transport.onPublish = async (envelope) => {
      // Stand in for the reviewer's worker: store its output on the round item it was sent.
      const unitId = String((envelope.payload as Record<string, unknown>).roundUnitId);
      const item = (await roundItems(ticketId)).get(unitId);
      if (!item) throw new Error(`no work item for ${unitId}`);
      await workItems.setExecutionOutput(item.workItemId, { agentId: REVIEWER_ID, content: 'REVIEWED' });
      await workItems.updateStatus(item.workItemId, 'completed', REVIEWER_ID);
    };
    const result = await planningRound(dispatchService(transport, false, executorDeps()), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });

    expect(wireRequests).toHaveLength(1);
    expect(transport.published).toHaveLength(1);
    expect(transport.published[0]).toMatchObject({ toAgentId: REVIEWER_ID, channel: MESH_CHANNELS.agentDirect(REVIEWER_ID) });
    expect(result.rounds.map((r) => [r.agentId, Boolean(r.executedInProcess)])).toEqual([[PM_PLANNING_AGENT_ID, true], [REVIEWER_ID, false]]);
    expect(result.finalOutput).toMatchObject({ content: 'REVIEWED' });
  }, 60_000);
});

describe('the controller mesh worker refuses unsigned execution while signing is configured', () => {
  /**
   * @description Delivers one execution envelope for project-manager through the real controller
   * worker over the queue transport and returns what the worker recorded on the round's work item.
   * @param signing - Whether delegation signing is configured when the worker is built.
   * @returns The work item after the worker handled the envelope.
   */
  async function deliverUnsignedEnvelope(signing: boolean) {
    for (const key of SIGNING_ENV) {
      if (signing) process.env[key] = 'fixture-presence-only'; else delete process.env[key];
    }
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const unitId = `${ticketId}-phase-2-round-1`;
    const created = await workItems.create({
      swarmRunId: 'run-1', externalId: ticketId, provider: 'direct', unitId, title: 'Planning Round 1',
      description: '', labels: [], acceptanceCriteria: [], depth: 0,
    });
    const { agentWorker } = createControllerSwarmWorker({
      pool: null,
      getProvider: () => { throw new Error('the registry provider must not run'); },
      agentProfileRepository: { getAgentProfile: async () => null } as never,
      swarmMemoryService: undefined as never,
      costTrackingService: { recordCost: async () => undefined } as never,
      agentMetricsService: { recordExecution: () => undefined } as never,
      meshTransport: transport,
      workItemRepository: workItems,
      runtimeIdentity: {
        agentId: PM_PLANNING_AGENT_ID, agentName: 'project-manager', aliases: [], role: 'project-manager',
        capabilities: [], externalPort: null, endpointUrl: '', internalEndpointUrl: '',
      },
      logger: createChildLogger({ module: 'controller-pm-hosted-brain-spec' }),
    });
    await transport.publish({
      correlationId: `forged-${ticketId}`, fromAgentId: 'not-the-controller', toAgentId: PM_PLANNING_AGENT_ID,
      channel: MESH_CHANNELS.agentDirect(PM_PLANNING_AGENT_ID), createdAt: new Date().toISOString(),
      payload: {
        externalId: ticketId, roundUnitId: unitId, phase: 2, round: 1, ownerSub: OPERATOR,
        workUnits: [planningUnit(ticketId)], workspaceTaskId: ticketId,
      },
    } as unknown as MeshEnvelope);
    await agentWorker.start();
    try {
      for (let i = 0; i < 100; i += 1) {
        const item = (await roundItems(ticketId)).get(unitId);
        if (item && item.status !== 'pending' && item.status !== 'assigned') return item;
        await new Promise((done) => setTimeout(done, 200));
      }
      throw new Error(`the worker never recorded a result for ${created.workItemId}`);
    } finally {
      agentWorker.stop();
    }
  }

  it('with signing configured the envelope is refused before any model or harness runs', async () => {
    const item = await deliverUnsignedEnvelope(true);
    expect(item.status).toBe('failed');
    expect(String((item.executionOutput as { error?: string }).error)).toBe(
      'Unsigned Redis mesh execution is prohibited while delegation enforcement is active',
    );
    expect(wireRequests).toHaveLength(0);
  }, 60_000);

  it('without signing the worker runs its handler as before, which reaches no hosted endpoint', async () => {
    const item = await deliverUnsignedEnvelope(false);
    expect(item.status).toBe('failed');
    expect(String((item.executionOutput as { error?: string }).error)).not.toContain('Unsigned Redis mesh execution');
    expect(wireRequests).toHaveLength(0);
  }, 60_000);
});
