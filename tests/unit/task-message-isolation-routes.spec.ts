import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryMessageStore } from '../../src/entities/message';
import { InMemoryTaskStore } from '../../src/entities/task';
import { createMessageRoutes } from '../../src/app/routes/message-routes';
import { createTaskRoutes } from '../../src/app/routes/task-routes';

const brokerMocks = vi.hoisted(() => ({ resolveBotCreds: vi.fn(async () => ({ OSHAL_CRED_GOOGLE: 'token' })) }));
vi.mock('../../src/app/routes/connector-token-broker', () => brokerMocks);

const ENV_KEYS = [
  'DATABASE_URL',
  'PGHOST',
  'POSTGRES_HOST',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'OSHAL_ALLOW_LEGACY_UNOWNED',
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  brokerMocks.resolveBotCreds.mockClear();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
});

afterEach(() => {
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

  it('scopes task list and direct task/message reads to the authenticated non-operator', async () => {
    const taskStore = new InMemoryTaskStore();
    const messageStore = new InMemoryMessageStore();
    await taskStore.create({
      taskId: 'task-user-a',
      title: 'User A task',
      processingMode: 'agentic',
      ownerSub: 'auth0|user-a',
    });
    await taskStore.create({
      taskId: 'task-user-b',
      title: 'User B task',
      processingMode: 'agentic',
      ownerSub: 'auth0|user-b',
    });
    await messageStore.save({
      taskId: 'task-user-a',
      role: 'user',
      type: 'task',
      text: 'visible to A',
    });
    await messageStore.save({
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
      workspaceService: {
        resolveTaskOwner: async (taskId: string) => (await taskStore.get(taskId))?.ownerSub ?? null,
      },
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
      workspaceService: {
        resolveTaskOwner: async () => null,
      },
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
    const taskStore = new InMemoryTaskStore();
    const messageStore = new InMemoryMessageStore();
    for (const taskId of ['fallback-email', 'fallback-weather']) {
      await taskStore.create({
        taskId,
        title: taskId,
        processingMode: 'agentic',
        ownerSub: 'auth0|user-a',
      });
    }
    const processMessage = vi.fn(async () => ({ success: true, response: 'ok' }));
    const pool = {};
    const app = express();
    app.use(express.json());
    app.use(mockOidc('auth0|user-a'));
    app.use('/api', createMessageRoutes({
      taskStore,
      messageStore,
      ticketService: {},
      workspaceService: {
        resolveTaskOwner: async (taskId: string) => (await taskStore.get(taskId))?.ownerSub ?? null,
      },
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
    expect(emailResponse.status).toBe(200);
    expect(brokerMocks.resolveBotCreds).not.toHaveBeenCalled();
    expect(processMessage.mock.calls[0][2]).not.toHaveProperty('creds');

    brokerMocks.resolveBotCreds.mockClear();
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
    expect(weatherResponse.status).toBe(200);
    expect(brokerMocks.resolveBotCreds).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenLastCalledWith('fallback-weather', 'Weather today.', expect.any(Object));
    expect(processMessage.mock.calls[1][2]).not.toHaveProperty('creds');
  });
});

function mockOidc(sub: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = {
      user: { sub, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` },
    };
    next();
  };
}
