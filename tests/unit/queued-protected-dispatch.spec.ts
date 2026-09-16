/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove a queued protected dispatch reaches the real worker gate in the supported hosted shape, refuses honestly without an owner connection, and never admits an agentic queued body.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotNodeClient } from '@/features/agent-management';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { ApplicationRemoteExecutionService, MemoryRemoteExecutionStore } from '@/features/application-remote-execution';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { configureQueuedApplicationPrincipals } from '@/shared/queued-application-principal';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { SpecialistContextRegistry, configureSpecialistContextRegistry } from '@/shared/specialist-context';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { StoredTask } from '@/shared/types';
import type { ITaskStore } from '@/entities/task';
import type { InternalTicket } from '@/entities/ticket';
import { executeManifestApplicationBot } from '@/features/swarm-orchestration/services/manifest-worker-application-execution';
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import { startProtectedWorkerFixture, REMOTE_AGENT, REMOTE_APP, REMOTE_ISSUER, REMOTE_SUB } from '../fixtures/bot-node-protected-execution';

const TICKET_ID = 'queued-protected-task';
const FACT_TOOL = 'fixture-facts';
const HOSTED = { baseUrl: 'https://unused.fixture.test/v1', apiKey: 'fixture-only', model: 'fixture-model' };
const actor: AuthorizationActor = { sub: REMOTE_SUB, issuer: REMOTE_ISSUER, isActive: true, isSwarmAdmin: false };
const admin: AuthorizationActor = { ...actor, sub: 'fixture-admin', isSwarmAdmin: true };
const catalog: AuthorizationCatalog = { version: 1, resources: { work: { scopes: ['own'] } },
  permissions: { 'work.ask': { resource: 'work', effect: 'execute', minimumTier: 'editor' } },
  roles: { reader: { tier: 'editor', grants: [{ permission: 'work.ask', scope: 'own' }] } },
  bindings: { bots: [{ id: REMOTE_AGENT, allOf: ['work.ask'] }], tools: [{ id: FACT_TOOL, allOf: ['work.ask'] }] } };

let fixture: Awaited<ReturnType<typeof startProtectedWorkerFixture>>;
let client: BotNodeClient;
let policy: ApplicationAuthorizationService;
let store: MemoryAuthorizationStore;
let authority: ApplicationRemoteExecutionService;
let remoteStore: MemoryRemoteExecutionStore;
let generation: string;
let tasks: Map<string, StoredTask>;
let taskStore: ITaskStore;
let hostedLookups: string[];
let hostedConnection: typeof HOSTED | null;
let hostedFailure: Error | null;
let builtConnections: unknown[];

/** Ticket the queue would dispatch, carrying only durable verified provenance. */
const ticket = { ticketId: TICKET_ID, ownerSub: REMOTE_SUB, title: 'How did we do in the stock market today?',
  metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: REMOTE_ISSUER } } as unknown as InternalTicket;

/** The exact request shape dispatch-manifest-worker builds for a queued manifest worker. */
function queuedRequest(overrides: Record<string, unknown> = {}) {
  return { text: 'Summarize the book outcome for today.', taskId: TICKET_ID, workspaceFolderId: TICKET_ID,
    agentId: REMOTE_AGENT, agenticMode: true, userSub: REMOTE_SUB, principalIssuer: REMOTE_ISSUER, ...overrides } as never;
}

function memoryTaskStore(): ITaskStore {
  return {
    async create(input: { taskId?: string; title?: string; processingMode?: string; agentId?: string;
      metadata?: Record<string, unknown>; ownerSub?: string }) {
      const now = new Date().toISOString();
      const task = { taskId: input.taskId!, title: input.title ?? '', status: 'created',
        processingMode: input.processingMode ?? 'direct', agentId: input.agentId, messageCount: 0, turnCount: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, totalInputCost: 0, totalOutputCost: 0, totalCost: 0,
        totalRequests: 0, costCurrency: 'USD', usageByModel: {}, metadata: input.metadata ?? {},
        ownerSub: input.ownerSub, createdAt: now, updatedAt: now } as unknown as StoredTask;
      tasks.set(task.taskId, task);
      return task;
    },
    async get(taskId: string) { return tasks.get(taskId) ?? null; },
    async replace(task: StoredTask) { tasks.set(task.taskId, task); return task; },
    async updateStatus() {}, async incrementMessageCount() {}, async incrementTurnCount() {},
    async recordUsage() {}, async list() { return [...tasks.values()]; }, async delete() {},
  } as unknown as ITaskStore;
}

async function change(action: 'grant' | 'revoke') {
  const preview = await policy.previewChange(admin, { action, app: REMOTE_APP, targetSub: actor.sub,
    targetIssuer: actor.issuer, role: 'reader', reason: 'Isolated queued protected dispatch proof',
    expectedRevision: (await store.read()).revision });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}

/** Dispatch exactly as the queue does: no ambient actor, only durable ticket provenance. */
function dispatch(request = queuedRequest()) {
  return runWithSystemIdentity(() => executeManifestApplicationBot(client, ticket, REMOTE_AGENT, request, taskStore,
    async (ownerSub: string) => {
      hostedLookups.push(ownerSub);
      if (hostedFailure) throw hostedFailure;
      return hostedConnection;
    }));
}

beforeEach(async () => {
  generation = randomUUID();
  tasks = new Map();
  taskStore = memoryTaskStore();
  hostedLookups = []; hostedConnection = HOSTED; hostedFailure = null; builtConnections = [];
  store = new MemoryAuthorizationStore();
  remoteStore = new MemoryRemoteExecutionStore();
  policy = new ApplicationAuthorizationService(store);
  await policy.registerApp({ app: REMOTE_APP, source: 'fixture-package', version: '1', mode: 'enforce',
    catalog, agentIds: [REMOTE_AGENT], toolNames: [FACT_TOOL] });
  policy.registerResourceAdapter(REMOTE_APP, 'work', { authorize: async input => input.grant.scope === 'own'
    && input.actor.sub === actor.sub && input.actor.issuer === actor.issuer });
  configureApplicationExecutionPolicy({ owner: () => REMOTE_APP, protectedApp: () => true,
    authorize: (candidate, operation) => policy.authorize(candidate, operation) });
  await change('grant');

  configureQueuedApplicationPrincipals({
    capture: async () => {},
    read: async (ticketId: string) => ticketId === TICKET_ID ? { ...actor } : null,
  });

  const registry = new SpecialistContextRegistry({ owner: () => REMOTE_APP,
    authorize: (candidate, operation) => policy.authorize(candidate, operation) });
  const staged = registry.stage(REMOTE_APP);
  staged.port.register({ agentId: REMOTE_AGENT, toolName: FACT_TOOL, facts: ['open_positions'],
    read: async () => ({ open_positions: 3 }) });
  staged.publish();
  configureSpecialistContextRegistry(registry);

  fixture = await startProtectedWorkerFixture(signing => {
    authority = new ApplicationRemoteExecutionService(remoteStore, {
      owner: async () => ({ app: REMOTE_APP, protected: true }),
      snapshot: app => {
        const registered = policy.getApp(app);
        return registered ? { app, source: registered.source, catalogRevision: registered.catalogRevision, generation } : null;
      },
      refreshActor: async candidate => ({ ...candidate, isActive: true }),
      authorize: (candidate, operation) => policy.authorize(candidate, operation),
      effective: (candidate, app, tenantId) => policy.effective(candidate, { app, tenantId }),
      issuer: signing.recordedIssuer, verifier: signing.verifier,
      tokenIssuer: 'urn:oshal:controller', dispatchAudience: 'urn:oshal:bot-node',
    });
    return authority;
  });
  configureProtectedResultAccess({
    assertResultAccess: (id, candidate, binding) => authority.assertResultAccess(id, candidate, binding),
    assertTaskResultAccess: (id, candidate) => authority.assertTaskResultAccess(id, candidate),
    hasTaskResults: id => authority.hasTaskResults(id),
    isProtectedAgent: () => true,
  });
  const built = fixture.controller._buildByoLlm.bind(fixture.controller);
  fixture.controller._buildByoLlm = (connection: unknown) => { builtConnections.push(connection); return built(connection); };
  vi.stubEnv('SWARM_SERVICE_SECRET', String(fixture.env.SWARM_SERVICE_SECRET));
  client = new BotNodeClient(() => fixture.workerUrl, 4000, { env: {},
    recordedDelegationIssuer: fixture.recordedIssuer, remoteExecutionAuthority: authority });
});

afterEach(async () => {
  configureApplicationExecutionPolicy(undefined);
  configureQueuedApplicationPrincipals(undefined);
  configureProtectedResultAccess(undefined);
  configureSpecialistContextRegistry(undefined);
  await fixture?.close();
  vi.unstubAllEnvs();
});

describe('queued protected dispatch in the supported shape', () => {
  it('is accepted end to end by the real worker gate with the owner hosted connection', async () => {
    const result = await dispatch();
    expect(result).toMatchObject({ success: true, response: 'Fixture protected answer', provider: 'fixture-hosted' });
    expect(hostedLookups).toEqual([REMOTE_SUB]);
    expect(builtConnections).toEqual([HOSTED]);
    expect(fixture.state.phases[0]).toBe('start');
    expect(fixture.state.phases.at(-1)).toBe('complete');
    expect(fixture.state.calls).toHaveLength(1);
    expect(fixture.state.calls[0].options).toMatchObject({ tools: [], enforceToolBoundary: true });
    const record = await remoteStore.read(result.applicationExecutionId!);
    expect(record).toMatchObject({ status: 'completed', binding: { app: REMOTE_APP, agentId: REMOTE_AGENT,
      sub: REMOTE_SUB, issuer: REMOTE_ISSUER, taskId: TICKET_ID } });
  });

  it('carries the package specialist-context facts, read under the restored ticket owner, into the worker prompt', async () => {
    await dispatch();
    const prompt = String((fixture.state.calls[0].messages as Array<{ content: string }>)[0].content);
    expect(prompt).toContain(`Application facts (${REMOTE_APP}; ${FACT_TOOL})`);
    const untrusted = JSON.parse(prompt.match(/<UNTRUSTED_CONTENT>([\s\S]*)<\/UNTRUSTED_CONTENT>/)![1]) as { content: string };
    expect(untrusted.content).toContain('{"open_positions":3}');
  });
});

describe('queued protected dispatch without a hosted owner connection', () => {
  it('refuses with the exact missing requirement and dispatches nothing', async () => {
    hostedConnection = null;
    await expect(dispatch()).rejects.toThrow(/no hosted AI connection/i);
    expect(hostedLookups).toEqual([REMOTE_SUB]);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
    expect(tasks.size).toBe(0);
  });

  it('names an incomplete hosted connection instead of sending a body the worker would deny', async () => {
    hostedConnection = { ...HOSTED, apiKey: '  ' };
    await expect(dispatch()).rejects.toThrow(/apiKey/);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });

  it('reports a failed resolution as a resolution failure, not as a missing connection', async () => {
    hostedFailure = new Error('provider ladder unavailable');
    await expect(dispatch()).rejects.toThrow(/provider ladder unavailable/);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });

  it('refuses when no hosted resolver is wired at all', async () => {
    await expect(runWithSystemIdentity(() => executeManifestApplicationBot(
      client, ticket, REMOTE_AGENT, queuedRequest(), taskStore))).rejects.toThrow(/hosted-connection resolver/);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });
});

describe('the agentic and credential-bearing queued shapes stay refused', () => {
  it('refuses a queued request carrying a deterministic provider intent', async () => {
    await expect(dispatch(queuedRequest({ providerIntent: { kind: 'priority-email' } })))
      .rejects.toThrow(/provider intent|connector credential/i);
    expect(hostedLookups).toEqual([]);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });

  it('refuses a queued request carrying connector credentials', async () => {
    await expect(dispatch(queuedRequest({ creds: { OSHAL_CRED_GOOGLE: 'token' } })))
      .rejects.toThrow(/provider intent|connector credential/i);
    expect(hostedLookups).toEqual([]);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });

  it('still denies the unshaped agentic queue body at the unchanged worker gate', async () => {
    const agentic = fixture.issue({ agenticMode: true, direct: undefined, byoLlmConnection: undefined });
    const response = await fixture.post(agentic);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({ success: false, error: 'authorization_remote_hosted_reasoning_required' });
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
    expect(fixture.store.listTasks()).toEqual([]);
  });
});

describe('the real queue dispatcher on a protected worker', () => {
  /** Ticket the queue polls, with the durable provenance protected dispatch requires. */
  function queuedTicket(): InternalTicket {
    return { ticketId: TICKET_ID, ticketType: 'trading-decision', title: 'How did we do in the stock market today?',
      description: 'Report today\'s outcome.', status: 'approved', stateGroup: 'active', executionPhase: null,
      priority: 'medium', labels: [], workspaceId: null, assignedAgentId: null, parentTicketId: null,
      externalProvider: null, externalId: null, externalUrl: null, ownerSub: REMOTE_SUB,
      metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: REMOTE_ISSUER },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as unknown as InternalTicket;
  }

  function dispatcherDeps(resolveHostedConnection?: (ownerSub: string) => Promise<typeof HOSTED | null>) {
    const statuses: Array<{ status: string; metadata: Record<string, unknown> }> = [];
    const messages: Array<Record<string, unknown>> = [];
    const deps = {
      activeTicketIds: new Set<string>(), dispatchStartTimes: new Map<string, number>(),
      resolveAgentIdByName: async () => REMOTE_AGENT,
      botNodeClient: client,
      ticketService: { updateStatus: async (_id: string, status: string, metadata: Record<string, unknown>) => {
        statuses.push({ status, metadata });
      } },
      taskStore,
      messageStore: { getByTask: async () => [], save: async (message: Record<string, unknown>) => { messages.push(message); } },
      // Unroutable so a regression that fell back to localhost would surface as a connection
      // failure rather than quietly replacing the honest refusal.
      port: '1',
      resolveHostedConnection,
    };
    return { deps, statuses, messages };
  }

  it('completes a protected ticket through the real worker with push-on-dispatch stamping enabled', async () => {
    const { deps, statuses, messages } = dispatcherDeps(async ownerSub => { hostedLookups.push(ownerSub); return HOSTED; });
    await dispatchManifestWorkerTicket(queuedTicket(), { ticketType: 'trading-decision', name: 'Trading decision',
      pipeline: 'manifest-worker', workerBot: 'protected-reasoner' } as never, deps as never);
    expect(hostedLookups).toEqual([REMOTE_SUB]);
    expect(fixture.state.calls).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ status: 'complete' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'assistant', text: 'Fixture protected answer' });
  });

  it('escalates with the exact missing requirement when the owner has no hosted connection', async () => {
    const { deps, statuses } = dispatcherDeps(async () => null);
    await dispatchManifestWorkerTicket(queuedTicket(), { ticketType: 'trading-decision', name: 'Trading decision',
      pipeline: 'manifest-worker', workerBot: 'protected-reasoner' } as never, deps as never);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
    const escalation = statuses.find(entry => entry.status === 'escalated');
    expect(escalation).toBeDefined();
    expect(String(escalation!.metadata.message)).toContain('authorization_queued_protected_shape_required');
    expect(String(escalation!.metadata.message)).toContain('no hosted AI connection');
    expect(String(escalation!.metadata.message)).not.toMatch(/ECONNREFUSED|send-message/);
  });
});
