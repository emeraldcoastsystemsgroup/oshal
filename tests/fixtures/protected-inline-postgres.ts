/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Own a private enforcing PostgreSQL server for real protected inline task/message HTTP routes, canonical persisted stores, current application policy and the real orchestrator. Only the model provider is doubled; package resources and dependency membership are SQL-backed fixture data.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Subscribe through the real loopback SSE route before inline work and own every stream connection through explicit fixture cleanup.
 */
import express, { type Request } from 'express';
import { get as httpGet, type ClientRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import { InMemoryTicketStore, InMemoryWorkspaceStore, WorkspaceService } from '@/features/ticketing';
import { StreamManager } from '@/features/streaming';
import { TaskOrchestrator } from '@/features/chat-orchestration/services/task-orchestrator';
import { LLMService, type LLMResponse, type SendRequestOptions } from '@/features/llm-provider/services/llm-service';
import { AUTHORIZATION_SCHEMA, ApplicationAuthorizationService, PostgresAuthorizationStore } from '@/features/application-authorization';
import { REMOTE_EXECUTION_SCHEMA, ApplicationRemoteExecutionService, PostgresRemoteExecutionStore } from '@/features/application-remote-execution';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { configureApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { createRecordedDelegationTokenIssuer, createDelegationTokenVerifier } from '@/shared/security/delegation-token';
import { ensureConversationStoreSchema } from '@/shared/services/database/conversation-schema';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createTaskRoutes } from '@/app/routes/task-routes';
import { createMessageRoutes } from '@/app/routes/message-routes';
import { createStreamRoutes } from '@/app/routes/stream-routes';
import type { AppContext } from '@/app/composition/app-context';

export const INLINE_APP = 'inline-fixture', INLINE_DEPENDENCY = 'inline-data';
export const INLINE_AGENT = 'e1f10000-0000-4000-8000-000000000001';
export const INLINE_ISSUER = 'https://inline.fixture.test';
export const INLINE_REPLY = 'PRIVATE INLINE REPLY 734';
export const INLINE_RUNTIME_ROLE = 'protected_inline_runtime';

const catalog: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'records.ask': { resource: 'records', effect: 'execute', minimumTier: 'editor' } },
  roles: { runner: { tier: 'editor', grants: [{ permission: 'records.ask', scope: 'own' }] } },
  bindings: { bots: [{ id: INLINE_AGENT, allOf: ['records.ask'] }] },
};

/** Synthetic vendor response only: orchestration, persistence and authority remain production code. */
class InlineProvider extends LLMService {
  calls = 0;
  private waiting?: { entered: () => void; released: Promise<void>; work?: () => Promise<void> };
  constructor() { super('inline-fixture-provider', {}); }
  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    this.calls++;
    const waiting = this.waiting; this.waiting = undefined;
    if (waiting) { waiting.entered(); if (waiting.work) await waiting.work(); await waiting.released; }
    return { content: [{ type: 'text', text: INLINE_REPLY }],
      usage: { inputTokens: 7, outputTokens: 3 }, model: 'inline-fixture-model' };
  }
  holdNext(work?: () => Promise<void>) {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const released = new Promise<void>(done => { release = done; });
    this.waiting = { entered, released, work };
    return { entered: started, release };
  }
}

function createActors(): Record<string, AuthorizationActor> {
  return {
    owner: { sub: 'inline-owner', issuer: INLINE_ISSUER, isActive: true, isSwarmAdmin: false },
    foreign: { sub: 'inline-foreign', issuer: INLINE_ISSUER, isActive: true, isSwarmAdmin: false },
    twin: { sub: 'inline-owner', issuer: 'https://other.fixture.test', isActive: true, isSwarmAdmin: false },
    admin: { sub: 'inline-admin', issuer: INLINE_ISSUER, isActive: true, isSwarmAdmin: true },
  };
}

/** Replace every inherited database selector before constructing production optional pools. */
function configureEnvironment(database: DisposablePostgres): void {
  for (const name of Object.keys(process.env).filter(key => /^PG/.test(key) || /^POSTGRES_/.test(key))) vi.stubEnv(name, undefined);
  const connection = database.roleConnection(INLINE_RUNTIME_ROLE);
  const url = new URL(`postgresql://127.0.0.1:${connection.port}/${connection.database}`);
  url.username = connection.user; url.password = connection.password;
  vi.stubEnv('DATABASE_URL', url.toString());
  vi.stubEnv('PGPOOL_MAX', '2'); vi.stubEnv('OSHAL_DB_GUC', 'on'); vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'auto'); vi.stubEnv('OSHAL_NO_AI', 'false');
  vi.stubEnv('MOCK_OIDC', 'false'); vi.stubEnv('OSHAL_EXECUTE_ENTITLEMENT', 'enforce');
}

async function bootstrap(owner: Pool): Promise<void> {
  await ensureConversationStoreSchema(owner);
  for (const sql of [...AUTHORIZATION_SCHEMA, ...REMOTE_EXECUTION_SCHEMA]) await owner.query(sql);
  await owner.query(`CREATE TABLE inline_fixture_records (owner_sub TEXT PRIMARY KEY)`);
  await owner.query('ALTER TABLE inline_fixture_records ENABLE ROW LEVEL SECURITY');
  await owner.query('ALTER TABLE inline_fixture_records FORCE ROW LEVEL SECURITY');
  await owner.query(`CREATE POLICY fixture_record_owner ON inline_fixture_records
    USING (owner_sub=current_setting('oshal.current_sub',true))
    WITH CHECK (owner_sub=current_setting('oshal.current_sub',true))`);
  for (const sub of ['inline-owner', 'inline-foreign', 'inline-admin']) {
    await owner.query('INSERT INTO inline_fixture_records VALUES ($1)', [sub]);
  }
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${INLINE_RUNTIME_ROLE}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${INLINE_RUNTIME_ROLE}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${INLINE_RUNTIME_ROLE}`);
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
}

function signing() {
  const key = generateKeyPairSync('ed25519');
  return {
    issuer: createRecordedDelegationTokenIssuer({ env: { OSHAL_DELEGATION_SIGNING_KID: 'inline-fixture',
      OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } }),
    verifier: createDelegationTokenVerifier({ env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({
      'inline-fixture': key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) } }),
  };
}

async function registerPolicy(policy: ApplicationAuthorizationService, runtime: Pool): Promise<void> {
  const ownsRecord = async (actor: AuthorizationActor) => Boolean((await runWithRequestIdentity({ sub: actor.sub,
    principalIssuer: actor.issuer, isOperator: false }, () => runtime.query(
      'SELECT owner_sub FROM inline_fixture_records WHERE owner_sub=$1', [actor.sub]))).rowCount);
  await policy.registerApp({ app: INLINE_DEPENDENCY, source: 'inline-fixture-source', version: '1.0.0', mode: 'enforce',
    catalog: { ...catalog, bindings: {} }, adapters: { records: { authorize: input => ownsRecord(input.actor) } } });
  await policy.registerApp({ app: INLINE_APP, source: 'inline-fixture-source', version: '1.0.0', mode: 'enforce',
    catalog, agentIds: [INLINE_AGENT], requiredApps: [INLINE_DEPENDENCY], adapters: { records: { authorize: async input => {
      const dependency = await policy.effective(input.actor, { app: INLINE_DEPENDENCY });
      return !dependency.denied && dependency.permissions.some(grant => grant.permission === 'records.ask') && await ownsRecord(input.actor);
    } } } });
}

async function change(policy: ApplicationAuthorizationService, store: PostgresAuthorizationStore,
  actors: Record<string, AuthorizationActor>, user = 'owner', action: 'grant' | 'revoke' = 'grant', app = INLINE_APP): Promise<void> {
  const actor = actors[user];
  const preview = await policy.previewChange(actors.admin, { app, action, role: 'runner', targetSub: actor.sub,
    targetIssuer: actor.issuer, reason: 'Private inline regression', expectedRevision: (await store.read()).revision });
  await policy.applyChange(actors.admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}

function configureAuthority(policy: ApplicationAuthorizationService, runtime: Pool,
  resolve: (sub: string, issuer: string) => Promise<AuthorizationActor | null>) {
  const records = new PostgresRemoteExecutionStore(runtime);
  const owner = async (_kind: 'bots' | 'tools', id: string) => runWithSystemIdentity(async () => {
    const row = (await runtime.query('SELECT app_name, protected FROM oshal_authorization_applications WHERE $1=ANY(agent_ids)', [id])).rows[0];
    return row ? { app: row.app_name as string, protected: row.protected as boolean } : undefined;
  });
  const authority = new ApplicationRemoteExecutionService(records, { ...signing(),
    tokenIssuer: 'urn:oshal:controller', dispatchAudience: 'urn:oshal:bot-node', owner,
    snapshot: app => { const value = policy.getApp(app); return value ? { app, source: value.source,
      catalogRevision: value.catalogRevision, generation: 'inline-fixture-generation' } : null; },
    refreshActor: actor => resolve(actor.sub, actor.issuer), authorize: (actor, operation) => policy.authorize(actor, operation),
    effective: (actor, app, tenantId) => policy.effective(actor, { app, tenantId }) });
  configureApplicationRemoteExecutionAuthority(authority);
  configureApplicationExecutionPolicy({ owner: async (kind, id) => (await owner(kind, id))?.app,
    protectedApp: app => Boolean(policy.getApp(app)), authorize: (actor, operation) => policy.authorize(actor, operation) });
  configureProtectedResultAccess({ assertResultAccess: (...args) => authority.assertResultAccess(...args),
    assertTaskResultAccess: (...args) => authority.assertTaskResultAccess(...args), hasTaskResults: id => authority.hasTaskResults(id),
    linkResult: (...args) => authority.linkResult(...args), isProtectedAgent: async id => Boolean((await owner('bots', id))?.protected) });
  return { authority, records };
}

function mount(ctx: AppContext, actors: Record<string, AuthorizationActor>) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const actor = actors[String(req.get('x-fixture-user'))];
    if (!actor) { res.sendStatus(401); return; }
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true,
      user: { sub: actor.sub, iss: actor.issuer }, idTokenClaims: { iss: actor.issuer } };
    runWithApplicationAuthorizationActor(structuredClone(actor), () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: false }, next));
  });
  app.use('/api/tasks', createTaskRoutes(ctx)); app.use('/api/stream', createStreamRoutes(ctx)); app.use('/api', createMessageRoutes(ctx));
  return app;
}

function createContext(actors: Record<string, AuthorizationActor>, provider: InlineProvider, runtime: Pool) {
  const tasks = new InMemoryTaskStore(), messages = new InMemoryMessageStore(), streams = new StreamManager();
  const orchestrator = new TaskOrchestrator({ taskStore: tasks, messageStore: messages, streamManager: streams,
    getProvider: () => provider, getTools: async () => [], getSystemPrompt: async () => 'Private fixture system prompt',
    executeTool: async () => { throw new Error('This direct chat fixture cannot execute tools'); } });
  const resolveActor = async (req: Request) => {
    const actor = actors[String(req.get('x-fixture-user'))];
    if (!actor) throw new Error('Fixture actor missing'); return structuredClone(actor);
  };
  const ctx = { taskStore: tasks, messageStore: messages, streamManager: streams, orchestrator, pool: runtime,
    applicationAuthorization: { resolveActor },
    workspaceService: new WorkspaceService(new InMemoryWorkspaceStore(), new InMemoryTicketStore()) } as unknown as AppContext;
  return { tasks, messages, ctx };
}

/** Canonical stores own optional pools without a public close API; fixture cleanup owns those generated connections. */
async function closeStores(stores: ReturnType<typeof createContext>): Promise<void> {
  for (const store of [stores.tasks, stores.messages]) {
    const pool = (store as unknown as { pool: Pool | null }).pool;
    if (pool) await pool.end();
  }
}

async function listen(ctx: AppContext, actors: Record<string, AuthorizationActor>) {
  const server = mount(ctx, actors).listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}

function openStream(base: string, taskId: string, connections: Set<ClientRequest>, user = 'owner') {
  return new Promise<{ status: number; text: () => string; closed: () => boolean; destroy: () => void }>((done, reject) => {
    let content = '', closed = false, settled = false;
    const request = httpGet(`${base}/api/stream/${taskId}`, { headers: { 'x-fixture-user': user, accept: 'text/event-stream' } }, response => {
      response.on('data', chunk => { content += String(chunk); });
      response.on('end', () => { closed = true; }); response.on('close', () => { closed = true; });
      settled = true; done({ status: response.statusCode!, text: () => content, closed: () => closed, destroy: () => request.destroy() });
    });
    request.on('error', error => { closed = true; if (!settled) reject(error); });
    request.on('close', () => { closed = true; connections.delete(request); }); connections.add(request);
  });
}

/** @description Build one owned PostgreSQL/HTTP lifetime with complete explicit cleanup and reload controls. */
export async function createProtectedInlinePostgresFixture() {
  const database = new DisposablePostgres({ purpose: 'protected-inline-thread', roles: [INLINE_RUNTIME_ROLE],
    migrations: ['078-cost-governance.sql', '090-cost-event-tokens-duration.sql'] });
  const actors = createActors(), provider = new InlineProvider();
  const connections = new Set<ClientRequest>();
  let stores: ReturnType<typeof createContext> | undefined, server: Server | undefined;
  try {
    const owner = await database.start(); configureEnvironment(database); await bootstrap(owner);
    const runtime = wrapPoolWithGuc(database.rolePool(INLINE_RUNTIME_ROLE));
    const state = new PostgresAuthorizationStore(runtime);
    const resolve = async (sub: string, issuer: string) => structuredClone(Object.values(actors).find(actor => actor.sub === sub && actor.issuer === issuer) ?? null);
    let policy = new ApplicationAuthorizationService(state, { resolveActor: resolve, refreshActor: actor => resolve(actor.sub, actor.issuer) });
    await registerPolicy(policy, runtime);
    for (const user of Object.keys(actors)) for (const app of [INLINE_DEPENDENCY, INLINE_APP]) await change(policy, state, actors, user, 'grant', app);
    let authorityState = configureAuthority(policy, runtime, resolve);
    stores = createContext(actors, provider, runtime);
    let endpoint = await listen(stores.ctx, actors); server = endpoint.server;
    return { database, owner, runtime, actors, provider,
      get tasks() { return stores!.tasks; }, get messages() { return stores!.messages; }, get ctx() { return stores!.ctx; },
      get policy() { return policy; }, get authority() { return authorityState.authority; }, get records() { return authorityState.records; },
      call: (path: string, user = 'owner', body?: unknown) => fetch(endpoint.base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-fixture-user': user, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      change: (user = 'owner', action: 'grant' | 'revoke' = 'grant', app = INLINE_APP) => change(policy, state, actors, user, action, app),
      openStream: (taskId: string, user = 'owner') => openStream(endpoint.base, taskId, connections, user),
      async reload() {
        await closeServer(server!); await closeStores(stores!);
        policy = new ApplicationAuthorizationService(new PostgresAuthorizationStore(runtime), { resolveActor: resolve, refreshActor: actor => resolve(actor.sub, actor.issuer) });
        await registerPolicy(policy, runtime); authorityState = configureAuthority(policy, runtime, resolve);
        stores = createContext(actors, provider, runtime); endpoint = await listen(stores.ctx, actors); server = endpoint.server;
      },
      async close() { connections.forEach(request => request.destroy()); await closeServer(server!);
        await closeStores(stores!); clearPorts(); await database.stop(); vi.unstubAllEnvs(); },
    };
  } catch (error) {
    if (server) await closeServer(server); if (stores) await closeStores(stores);
    clearPorts(); await database.stop(); vi.unstubAllEnvs(); throw error;
  }
}

function clearPorts(): void {
  configureProtectedResultAccess(undefined); configureApplicationRemoteExecutionAuthority(undefined); configureApplicationExecutionPolicy(undefined);
}

export type ProtectedInlinePostgresFixture = Awaited<ReturnType<typeof createProtectedInlinePostgresFixture>>;
