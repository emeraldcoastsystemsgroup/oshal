/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Isolate real worker HTTP delegation, signed controller permits and SQLite task reasoning without deployment services.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import type { Pool } from 'pg';
import { createDelegationTokenIssuer, createDelegationTokenVerifier, createRecordedDelegationTokenIssuer } from '@/shared/security/delegation-token';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { DELEGATION_HTTP_HEADER } from '@/shared/security/delegation-http-policy';
import { REMOTE_EXECUTION_PATH, REMOTE_PERMIT_AUDIENCE, REMOTE_PERMIT_SCOPE, type RemoteExecutionPermit } from '@/shared/application-remote-execution';
import { getRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { createBotNodeDelegationRuntime } from '@/app/bot-node-delegation';
import { createProtectedBotDispatchContext } from '@/app/bot-node-protected-context';
import { createProtectedBotExecutionBoundary } from '@/app/bot-node-protected-execution';
import { createBotControllerPermitCheck } from '@/app/bot-node-controller-permit';
import { createBotNodeExecutionHandler } from '@/app/bot-node-execution-handler';
import { buildBotNodeHttpResponse } from '@/app/bot-node-http-response';
import type { MeshEnvelope } from '@/features/agent-management';
import type { ApplicationRemoteExecutionAuthority, RemoteExecutionCheck } from '@/shared/application-remote-execution';
import { createApplicationRemoteExecutionRoutes } from '@/app/routes/application-remote-execution-routes';

const requireModule = createRequire(import.meta.url);
const TaskController = requireModule('../../any-bot/server/controllers/TaskController.js');
const TaskStore = requireModule('../../any-bot/server/stores/TaskStore.js');
const MessageStore = requireModule('../../any-bot/server/stores/MessageStore.js');
const ToolRegistry = requireModule('../../any-bot/server/services/ToolRegistry.js');
const config = requireModule('../../any-bot/server/utils/config.js');
/** @description Fixed runtime target used only in isolated signed dispatch fixtures. */
export const REMOTE_AGENT = 'protected-reasoner';
/** @description Disposable policy namespace with no deployment application records. */
export const REMOTE_APP = 'fixture-business';
/** @description Deliberately repeated subject for provider-namespace isolation proofs. */
export const REMOTE_SUB = 'same-subject';
/** @description Fixture identity provider, never resolved over the network. */
export const REMOTE_ISSUER = 'https://identity.fixture.test/one';
const SECRET = 'isolated-machine-proof';

interface DispatchRecord { body: Record<string, unknown>; token: string; jti: string; started: boolean; completed: boolean }
/** @description Mutable fixture authority; no production identity or provider is consulted. */
export interface RemoteFixtureState {
  allowed: boolean;
  owner: string | null;
  phases: string[];
  calls: Array<{ messages: unknown; options: Record<string, unknown>; identity: unknown; actor: unknown }>;
  mutatePermit?: (permit: RemoteExecutionPermit) => void;
  mutateSignedPermit?: (permit: RemoteExecutionPermit) => void;
  denyPhase?: string;
  afterProvider?: () => void | Promise<void>;
  beforeProvider?: () => void;
  duringOwnership?: () => Promise<void>;
  beforeCheck?: (input: RemoteExecutionCheck) => Promise<void>;
}

function signingFixture() {
  const pair = generateKeyPairSync('ed25519');
  const publicKeys = JSON.stringify({ fixture: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() });
  const signingEnv = { OSHAL_DELEGATION_SIGNING_KID: 'fixture', OSHAL_DELEGATION_SIGNING_PRIVATE_KEY:
    pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), OSHAL_DELEGATION_TTL_SECONDS: '300' };
  const env = { OSHAL_DELEGATION_PUBLIC_KEYS: publicKeys, SWARM_SERVICE_SECRET: SECRET };
  return { issuer: createDelegationTokenIssuer({ env: signingEnv }), env,
    recordedIssuer: createRecordedDelegationTokenIssuer({ env: signingEnv }), verifier: createDelegationTokenVerifier({ env }) };
}

function signBody(issuer: ReturnType<typeof signingFixture>['issuer'], body: Record<string, unknown>, permit = false): string {
  return issuer.issue({ iss: 'urn:oshal:controller', aud: permit ? REMOTE_PERMIT_AUDIENCE : 'urn:oshal:bot-node',
    sub: String(body.sub ?? body.userSub), principal_iss: String(body.issuer ?? body.principalIssuer), azp: REMOTE_AGENT,
    task_id: String(body.taskId), method: 'POST', path: permit ? REMOTE_EXECUTION_PATH : '/api/swarm-execute',
    scope: permit ? [...REMOTE_PERMIT_SCOPE] : ['swarm:execute'], body_sha256: delegationRequestBodySha256(body) });
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function controllerRouter(records: Map<string, DispatchRecord>, state: RemoteFixtureState, signing: ReturnType<typeof signingFixture>) {
  const app = express(); app.use(express.json());
  app.post(REMOTE_EXECUTION_PATH, (req, res) => {
    const input = req.body, record = records.get(input.executionId);
    state.phases.push(input.phase);
    if (req.get('X-Service-Secret') !== SECRET || !record || record.token !== input.token || !state.allowed
      || state.denyPhase === input.phase || record.completed || (input.phase === 'start' ? record.started : !record.started)) {
      res.status(403).json({ error: 'fixture_denied' }); return;
    }
    if (input.phase === 'start') record.started = true;
    if (input.phase === 'complete') record.completed = true;
    const permit: RemoteExecutionPermit = { executionId: input.executionId, app: REMOTE_APP, agentId: REMOTE_AGENT,
      taskId: String(record.body.taskId), workspaceId: String(record.body.workspaceFolderId), sub: String(record.body.userSub),
      issuer: String(record.body.principalIssuer), tenantId: 'fixture-tenant', phase: input.phase, nonce: input.nonce,
      dispatchJti: record.jti, allowedPermissions: [`${REMOTE_APP}:read`], expiresAt: new Date(Date.now() + 10_000).toISOString() };
    state.mutatePermit?.(permit);
    const token = signBody(signing.issuer, permit as unknown as Record<string, unknown>, true);
    state.mutateSignedPermit?.(permit);
    res.json({ permit, token });
  });
  return app;
}

function realControllerRouter(authority: ApplicationRemoteExecutionAuthority, state: RemoteFixtureState) {
  const app = express(); app.use(express.json());
  app.use(REMOTE_EXECUTION_PATH, async (req, res, next) => {
    state.phases.push(req.body.phase);
    try { await state.beforeCheck?.(req.body); next(); }
    catch { res.status(503).json({ error: 'fixture_check_failed' }); }
  });
  app.use(createApplicationRemoteExecutionRoutes(authority, (req, res, next) => {
    if (req.get('X-Service-Secret') !== SECRET) { res.sendStatus(401); return; } next();
  }));
  return app;
}

function sqliteController(directory: string, state: RemoteFixtureState) {
  const priorWorkspace = config.filesystem.workspaceDir, priorGitlab = config.gitlab.enabled;
  config.filesystem.workspaceDir = directory; config.gitlab.enabled = false;
  const store = new TaskStore(join(directory, 'tasks.sqlite')); store.init();
  const messages = new MessageStore(store.db); messages.init();
  const controller = Object.create(TaskController.prototype);
  Object.assign(controller, { taskStore: store, messageStore: messages, activeTasks: new Map(), toolRegistry: new ToolRegistry(), stream: null,
    llm: null, agenticController: { execute: () => { throw new Error('Agentic execution must remain unreachable'); } } });
  controller._buildByoLlm = () => ({ generateResponse: async (input: unknown, options: Record<string, unknown>) => {
    state.beforeProvider?.();
    state.calls.push({ messages: input, options, identity: getRequestIdentity(), actor: getApplicationAuthorizationActor() });
    await state.afterProvider?.();
    return { content: 'Fixture protected answer', provider: 'fixture-hosted', model: 'fixture-model' };
  } });
  return { controller, store, messages, close() {
    store.close(); config.filesystem.workspaceDir = priorWorkspace; config.gitlab.enabled = priorGitlab;
  } };
}

/**
 * @description Build the same request-to-envelope identity fields as the production HTTP ingress.
 * @param body - Signed fixture request.
 * @returns A raw envelope, which alone never carries protected authority.
 */
export function remoteEnvelope(body: Record<string, unknown>): MeshEnvelope {
  return { correlationId: randomUUID(), fromAgentId: 'swarm-controller', toAgentId: REMOTE_AGENT,
    channel: `swarm.agent.${REMOTE_AGENT}`, messageType: 'request', payload: { ...body, externalId: body.taskId,
      workspaceTaskId: body.workspaceFolderId } };
}

function workerRouter(env: NodeJS.ProcessEnv, handler: ReturnType<typeof createBotNodeExecutionHandler>) {
  const used = new Set<string>();
  const delegation = createBotNodeDelegationRuntime({ localAgentId: REMOTE_AGENT, env, replayStore: {
    consume: async ({ issuer, jti }) => { const key = `${issuer}:${jti}`; if (used.has(key)) return false; used.add(key); return true; },
  } });
  const app = express(); app.use(express.json());
  app.post('/api/swarm-execute', (req, res, next) => {
    if (req.get('X-Service-Secret') !== SECRET) { res.sendStatus(401); return; } next();
  }, delegation.authorize, createProtectedBotDispatchContext(), async (req, res) => {
    try {
      const result = await runWithSystemIdentity(() => handler(remoteEnvelope(req.body)));
      res.status(result.success ? 200 : 503).json(buildBotNodeHttpResponse(result, { durationMs: 1,
        taskId: String(req.body.taskId), defaultModel: 'fixture-model', defaultProvider: 'fixture-hosted' }));
    } catch (error) { res.status(503).json({ success: false, error: error instanceof Error ? error.message : 'fixture_error' }); }
  });
  return app;
}

/**
 * @description Start loopback worker/controller fixtures, real TaskController and disposable SQLite history.
 * @param createAuthority - Optional real controller service constructed with fixture-only signing capabilities.
 * @returns A bounded request fixture with explicit cleanup; keys and providers exist only inside this fixture.
 */
export async function startProtectedWorkerFixture(createAuthority?: (signing: ReturnType<typeof signingFixture>) => ApplicationRemoteExecutionAuthority) {
  const directory = mkdtempSync(join(tmpdir(), 'oshal-remote-worker-'));
  const state: RemoteFixtureState = { allowed: true, owner: REMOTE_APP, phases: [], calls: [] };
  const signing = signingFixture(), records = new Map<string, DispatchRecord>();
  const authority = createAuthority?.(signing);
  const controllerHttp = await listen(authority ? realControllerRouter(authority, state) : controllerRouter(records, state, signing));
  const env = { ...signing.env, SWARM_CONTROLLER_URL: controllerHttp.url };
  const sqlite = sqliteController(directory, state);
  const pool = { query: async () => {
    await state.duringOwnership?.();
    return { rows: state.owner ? [{ app: state.owner, protected: true }] : [] };
  } } as unknown as Pick<Pool, 'query'>;
  const handler = createBotNodeExecutionHandler({ anyBotTaskController: sqlite.controller,
    providerName: 'claude-code', modelName: 'unused-cli',
    runApplicationExecution: createProtectedBotExecutionBoundary(pool, REMOTE_AGENT, createBotControllerPermitCheck({ env })) });
  const workerHttp = await listen(workerRouter(env, handler));
  const issue = (overrides: Record<string, unknown> = {}) => {
    const body = { agentId: REMOTE_AGENT, taskId: 'fixture-task', workspaceFolderId: 'fixture-workspace', userSub: REMOTE_SUB,
      principalIssuer: REMOTE_ISSUER, text: 'Summarize authorized context.', direct: true, agenticMode: false,
      byoLlmConnection: { baseUrl: 'https://unused.fixture.test/v1', apiKey: 'fixture-only', model: 'fixture-model' },
      applicationExecutionId: randomUUID(), ...overrides };
    const token = signBody(signing.issuer, body);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    records.set(body.applicationExecutionId, { body, token, jti: claims.jti, started: false, completed: false });
    return { body, token };
  };
  return { state, env, issue, handler, authority, recordedIssuer: signing.recordedIssuer, workerUrl: workerHttp.url,
    controller: sqlite.controller, store: sqlite.store, messages: sqlite.messages,
    post: (request: { body: unknown; token?: string }, machine = SECRET) => fetch(`${workerHttp.url}/api/swarm-execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Secret': machine,
        ...(request.token ? { [DELEGATION_HTTP_HEADER]: request.token } : {}) }, body: JSON.stringify(request.body) }),
    async close() {
      await Promise.all([workerHttp.server, controllerHttp.server].map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
      })));
      sqlite.close(); rmSync(directory, { recursive: true, force: true });
    } };
}
