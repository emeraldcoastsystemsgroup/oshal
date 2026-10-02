/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for build-lane planning crossing the signed bot-node hop (controller-pm-round-executor.ts; replaces controller-pm-hosted-brain-postgres, whose hosted-key path was removed). Runs the real MultiRoundDispatchService over a queueing mesh transport and real Postgres work items, with the real executor sending project-manager's round through a real BotNodeClient (a locally generated Ed25519 key) to a real loopback node that verifies every delegation token against the public half. Proves: one signed request bound to the root owner and verified issuer reaches the configured planning node, carries no credential or model choice, and its reply is the round output; refusals by name (no owner, no issuer, non-operator, protected application, a planning node that is unknown, owns no node or is off the allowlist) make no node call; a node failure or an unreachable node is a named failed output with no mesh fallback; under signing a round no executor owns is skipped and the controller's own mesh worker refuses unsigned execution; without signing the reviewer round still crosses the mesh.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import * as http from 'node:http';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { WorkItemRepository } from '../../src/entities/work-item';
import {
  BotNodeClient,
  MESH_CHANNELS,
  MeshCommunicationService,
  type ConsumedEnvelope,
  type MeshEnvelope,
  type MeshSubscription,
  type MeshTransport,
} from '../../src/features/agent-management';
import { BUILD_EXECUTION_TARGETS, MultiRoundDispatchService, type RoundOwner } from '../../src/features/swarm-orchestration';
import type { DecomposedWorkUnit } from '../../src/features/swarm-orchestration/services/ticket-decomposition-service';
import { createDelegationTokenVerifier } from '../../src/shared/security/delegation-token';
import { delegationRequestBodySha256 } from '../../src/shared/security/delegation-request-binding';
import type { DelegationTokenClaims } from '../../src/shared/types';
import { createChildLogger } from '../../src/shared/logger';
import { runWithSystemIdentity } from '../../src/shared/services/database/request-identity';
import {
  DEFAULT_PLANNING_NODE,
  PLANNING_NODE_ENV,
  PLANNING_REPLY_NOTE,
  PM_PLANNING_AGENT_ID,
  createControllerPmRoundExecutor,
  type ControllerPmRoundExecutorDeps,
} from '../../src/app/extensions/swarm/controller-pm-round-executor';
import { createControllerSwarmWorker } from '../../src/app/extensions/swarm/controller-swarm-worker';
import { SwarmBotRegistry } from '../../src/app/extensions/swarm/swarm-bot-registry';

const OPERATOR = 'pm-planning-operator-sub';
const OTHER_OWNER = 'pm-planning-other-sub';
const ISSUER = 'https://issuer.fixture.invalid';
const REVIEWER_ID = 'a0000000-0000-0000-0000-000000000003';
const ARCHITECT_ID = 'a0000000-0000-0000-0000-000000000018';
const KID = 'spec-pm-planning-node';
const PAIR = generateKeyPairSync('ed25519');
const pem = (key: KeyObject, type: 'pkcs8' | 'spki') => key.export({ format: 'pem', type }).toString();
/** The controller's signing half, handed to the client explicitly; never the process environment. */
const SIGNING = { OSHAL_DELEGATION_SIGNING_KID: KID, OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: pem(PAIR.privateKey, 'pkcs8') } as NodeJS.ProcessEnv;
const verifier = createDelegationTokenVerifier({ env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ [KID]: pem(PAIR.publicKey, 'spki') }) } });
const PLAN = [
  '## Project Plan', '', 'Two modules.', '', '## SUBTASK DECOMPOSITION', '',
  '### Subtask 1: Build the CSV parser module', 'Parse rows. Suggested agent role: code-developer', '',
  '### Subtask 2: Build the schema validator module', 'Validate rows. Suggested agent role: code-developer',
].join('\n');
/** The process-environment signing keys the controller worker reads (presence only). */
const WORKER_SIGNING_ENV = ['OSHAL_DELEGATION_SIGNING_KID', 'OSHAL_DELEGATION_SIGNING_PRIVATE_KEY'] as const;
const USAGE = { inputTokens: 900, outputTokens: 300, totalTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 };

interface ReceivedDispatch { body: Record<string, unknown>; claims?: DelegationTokenClaims; verifyError?: string }

const received: ReceivedDispatch[] = [];
let node: { baseUrl: string; failNext: boolean; close: () => Promise<void> };
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
 * @description A real loopback bot node: it verifies the delegation token against the public half,
 * records the request, and answers the planning reply (or a failed execution when asked to).
 * @returns A started node.
 */
async function startNode(): Promise<typeof node> {
  const state = { failNext: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const record: ReceivedDispatch = { body };
      try {
        record.claims = verifier.verify(String(req.headers['x-oshal-delegation-token'] ?? ''), {
          iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', azp: String(body.agentId), task_id: String(body.taskId),
          method: 'POST', path: '/api/swarm-execute', body_sha256: delegationRequestBodySha256(body), scope: ['swarm:execute'],
          sub: String(body.userSub), principal_iss: String(body.principalIssuer),
        });
      } catch (err) {
        record.verifyError = err instanceof Error ? err.message : String(err);
      }
      received.push(record);
      const failed = state.failNext;
      state.failNext = false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(failed
        ? { success: false, error: 'the engine refused the turn', response: '', cost: 0, model: 'node-model', provider: 'node-provider', durationMs: 1, usage: { ...USAGE, inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
        : { success: true, response: PLAN, cost: 0, model: 'node-model', provider: 'node-provider', durationMs: 1, usage: USAGE }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    get failNext() { return state.failNext; },
    set failNext(value: boolean) { state.failNext = value; },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** A signed client whose endpoint resolver points the architect at the loopback node. */
function clientFor(resolve: (agentId: string) => string | null = (agentId) => (agentId === ARCHITECT_ID ? node.baseUrl : null)) {
  return new BotNodeClient(resolve, 5_000, { env: SIGNING });
}

/**
 * @description The real executor with fixture seams for the operator list and application
 * protection; the registry read and the planning-node rules stay the production ones.
 * @param overrides - Seams a case replaces.
 * @returns The executor deps.
 */
function executorDeps(overrides: Partial<ControllerPmRoundExecutorDeps> = {}): ControllerPmRoundExecutorDeps {
  return {
    botNodeClient: clientFor(),
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

/** The round as the queue manager runs it: under the trusted SYSTEM identity, which may act for the root's owner. */
function planningRound(service: MultiRoundDispatchService, ticketId: string, owner: RoundOwner) {
  return runWithSystemIdentity(() => service.executePhaseWithRounds('run-1', ticketId, 2, [planningUnit(ticketId)], PM_PLANNING_AGENT_ID, policy, ticketId, owner));
}

function errorOf(result: { finalOutput?: unknown }): string {
  return String((result.finalOutput as { error?: string } | undefined)?.error);
}

beforeAll(async () => {
  node = await startNode();
  fixturePg = new DisposablePostgres({ purpose: 'controller-pm-planning-node' });
  pool = await fixturePg.start();
  workItems = new WorkItemRepository(pool);
  for (const key of [...WORKER_SIGNING_ENV, PLANNING_NODE_ENV]) savedEnv[key] = process.env[key];
}, 180_000);

beforeEach(() => {
  received.length = 0;
  for (const key of [...WORKER_SIGNING_ENV, PLANNING_NODE_ENV]) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

afterAll(async () => {
  await node.close();
  await fixturePg.stop();
}, 120_000);

describe('build-lane planning crosses the signed hop to the configured planning node', () => {
  it('sends project-manager round 1 to the architect node as the owner, records the reply as the round output, and skips the reviewer round under signing', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const result = await planningRound(dispatchService(transport, true, executorDeps()), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });

    expect(received).toHaveLength(1);
    const [sent] = received;
    expect(sent.verifyError).toBeUndefined();
    expect(sent.claims).toMatchObject({ sub: OPERATOR, principal_iss: ISSUER, azp: ARCHITECT_ID, task_id: ticketId });
    expect(sent.body).toMatchObject({ agentId: ARCHITECT_ID, taskId: ticketId, workspaceFolderId: ticketId, userSub: OPERATOR, principalIssuer: ISSUER, agenticMode: true });
    const text = String(sent.body.text);
    expect(text).toContain('SUBTASK DECOMPOSITION');
    expect(text.endsWith(PLANNING_REPLY_NOTE)).toBe(true);
    // No credential, endpoint or model choice rides the request: the node's switch rows decide.
    expect(JSON.stringify(sent.body)).not.toMatch(/apiKey|byoLlmConnection|baseUrl/);

    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]).toMatchObject({ agentId: PM_PLANNING_AGENT_ID, round: 1, executedInProcess: true });
    expect(result.finalOutput).toMatchObject({ agentId: PM_PLANNING_AGENT_ID, executedBy: ARCHITECT_ID, content: PLAN, provider: 'node-provider', model: 'node-model' });
    expect(transport.published).toHaveLength(0);

    const items = await roundItems(ticketId);
    const round1 = items.get(`${ticketId}-phase-2-round-1`);
    expect(round1?.status).toBe('completed');
    expect(round1?.assignedAgentId).toBe(PM_PLANNING_AGENT_ID);
    expect((round1?.executionOutput as { content?: string })?.content).toBe(PLAN);
    expect(items.has(`${ticketId}-phase-2-round-2`)).toBe(false);
  }, 60_000);

  it.each([
    ['a root with no verified issuer', { ownerSub: OPERATOR, principalIssuer: null }, 'the root ticket carries no verified principal issuer'],
    ['an ownerless root', { ownerSub: null, principalIssuer: ISSUER }, 'the root ticket has no owner'],
    ['a root owned by someone who is not an operator', { ownerSub: OTHER_OWNER, principalIssuer: ISSUER }, 'the root ticket owner is not a deployment operator'],
  ])('refuses %s by name and calls no node', async (_label, owner, reason) => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const result = await planningRound(dispatchService(transport, true, executorDeps()), ticketId, owner as RoundOwner);

    expect(received).toHaveLength(0);
    expect(result.finalOutput).toMatchObject({ status: 'failed' });
    expect(errorOf(result)).toBe(`pm_planning_refused: ${reason}`);
    expect((await roundItems(ticketId)).get(`${ticketId}-phase-2-round-1`)?.status).toBe('failed');
    expect(transport.published).toHaveLength(0);
  }, 30_000);

  it('refuses when project-manager or the planning node bot is bound to a protected application, and when that check fails', async () => {
    const variants: Array<[ControllerPmRoundExecutorDeps['isProtected'], string]> = [
      [async (agentId) => agentId === PM_PLANNING_AGENT_ID, 'project-manager is bound to a protected application'],
      [async (agentId) => agentId === ARCHITECT_ID, 'the planning node bot is bound to a protected application'],
      [async () => { throw new Error('authorization store down'); }, 'the protected-application check failed'],
    ];
    for (const [isProtected, reason] of variants) {
      const ticketId = freshTicketId();
      const result = await planningRound(dispatchService(new QueueMeshTransport(), true, executorDeps({ isProtected })), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });
      expect(errorOf(result)).toBe(`pm_planning_refused: ${reason}`);
    }
    expect(received).toHaveLength(0);
  }, 30_000);

  it('refuses by name a planning node that is unknown, owns no node or is off the build-lane allowlist, reading the setting', async () => {
    const offAllowlist = SwarmBotRegistry.listDefinitions().find((d) => d.requiresOwnNode && d.agentId && !BUILD_EXECUTION_TARGETS.has(d.agentId))?.name;
    expect(offAllowlist).toBeDefined();
    const variants: Array<[string, string]> = [
      ['no-such-bot', `${PLANNING_NODE_ENV} names no registry bot (no-such-bot)`],
      ['project-manager', `the planning node project-manager does not own a node (${PLANNING_NODE_ENV})`],
      [offAllowlist as string, `the planning node ${offAllowlist} is not a build-lane execution target (${PLANNING_NODE_ENV})`],
    ];
    for (const [planningNode, reason] of variants) {
      const ticketId = freshTicketId();
      const result = await planningRound(dispatchService(new QueueMeshTransport(), true, executorDeps({ planningNode })), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });
      expect(errorOf(result)).toBe(`pm_planning_refused: ${reason}`);
    }
    process.env[PLANNING_NODE_ENV] = 'no-such-bot';
    const ticketId = freshTicketId();
    const result = await planningRound(dispatchService(new QueueMeshTransport(), true, executorDeps()), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });
    expect(errorOf(result)).toBe(`pm_planning_refused: ${PLANNING_NODE_ENV} names no registry bot (no-such-bot)`);
    expect(DEFAULT_PLANNING_NODE).toBe('system-architect');
    expect(received).toHaveLength(0);
  }, 30_000);

  it('a node that reports a failed execution yields a named failed output, recorded on the round', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    node.failNext = true;
    const result = await planningRound(dispatchService(transport, true, executorDeps()), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });

    expect(received).toHaveLength(1);
    expect(result.finalOutput).toMatchObject({ status: 'failed', error: 'pm_planning_node_failed: Bot node execution failed: the engine refused the turn' });
    expect((await roundItems(ticketId)).get(`${ticketId}-phase-2-round-1`)?.status).toBe('failed');
    expect(transport.published).toHaveLength(0);
  }, 30_000);

  it('an unreachable planning node yields a named failed output and nothing on the mesh', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const result = await planningRound(dispatchService(transport, true, executorDeps({ botNodeClient: clientFor(() => null) })), ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER });

    expect(received).toHaveLength(0);
    expect(errorOf(result)).toMatch(/^pm_planning_node_failed: No endpoint found/);
    expect(transport.published).toHaveLength(0);
  }, 30_000);

  it('under signing, a round no in-process executor owns publishes nothing and creates no work item', async () => {
    const transport = new QueueMeshTransport();
    const ticketId = freshTicketId();
    const service = dispatchService(transport, true, executorDeps());
    const result = await runWithSystemIdentity(() => service.executePhaseWithRounds('run-1', ticketId, 8, [planningUnit(ticketId)], ARCHITECT_ID, policy, ticketId, { ownerSub: OPERATOR, principalIssuer: ISSUER }));

    expect(result).toMatchObject({ rounds: [], finalOutput: undefined, allRoundsComplete: false });
    expect(transport.published).toHaveLength(0);
    expect((await roundItems(ticketId)).size).toBe(0);
    expect(received).toHaveLength(0);
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

    expect(received).toHaveLength(1);
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
    for (const key of WORKER_SIGNING_ENV) {
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
      logger: createChildLogger({ module: 'controller-pm-planning-node-spec' }),
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
    expect(received).toHaveLength(0);
  }, 60_000);

  it('without signing the worker runs its handler as before, which reaches no node', async () => {
    const item = await deliverUnsignedEnvelope(false);
    expect(item.status).toBe('failed');
    expect(String((item.executionOutput as { error?: string }).error)).not.toContain('Unsigned Redis mesh execution');
    expect(received).toHaveLength(0);
  }, 60_000);
});
