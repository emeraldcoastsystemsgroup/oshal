/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The OSHAL Node runs its own chat turns locally (operator, 2026-10-01). Unit: planNodeChat hands a turn to the node only for a CLI harness the controller refuses AND a matching advertised executor; composeNodePrompt stays under the node's command-line budget, newest turns kept; NodeExecutorProvider queues one mcp.call-tool task (origin node-chat) on the requesting node and maps its result, failure and timeout. Integration over loopback HTTP: the REAL remote-client router, bridge and TaskOrchestrator, with the REAL antigravity-cli HarnessLLMBridge as the bot's provider (the controller would refuse it); the test plays the node (claims the task, completes it), and the node's answer reaches the node as the chat.reply. A node without the executor keeps the controller path (the refusal), and a failed node run is said in the reply.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Review cases: a stale node-chat claim is expired through the queue before a new turn is queued and a fresh or foreign claim is left alone; a timed-out turn withdraws its task; a transient result read is retried; the bot model travels in the task arguments; a message that cannot fit is refused and the latest message is never cut; resolveNodeTurnProvider keeps the controller path with no lookup or a throwing one; the settlement cost builder skips a node-chat envelope (the orchestrator already meters the turn).
 */
import express from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteTaskJournalService } from '@/features/remote-client';
import { InMemoryRemoteTaskJournalFixture } from '../helpers/in-memory-remote-task-journal';
import { apiOrigin } from '../helpers';
import { TaskOrchestrator, type TaskOrchestratorDeps } from '../../src/features/chat-orchestration/services/task-orchestrator';
import { LLMService } from '../../src/features/llm-provider/services/llm-service';
import { HarnessLLMBridge } from '../../src/features/llm-provider/services/harness-adapter';
import { AntigravityCliHarnessAdapter } from '../../src/features/llm-provider/services/antigravity-cli-harness-adapter';
import {
  NODE_PROMPT_BUDGET_CHARS,
  NodeExecutorProvider,
  composeNodePrompt,
  planNodeChat,
  resolveNodeTurnProvider,
  type NodeTaskQueue,
} from '../../src/app/routes/remote-client-node-chat';
import { buildRemoteTaskCostEvent } from '../../src/app/routes/remote-client-task-operations';

const SECRET = 'test-remote-secret-node-chat';
const OWNER = 'auth0|node-chat-owner';
const ENV_KEYS = ['REMOTE_CLIENT_SHARED_SECRET', 'REMOTE_CLIENT_REQUIRE_NODE_TOKEN', 'REMOTE_CLIENT_CONTROL_PLANE_TOKEN', 'REMOTE_CLIENT_AUTH_HEADER', 'OSHAL_ALLOW_LEGACY_UNOWNED', 'OSHAL_OPERATOR_SUBS'];
let savedEnv: Record<string, string | undefined> = {};
let routerGraph: typeof import('../../src/app/routes/remote-client-routes');

beforeAll(async () => { routerGraph = await import('../../src/app/routes/remote-client-routes'); }, 120_000);
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

const antigravityBridge = () => new HarnessLLMBridge(new AntigravityCliHarnessAdapter());

describe('planNodeChat', () => {
  it('hands the turn to the node only for a refused CLI harness the node can run', () => {
    expect(planNodeChat('harness:antigravity-cli', ['chat', 'antigravity.exec'])).toEqual({ harnessType: 'antigravity-cli', tool: 'antigravity.exec' });
    expect(planNodeChat('harness:codex-cli', ['codex.exec'])).toEqual({ harnessType: 'codex-cli', tool: 'codex.exec' });
    expect(planNodeChat('harness:claude-code', ['claude.exec'])).toEqual({ harnessType: 'claude-code', tool: 'claude.exec' });
    expect(planNodeChat('harness:antigravity-cli', ['antigravity.exec'], ' gemini-3.8-flash-low ')).toEqual({ harnessType: 'antigravity-cli', tool: 'antigravity.exec', model: 'gemini-3.8-flash-low' });
  });

  it('keeps the controller path for a node without the executor, a hosted provider, or anything that is not a refused harness', () => {
    expect(planNodeChat('harness:antigravity-cli', ['chat', 'codex.exec'])).toBeNull();
    expect(planNodeChat('harness:antigravity-cli', undefined)).toBeNull();
    for (const name of ['byo-hosted:gpt-x', 'anthropic', 'harness:noop', 'harness:a2a', '', undefined]) {
      expect(planNodeChat(name, ['antigravity.exec', 'codex.exec', 'claude.exec']), String(name)).toBeNull();
    }
  });
});

describe('composeNodePrompt', () => {
  it('puts the latest message in the request, earlier turns above it, and a bounded system slice first', () => {
    const prompt = composeNodePrompt('Be brief.', [
      { role: 'user', content: 'first question' }, { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: 'second question' },
    ]);
    expect(prompt).toBe('## System instructions\nBe brief.\n\n## Conversation so far\nUser: first question\nAssistant: first answer\n\n## Request\nsecond question');
  });

  it('stays under the node budget, dropping the OLDEST turns and capping the system prompt', () => {
    const turns = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(900) }));
    const prompt = composeNodePrompt('S'.repeat(50_000), [...turns, { role: 'user', content: 'latest' }]);
    expect(prompt.length).toBeLessThanOrEqual(NODE_PROMPT_BUDGET_CHARS);
    expect(prompt.endsWith('## Request\nlatest')).toBe(true);
    expect(prompt).toContain('turn 59 ');
    expect(prompt).not.toContain('turn 0 ');
    expect(prompt.split('## System instructions\n')[1].indexOf('\n\n')).toBeLessThanOrEqual(4_000);
  });

  it('never cuts the latest message: the system slice and older turns give way, and a message that cannot fit is refused with the limit', () => {
    const latest = 'Q'.repeat(NODE_PROMPT_BUDGET_CHARS - 300);
    const prompt = composeNodePrompt('S'.repeat(3_000), [{ role: 'user', content: 'older' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: latest }]);
    expect(prompt.length).toBeLessThanOrEqual(NODE_PROMPT_BUDGET_CHARS);
    expect(prompt.endsWith('## Request\n' + latest)).toBe(true);
    expect(prompt).not.toContain('older');
    expect(() => composeNodePrompt('', [{ role: 'user', content: 'Q'.repeat(NODE_PROMPT_BUDGET_CHARS + 1) }])).toThrow(/takes at most \d+ in one turn/);
  });
});

/** A node queue double: records the enqueued envelope and answers getCompletedResult from a script. */
function scriptedQueue(answers: Array<{ status: 'completed' | 'failed'; output?: unknown; error?: string } | null>) {
  const enqueued: Array<Record<string, unknown>> = [];
  const queue: NodeTaskQueue = {
    enqueueTask: async (_clientId, input) => { enqueued.push(input as Record<string, unknown>); return input; },
    getCompletedResult: async () => (answers.length ? answers.shift() ?? null : null),
  };
  return { queue, enqueued };
}
const PLAN = { harnessType: 'antigravity-cli', tool: 'antigravity.exec' };
const request = { messages: [{ role: 'user', content: 'what is 2+2?' }], systemPrompt: 'SYSTEM' } as never;

describe('NodeExecutorProvider', () => {
  it('queues one mcp.call-tool task on the requesting node and returns its answer', async () => {
    const { queue, enqueued } = scriptedQueue([null, { status: 'completed', output: { response: ' 4 ', usage: { inputTokens: 7, outputTokens: 1 } } }]);
    const provider = new NodeExecutorProvider({ queue, clientId: 'node-a', agentId: 'bot-1', plan: PLAN, chatTaskId: 'remote-chat-1', userSub: OWNER, sleep: async () => undefined });
    const response = await provider.sendRequest(request);
    expect(provider.getProviderName()).toBe('node:antigravity-cli');
    expect(response.content).toEqual([{ type: 'text', text: '4' }]);
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ fromAgentId: 'bot-1', toAgentId: 'node-a', intent: 'mcp.call-tool', userSub: OWNER,
      input: { name: 'antigravity.exec', origin: 'node-chat', chatTaskId: 'remote-chat-1' } });
    expect(String((enqueued[0].input as { arguments: { prompt: string } }).arguments.prompt)).toContain('what is 2+2?');
    expect((enqueued[0].input as { arguments: Record<string, unknown> }).arguments.model).toBeUndefined();
    const withModel = scriptedQueue([{ status: 'completed', output: { response: 'ok' } }]);
    await new NodeExecutorProvider({ queue: withModel.queue, clientId: 'n', agentId: 'b', plan: { ...PLAN, model: 'gemini-3.8-flash-low' }, chatTaskId: 't', sleep: async () => undefined }).sendRequest(request);
    expect((withModel.enqueued[0].input as { arguments: Record<string, unknown> }).arguments).toEqual({ prompt: expect.any(String), model: 'gemini-3.8-flash-low' });
  });

  it('expires a node-chat claim older than the deadline before queuing, leaves a fresh or foreign claim alone, and withdraws its own task on timeout', async () => {
    const failed: Array<Record<string, unknown>> = [];
    const make = (active: { taskId: string; correlationId: string; claimedAt: string | null; input?: Record<string, unknown> } | null) => {
      const base = scriptedQueue([]);
      const queue: NodeTaskQueue = { ...base.queue, getActiveTask: async () => active, failTask: async (_c, input) => { failed.push(input as Record<string, unknown>); return input; } };
      return { queue, enqueued: base.enqueued };
    };
    const old = new Date(Date.now() - 20 * 60_000).toISOString(), fresh = new Date().toISOString();
    const stale = make({ taskId: 'node-chat-stale', correlationId: 'node-chat-stale', claimedAt: old, input: { origin: 'node-chat', name: 'antigravity.exec' } });
    await expect(new NodeExecutorProvider({ queue: stale.queue, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't', timeoutMs: 30, pollMs: 5 }).sendRequest(request)).rejects.toThrow('did not answer within');
    expect(failed.map((x) => [x.taskId, x.status, String(x.error).slice(0, 23)])).toEqual([['node-chat-stale', 'failed', 'the node never reported'], [stale.enqueued[0].taskId, 'failed', 'This computer did not a']]);
    failed.length = 0;
    // A fresh claim of our own kind, a foreign tool's claim however old, and no claim: none is expired. The deadline here is
    // longer than the fresh claim's age, so only the queue double's empty answers end these turns (the result read is scripted
    // to answer once, with a failure, so each turn ends at once rather than at the deadline).
    for (const active of [{ taskId: 'mine-fresh', correlationId: 'mine-fresh', claimedAt: fresh, input: { origin: 'node-chat' } }, { taskId: 'foreign', correlationId: 'foreign', claimedAt: old, input: { name: 'shell.exec' } }, null]) {
      const q = make(active);
      q.queue.getCompletedResult = async () => ({ status: 'failed', error: 'synthetic' });
      await expect(new NodeExecutorProvider({ queue: q.queue, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't', timeoutMs: 60_000, pollMs: 5, sleep: async () => undefined }).sendRequest(request)).rejects.toThrow('synthetic');
      expect(failed).toEqual([]);
    }
  });

  it('a transient result read error is retried, and only a run of them ends the turn', async () => {
    let reads = 0;
    const flaky: NodeTaskQueue = { enqueueTask: async (_c, i) => i, getCompletedResult: async () => { reads += 1; if (reads < 3) throw new Error('journal busy'); return { status: 'completed', output: { response: 'late but fine' } }; } };
    const response = await new NodeExecutorProvider({ queue: flaky, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't', sleep: async () => undefined }).sendRequest(request);
    expect(response.content).toEqual([{ type: 'text', text: 'late but fine' }]);
    const dead: NodeTaskQueue = { enqueueTask: async (_c, i) => i, getCompletedResult: async () => { throw new Error('journal down'); } };
    await expect(new NodeExecutorProvider({ queue: dead, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't', sleep: async () => undefined }).sendRequest(request)).rejects.toThrow('could not read');
  });

  it('resolveNodeTurnProvider keeps the controller path with no lookup, a throwing lookup, or a plan that does not apply', () => {
    const queue = scriptedQueue([]).queue;
    const base = { queue, clientId: 'n', agentId: 'b', chatTaskId: 't', capabilities: ['antigravity.exec'] };
    expect(resolveNodeTurnProvider(base)).toBeUndefined();
    expect(resolveNodeTurnProvider({ ...base, getChatProvider: () => { throw new Error('no such agent'); } })).toBeUndefined();
    expect(resolveNodeTurnProvider({ ...base, getChatProvider: () => ({ getProviderName: () => 'byo-hosted:x' }) })).toBeUndefined();
    const provider = resolveNodeTurnProvider({ ...base, getChatProvider: () => ({ getProviderName: () => 'harness:antigravity-cli', getModel: () => 'gemini-3.8-flash-low' }) });
    expect(provider?.getProviderName()).toBe('node:antigravity-cli');
  });

  it('the settlement cost builder skips a node-chat envelope: the orchestrator already meters that turn', () => {
    const result = { taskId: 'nc', correlationId: 'nc', clientId: 'n', status: 'completed' as const, artifacts: [], completedAt: new Date().toISOString(), output: { response: 'ok', provider: 'antigravity-cli', usage: { inputTokens: 25290, outputTokens: 1 } } };
    const envelope = (input: Record<string, unknown>) => ({ taskId: 'nc', correlationId: 'nc', fromAgentId: 'bot', toAgentId: 'n', intent: 'mcp.call-tool' as const, input, artifacts: [], createdAt: new Date().toISOString(), status: 'completed' as const });
    expect(buildRemoteTaskCostEvent(envelope({ name: 'antigravity.exec', arguments: { prompt: 'p' }, origin: 'node-chat' }), result)).toBeNull();
    expect(buildRemoteTaskCostEvent(envelope({ name: 'antigravity.exec', arguments: { prompt: 'p' } }), result)).toMatchObject({ agentId: 'bot', inputTokens: 25290 });
  });

  it('a failed or empty node run is an error with the node\'s reason, never an answer', async () => {
    const failed = scriptedQueue([{ status: 'failed', error: 'agy is not signed in' }]);
    await expect(new NodeExecutorProvider({ queue: failed.queue, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't' }).sendRequest(request)).rejects.toThrow('agy is not signed in');
    const empty = scriptedQueue([{ status: 'completed', output: { response: '   ' } }]);
    await expect(new NodeExecutorProvider({ queue: empty.queue, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't' }).sendRequest(request)).rejects.toThrow('returned no answer');
  });

  it('stops waiting at its deadline and says so', async () => {
    const { queue } = scriptedQueue([]);
    const provider = new NodeExecutorProvider({ queue, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't', timeoutMs: 30, pollMs: 5 });
    await expect(provider.sendRequest(request)).rejects.toThrow('did not answer within');
  });
});

/** A REAL TaskOrchestrator over in-memory store and stream doubles; the bot's provider is the refused antigravity bridge. */
function realOrchestrator(): TaskOrchestrator {
  const saved: Array<Record<string, unknown>> = [];
  const tasks = new Map<string, Record<string, unknown>>();
  return new TaskOrchestrator({
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
    getProvider: () => antigravityBridge(),
    getTools: async () => [],
    executeTool: async () => 'ok',
    getSystemPrompt: async () => 'SYSTEM',
  } as unknown as TaskOrchestratorDeps);
}

const servers: Array<{ close: (cb: () => void) => void }> = [];
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(resolve))));
  servers.length = 0;
});
const H = { 'content-type': 'application/json', 'x-remote-client-key': SECRET };

/** Boot the REAL router with the real orchestrator and the per-bot provider lookup; register one owned node. */
async function bootNode(clientId: string, capabilities: string[]): Promise<string> {
  const { createRemoteClientRoutes, remoteClientRegistry } = routerGraph;
  const app = express();
  app.use(express.json());
  app.use('/api/remote-clients', createRemoteClientRoutes({
    taskJournalService: new RemoteTaskJournalService(new InMemoryRemoteTaskJournalFixture()),
    orchestrator: realOrchestrator(),
    getChatProvider: () => antigravityBridge(),
  }));
  for (let i = 0; i < 20 && !remoteClientRegistry.isTaskJournalReady(); i += 1) await Promise.resolve();
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
  const base = `http://127.0.0.1:${address.port}/api/remote-clients`;
  const registered = await fetch(`${base}/register`, { method: 'POST', headers: H, body: JSON.stringify({
    clientId, name: `Node ${clientId}`, transport: 'http', platform: 'windows', controlPlaneUrl: apiOrigin(), capabilities, tags: ['test'], ownerSub: OWNER }) });
  expect(registered.status).toBe(201);
  return base;
}

/** Poll swarm/next, as the node does, until the chat.reply arrives. */
async function nextReply(base: string, clientId: string): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | null = null;
  await vi.waitFor(async () => {
    const res = await fetch(`${base}/${clientId}/swarm/next`, { headers: H });
    if (res.status === 200) {
      const body = await res.json() as { message?: { payload?: Record<string, unknown> } };
      if (body.message?.payload?.type === 'chat.reply') payload = body.message.payload;
    }
    expect(payload).not.toBeNull();
  }, { timeout: 20_000, interval: 50 });
  return payload as unknown as Record<string, unknown>;
}

/** Act as the node's worker: claim the handed-off task (GET tasks/next), then settle it. */
async function claimTask(base: string, clientId: string): Promise<{ taskId: string; correlationId: string; intent: string; input: Record<string, unknown> }> {
  let task: { taskId: string; correlationId: string; intent: string; input: Record<string, unknown> } | null = null;
  await vi.waitFor(async () => {
    const res = await fetch(`${base}/${clientId}/tasks/next`, { headers: H });
    if (res.status === 200) task = ((await res.json()) as { task: typeof task }).task;
    expect(task).not.toBeNull();
  }, { timeout: 20_000, interval: 50 });
  return task as unknown as { taskId: string; correlationId: string; intent: string; input: Record<string, unknown> };
}

describe('a node chat turn over the real routes', () => {
  it('runs on the requesting node: the node claims an antigravity.exec task and its answer is the chat reply', async () => {
    const clientId = 'node-runs-its-own-chat';
    const base = await bootNode(clientId, ['chat', 'antigravity.exec']);
    const accepted = await fetch(`${base}/${clientId}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'hello from the node', userSub: OWNER }) });
    expect(accepted.status).toBe(202);
    const task = await claimTask(base, clientId);
    expect(task.intent).toBe('mcp.call-tool');
    expect(task.input).toMatchObject({ name: 'antigravity.exec', origin: 'node-chat' });
    expect(String((task.input.arguments as { prompt: string }).prompt)).toContain('## Request\nhello from the node');
    const settled = await fetch(`${base}/${clientId}/tasks/${encodeURIComponent(task.taskId)}/complete`, { method: 'POST', headers: H,
      body: JSON.stringify({ correlationId: task.correlationId, toolName: 'antigravity.exec', output: { response: 'answer from agy', provider: 'antigravity-cli', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } } }) });
    expect(settled.status).toBe(200);
    expect(await nextReply(base, clientId)).toMatchObject({ type: 'chat.reply', success: true, text: 'answer from agy' });
  });

  it('a node run that fails is said in the reply with the node\'s reason', async () => {
    const clientId = 'node-run-fails';
    const base = await bootNode(clientId, ['chat', 'antigravity.exec']);
    await fetch(`${base}/${clientId}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'hello', userSub: OWNER }) });
    const task = await claimTask(base, clientId);
    await fetch(`${base}/${clientId}/tasks/${encodeURIComponent(task.taskId)}/fail`, { method: 'POST', headers: H,
      body: JSON.stringify({ correlationId: task.correlationId, toolName: 'antigravity.exec', error: 'agy is not signed in on this computer' }) });
    const reply = await nextReply(base, clientId);
    expect(reply).toMatchObject({ type: 'chat.reply', success: false, text: '' });
    expect(String(reply.error)).toContain('agy is not signed in on this computer');
  });

  it('a node without the executor keeps the controller path, which refuses the CLI as before', async () => {
    const clientId = 'node-without-agy';
    const base = await bootNode(clientId, ['chat', 'codex.exec']);
    await fetch(`${base}/${clientId}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'hello', userSub: OWNER }) });
    const reply = await nextReply(base, clientId);
    expect(reply).toMatchObject({ type: 'chat.reply', success: false });
    expect(String(reply.error)).toContain('antigravity-cli unattended execution is disabled');
    const queued = await fetch(`${base}/${clientId}/tasks/next`, { headers: H });
    expect(queued.status).toBe(204);
  });
});

// The orchestrator accepts a turnProvider only when it is an LLMService; the node provider must be one.
it('NodeExecutorProvider is an LLMService, which is what the orchestrator checks before using a turnProvider', () => {
  expect(new NodeExecutorProvider({ queue: scriptedQueue([]).queue, clientId: 'n', agentId: 'b', plan: PLAN, chatTaskId: 't' })).toBeInstanceOf(LLMService);
});
