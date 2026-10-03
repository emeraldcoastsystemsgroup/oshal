/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Regression guard for the OSHAL Node "The bot returned an empty reply." report (2026-10-01). A remote chat turn that the orchestrator FAILS without throwing must carry its reason in the chat.reply `error` field the node prints. The REAL remote-client router over loopback HTTP drives the REAL bridge into a REAL TaskOrchestrator whose provider is the REAL antigravity-cli HarnessLLMBridge, so the turn hits the controller's actual unattended-execution refusal (the live failure) before anything is spawned. Only the stores and the stream are doubled, outside the guarded boundary. An answered turn is unchanged, and a failure with no reason adds no blank error.
 */
import express from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiOrigin } from '../helpers';
import { RemoteTaskJournalService } from '@/features/remote-client';
import { InMemoryRemoteTaskJournalFixture } from '../helpers/in-memory-remote-task-journal';
import { TaskOrchestrator, type TaskOrchestratorDeps } from '../../src/features/chat-orchestration/services/task-orchestrator';
import { LLMService, type LLMResponse, type SendRequestOptions } from '../../src/features/llm-provider/services/llm-service';
import { HarnessLLMBridge } from '../../src/features/llm-provider/services/harness-adapter';
import { AntigravityCliHarnessAdapter } from '../../src/features/llm-provider/services/antigravity-cli-harness-adapter';

const SECRET = 'test-remote-secret-reply-error';
const ENV_KEYS = ['REMOTE_CLIENT_SHARED_SECRET', 'REMOTE_CLIENT_REQUIRE_NODE_TOKEN', 'REMOTE_CLIENT_CONTROL_PLANE_TOKEN', 'REMOTE_CLIENT_AUTH_HEADER', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
let savedEnv: Record<string, string | undefined> = {};

type ChatOrchestrator = Parameters<typeof import('../../src/app/routes/remote-client-routes')['createRemoteClientRoutes']>[0]['orchestrator'];
let routerGraph: typeof import('../../src/app/routes/remote-client-routes');

/** Loaded once in the file hook so the one-time router-graph transform never lands on a test's timeout. */
beforeAll(async () => {
  routerGraph = await import('../../src/app/routes/remote-client-routes');
}, 120_000);

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A provider that answers, so the success path is observable through the same real orchestrator. */
class AnsweringProvider extends LLMService {
  constructor() { super('fixture-answering', {}); }
  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    return { content: [{ type: 'text', text: 'fixture answer' }], usage: { inputTokens: 1, outputTokens: 1 }, model: 'fixture-model' };
  }
}

/**
 * @description A REAL TaskOrchestrator over in-memory store and stream doubles (collaborators outside the guarded boundary).
 * @param provider The LLM provider every turn runs on.
 * @returns The orchestrator.
 */
function realOrchestrator(provider: LLMService): TaskOrchestrator {
  const saved: Array<Record<string, unknown>> = [];
  const tasks = new Map<string, Record<string, unknown>>();
  const deps = {
    taskStore: {
      create: async (input: Record<string, unknown>) => { tasks.set(String(input.taskId), { ...input }); return { ...input }; },
      get: async (taskId: string) => tasks.get(taskId) ?? null,
      updateStatus: async () => {}, incrementMessageCount: async () => {}, incrementTurnCount: async () => {}, recordUsage: async () => {},
    },
    messageStore: {
      save: async (input: Record<string, unknown>) => { saved.push(input); return { ...input, messageId: `m-${saved.length}`, createdAt: new Date().toISOString() }; },
      getRecent: async () => [...saved],
    },
    streamManager: { associateTaskWithSession: () => {}, broadcastTaskUpdate: () => {}, broadcastMessage: () => {}, broadcastError: () => {} },
    getProvider: () => provider,
    getTools: async () => [],
    executeTool: async () => 'ok',
    getSystemPrompt: async () => 'SYSTEM',
  } as unknown as TaskOrchestratorDeps;
  return new TaskOrchestrator(deps);
}

const servers: Array<{ close: (cb: () => void) => void }> = [];
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(resolve))));
  servers.length = 0;
});

/**
 * @description Boot the REAL remote-client router around an orchestrator and register one device as the node daemon.
 * @param orchestrator The orchestrator the chat route hands each turn to.
 * @param clientId The device to register.
 * @returns The router base URL.
 */
async function bootWithDevice(orchestrator: ChatOrchestrator, clientId: string): Promise<string> {
  const { createRemoteClientRoutes, remoteClientRegistry } = routerGraph;
  const app = express();
  app.use(express.json());
  app.use('/api/remote-clients', createRemoteClientRoutes({
    taskJournalService: new RemoteTaskJournalService(new InMemoryRemoteTaskJournalFixture()),
    orchestrator,
  }));
  for (let i = 0; i < 20 && !remoteClientRegistry.isTaskJournalReady(); i += 1) await Promise.resolve();
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
  const base = `http://127.0.0.1:${address.port}/api/remote-clients`;
  const registered = await fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
    body: JSON.stringify({ clientId, name: `Device ${clientId}`, transport: 'http', platform: 'windows', controlPlaneUrl: apiOrigin(), capabilities: ['chat'], tags: ['test'] }),
  });
  expect(registered.status).toBe(201);
  return base;
}

/**
 * @description Send one chat turn as the node and poll swarm/next, as the node does, until its chat.reply arrives.
 * @param base The router base URL.
 * @param clientId The registered device.
 * @param text The turn's text.
 * @returns The chat.reply payload the node would receive.
 */
async function chatReply(base: string, clientId: string, text: string): Promise<Record<string, unknown>> {
  const headers = { 'content-type': 'application/json', 'x-remote-client-key': SECRET };
  const accepted = await fetch(`${base}/${clientId}/chat`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  expect(accepted.status).toBe(202);
  let payload: Record<string, unknown> | null = null;
  await vi.waitFor(async () => {
    const res = await fetch(`${base}/${clientId}/swarm/next`, { headers });
    if (res.status === 200) {
      const body = await res.json() as { message?: { payload?: Record<string, unknown> } };
      if (body.message?.payload?.type === 'chat.reply') payload = body.message.payload;
    }
    expect(payload).not.toBeNull();
  }, { timeout: 15_000, interval: 50 });
  return payload as unknown as Record<string, unknown>;
}

describe('remote-client chat reply carries the failure reason', () => {
  it('a turn refused on the controller (the fleet-default antigravity-cli harness) reaches the node with its reason, not as an empty reply', async () => {
    const orchestrator = realOrchestrator(new HarnessLLMBridge(new AntigravityCliHarnessAdapter()));
    const base = await bootWithDevice(orchestrator, 'device-refused-harness');
    const payload = await chatReply(base, 'device-refused-harness', 'hello');
    expect(payload).toMatchObject({ type: 'chat.reply', success: false, text: '' });
    expect(String(payload.error)).toContain('antigravity-cli unattended execution is disabled');
  });

  it('an answered turn is unchanged: its text arrives and no error key is added', async () => {
    const base = await bootWithDevice(realOrchestrator(new AnsweringProvider()), 'device-answered');
    const payload = await chatReply(base, 'device-answered', 'hello');
    expect(payload).toMatchObject({ type: 'chat.reply', success: true, text: 'fixture answer' });
    expect(payload).not.toHaveProperty('error');
  });

  it('a failure that gives no reason adds no blank error, so the node keeps its own fallback text', async () => {
    const reasonless = { processMessage: async () => ({ success: false, error: '   ' }) };
    const base = await bootWithDevice(reasonless, 'device-reasonless');
    const payload = await chatReply(base, 'device-reasonless', 'hello');
    expect(payload).toMatchObject({ type: 'chat.reply', success: false, text: '' });
    expect(payload).not.toHaveProperty('error');
  });
});
