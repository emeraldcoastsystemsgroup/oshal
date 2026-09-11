/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise protected result routes with real policy, signed execution lifecycle, canonical stores and loopback SSE.
 */
import express, { type Request } from 'express';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { get as httpGet, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import { StreamManager } from '@/features/streaming';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { ApplicationRemoteExecutionService } from '@/features/application-remote-execution/service';
import { MemoryRemoteExecutionStore } from '@/features/application-remote-execution/store';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { createRecordedDelegationTokenIssuer, createDelegationTokenVerifier } from '@/shared/security/delegation-token';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { createTaskRoutes } from '@/app/routes/task-routes';
import { createMessageRoutes } from '@/app/routes/message-routes';
import { createStreamRoutes } from '@/app/routes/stream-routes';
import { persistProtectedResultTask } from '@/app/routes/protected-result-persistence';
import type { AppContext } from '@/app/composition/app-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

export const RESULT_APP = 'result-fixture', RESULT_AGENT = 'result-fixture-bot', RESULT_ISSUER = 'https://result.fixture.test';
const NOW = 1_800_000_000_000;
const catalog: AuthorizationCatalog = { version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'records.ask': { resource: 'records', effect: 'execute', minimumTier: 'editor' } },
  roles: { reader: { tier: 'editor', grants: [{ permission: 'records.ask', scope: 'own' }] } },
  bindings: { bots: [{ id: RESULT_AGENT, allOf: ['records.ask'] }] } };

function fixtureActors(): Record<string, AuthorizationActor> {
  return { alice: { sub: 'alice', issuer: RESULT_ISSUER, isActive: true, isSwarmAdmin: false },
    bob: { sub: 'bob', issuer: RESULT_ISSUER, isActive: true, isSwarmAdmin: false },
    twin: { sub: 'alice', issuer: 'https://other.fixture.test', isActive: true, isSwarmAdmin: false },
    admin: { sub: 'admin', issuer: RESULT_ISSUER, isActive: true, isSwarmAdmin: true } };
}

function signing() {
  const key = generateKeyPairSync('ed25519');
  return { issuer: createRecordedDelegationTokenIssuer({ nowEpochSeconds: () => NOW / 1000, env: {
    OSHAL_DELEGATION_SIGNING_KID: 'fixture', OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } }),
  verifier: createDelegationTokenVerifier({ nowEpochSeconds: () => NOW / 1000, env: {
    OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ fixture: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) } }) };
}

async function policyFixture(actors: Record<string, AuthorizationActor>) {
  const state = new MemoryAuthorizationStore();
  const resolve = async (sub: string, issuer: string) => structuredClone(Object.values(actors).find(actor => actor.sub === sub && actor.issuer === issuer) ?? null);
  const policy = new ApplicationAuthorizationService(state, { now: () => NOW, resolveActor: resolve, refreshActor: actor => resolve(actor.sub, actor.issuer) });
  await policy.registerApp({ app: RESULT_APP, source: 'fixture-source', version: '1.0.0', mode: 'enforce', catalog,
    agentIds: [RESULT_AGENT], adapters: { records: { authorize: async () => true } } });
  const change = async (target = 'alice', action: 'grant' | 'revoke' = 'grant') => {
    const actor = actors[target];
    const preview = await policy.previewChange(actors.admin, { app: RESULT_APP, action, role: 'reader', targetSub: actor.sub,
      targetIssuer: actor.issuer, reason: 'Isolated result access proof', expectedRevision: (await state.read()).revision });
    await policy.applyChange(actors.admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
  };
  await change();
  return { policy, change, resolve };
}

function authorityFixture(policy: ApplicationAuthorizationService, resolve: (sub: string, issuer: string) => Promise<AuthorizationActor | null>) {
  const keys = signing(), records = new MemoryRemoteExecutionStore();
  const authority = new ApplicationRemoteExecutionService(records, { ...keys, tokenIssuer: 'urn:oshal:controller', dispatchAudience: 'urn:oshal:bot-node',
    now: () => NOW, owner: async (_kind, agentId) => agentId === RESULT_AGENT ? { app: RESULT_APP, protected: true } : undefined,
    snapshot: app => policy.getApp(app) ? { app, source: 'fixture-source', catalogRevision: policy.getApp(app)!.catalogRevision, generation: 'fixture-generation' } : null,
    refreshActor: actor => resolve(actor.sub, actor.issuer), authorize: (actor, operation) => policy.authorize(actor, operation),
    effective: (actor, app, tenantId) => policy.effective(actor, { app, tenantId }) });
  configureProtectedResultAccess({ assertResultAccess: (...args) => authority.assertResultAccess(...args),
    assertTaskResultAccess: (...args) => authority.assertTaskResultAccess(...args), hasTaskResults: taskId => authority.hasTaskResults(taskId),
    isProtectedAgent: agent => agent === RESULT_AGENT });
  return { authority, records, keys };
}

async function completeExecution(authority: ApplicationRemoteExecutionService, keys: ReturnType<typeof signing>, actor: AuthorizationActor, taskId: string) {
  const prepared = await authority.prepare(actor, { agentId: RESULT_AGENT, taskId, workspaceId: taskId });
  if (!prepared) throw new Error('Fixture must prepare a protected execution');
  const body = { text: 'Fixture known result', taskId, workspaceFolderId: taskId, agentId: RESULT_AGENT,
    userSub: actor.sub, principalIssuer: actor.issuer, applicationExecutionId: prepared.executionId, direct: true, agenticMode: false };
  const receipt = keys.issuer.issue({ iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', azp: RESULT_AGENT,
    sub: actor.sub, principal_iss: actor.issuer, task_id: taskId, method: 'POST', path: '/api/swarm-execute',
    body_sha256: delegationRequestBodySha256(body), scope: ['swarm:execute'] });
  await authority.bind(prepared.executionId, receipt, body);
  for (const phase of ['start', 'work', 'complete'] as const) await authority.revalidate({ executionId: prepared.executionId, token: receipt.token, phase, nonce: randomUUID() });
  return prepared.executionId;
}

function mount(ctx: AppContext, actors: Record<string, AuthorizationActor>) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const actor = actors[String(req.get('x-fixture-user') || '')];
    if (!actor) { res.sendStatus(401); return; }
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: actor.sub, iss: actor.issuer } };
    runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, next);
  });
  app.use('/api/tasks', createTaskRoutes(ctx)); app.use('/api/stream', createStreamRoutes(ctx)); app.use('/api', createMessageRoutes(ctx));
  return app;
}

/**
 * @description Start actual protected result HTTP and streaming routes with isolated canonical stores and policy.
 * @returns Local fixture controls and explicit cleanup; no deployment database or provider is used.
 */
export async function createProtectedResultFixture() {
  const actors = fixtureActors(), { policy, change, resolve } = await policyFixture(actors);
  const { authority, records, keys } = authorityFixture(policy, resolve);
  const tasks = new InMemoryTaskStore(), messages = new InMemoryMessageStore(), streams = new StreamManager();
  const resolveActor = async (req: Request) => { const actor = actors[String(req.get('x-fixture-user'))];
    if (!actor) throw new Error('No fixture identity'); return structuredClone(actor); };
  const ctx = { taskStore: tasks, messageStore: messages, streamManager: streams, applicationAuthorization: { resolveActor },
    workspaceService: { resolveTaskOwner: async () => null } } as unknown as AppContext;
  const server = mount(ctx, actors).listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections: ClientRequest[] = [];
  const call = (path: string, user = 'alice', body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-fixture-user': user, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const seed = async (taskId = 'protected-task', user = 'alice') => {
    const executionId = await completeExecution(authority, keys, actors[user], taskId);
    await persistProtectedResultTask(ctx, taskId, RESULT_AGENT, executionId, actors[user]);
    await messages.save({ taskId, role: 'assistant', type: 'completion', text: 'PRIVATE RESULT 42', contentBlocks: [], metadata: {} });
    return executionId;
  };
  const openStream = (path: string, user = 'alice') => new Promise<{ status: number; text: () => string; request: ClientRequest }>(done => {
    let content = ''; const request = httpGet(base + path, { headers: { 'x-fixture-user': user } }, response => {
      response.on('data', chunk => { content += String(chunk); }); done({ status: response.statusCode!, text: () => content, request });
    }); connections.push(request);
  });
  return { actors, policy, authority, records, tasks, messages, streams, ctx, base, call, change, seed, openStream,
    complete: (taskId: string, user = 'alice') => completeExecution(authority, keys, actors[user], taskId),
    async close() { connections.forEach(request => request.destroy()); server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done())); configureProtectedResultAccess(undefined); } };
}
