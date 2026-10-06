/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the ADR-149 chat shape for protected node bots and the live rail publish. Every chat client posts agenticMode:true or omits it, and a protected node admits only direct, non-agentic reasoning with exactly one server-resolved brain, so every cockpit and rail turn to a protected node bot was refused. These cases drive the real message and stream routers, executeBotOrInline, stampRemoteBrain, BotNodeClient, the swarm registry (the bot registered through the real manifestBotDefinition, so it carries the codex-cli manifest default), StreamManager and the application actor middleware against a loopback stub node that records each body. The rail, cockpit api-client and legacy streaming bodies all reach a protected node with direct:true and agenticMode:false and one brain shape (the hosted wire trio for a plain caller, the stamped CLI provider for the demo operator); an unprotected node keeps agenticMode:true; the persisted reply reaches the owner's real task stream exactly once, after both turns are saved, while another identity cannot subscribe; a node refusal publishes and persists nothing; and the route never publishes an inline turn. Doubles: the execution-policy port, the brain ladder, PM ticket intake, BudgetService and the stub node.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A5: the route decides protection with the inline branch's exact expression, so a bot that only the controller's protected-agent read (the ownership claim BotNodeClient's protected prepare decides from) protects is still sent direct:true, agenticMode:false; without it such a bot would be prepared as protected and then refused for the agentic shape.
 */

import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { createServer, get as httpGet, type ClientRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, InMemoryWorkspaceStore, WorkspaceService } from '@/features/ticketing';
import { StreamManager } from '@/features/streaming';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { createApplicationActorContext } from '@/app/middleware/application-authorization-context';
import { manifestBotDefinition } from '@/app/extensions/swarm/manifest-bot-definition';

vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));

// The same four doubles as inline-hosted-brain-entry-points.spec.ts: the ladder's resolution order,
// PM ticket intake and the budget have their own suites. The router, the chokepoint, the remote
// brain stamp, the node client, the registry and the stream are real.
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/free-tier-rotation')>();
  return { ...actual, resolveUserLlmConnection: vi.fn(async () => undefined), reportResolvedLlmFailure: vi.fn(async () => false) };
});
vi.mock('@/features/chat-orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/chat-orchestration')>();
  return {
    ...actual,
    resolveProjectManagerTicketExecutionContext: vi.fn(async (_deps: unknown, input: { requestedTaskId: string; source: string }) => ({
      taskId: input.requestedTaskId, source: input.source, ticketCreated: false,
      ticketId: null, ticketStatus: null, ticketTitle: null, ticketContext: undefined,
    })),
  };
});
vi.mock('@/features/cost-governance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/cost-governance')>();
  return { ...actual, BudgetService: class { async checkBudget(): Promise<{ allowed: boolean }> { return { allowed: true }; } } };
});

const USER_SUB = 'auth0|protected-node-chat-user';
const OTHER_SUB = 'auth0|protected-node-chat-other';
const USER_ISSUER = 'https://protected-node-chat.fixture.test';
const TASK_ID = 'f2b7a9d0-0000-4000-8000-000000000049';
const NODE_AGENT = 'cb999999-0000-4000-8000-000000000049';
const NODE_APP = 'spec-protected-node-app';
const NODE_REPLY = 'node answer';
const CONNECTION = { baseUrl: 'https://hosted.example.test/v1', apiKey: 'sk-test-never-logged', model: 'test-model' };
/** Brain and connector fields that must never ride a plain caller's hosted turn to the node. */
const NOT_ON_A_HOSTED_TURN = ['providerId', 'model', 'configVersion', 'providerConfigRequired', 'fallbackOrder', 'creds', 'providerIntent'];
/** The body the rail (swarmbot-chat.js) posts. */
const RAIL_BODY = { taskId: TASK_ID, text: 'hello node', agentId: NODE_AGENT, agenticMode: true, source: 'swarmbot-chat' };

type NodeBody = Record<string, unknown>;
interface NodeReply { status: number; body: Record<string, unknown> }
interface TaskStream { status: number; messages: () => Array<Record<string, unknown>> }

const servers: Server[] = [];
const subscriptions: ClientRequest[] = [];
let processMessage: ReturnType<typeof vi.fn>;
let messageSave: ReturnType<typeof vi.fn>;
let order: string[];

beforeEach(() => {
  order = [];
  processMessage = vi.fn(async () => ({ success: true, response: 'inline answer', usageSummary: undefined }));
  messageSave = vi.fn(async (record: { role: string }) => { order.push(`save:${record.role}`); return {}; });
});

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) subscription.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  configureApplicationExecutionPolicy(undefined);
  configureProtectedResultAccess(undefined);
  (await import('../../src/app/extensions/swarm/swarm-bot-registry')).unregisterAppBots(NODE_APP);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** Points the execution-policy port at the stub bot's application; `on` decides whether it is protected. */
function protect(on: boolean): void {
  configureApplicationExecutionPolicy({
    owner: (kind, id) => (kind === 'bots' && id === NODE_AGENT ? NODE_APP : undefined),
    protectedApp: (app) => on && app === NODE_APP,
    authorize: async (_actor, operation) => ({ allowed: true, reason: 'fixture', decisionId: 'fixture', revision: 1, app: operation.app, grants: [] }),
  });
}

/** Arms the doubled ladder; returns the double so a case can prove it was never walked. */
async function armLadder(): Promise<ReturnType<typeof vi.fn>> {
  const rotation = await import('../../src/app/routes/free-tier-rotation');
  const doubled = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
  doubled.mockImplementation(async () => ({ ...CONNECTION, resolutionSource: 'explicit' }));
  return doubled;
}

/** A REAL loopback "bot node", registered the way the manifest loader registers a package node bot. */
async function bootStubNode(reply: NodeReply = { status: 200, body: { success: true, response: NODE_REPLY } }): Promise<NodeBody[]> {
  const bodies: NodeBody[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      bodies.push({ url: req.url, ...(raw ? JSON.parse(raw) : {}) });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  const port = await listen(server);
  const registry = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const { warmBotEndpointRegistry } = await import('../../src/features/agent-management/services/bot-node-client');
  // The resolver's synchronous require cannot load the .ts registry under vitest; warm it first.
  await warmBotEndpointRegistry();
  registry.registerAppBots(NODE_APP, [manifestBotDefinition({
    agentId: NODE_AGENT, name: 'spec-protected-node-bot', container: 'spec-protected-node-bot', port,
  })]);
  return bodies;
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return address.port;
}

/** The identity stamping the OIDC middleware produces, taken from a test header. */
function fixtureIdentity(req: Request, _res: ExpressResponse, next: NextFunction): void {
  const sub = req.header('x-test-sub');
  if (sub) {
    (req as unknown as { oidc?: unknown }).oidc = { isAuthenticated: () => true,
      user: { sub, iss: USER_ISSUER, email: `${sub}@example.test` }, idTokenClaims: { iss: USER_ISSUER } };
  }
  next();
}

/** Boots the REAL message and stream routers behind the actor middleware server.ts mounts. */
async function bootApp(): Promise<{ base: string; streamManager: StreamManager }> {
  const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
  const { createStreamRoutes } = await import('../../src/app/routes/stream-routes');
  const tasks = new InMemoryTaskStore();
  // Stamped with the node bot, so /tasks/:taskId/messages (no agentId in the body) resolves it.
  await tasks.create({ taskId: TASK_ID, ownerSub: USER_SUB, agentId: NODE_AGENT, title: 'Protected node chat fixture',
    processingMode: 'agentic', metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: USER_ISSUER } });
  const streamManager = new StreamManager(60_000);
  const resolveActor = async (req: Request) => {
    const sub = getCaller(req).sub, issuer = getAuthenticatedPrincipalIssuer(req);
    if (!sub || !issuer) throw new Error('Fixture requires a verified principal');
    return { sub, issuer, isActive: true, isSwarmAdmin: false };
  };
  const ctx = {
    taskStore: tasks, streamManager, ticketService: {}, pool: {},
    workspaceService: new WorkspaceService(new InMemoryWorkspaceStore(), new InMemoryTicketStore()),
    applicationAuthorization: { resolveActor }, orchestrator: { processMessage }, messageStore: { save: messageSave, getByTask: async () => [] },
  } as unknown as Parameters<typeof createMessageRoutes>[0];
  const app = express();
  app.use(express.json());
  app.use(fixtureIdentity);
  app.use(createApplicationActorContext(resolveActor));
  app.use('/api/stream', createStreamRoutes(ctx));
  app.use('/api', createMessageRoutes(ctx));
  const port = await listen(createServer(app));
  return { base: `http://127.0.0.1:${port}/api`, streamManager };
}

function send(base: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB } });
}

/** Opens a real SSE subscription to the fixture task; resolves when the response head arrives. */
function openTaskStream(base: string, sub: string): Promise<TaskStream> {
  return new Promise((resolve, reject) => {
    let raw = '';
    const subscription = httpGet(`${base}/stream/${TASK_ID}`, { headers: { 'x-test-sub': sub } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { raw += chunk; });
      resolve({ status: response.statusCode ?? 0, messages: () => raw.split('\n')
        .filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice('data: '.length)))
        .filter((event: { type?: string }) => event.type === 'message') });
    });
    subscription.on('error', reject);
    subscriptions.push(subscription);
  });
}

/** A REAL CLI-harness INLINE bot from the active registry (same rule as the hosted-brain entry spec). */
async function pickInlineCliAgentId(): Promise<string> {
  const { getActiveRegistry } = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const entry = getActiveRegistry().find((bot) => {
    const roles = (bot as { accessRoles?: string[] }).accessRoles;
    const inline = bot.container === 'oshal-api' && !(bot as { requiresOwnNode?: boolean }).requiresOwnNode;
    return Boolean(bot.agentId) && bot.harnessType === 'codex-cli' && (!roles || roles.length === 0) && inline;
  });
  if (!entry?.agentId) throw new Error('no open inline codex-cli registry bot found');
  return entry.agentId;
}

describe('a chat turn to a protected node bot gets the one shape a protected node admits', () => {
  it('A1: a plain caller\'s rail turn arrives direct and non-agentic, with the hosted wire trio as its only brain', async () => {
    protect(true);
    const bodies = await bootStubNode();
    await armLadder();
    const { base } = await bootApp();

    const res = await send(base, '/send-message', RAIL_BODY);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { response: string }).response).toBe(NODE_REPLY);
    expect(processMessage).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ url: '/api/swarm-execute', direct: true, agenticMode: false });
    expect(bodies[0].byoLlmConnection).toEqual(CONNECTION);
    for (const field of NOT_ON_A_HOSTED_TURN) expect(bodies[0], field).not.toHaveProperty(field);
  });

  it('A2: the demo operator\'s turn carries the stamped CLI provider instead, still direct and non-agentic, and never walks the ladder', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', USER_SUB);
    protect(true);
    const bodies = await bootStubNode();
    const ladder = await armLadder();
    const { base } = await bootApp();

    const res = await send(base, '/send-message', RAIL_BODY);

    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ direct: true, agenticMode: false, providerId: 'openai-codex', providerConfigRequired: true });
    expect(bodies[0]).not.toHaveProperty('byoLlmConnection');
    expect(ladder).not.toHaveBeenCalled();
  });

  it.each([
    { client: 'rail', path: '/send-message', body: RAIL_BODY },
    { client: 'cockpit api-client', path: `/tasks/${TASK_ID}/messages`,
      body: { text: 'hello node', agenticMode: true, source: 'dashboard', targetBot: 'assistant', autoApprove: true } },
    { client: 'legacy streaming client', path: `/tasks/${TASK_ID}/messages`, body: { text: 'hello node', source: 'dashboard' } },
  ])('A3: the $client body reaches the protected node with agenticMode:false and direct:true', async ({ path, body }) => {
    protect(true);
    const bodies = await bootStubNode();
    await armLadder();
    const { base } = await bootApp();

    const res = await send(base, path, body);

    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ agentId: NODE_AGENT, direct: true, agenticMode: false });
  });

  it('A4: an unprotected node bot keeps the client\'s agenticMode:true, so the server does not reshape every node turn', async () => {
    protect(false);
    const bodies = await bootStubNode();
    await armLadder();
    const { base } = await bootApp();

    const res = await send(base, '/send-message', RAIL_BODY);

    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ direct: true, agenticMode: true });
  });

  it('A5: a bot the controller\'s protected-agent read protects is reshaped even when the execution policy says unprotected, because that read is what protected dispatch prepares from', async () => {
    protect(false);
    configureProtectedResultAccess({
      isProtectedAgent: (agentId) => agentId === NODE_AGENT,
      hasTaskResults: async () => false,
      assertResultAccess: async () => undefined,
      assertTaskResultAccess: async () => undefined,
      linkResult: async () => undefined,
    });
    const bodies = await bootStubNode();
    await armLadder();
    const { base } = await bootApp();

    const res = await send(base, '/send-message', RAIL_BODY);

    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ agentId: NODE_AGENT, direct: true, agenticMode: false });
  });
});

describe('the persisted node reply reaches the rail on the task stream', () => {
  it('B1: the owner\'s real stream receives exactly one assistant message after both turns are saved; another identity cannot subscribe', async () => {
    protect(true);
    await bootStubNode();
    await armLadder();
    const { base, streamManager } = await bootApp();
    const publish = streamManager.broadcastMessage.bind(streamManager);
    vi.spyOn(streamManager, 'broadcastMessage').mockImplementation((taskId, message) => { order.push('event'); publish(taskId, message); });
    const owner = await openTaskStream(base, USER_SUB);
    const other = await openTaskStream(base, OTHER_SUB);
    expect(owner.status).toBe(200);
    expect(other.status).toBe(404);

    const res = await send(base, '/send-message', RAIL_BODY);

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(owner.messages()).toHaveLength(1));
    expect(owner.messages()[0]).toMatchObject({ type: 'message', taskId: TASK_ID });
    expect(owner.messages()[0].message).toEqual({ role: 'assistant', type: 'say', text: NODE_REPLY });
    expect(order).toEqual(['save:user', 'save:assistant', 'event']);
    expect(other.messages()).toEqual([]);
  });

  it('B2: a node refusal answers the route\'s 500 and neither publishes nor persists', async () => {
    protect(true);
    const bodies = await bootStubNode({ status: 403, body: { success: false, error: 'authorization_remote_hosted_reasoning_required' } });
    await armLadder();
    const { base, streamManager } = await bootApp();
    const publish = vi.spyOn(streamManager, 'broadcastMessage');

    const res = await send(base, '/send-message', RAIL_BODY);

    expect(res.status).toBe(500);
    expect(bodies).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    expect(messageSave).not.toHaveBeenCalled();
  });

  it('B3: the route never publishes an inline turn, whose reply the orchestrator already publishes', async () => {
    const agentId = await pickInlineCliAgentId();
    await armLadder();
    const { base, streamManager } = await bootApp();
    const publish = vi.spyOn(streamManager, 'broadcastMessage');

    const res = await send(base, '/send-message', { taskId: TASK_ID, text: 'hello', agentId, agenticMode: true });

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
