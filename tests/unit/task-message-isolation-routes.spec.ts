/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Keep the inline credential-isolation fixture independent of production bot endpoint registration.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BUG-17: the broker mock was bound to `resolveBotCreds`, a name connector-token-broker has not exported since 2026-08-06, so both `not.toHaveBeenCalled()` assertions could never fail. The mock and assertions now name `resolveServerOperationCreds`, a new case proves every mocked name is a real export, and the credential assertions run before the transport status so a routing change cannot turn this guard into a liveness check.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bind task and ticket fallback reads to verified current actors and actual canonical stores; prove ambiguous, unavailable and mixed-transport refusals without changing broker assertions.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Match maintained fixture input and transport declarations without changing ownership, identity or boundary assertions.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryMessageStore } from '../../src/entities/message';
import { InMemoryTaskStore } from '../../src/entities/task';
import { createMessageRoutes } from '../../src/app/routes/message-routes';
import { createTaskRoutes } from '../../src/app/routes/task-routes';
import { BotNodeClient } from '../../src/features/agent-management';
import { InMemoryTicketStore, InMemoryWorkspaceStore, WorkspaceService } from '@/features/ticketing';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY as OWNER_ISSUER } from '@/shared/security/owner-principal-issuer';
import { configureProtectedResultAccess, PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { getCaller } from '@/shared/middleware/authz';

const brokerMocks = vi.hoisted(() => ({
  resolveServerOperationCreds: vi.fn(async () => ({ OSHAL_CRED_GOOGLE: 'token' })),
}));
vi.mock('../../src/app/routes/connector-token-broker', () => brokerMocks);

const ENV_KEYS = [
  'DATABASE_URL',
  'PGHOST',
  'POSTGRES_HOST',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'OSHAL_ALLOW_LEGACY_UNOWNED',
  'SWARM_SERVICE_SECRET',
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  brokerMocks.resolveServerOperationCreds.mockClear();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
});

afterEach(() => {
  configureProtectedResultAccess(undefined);
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('task/message API isolation routes', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  async function ownershipFixture() {
    vi.spyOn(BotNodeClient.prototype, 'hasEndpoint').mockReturnValue(false);
    const tasks = new InMemoryTaskStore(), messages = new InMemoryMessageStore(), tickets = new InMemoryTicketStore();
    const workspace = new WorkspaceService(new InMemoryWorkspaceStore(), tickets);
    const actors: Record<string, AuthorizationActor> = {
      owner: { sub: 'owner', issuer: 'https://identity.fixture.test', isActive: true, isSwarmAdmin: false },
      twin: { sub: 'owner', issuer: 'https://other.fixture.test', isActive: true, isSwarmAdmin: false },
      foreign: { sub: 'foreign', issuer: 'https://identity.fixture.test', isActive: true, isSwarmAdmin: false },
    };
    const processMessage = vi.fn(async (_taskId: string, _text: string, _options: Record<string, unknown>) => ({ success: true, response: 'ok' }));
    const resolveActor = async (req: Request) => {
      const actor = Object.values(actors).find(row => row.sub === getCaller(req).sub && row.issuer === getAuthenticatedPrincipalIssuer(req));
      if (!actor) throw new Error('fixture current actor unavailable');
      return structuredClone(actor);
    };
    const ctx = { taskStore: tasks, messageStore: messages, workspaceService: workspace,
      applicationAuthorization: { resolveActor }, orchestrator: { processMessage }, ticketService: {}, pool: {} };
    const app = express(); app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const user = actors[req.get('x-fixture-user') || ''];
      if (user) (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true,
        ...(req.get('x-fixture-pat') ? { idToken: 'cli-token' } : {}), user: { sub: user.sub, iss: user.issuer } };
      next();
    });
    app.use('/api', createMessageRoutes(ctx as never));
    const server = app.listen(0); servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const base = `http://127.0.0.1:${address.port}/api`;
    const call = (id: string, user = 'owner', headers: Record<string, string> = {}) => fetch(`${base}/${id}/messages`,
      { headers: { ...headers, ...(user ? { 'x-fixture-user': user } : {}) } });
    const send = (id: string, user = 'owner', headers: Record<string, string> = {},
      agentId = 'a0000000-0000-0000-0000-000000000036') => fetch(`${base}/tasks/${id}/messages`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...(user ? { 'x-fixture-user': user } : {}) },
      body: JSON.stringify({ text: 'bounded fixture turn', source: 'dispatch-manifest-worker',
        interactionMode: 'task', agentId }) });
    const ticket = (ownerSub: string | null = 'owner', issuer: string | null = actors.owner.issuer) => tickets.create(
      CreateInternalTicketSchema.parse({ title: 'ownership fixture', ownerSub, metadata: issuer ? { [OWNER_ISSUER]: issuer } : {} }));
    return { tasks, messages, tickets, workspace, actors, ctx, processMessage, call, send, ticket };
  }

  it('reads an actual ticket-bound history with its recorded issuer and current actor', async () => {
    const f = await ownershipFixture(), ticket = await f.ticket();
    await f.tickets.linkTask(ticket.ticketId, 'linked');
    await f.messages.save({ metadata: {}, contentBlocks: [], taskId: 'linked', role: 'assistant', type: 'completion', text: 'TICKET OWNED HISTORY' });
    expect((await f.call('linked')).status).toBe(200);
    expect((await f.call('linked', 'twin')).status).toBe(404);
    f.actors.owner.isActive = false;
    expect((await f.call('linked')).status).toBe(404);
    f.actors.owner.isActive = true;
    vi.spyOn(f.ctx.applicationAuthorization, 'resolveActor').mockRejectedValue(new Error('directory offline'));
    expect((await f.call('linked')).status).toBe(404);
  });

  it('treats a present direct ownerless ticket as authoritative instead of borrowing a linked owner', async () => {
    const f = await ownershipFixture(), direct = await f.ticket(null), linked = await f.ticket();
    await f.tickets.linkTask(linked.ticketId, direct.ticketId);
    await f.messages.save({ metadata: {}, contentBlocks: [], taskId: direct.ticketId, role: 'assistant', type: 'completion', text: 'OWNERLESS SENTINEL' });
    expect(await f.workspace.resolveTaskOwnership(direct.ticketId)).toEqual({ ticketId: direct.ticketId,
      ownerSub: null, ownerPrincipalIssuer: f.actors.owner.issuer });
    expect(await f.workspace.resolveTaskOwner(direct.ticketId)).toBe('owner');
    expect((await f.call(direct.ticketId)).status).toBe(404);
    expect((await f.send(direct.ticketId)).status).toBe(404);
    expect(f.processMessage).not.toHaveBeenCalled();
  });

  it('keeps an owned direct ticket authoritative despite unrelated linked ownership', async () => {
    const f = await ownershipFixture(), direct = await f.ticket(), foreign = await f.ticket('foreign');
    await f.tickets.linkTask(foreign.ticketId, direct.ticketId);
    expect(await f.workspace.resolveTaskOwnership(direct.ticketId)).toEqual({ ticketId: direct.ticketId,
      ownerSub: 'owner', ownerPrincipalIssuer: f.actors.owner.issuer });
    expect((await f.call(direct.ticketId)).status).toBe(200);
    expect((await f.call(direct.ticketId, 'foreign')).status).toBe(404);
  });

  it.each([null, 'https://identity.fixture.test'])('admits identical multi-link tuples including legacy issuer %s', async issuer => {
    const f = await ownershipFixture(), first = await f.ticket('owner', issuer), second = await f.ticket('owner', issuer);
    await f.tickets.linkTask(second.ticketId, 'multi'); await f.tickets.linkTask(first.ticketId, 'multi');
    const expected = [first.ticketId, second.ticketId].sort()[0];
    expect(await f.workspace.resolveTaskOwnership('multi')).toEqual({ ticketId: expected, ownerSub: 'owner', ownerPrincipalIssuer: issuer });
    expect((await f.call('multi')).status).toBe(200);
  });

  it.each(['foreign-owner', 'foreign-issuer', 'legacy-vs-stamped', 'ownerless', 'missing', 'read-error'])
    ('refuses ambiguous or unavailable linked ownership: %s', async kind => {
      const f = await ownershipFixture(), first = await f.ticket();
      const second = await f.ticket(kind === 'foreign-owner' ? 'foreign' : kind === 'ownerless' ? null : 'owner',
        kind === 'foreign-issuer' ? 'https://other.fixture.test' : kind === 'legacy-vs-stamped' ? null : f.actors.owner.issuer);
      await f.tickets.linkTask(first.ticketId, 'uncertain'); await f.tickets.linkTask(second.ticketId, 'uncertain');
      const read = f.tickets.get.bind(f.tickets);
      if (kind === 'missing' || kind === 'read-error') vi.spyOn(f.tickets, 'get').mockImplementation(async id => {
        if (id === second.ticketId) { if (kind === 'read-error') throw new Error('ticket read failed'); return null; }
        return read(id);
      });
      await expect(f.workspace.resolveTaskOwnership('uncertain')).rejects.toThrow();
      expect((await f.call('uncertain')).status).toBe(404);
      expect((await f.send('uncertain')).status).toBe(404);
      expect(f.processMessage).not.toHaveBeenCalled();
    });

  it('does not erase a task issuer or protected lineage when obtaining ticket ownership', async () => {
    const f = await ownershipFixture(), ticket = await f.ticket();
    await f.tickets.linkTask(ticket.ticketId, 'task-stamped');
    await f.tasks.create({ taskId: 'task-stamped', title: '', processingMode: 'agentic',
      metadata: { [OWNER_ISSUER]: 'https://other.fixture.test' } });
    expect((await f.call('task-stamped')).status).toBe(404);
    const before = (await f.tasks.get('task-stamped'))!;
    await f.tasks.replace({ ...before, metadata: { [OWNER_ISSUER]: f.actors.owner.issuer, [PROTECTED_RESULT_EXECUTIONS]: ['execution-sentinel'] } });
    const assertResultAccess = vi.fn(async () => { throw new Error('revoked'); });
    configureProtectedResultAccess({ isProtectedAgent: async () => false, hasTaskResults: async () => false,
      assertResultAccess, assertTaskResultAccess: async () => { throw new Error('revoked'); },
      linkResult: async () => undefined });
    expect((await f.call('task-stamped')).status).toBe(404);
    expect(assertResultAccess).toHaveBeenCalledWith('execution-sentinel', f.actors.owner, { taskId: 'task-stamped' });
    expect((await f.tasks.get('task-stamped'))?.metadata).toEqual({ [OWNER_ISSUER]: f.actors.owner.issuer, [PROTECTED_RESULT_EXECUTIONS]: ['execution-sentinel'] });
  });

  it('admits truly absent unlinked writes but refuses unknown history and storage failures', async () => {
    const f = await ownershipFixture();
    expect((await f.send('new-unlinked')).status).toBe(200);
    expect(f.processMessage).toHaveBeenCalledTimes(1);
    await f.messages.save({ metadata: {}, contentBlocks: [], taskId: 'orphan', role: 'assistant', type: 'completion', text: 'UNOWNED HISTORY' });
    expect((await f.send('orphan')).status).toBe(404);
    vi.spyOn(f.tickets, 'get').mockRejectedValue(new Error('ticket infrastructure failed'));
    expect((await f.send('failed-lookup')).status).toBe(404);
    expect(f.processMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['task', 'links', 'history'])('never interprets a failed %s lookup as a new unlinked thread', async store => {
    const f = await ownershipFixture();
    if (store === 'task') vi.spyOn(f.tasks, 'get').mockRejectedValue(new Error('task unavailable'));
    if (store === 'links') vi.spyOn(f.tickets, 'getTicketLinksForTask').mockRejectedValue(new Error('links unavailable'));
    if (store === 'history') vi.spyOn(f.messages, 'getByTask').mockRejectedValue(new Error('history unavailable'));
    expect((await f.send('unknown')).status).toBe(404);
    expect(f.processMessage).not.toHaveBeenCalled();
  });

  it('preserves the exact empty-task write exception without granting protected history', async () => {
    const f = await ownershipFixture();
    await f.tasks.create({ taskId: 'empty', title: '', processingMode: 'agentic', ownerSub: 'owner', agentId: 'protected-bot',
      metadata: { [OWNER_ISSUER]: f.actors.owner.issuer } });
    configureProtectedResultAccess({ isProtectedAgent: async agent => agent === 'protected-bot', hasTaskResults: async () => false,
      assertResultAccess: async () => { throw new Error('denied'); }, assertTaskResultAccess: async () => { throw new Error('denied'); },
      linkResult: async () => undefined });
    expect((await f.call('empty')).status).toBe(404);
    expect((await f.send('empty', 'twin')).status).toBe(404);
    f.actors.owner.isActive = false; expect((await f.send('empty')).status).toBe(404);
    f.actors.owner.isActive = true; expect((await f.send('empty')).status).toBe(200);
    await f.messages.save({ metadata: {}, contentBlocks: [], taskId: 'empty', role: 'assistant', type: 'completion', text: 'EXISTING RESULT' });
    expect((await f.send('empty')).status).toBe(404);
    expect(f.processMessage).toHaveBeenCalledTimes(1);
  });

  it('retains bare trusted-sub ordinary compatibility but refuses protected output and mismatched subjects', async () => {
    const f = await ownershipFixture(); process.env.SWARM_SERVICE_SECRET = 'bare-message-fixture-sentinel';
    await f.tasks.create({ taskId: 'ordinary-service', title: '', processingMode: 'agentic', ownerSub: 'owner',
      metadata: { [OWNER_ISSUER]: f.actors.owner.issuer } });
    const headers = { 'x-service-secret': 'bare-message-fixture-sentinel', 'x-oshal-user-sub': 'owner' };
    expect((await f.call('ordinary-service', '', headers)).status).toBe(200);
    expect((await f.send('ordinary-service', '', headers)).status).toBe(200);
    expect((await f.call('ordinary-service', '', { ...headers, 'x-oshal-user-sub': 'foreign' })).status).toBe(404);
    expect((await f.call('ordinary-service', '', { 'x-service-secret': headers['x-service-secret'] })).status).toBe(403);
    configureProtectedResultAccess({ isProtectedAgent: async () => false, hasTaskResults: async () => true,
      assertResultAccess: async () => undefined, assertTaskResultAccess: async () => undefined, linkResult: async () => undefined });
    expect((await f.call('ordinary-service', '', headers)).status).toBe(404);
    expect((await f.send('ordinary-service', '', headers)).status).toBe(404);
    expect(f.processMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['oidc', 'pat'])('keeps authenticated %s ownership authoritative over valid conflicting service headers', async kind => {
    const f = await ownershipFixture(); process.env.SWARM_SERVICE_SECRET = 'mixed-message-fixture-sentinel';
    await f.tasks.create({ taskId: 'mixed', title: '', processingMode: 'agentic', ownerSub: 'owner',
      metadata: { [OWNER_ISSUER]: f.actors.owner.issuer } });
    const headers = { 'x-service-secret': 'mixed-message-fixture-sentinel', 'x-oshal-user-sub': 'foreign',
      ...(kind === 'pat' ? { 'x-fixture-pat': 'true' } : {}) };
    expect((await f.call('mixed', 'owner', headers)).status).toBe(200);
    expect((await f.send('mixed', 'owner', headers)).status).toBe(200);
    expect(f.processMessage.mock.calls[0][2]).toMatchObject({ userSub: 'owner' });
    headers['x-oshal-user-sub'] = 'owner';
    expect((await f.call('mixed', 'foreign', headers)).status).toBe(404);
    expect((await f.send('mixed', 'foreign', headers)).status).toBe(404);
    expect((await f.send('mixed', 'twin', headers)).status).toBe(404);
    expect(f.processMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a mixed-auth authenticated turn subject to actual bot execute entitlement', async () => {
    const f = await ownershipFixture(); process.env.SWARM_SERVICE_SECRET = 'mixed-entitlement-fixture-sentinel';
    const { getActiveRegistry } = await import('@/app/extensions/swarm/swarm-bot-registry');
    const scoped = getActiveRegistry().find(bot => bot.agentId && Array.isArray(bot.accessRoles) && bot.accessRoles.length
      && !bot.accessRoles.includes('jarvis') && !String(bot.role ?? '').startsWith('assistant/'));
    if (!scoped?.agentId) throw new Error('fixture requires actual scoped bot');
    const headers = { 'x-service-secret': 'mixed-entitlement-fixture-sentinel', 'x-oshal-user-sub': 'foreign' };
    const response = await f.send('unlinked-entitlement', 'owner', headers, scoped.agentId);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'caller_not_entitled_to_agent' });
    expect(f.processMessage).not.toHaveBeenCalled();
  });

  it('scopes task list and direct task/message reads to the authenticated non-operator', async () => {
    const taskStore = new InMemoryTaskStore();
    const messageStore = new InMemoryMessageStore();
    await taskStore.create({
      metadata: {},
      taskId: 'task-user-a',
      title: 'User A task',
      processingMode: 'agentic',
      ownerSub: 'auth0|user-a',
    });
    await taskStore.create({
      metadata: {},
      taskId: 'task-user-b',
      title: 'User B task',
      processingMode: 'agentic',
      ownerSub: 'auth0|user-b',
    });
    await messageStore.save({
      metadata: {}, contentBlocks: [],
      taskId: 'task-user-a',
      role: 'user',
      type: 'task',
      text: 'visible to A',
    });
    await messageStore.save({
      metadata: {}, contentBlocks: [],
      taskId: 'task-user-b',
      role: 'user',
      type: 'task',
      text: 'secret from B',
    });

    const app = express();
    app.use(express.json());
    app.use(mockOidc('auth0|user-a'));
    const ctx = {
      taskStore,
      messageStore,
      memoryService: {
        createCheckpoint: async () => ({}),
        listCheckpoints: async () => [],
      },
      workspaceBootstrapService: {
        getTaskWorkspaceStatus: async () => ({}),
        bootstrapTaskWorkspace: async () => ({}),
      },
      workspaceService: new WorkspaceService(new InMemoryWorkspaceStore(), new InMemoryTicketStore()),
      applicationAuthorization: { resolveActor: verifiedFixtureActor },
      orchestrator: {
        processMessage: async () => ({ success: true, response: 'ok' }),
      },
      pool: {},
    } as never;
    app.use('/api/tasks', createTaskRoutes(ctx));
    app.use('/api', createMessageRoutes(ctx));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${baseUrl}/api/tasks?scope=all&ownerSub=auth0%7Cuser-b`);
    const listBody = await listResponse.json() as { tasks: Array<{ taskId: string }> };
    expect(listResponse.status).toBe(200);
    expect(listBody.tasks.map((task) => task.taskId)).toEqual(['task-user-a']);

    const otherTaskResponse = await fetch(`${baseUrl}/api/tasks/task-user-b`);
    expect(otherTaskResponse.status).toBe(404);

    const ownMessagesResponse = await fetch(`${baseUrl}/api/task-user-a/messages`);
    const ownMessagesBody = await ownMessagesResponse.json() as { messages: Array<{ text: string }> };
    expect(ownMessagesResponse.status).toBe(200);
    expect(ownMessagesBody.messages.map((message) => message.text)).toEqual(['visible to A']);

    const otherMessagesResponse = await fetch(`${baseUrl}/api/task-user-b/messages`);
    expect(otherMessagesResponse.status).toBe(404);
  });

  it('does not expose messages when RLS hides the owning task row', async () => {
    const taskStore = new InMemoryTaskStore();
    const messageStore = new InMemoryMessageStore();
    await messageStore.save({
      metadata: {}, contentBlocks: [],
      taskId: 'hidden-task-user-b',
      role: 'user',
      type: 'task',
      text: 'message on a task the caller cannot see',
    });

    const app = express();
    app.use(express.json());
    app.use(mockOidc('auth0|user-a'));
    app.use('/api', createMessageRoutes({
      taskStore,
      messageStore,
      workspaceService: new WorkspaceService(new InMemoryWorkspaceStore(), new InMemoryTicketStore()),
      applicationAuthorization: { resolveActor: verifiedFixtureActor },
    } as never));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/api/hidden-task-user-b/messages`);
    expect(response.status).toBe(404);
  });

  it('never brokers connector credentials into localhost model fallback', async () => {
    vi.spyOn(BotNodeClient.prototype, 'hasEndpoint').mockReturnValue(false);
    const taskStore = new InMemoryTaskStore();
    const messageStore = new InMemoryMessageStore();
    for (const taskId of ['fallback-email', 'fallback-weather']) {
      await taskStore.create({
      metadata: {},
        taskId,
        title: taskId,
        processingMode: 'agentic',
        ownerSub: 'auth0|user-a',
      });
    }
    const processMessage = vi.fn(async (_taskId: string, _text: string, _options: Record<string, unknown>) => ({ success: true, response: 'ok' }));
    const pool = {};
    const app = express();
    app.use(express.json());
    app.use(mockOidc('auth0|user-a'));
    app.use('/api', createMessageRoutes({
      taskStore,
      messageStore,
      ticketService: {},
      workspaceService: new WorkspaceService(new InMemoryWorkspaceStore(), new InMemoryTicketStore()),
      applicationAuthorization: { resolveActor: verifiedFixtureActor },
      orchestrator: { processMessage },
      pool,
    } as never));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const emailResponse = await fetch(`${baseUrl}/api/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: 'fallback-email',
        text: 'Summarize important email.',
        source: 'dispatch-manifest-worker',
        interactionMode: 'task',
        agentId: 'b0000000-0000-0000-0000-000000000001',
      }),
    });
    // The credential property is asserted first and on its own: a transport change must not be
    // able to turn this security guard into a liveness check (BUG-17).
    expect(brokerMocks.resolveServerOperationCreds).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0][2]).not.toHaveProperty('creds');
    expect(processMessage.mock.calls[0][2]).not.toHaveProperty('providerIntent');
    expect(emailResponse.status).toBe(200);

    brokerMocks.resolveServerOperationCreds.mockClear();
    const weatherResponse = await fetch(`${baseUrl}/api/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: 'fallback-weather',
        text: 'Weather today.',
        source: 'dispatch-manifest-worker',
        interactionMode: 'task',
        agentId: 'a0000000-0000-0000-0000-000000000036',
      }),
    });
    expect(brokerMocks.resolveServerOperationCreds).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenLastCalledWith('fallback-weather', 'Weather today.', expect.any(Object));
    expect(processMessage.mock.calls[1][2]).not.toHaveProperty('creds');
    expect(processMessage.mock.calls[1][2]).not.toHaveProperty('providerIntent');
    expect(weatherResponse.status).toBe(200);
  });

  it('mocks only broker names the real module exports, so the assertions above can go red', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/app/routes/connector-token-broker');
    for (const name of Object.keys(brokerMocks)) {
      expect(typeof actual[name], `connector-token-broker exports no "${name}"`).toBe('function');
    }
  });
});

function mockOidc(sub: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub, iss: 'https://identity.fixture.test', email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` },
    };
    next();
  };
}

async function verifiedFixtureActor(req: Request): Promise<AuthorizationActor> {
  const user = req.oidc?.user;
  if (!req.oidc?.isAuthenticated() || !user?.sub || !user.iss) throw new Error('verified fixture identity required');
  return { sub: user.sub, issuer: user.iss, isActive: true, isSwarmAdmin: false };
}
