/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the concierge node route (inline-bot-execution seq 22, message-routes seq 28). The inline app concierges answered 422 NO_HOSTED_BRAIN for the deployment operator whenever the hosted lane was off, because an inline turn can never run the operator's CLI login. These cases drive the REAL message and stream routers, executeBotOrInline, stampRemoteBrain, BotNodeClient with the real concierge resolver, the swarm registry (the package bot registered through the real manifestBotDefinition, so it is controller-inline with the codex-cli default), StreamManager and the application actor middleware against a loopback stub concierge node answering /api/health and /api/swarm-execute. C1 the operator's Antigravity turn to an unprotected inline app bot reaches the node with the stamped provider and no hosted connection, and the orchestrator is never called; C2 a protected bot is non-agentic there; C3 a non-operator, C4 a hosted brain, C5 a Codex CLI brain and C6 a static core inline bot all stay inline and never touch the node; C7 with the URL unset the operator's turn is the legacy inline turn and the empty-ladder 422 body is byte-identical; C8 an unhealthy node keeps the turn inline and an empty ladder answers 422 with detail concierge_node_unavailable and no swarm-execute call; C9 an explicit BYO or provider choice stays inline; C10 the reply reaches the owner's stream exactly once while another identity cannot subscribe; C11 Jarvis delegateOne's direct shape through executeBotOrInline reaches the node. Doubles: the brain ladder (resolveUserBrain and resolveUserLlmConnection), PM ticket intake, BudgetService and the stub node.
 */

import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { createServer, get as httpGet, type ClientRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, InMemoryWorkspaceStore, WorkspaceService } from '@/features/ticketing';
import { StreamManager } from '@/features/streaming';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { createApplicationActorContext } from '@/app/middleware/application-authorization-context';
import { manifestBotDefinition } from '@/app/extensions/swarm/manifest-bot-definition';
import { NoHostedBrainError } from '@/app/routes/inline-bot-execution';

vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));

// The same doubles as protected-node-chat-turn.spec.ts plus the user-brain resolver, whose order has
// its own suite. The router, the chokepoint, the remote brain stamp, the node client, the registry,
// the concierge resolver and the stream are real.
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/free-tier-rotation')>();
  return { ...actual, resolveUserLlmConnection: vi.fn(async () => undefined), reportResolvedLlmFailure: vi.fn(async () => false) };
});
vi.mock('@/app/routes/user-brain-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/user-brain-resolution')>();
  return { ...actual, resolveUserBrain: vi.fn(async () => ({ kind: 'none' })) };
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

const OPERATOR_SUB = 'auth0|concierge-node-operator';
const GUEST_SUB = 'auth0|concierge-node-member';
const OTHER_SUB = 'auth0|concierge-node-other';
const USER_ISSUER = 'https://concierge-node.fixture.test';
const TASK_ID = 'f2b7a9d0-0000-4000-8000-0000000000c1';
const APP_BOT = 'cc000000-0000-4000-8000-0000000000c1';
const APP = 'spec-concierge-app';
const NODE_REPLY = 'concierge answer';
const ANTIGRAVITY = { kind: 'cli', providerId: 'antigravity-cli' } as const;
const CONNECTION = { baseUrl: 'https://hosted.example.test/v1', apiKey: 'sk-test-never-logged', model: 'test-model' };
const NO_HOSTED_BRAIN_BODY = { success: false, error: new NoHostedBrainError().message, code: 'NO_HOSTED_BRAIN' };

type NodeRequest = Record<string, unknown> & { method: string; url: string };
interface StubNode { requests: NodeRequest[]; executions: () => NodeRequest[]; url: string }
interface TaskStream { status: number; messages: () => Array<Record<string, unknown>> }

const servers: Server[] = [];
const subscriptions: ClientRequest[] = [];
let processMessage: ReturnType<typeof vi.fn>;
let messageSave: ReturnType<typeof vi.fn>;
let order: string[];
let stubCount = 0;

beforeEach(async () => {
  order = [];
  processMessage = vi.fn(async () => ({ success: true, response: 'inline answer', usageSummary: undefined }));
  messageSave = vi.fn(async (record: { role: string }) => { order.push(`save:${record.role}`); return {}; });
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR_SUB);
  vi.stubEnv('OSHAL_CONCIERGE_NODE_URL', '');
  const registry = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const client = await import('../../src/features/agent-management/services/bot-node-client');
  // The resolvers' synchronous requires cannot load the .ts modules under vitest; warm them first.
  await client.warmBotEndpointRegistry();
  await client.warmInlineAppBotOwner();
  registry.registerAppBots(APP, [manifestBotDefinition({ agentId: APP_BOT, name: 'spec-inline-app-concierge' })]);
});

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) subscription.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  configureApplicationExecutionPolicy(undefined);
  (await import('../../src/app/extensions/swarm/swarm-bot-registry')).unregisterAppBots(APP);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** Points the execution-policy port at the inline app bot's package; `on` decides protection. */
function protect(on: boolean): void {
  configureApplicationExecutionPolicy({
    owner: (kind, id) => (kind === 'bots' && id === APP_BOT ? APP : undefined),
    protectedApp: (app) => on && app === APP,
    authorize: async (_actor, operation) => ({ allowed: true, reason: 'fixture', decisionId: 'fixture', revision: 1, app: operation.app, grants: [] }),
  });
}

/** Arms the doubled brain resolver for the caller. */
async function armBrain(brain: Record<string, unknown>): Promise<ReturnType<typeof vi.fn>> {
  const resolution = await import('../../src/app/routes/user-brain-resolution');
  const doubled = resolution.resolveUserBrain as unknown as ReturnType<typeof vi.fn>;
  doubled.mockImplementation(async () => brain);
  return doubled;
}

/** Arms the doubled hosted ladder; `null` leaves it empty. */
async function armLadder(connection: Record<string, unknown> | null = { ...CONNECTION, resolutionSource: 'explicit' }): Promise<ReturnType<typeof vi.fn>> {
  const rotation = await import('../../src/app/routes/free-tier-rotation');
  const doubled = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
  doubled.mockImplementation(async () => connection ?? undefined);
  return doubled;
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return address.port;
}

/**
 * A REAL loopback concierge node answering GET /api/health and POST /api/swarm-execute. Each stub is
 * addressed under its own path prefix so the route's per-URL health cache can never carry one
 * stub's answer into another case that happens to reuse the port.
 */
async function bootConcierge(health = 200, reply = { success: true, response: NODE_REPLY }): Promise<StubNode> {
  const requests: NodeRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', ...(raw ? JSON.parse(raw) : {}) });
      const isHealth = req.method === 'GET' && (req.url ?? '').endsWith('/api/health');
      res.writeHead(isHealth ? health : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isHealth ? { status: health === 200 ? 'ok' : 'unavailable' } : reply));
    });
  });
  const port = await listen(server);
  stubCount += 1;
  const url = `http://127.0.0.1:${port}/concierge-${stubCount}`;
  vi.stubEnv('OSHAL_CONCIERGE_NODE_URL', url);
  return { requests, url, executions: () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/swarm-execute')) };
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

/** The app context the routes and the chokepoint read. */
function appContext(tasks: InMemoryTaskStore, streamManager: StreamManager) {
  const resolveActor = async (req: Request) => {
    const sub = getCaller(req).sub, issuer = getAuthenticatedPrincipalIssuer(req);
    if (!sub || !issuer) throw new Error('Fixture requires a verified principal');
    return { sub, issuer, isActive: true, isSwarmAdmin: false };
  };
  return {
    ctx: {
      taskStore: tasks, streamManager, ticketService: {}, pool: {},
      workspaceService: new WorkspaceService(new InMemoryWorkspaceStore(), new InMemoryTicketStore()),
      applicationAuthorization: { resolveActor }, orchestrator: { processMessage }, messageStore: { save: messageSave, getByTask: async () => [] },
    },
    resolveActor,
  };
}

/** Boots the REAL message and stream routers behind the actor middleware server.ts mounts. */
async function bootApp(owner = OPERATOR_SUB): Promise<{ base: string; streamManager: StreamManager }> {
  const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
  const { createStreamRoutes } = await import('../../src/app/routes/stream-routes');
  const tasks = new InMemoryTaskStore();
  await tasks.create({ taskId: TASK_ID, ownerSub: owner, agentId: APP_BOT, title: 'Concierge node chat fixture',
    processingMode: 'agentic', metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: USER_ISSUER } });
  const streamManager = new StreamManager(60_000);
  const { ctx, resolveActor } = appContext(tasks, streamManager);
  const routeCtx = ctx as unknown as Parameters<typeof createMessageRoutes>[0];
  const app = express();
  app.use(express.json());
  app.use(fixtureIdentity);
  app.use(createApplicationActorContext(resolveActor));
  app.use('/api/stream', createStreamRoutes(routeCtx));
  app.use('/api', createMessageRoutes(routeCtx));
  const port = await listen(createServer(app));
  return { base: `http://127.0.0.1:${port}/api`, streamManager };
}

function send(base: string, body: Record<string, unknown>, sub = OPERATOR_SUB): Promise<Response> {
  return fetch(`${base}/send-message`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-test-sub': sub } });
}

/** The body the rail (swarmbot-chat.js) posts. */
function railBody(agentId = APP_BOT): Record<string, unknown> {
  return { taskId: TASK_ID, text: 'hello concierge', agentId, agenticMode: true, source: 'swarmbot-chat' };
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

/** A REAL open, static, codex-cli INLINE bot from the active registry (not a package bot). */
async function pickStaticInlineAgentId(): Promise<string> {
  const { getActiveRegistry } = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const entry = getActiveRegistry().find((bot) => {
    const roles = (bot as { accessRoles?: string[] }).accessRoles;
    const inline = bot.container === 'oshal-api' && !(bot as { requiresOwnNode?: boolean }).requiresOwnNode;
    return Boolean(bot.agentId) && bot.agentId !== APP_BOT && bot.harnessType === 'codex-cli' && (!roles || roles.length === 0) && inline;
  });
  if (!entry?.agentId) throw new Error('no open inline codex-cli registry bot found');
  return entry.agentId;
}

/**
 * Calls the chokepoint directly, the way Jarvis delegateOne and the app routes do: under the verified
 * caller's application actor, which the actor middleware establishes for every authenticated request.
 */
async function executeDirect(request: Record<string, unknown>) {
  const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
  const { BotNodeClient, createRegistryEndpointResolver } = await import('../../src/features/agent-management');
  const { ctx } = appContext(new InMemoryTaskStore(), new StreamManager(60_000));
  const actor = { sub: OPERATOR_SUB, issuer: USER_ISSUER, isActive: true, isSwarmAdmin: false };
  return runWithApplicationAuthorizationActor(actor, () => executeBotOrInline(ctx as never,
    new BotNodeClient(createRegistryEndpointResolver()), APP_BOT, {
      text: 'delegated ask', taskId: 'jarvis-concierge-fixture', workspaceFolderId: 'jarvis-concierge-fixture',
      agentId: APP_BOT, ...request,
    } as never));
}

describe('the operator\'s CLI turn to an inline app bot runs on the concierge node', () => {
  it('C1: an unprotected inline app bot reaches the node with the stamped Antigravity provider, direct and agentic, and never the orchestrator', async () => {
    const node = await bootConcierge();
    await armBrain(ANTIGRAVITY);
    const ladder = await armLadder();
    const { base } = await bootApp();

    const res = await send(base, railBody());

    expect(res.status).toBe(200);
    expect(((await res.json()) as { response: string }).response).toBe(NODE_REPLY);
    expect(processMessage).not.toHaveBeenCalled();
    expect(ladder).not.toHaveBeenCalled();
    expect(node.executions()).toHaveLength(1);
    expect(node.executions()[0]).toMatchObject({
      agentId: APP_BOT, direct: true, agenticMode: true, userSub: OPERATOR_SUB,
      providerId: 'antigravity-cli', providerConfigRequired: true,
    });
    for (const field of ['byoLlmConnection', 'creds', 'providerIntent', 'byoLlmResolutionSource']) {
      expect(node.executions()[0], field).not.toHaveProperty(field);
    }
    expect(order).toEqual(['save:user', 'save:assistant']);
  });

  it('C2: a protected inline app bot is non-agentic on the node, through the route and through the chokepoint alone', async () => {
    protect(true);
    const node = await bootConcierge();
    await armBrain(ANTIGRAVITY);
    await armLadder();
    const { base } = await bootApp();

    const res = await send(base, railBody());
    expect(res.status).toBe(200);
    // The chokepoint flips it itself, so a caller that sends agenticMode:true is still non-agentic.
    await executeDirect({ agenticMode: true, direct: true, userSub: OPERATOR_SUB });

    expect(processMessage).not.toHaveBeenCalled();
    expect(node.executions()).toHaveLength(2);
    for (const body of node.executions()) {
      expect(body).toMatchObject({ agentId: APP_BOT, direct: true, agenticMode: false, providerId: 'antigravity-cli' });
    }
  });
});

describe('every other turn stays on its existing path and never touches the node', () => {
  it('C3: a non-operator caller stays inline on the hosted ladder; the brain resolver is never walked', async () => {
    const node = await bootConcierge();
    const brain = await armBrain(ANTIGRAVITY);
    await armLadder();
    const { base } = await bootApp(GUEST_SUB);

    const res = await send(base, railBody(), GUEST_SUB);

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(brain).not.toHaveBeenCalled();
    expect(node.requests).toEqual([]);
  });

  it.each([
    { label: 'C4: a hosted brain', brain: { kind: 'hosted', connection: CONNECTION } },
    { label: 'C5: an openai-codex CLI brain', brain: { kind: 'cli', providerId: 'openai-codex' } },
  ])('$label stays inline, with no health probe and no dispatch', async ({ brain }) => {
    const node = await bootConcierge();
    await armBrain(brain);
    await armLadder();
    const { base } = await bootApp();

    const res = await send(base, railBody());

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(node.requests).toEqual([]);
  });

  it('C6: a static core inline bot stays inline even for the operator\'s Antigravity brain', async () => {
    const node = await bootConcierge();
    const brain = await armBrain(ANTIGRAVITY);
    await armLadder();
    const { base } = await bootApp();

    const res = await send(base, railBody(await pickStaticInlineAgentId()));

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(brain).not.toHaveBeenCalled();
    expect(node.requests).toEqual([]);
  });

  it('C7: with the URL unset the operator\'s turn is the legacy inline turn and the empty-ladder 422 is byte-identical', async () => {
    const brain = await armBrain(ANTIGRAVITY);
    await armLadder();
    const { base } = await bootApp();

    const answered = await send(base, railBody());
    expect(answered.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0][2]).toMatchObject({ agentId: APP_BOT, byoLlmConnection: CONNECTION, userSub: OPERATOR_SUB });

    await armLadder(null);
    const refused = await send(base, railBody());
    expect(refused.status).toBe(422);
    expect(await refused.text()).toBe(JSON.stringify(NO_HOSTED_BRAIN_BODY));
    expect(brain).not.toHaveBeenCalled();
  });

  it('C8: an unhealthy node keeps the turn inline; with an empty ladder the 422 names the node and nothing is dispatched', async () => {
    const node = await bootConcierge(503);
    await armBrain(ANTIGRAVITY);
    await armLadder();
    const { base } = await bootApp();

    const answered = await send(base, railBody());
    expect(answered.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(node.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${new URL(node.url).pathname}/api/health`]);

    // An unreachable node (nothing listening) with nothing on the ladder.
    const closed = createServer();
    const port = await listen(closed);
    await new Promise<void>((resolve) => { servers.splice(servers.indexOf(closed), 1); closed.close(() => resolve()); });
    vi.stubEnv('OSHAL_CONCIERGE_NODE_URL', `http://127.0.0.1:${port}/concierge-down-${stubCount}`);
    await armLadder(null);

    const refused = await send(base, railBody());
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ ...NO_HOSTED_BRAIN_BODY, detail: 'concierge_node_unavailable' });
    expect(node.executions()).toEqual([]);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'an explicit BYO connection', choice: { byoLlmConnection: CONNECTION } },
    { label: 'an explicit provider stamp', choice: { providerId: 'openai-codex' } },
    { label: 'a non-interactive (swarm) dispatch', choice: { direct: false } },
  ])('C9: $label stays inline through the chokepoint', async ({ choice }) => {
    const node = await bootConcierge();
    const brain = await armBrain(ANTIGRAVITY);
    await armLadder();

    await executeDirect({ agenticMode: true, direct: true, userSub: OPERATOR_SUB, ...choice });

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(brain).not.toHaveBeenCalled();
    expect(node.requests).toEqual([]);
  });
});

describe('the concierge reply reaches the rail like any node reply', () => {
  it('C10: the owner\'s stream receives exactly one assistant message after both turns are saved; another identity cannot subscribe', async () => {
    await bootConcierge();
    await armBrain(ANTIGRAVITY);
    await armLadder();
    const { base, streamManager } = await bootApp();
    const publish = streamManager.broadcastMessage.bind(streamManager);
    vi.spyOn(streamManager, 'broadcastMessage').mockImplementation((taskId, message) => { order.push('event'); publish(taskId, message); });
    const owner = await openTaskStream(base, OPERATOR_SUB);
    const other = await openTaskStream(base, OTHER_SUB);
    expect(owner.status).toBe(200);
    expect(other.status).toBe(404);

    const res = await send(base, railBody());

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(owner.messages()).toHaveLength(1));
    expect(owner.messages()[0].message).toEqual({ role: 'assistant', type: 'say', text: NODE_REPLY });
    expect(order).toEqual(['save:user', 'save:assistant', 'event']);
    expect(other.messages()).toEqual([]);
  });

  it('C11: Jarvis delegateOne\'s direct shape through executeBotOrInline reaches the node', async () => {
    const node = await bootConcierge();
    await armBrain(ANTIGRAVITY);
    await armLadder();

    const result = await executeDirect({
      taskId: 'jarvis-delegate-fixture', workspaceFolderId: `jarvis-spec-${OPERATOR_SUB}`,
      agenticMode: true, direct: true, userSub: OPERATOR_SUB,
    });

    expect(result.response).toBe(NODE_REPLY);
    expect(processMessage).not.toHaveBeenCalled();
    expect(node.executions()).toHaveLength(1);
    expect(node.executions()[0]).toMatchObject({
      agentId: APP_BOT, direct: true, agenticMode: true, userSub: OPERATOR_SUB, providerId: 'antigravity-cli',
      workspaceFolderId: `jarvis-spec-${OPERATOR_SUB}`,
    });
  });
});
