/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the bounded SAME-endpoint BYO retry (operator decision 2026-09-22): the invariant that an explicit BYO turn never rotates onto another provider, that a retryable wall IS replayed against the same endpoint across a REAL http boundary with the real TaskOrchestrator, that the excluded classes are not replayed, and that neither the attempt bound nor the wall-clock ceiling can be exceeded.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reworked after review refuted the first build. The retry now wraps the PROVIDER call inside the orchestrator turn, so the cases count what the turn persists: ONE saved user message and ONE error broadcast whatever the attempt count. Explicit-only keying: a threaded connection with no resolution source, or a free-tier / operator-key one, gets exactly one attempt. The cockpit path is crossed for real (POST /api/send-message through createMessageRoutes with the REAL orchestrator and a loopback endpoint; a decoy provider is the rotation lane and is never called). HTTP 503 "high demand" is in the vocabulary; a bare 500, 400, 401 and 404 are not. OSHAL_BYO_RETRY_MAX_ATTEMPTS=0 is OFF, an oversized override clamps and logs once.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added the bodyless 503 the operator's endpoint answered on 2026-09-22 ("503 status code (no body)"). Every 503 case here carried a high-demand body, so the vocabulary could have been narrowed to that wording and still read green while the failure that prompted the work went unretried.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => {
  const spy = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: (): unknown => spy };
  return spy;
});
vi.mock('@/shared/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/shared/logger')>(),
  createChildLogger: () => logSpies,
}));
// The ticket-context resolver wants a real store/pool and is not under test; the ladder is doubled
// so the cockpit route resolves the loopback endpoint as the caller's EXPLICIT choice. Everything
// else the route runs — the router, the shared turn body, the REAL orchestrator, the REAL hosted
// provider over a REAL http boundary — is real.
vi.mock('@/features/chat-orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat-orchestration')>();
  return {
    ...actual,
    resolveProjectManagerTicketExecutionContext: vi.fn(async (_deps: unknown, input: { requestedTaskId: string; source: string }) => ({
      taskId: input.requestedTaskId, source: input.source, ticketCreated: false, ticketId: null, ticketStatus: null, ticketTitle: null, ticketContext: undefined,
    })),
  };
});
const ladder = vi.hoisted(() => ({ resolve: vi.fn<() => Promise<unknown>>(async () => undefined) }));
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/routes/free-tier-rotation')>(),
  resolveUserLlmConnection: (..._args: unknown[]) => ladder.resolve(),
}));
vi.mock('@/features/cost-governance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/cost-governance')>(),
  BudgetService: class { async checkBudget(): Promise<{ allowed: boolean }> { return { allowed: true }; } },
}));

import {
  LLMService,
  type LLMResponse,
  type SendRequestOptions,
} from '../../src/features/llm-provider/services/llm-service';
import {
  DEFAULT_SAME_ENDPOINT_RETRY_PLAN,
  SAME_ENDPOINT_RETRY_CEILING,
  classifySameEndpointRetry,
  resetSameEndpointRetryPlanWarningsForTesting,
  runWithSameEndpointRetry,
  sameEndpointAttemptsOf,
  sameEndpointBackoffMs,
  sameEndpointRetryPlan,
} from '../../src/features/llm-provider/services/same-endpoint-retry';
import {
  TaskOrchestrator,
  type TaskOrchestratorDeps,
} from '../../src/features/chat-orchestration/services/task-orchestrator';
import {
  executeBotOrInline,
  isExplicitByoTurn,
  retryHostedBrainTurn,
} from '../../src/app/routes/inline-bot-execution';
import { reportResolvedLlmFailure } from '../../src/app/routes/free-tier-rotation';
import type { AppContext } from '../../src/app/composition/app-context';
import type { BotNodeClient, BotNodeRequest } from '../../src/features/agent-management';

const SECRET_KEY = 'sk-byo-retry-secret-4f2';
const HIGH_DEMAND = '{"error":{"message":"This model is currently experiencing high demand. Please try again later.","status":"UNAVAILABLE"}}';
const USER_SUB = 'auth0|byo-retry-user';
const TASK_ID = 'f2b7a9d0-0000-4000-8000-00000000b7e0';

/** A REAL local OpenAI-compatible endpoint that answers a SCRIPTED sequence — the boundary under guard. */
function createScriptedEndpoint() {
  const requests: Array<{ host: string; authorization?: string; model: unknown }> = [];
  let script: Array<{ status: number; payload: unknown }> = [];
  let fallback: { status: number; payload: unknown } = { status: 200, payload: textCompletion('ok') };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ host: String(req.headers.host ?? ''), authorization: req.headers.authorization, model: body.model });
      const next = script.shift() ?? fallback;
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(typeof next.payload === 'string' ? next.payload : JSON.stringify(next.payload));
    });
  });
  return {
    requests,
    reset(): void {
      requests.length = 0;
      script = [];
      fallback = { status: 200, payload: textCompletion('ok') };
    },
    /** Answers for the first N calls, in order; anything beyond falls through to `setFallback`. */
    setScript(entries: Array<{ status: number; payload: unknown }>): void { script = [...entries]; },
    setFallback(status: number, payload: unknown): void { fallback = { status, payload }; },
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}/v1`;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

/** Minimal OpenAI chat-completions text payload. */
function textCompletion(text: string): Record<string, unknown> {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    model: 'stub-model',
  };
}

/** The lane a ROTATION would land on. If this ever answers, the BYO boundary was crossed. */
class RotationProvider extends LLMService {
  constructor() { super('rotation-lane', {}); }

  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    return {
      content: [{ type: 'text', text: 'ROTATED-TO-ANOTHER-PROVIDER' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'rotation-model',
    };
  }
}

/** A REAL TaskOrchestrator over in-memory store/stream doubles that COUNT what the turn persists. */
function buildOrchestrator() {
  const saved: Array<Record<string, any>> = [];
  const tasks = new Map<string, Record<string, any>>();
  const taskStore = {
    create: async (input: Record<string, any>) => { tasks.set(String(input.taskId), { ...input }); return { ...input }; },
    get: async (taskId: string) => tasks.get(taskId) ?? null,
    updateStatus: async () => {},
    incrementMessageCount: async () => {},
    incrementTurnCount: async () => {},
    recordUsage: vi.fn(async () => {}),
  };
  const messageStore = {
    save: async (input: Record<string, any>) => { saved.push(input); return { ...input, messageId: `m-${saved.length}` }; },
    getRecent: async () => [...saved],
  };
  const broadcastError = vi.fn();
  const streamManager = {
    associateTaskWithSession: () => {},
    broadcastTaskUpdate: () => {},
    broadcastMessage: () => {},
    broadcastError,
  };
  const getProvider = vi.fn(() => new RotationProvider());
  const deps = {
    taskStore,
    messageStore,
    streamManager,
    getProvider,
    getTools: async () => [],
    executeTool: async () => 'ok',
    getSystemPrompt: async () => 'SYSTEM',
  } as unknown as TaskOrchestratorDeps;
  const userMessages = () => saved.filter((m) => m.role === 'user').length;
  return { orchestrator: new TaskOrchestrator(deps), getProvider, saved, userMessages, broadcastError, recordUsage: taskStore.recordUsage };
}

/** The base turn options every orchestrator case runs with. */
function turnOptions(baseUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agenticMode: true, autoApprove: false, source: 'test', agentId: 'agent-1',
    byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
    ...extra,
  };
}

/** A real registry agent that is controller-inline on a CLI harness and unscoped — the population the cockpit fix serves. */
async function pickCliHarnessAgentId(): Promise<string> {
  const { getActiveRegistry } = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const entry = getActiveRegistry().find((bot) => {
    const roles = (bot as { accessRoles?: string[] }).accessRoles;
    const open = !roles || roles.length === 0;
    const inline = bot.container === 'oshal-api' && !(bot as { requiresOwnNode?: boolean }).requiresOwnNode;
    return Boolean(bot.agentId) && bot.harnessType === 'codex-cli' && open && inline;
  });
  if (!entry?.agentId) throw new Error('no open inline codex-cli registry bot found');
  return entry.agentId;
}

const servers: Array<{ close: (cb: () => void) => void }> = [];

/** Boots the REAL message router over the REAL orchestrator with the identity stamping the OIDC middleware produces. */
async function bootSendMessageApp(orchestrator: TaskOrchestrator): Promise<string> {
  const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
  const ctx = {
    taskStore: { get: async () => null, incrementMessageCount: async () => undefined, incrementTurnCount: async () => undefined },
    workspaceService: { resolveTaskOwner: async () => null },
    ticketService: {},
    pool: {},
    orchestrator,
    messageStore: { save: async () => ({}) },
  } as unknown as Parameters<typeof createMessageRoutes>[0];
  const app = express();
  app.use(express.json());
  app.use(((req: Request, _res: Response, next: NextFunction) => {
    const sub = req.header('x-test-sub');
    if (sub) (req as Request & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub, email: `${sub}@example.test` } };
    next();
  }));
  app.use('/api', createMessageRoutes(ctx));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}/api`;
}

const endpoint = createScriptedEndpoint();
let baseUrl = '';
/** No-op sleep: these guards assert the retry ARITHMETIC, not that the process can wait. */
const noSleep = async (): Promise<void> => {};
const ENV_KEYS = ['OSHAL_BYO_RETRY_MAX_ATTEMPTS', 'OSHAL_BYO_RETRY_BASE_DELAY_MS', 'OSHAL_BYO_RETRY_MAX_DELAY_MS', 'OSHAL_BYO_RETRY_BUDGET_MS',
  'OSHAL_LLM_BUDGETS', 'OSHAL_EXECUTE_ENTITLEMENT', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'SWARM_SERVICE_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => { baseUrl = await endpoint.listen(); });
afterAll(async () => { await endpoint.close(); });

beforeEach(() => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  process.env.OSHAL_EXECUTE_ENTITLEMENT = 'off';
  // The replay must not wait between attempts here: the bounds have their own arithmetic cases.
  process.env.OSHAL_BYO_RETRY_BASE_DELAY_MS = '0';
  endpoint.reset();
  ladder.resolve.mockReset();
  ladder.resolve.mockImplementation(async () => undefined);
  resetSameEndpointRetryPlanWarningsForTesting();
  logSpies.warn.mockClear();
});

afterEach(async () => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
});

describe('THE INVARIANT — an explicit BYO turn is never rotated onto another provider', () => {
  const explicit = { baseUrl: 'https://byo.example.test/v1', apiKey: 'user-key', model: 'user-model', resolutionSource: 'explicit' as const };

  it('reportResolvedLlmFailure refuses to authorise a rotation for an explicit connection, on every retryable wall', async () => {
    for (const wall of ['429 too many requests', '402 quota exceeded', 'ResourceExhausted', 'rate-limit hit', 'HTTP 503: high demand']) {
      await expect(reportResolvedLlmFailure(null, explicit, new Error(wall))).resolves.toBe(false);
    }
  });

  it('retryHostedBrainTurn returns no next lane for an explicit connection — there is nowhere it may go', async () => {
    const resolveConnection = vi.fn(async () => ({ baseUrl: 'https://other.example.test/v1', apiKey: 'k', model: 'other-model' }));
    const next = await retryHostedBrainTurn(
      null as unknown as AppContext['pool'], 'cli-bot', 'user-1', explicit, new Error('429 too many requests'),
      { loadRegistry: () => [{ agentId: 'cli-bot', harnessType: 'claude-code' }], resolveConnection } as any,
    );
    expect(next).toBeNull();
    expect(resolveConnection).not.toHaveBeenCalled();
  });
});

describe('the replay wraps the PROVIDER CALL — one saved user message, one broadcast, whatever the attempt count', () => {
  it('a 503 "high demand" wall is replayed on the SAME endpoint inside the turn and answered on the replay', async () => {
    endpoint.setScript([{ status: 503, payload: HIGH_DEMAND }, { status: 503, payload: HIGH_DEMAND }, { status: 200, payload: textCompletion('recovered') }]);
    const { orchestrator, getProvider, userMessages, broadcastError } = buildOrchestrator();

    const result = await orchestrator.processMessage('task-503', 'hi', turnOptions(baseUrl, { byoLlmRetry: true }) as any);

    expect(result.success).toBe(true);
    expect(result.response).toBe('recovered');
    expect(endpoint.requests).toHaveLength(3);
    // SAME endpoint: same host:port, same bearer, same model on every attempt.
    expect(new Set(endpoint.requests.map((r) => r.host)).size).toBe(1);
    expect(endpoint.requests.every((r) => r.authorization === `Bearer ${SECRET_KEY}`)).toBe(true);
    expect(endpoint.requests.every((r) => r.model === 'user-model')).toBe(true);
    // The turn persisted ONCE: the replays happened beneath saveUserMessage, not around it.
    expect(userMessages()).toBe(1);
    expect(broadcastError).not.toHaveBeenCalled();
    // The whole boundary, in one assertion: nothing but the user's own endpoint ever ran.
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('an endpoint that never recovers is reported ONCE — one saved user message, one error broadcast, the failure naming the attempts', async () => {
    endpoint.setFallback(503, HIGH_DEMAND);
    const { orchestrator, userMessages, broadcastError, recordUsage } = buildOrchestrator();

    const result = await orchestrator.processMessage('task-503-wall', 'hi', turnOptions(baseUrl, { byoLlmRetry: true }) as any);

    expect(result.success).toBe(false);
    expect(endpoint.requests).toHaveLength(DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts);
    expect(userMessages()).toBe(1);
    expect(broadcastError).toHaveBeenCalledTimes(1);
    expect(result.error).toContain(`(${DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts} attempts on the same endpoint)`);
    expect(sameEndpointAttemptsOf(new Error(result.error ?? ''))).toBe(DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts);
    // A failed attempt records NO usage — the measured reason a replay cannot duplicate the ledger.
    expect(result.usageSummary).toBeUndefined();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('replays a 429 and a 402 spend-cap wall too — the intermittent-cap case', async () => {
    for (const wall of [{ status: 429, payload: 'rate limited' }, { status: 402, payload: 'monthly quota exceeded' }]) {
      endpoint.reset();
      endpoint.setScript([wall, { status: 200, payload: textCompletion('cap-was-transient') }]);
      const { orchestrator, userMessages } = buildOrchestrator();
      const result = await orchestrator.processMessage(`task-${wall.status}`, 'hi', turnOptions(baseUrl, { byoLlmRetry: true }) as any);
      expect(result.response).toBe('cap-was-transient');
      expect(endpoint.requests).toHaveLength(2);
      expect(userMessages()).toBe(1);
    }
  });

  it('without byoLlmRetry the same wall gets exactly one attempt', async () => {
    endpoint.setFallback(503, HIGH_DEMAND);
    const { orchestrator } = buildOrchestrator();
    const result = await orchestrator.processMessage('task-no-retry', 'hi', turnOptions(baseUrl) as any);
    expect(result.success).toBe(false);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('a 401, a 403, a 404 and a bare 500 are not capacity problems — never replayed, even with the retry on', async () => {
    for (const [status, payload] of [[401, 'unauthorized: invalid api key'], [403, 'forbidden: key not permitted'], [404, 'model not found'], [500, 'internal server error']] as const) {
      endpoint.reset();
      endpoint.setFallback(status, payload);
      const { orchestrator } = buildOrchestrator();
      const result = await orchestrator.processMessage(`task-${status}`, 'hi', turnOptions(baseUrl, { byoLlmRetry: true }) as any);
      expect(result.success).toBe(false);
      expect(endpoint.requests, `status ${status}`).toHaveLength(1);
    }
  });
});

describe('explicit-only keying — a threaded connection is explicit only when its caller says so', () => {
  const connection = { baseUrl: 'https://byo.example.test/v1', apiKey: 'user-key', model: 'user-model' };

  it('isExplicitByoTurn names exactly resolutionSource === "explicit", carried either way', () => {
    expect(isExplicitByoTurn({ byoLlmConnection: connection, byoLlmResolutionSource: 'explicit' }, undefined)).toBe(true);
    expect(isExplicitByoTurn({ byoLlmConnection: connection }, undefined)).toBe(false);
    expect(isExplicitByoTurn({ byoLlmConnection: connection, byoLlmResolutionSource: 'free-tier' }, undefined)).toBe(false);
    expect(isExplicitByoTurn({ byoLlmConnection: connection, byoLlmResolutionSource: 'operator-key' }, undefined)).toBe(false);
    expect(isExplicitByoTurn(undefined, { ...connection, resolutionSource: 'explicit' } as any)).toBe(true);
    expect(isExplicitByoTurn(undefined, { ...connection, resolutionSource: 'platform' } as any)).toBe(false);
    expect(isExplicitByoTurn(undefined, undefined)).toBe(false);
  });

  const request: BotNodeRequest = {
    text: 'draft the thing', taskId: 'inline-task', workspaceFolderId: 'inline-task', agentId: 'inline-agent',
    agenticMode: true, direct: true, userSub: USER_SUB,
  };
  const inlineOnly = { hasEndpoint: vi.fn(() => false), execute: vi.fn() } as unknown as BotNodeClient;

  it('executeBotOrInline asks for the replay ONLY when the threaded connection was explicit', async () => {
    for (const [source, expected] of [['explicit', true], [undefined, false], ['free-tier', false], ['operator-key', false]] as const) {
      const processMessage = vi.fn(async () => ({ success: true, response: 'ok', turnCount: 1, toolsUsed: [] }));
      const ctx = { orchestrator: { processMessage } } as unknown as AppContext;
      await executeBotOrInline(ctx, inlineOnly, 'inline-agent', {
        ...request, byoLlmConnection: connection, ...(source ? { byoLlmResolutionSource: source } : {}),
      });
      expect(processMessage).toHaveBeenCalledTimes(1);
      const options = processMessage.mock.calls[0][2] as { byoLlmRetry?: boolean; byoLlmConnection?: unknown };
      expect(options.byoLlmRetry, `source ${String(source)}`).toBe(expected);
      expect(options.byoLlmConnection).toEqual(connection);
    }
  });

  it('a threaded connection with NO source gets exactly ONE attempt against the real endpoint (executeBotOrInline → real orchestrator)', async () => {
    endpoint.setFallback(503, HIGH_DEMAND);
    const { orchestrator } = buildOrchestrator();
    const ctx = { orchestrator } as unknown as AppContext;

    await expect(executeBotOrInline(ctx, inlineOnly, 'inline-agent', {
      ...request, byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
    })).rejects.toThrow(/Inline bot execution failed/);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('a threaded free-tier lane gets exactly ONE attempt too — it rotates, it does not wait', async () => {
    endpoint.setFallback(503, HIGH_DEMAND);
    const { orchestrator } = buildOrchestrator();
    const ctx = { orchestrator } as unknown as AppContext;

    await expect(executeBotOrInline(ctx, inlineOnly, 'inline-agent', {
      ...request, byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' }, byoLlmResolutionSource: 'free-tier',
    })).rejects.toThrow(/Inline bot execution failed/);
    expect(endpoint.requests).toHaveLength(1);
  });
});

describe('the cockpit chat path — POST /api/send-message over the REAL router and the REAL orchestrator', () => {
  it('replays the 503 wall on the SAME endpoint and answers on the replay — one user message saved, the rotation lane never called', async () => {
    const agentId = await pickCliHarnessAgentId();
    ladder.resolve.mockImplementation(async () => ({ baseUrl, apiKey: SECRET_KEY, model: 'user-model', resolutionSource: 'explicit' }));
    endpoint.setScript([{ status: 503, payload: HIGH_DEMAND }, { status: 503, payload: HIGH_DEMAND }, { status: 200, payload: textCompletion('recovered') }]);
    const { orchestrator, getProvider, userMessages, broadcastError } = buildOrchestrator();
    const base = await bootSendMessageApp(orchestrator);

    const res = await fetch(`${base}/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; response: string; brainFallback?: unknown };
    expect(body.success).toBe(true);
    expect(body.response).toBe('recovered');
    expect(body.brainFallback).toBeUndefined();
    expect(endpoint.requests).toHaveLength(3);
    expect(endpoint.requests.every((r) => r.authorization === `Bearer ${SECRET_KEY}`)).toBe(true);
    expect(userMessages()).toBe(1);
    expect(broadcastError).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('a NON-operator whose explicit endpoint stays walled gets that failure — bounded attempts, no other provider, ever', async () => {
    const agentId = await pickCliHarnessAgentId();
    ladder.resolve.mockImplementation(async () => ({ baseUrl, apiKey: SECRET_KEY, model: 'user-model', resolutionSource: 'explicit' }));
    endpoint.setFallback(503, HIGH_DEMAND);
    const { orchestrator, getProvider, userMessages, broadcastError } = buildOrchestrator();
    const base = await bootSendMessageApp(orchestrator);

    const res = await fetch(`${base}/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    const body = await res.json() as { success: boolean; error?: string; code?: string };
    expect(body.success).toBe(false);
    expect(body.code).not.toBe('BYO_FALLBACK_NOT_READY');
    expect(String(body.error)).toContain('503');
    expect(endpoint.requests).toHaveLength(DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts);
    expect(userMessages()).toBe(1);
    expect(broadcastError).toHaveBeenCalledTimes(1);
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('a resolver-owned lane on this path gets exactly one attempt (it rotates instead of waiting)', async () => {
    const agentId = await pickCliHarnessAgentId();
    ladder.resolve.mockImplementation(async () => ({ baseUrl, apiKey: SECRET_KEY, model: 'user-model', resolutionSource: 'operator-key' }));
    endpoint.setFallback(503, HIGH_DEMAND);
    const { orchestrator } = buildOrchestrator();
    const base = await bootSendMessageApp(orchestrator);

    const res = await fetch(`${base}/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect((await res.json() as { success: boolean }).success).toBe(false);
    expect(endpoint.requests).toHaveLength(1);
  });
});

describe('the classifier — one vocabulary, three retryable classes, everything else refused with its reason', () => {
  it('classifies each member of the shared vocabulary, and everything outside it', () => {
    expect(classifySameEndpointRetry(new Error('429 too many requests'))).toEqual({ retry: true, reason: 'rate-limit' });
    expect(classifySameEndpointRetry(new Error('rate-limit reached'))).toEqual({ retry: true, reason: 'rate-limit' });
    expect(classifySameEndpointRetry(new Error('request was throttled'))).toEqual({ retry: true, reason: 'rate-limit' });
    expect(classifySameEndpointRetry(new Error('402 payment required'))).toEqual({ retry: true, reason: 'quota' });
    expect(classifySameEndpointRetry(new Error('quota exceeded'))).toEqual({ retry: true, reason: 'quota' });
    expect(classifySameEndpointRetry(new Error('ResourceExhausted'))).toEqual({ retry: true, reason: 'quota' });
    // The 2026-09-21 refusal, exactly as the endpoint gave it.
    expect(classifySameEndpointRetry(new Error(`byo-hosted endpoint generativelanguage.googleapis.com returned HTTP 503: ${HIGH_DEMAND}`)))
      .toEqual({ retry: true, reason: 'capacity' });
    // And the shape the SAME endpoint gave on 2026-09-22, with no body at all to read: the bare
    // status is the whole signal, so `503` alone has to carry it or tonight's outage is not covered.
    expect(classifySameEndpointRetry(new Error('503 status code (no body)'))).toEqual({ retry: true, reason: 'capacity' });
    expect(classifySameEndpointRetry(new Error('server overloaded, retry shortly'))).toEqual({ retry: true, reason: 'capacity' });
    expect(classifySameEndpointRetry(new Error('service unavailable'))).toEqual({ retry: true, reason: 'capacity' });
    // A bare 500 is a server fault, not a capacity signal.
    expect(classifySameEndpointRetry(new Error('returned HTTP 500: internal server error'))).toEqual({ retry: false, reason: 'not-a-provider-wall' });
    expect(classifySameEndpointRetry(new Error('returned HTTP 400: bad request'))).toEqual({ retry: false, reason: 'not-a-provider-wall' });
    expect(classifySameEndpointRetry(new Error('returned HTTP 404: model not found'))).toEqual({ retry: false, reason: 'not-a-provider-wall' });
    expect(classifySameEndpointRetry(new Error('returned HTTP 401: unauthorized'))).toEqual({ retry: false, reason: 'not-a-provider-wall' });
    // Excluded: deterministic against this key, so a replay only spends the user's wait.
    expect(classifySameEndpointRetry(new Error('403 forbidden'))).toEqual({ retry: false, reason: 'authorization' });
    // Excluded: a 200 that was billed — rotation-only.
    expect(classifySameEndpointRetry(new Error('LLM endpoint returned no final answer'))).toEqual({ retry: false, reason: 'completed-empty' });
    expect(classifySameEndpointRetry(new Error('empty_final_answer'))).toEqual({ retry: false, reason: 'completed-empty' });
    expect(classifySameEndpointRetry(new Error('tool schema invalid'))).toEqual({ retry: false, reason: 'not-a-provider-wall' });
    // A body carrying both reads as the authorization verdict, never as the wall.
    expect(classifySameEndpointRetry(new Error('403 forbidden: rate-limit policy'))).toEqual({ retry: false, reason: 'authorization' });
    // Vendors put the status on `code`; it is read exactly as the rotation gate reads it.
    expect(classifySameEndpointRetry(Object.assign(new Error('upstream said no'), { code: 429 }))).toEqual({ retry: true, reason: 'rate-limit' });
  });

  it('preserves failure identity — a thrown run rethrows its ORIGINAL error object, annotated with the attempts', async () => {
    const original = Object.assign(new Error('429 too many requests'), { code: 'BYO_HOSTED_HTTP_ERROR' });
    const run = vi.fn(async () => { throw original; });

    await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, { sleep: noSleep })).rejects.toBe(original);
    expect(run).toHaveBeenCalledTimes(DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts);
    expect(sameEndpointAttemptsOf(original)).toBe(DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts);
    expect(original.message).toContain('429 too many requests');
  });

  it('a failure that was never retried is not annotated', async () => {
    const original = new Error('403 forbidden');
    await expect(runWithSameEndpointRetry({ agentId: 'a' }, async () => { throw original; }, { sleep: noSleep })).rejects.toBe(original);
    expect(original.message).toBe('403 forbidden');
    expect(sameEndpointAttemptsOf(original)).toBe(1);
  });
});

describe('the bounds cannot be exceeded, 0 is off, and an override outside the ceiling is clamped once', () => {
  it('never makes more than maxAttempts attempts, for any bound', async () => {
    for (const maxAttempts of [1, 2, 3, 5]) {
      const run = vi.fn(async () => { throw new Error('429 too many requests'); });
      await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, {
        plan: { maxAttempts, budgetMs: Number.MAX_SAFE_INTEGER }, sleep: noSleep,
      })).rejects.toThrow('429');
      expect(run).toHaveBeenCalledTimes(maxAttempts);
    }
  });

  it('OSHAL_BYO_RETRY_MAX_ATTEMPTS=0 switches the retry OFF — exactly one attempt', async () => {
    process.env.OSHAL_BYO_RETRY_MAX_ATTEMPTS = '0';
    expect(sameEndpointRetryPlan(process.env).maxAttempts).toBe(1);
    const run = vi.fn(async () => { throw new Error('429 too many requests'); });
    await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, { sleep: noSleep })).rejects.toThrow('429');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an override above the ceiling is clamped to it, and the clamp is logged exactly once per process', () => {
    process.env.OSHAL_BYO_RETRY_MAX_ATTEMPTS = '500';
    process.env.OSHAL_BYO_RETRY_BUDGET_MS = '9999999';
    expect(sameEndpointRetryPlan(process.env)).toMatchObject({ maxAttempts: SAME_ENDPOINT_RETRY_CEILING.maxAttempts, budgetMs: SAME_ENDPOINT_RETRY_CEILING.budgetMs });
    sameEndpointRetryPlan(process.env);
    sameEndpointRetryPlan(process.env);
    const clampLines = logSpies.warn.mock.calls.filter((call) => String(call[1]).includes('clamped'));
    expect(clampLines).toHaveLength(2); // one per variable, not one per read
    expect(clampLines.map((call) => (call[0] as { name: string }).name).sort()).toEqual(['OSHAL_BYO_RETRY_BUDGET_MS', 'OSHAL_BYO_RETRY_MAX_ATTEMPTS']);
  });

  it('a non-numeric or negative override is ignored, logged once, and never obeyed', () => {
    process.env.OSHAL_BYO_RETRY_MAX_ATTEMPTS = 'three';
    process.env.OSHAL_BYO_RETRY_BUDGET_MS = '-1';
    expect(sameEndpointRetryPlan(process.env)).toMatchObject({
      maxAttempts: DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts, budgetMs: DEFAULT_SAME_ENDPOINT_RETRY_PLAN.budgetMs,
    });
    sameEndpointRetryPlan(process.env);
    expect(logSpies.warn.mock.calls.filter((call) => String(call[1]).includes('ignored'))).toHaveLength(2);
  });

  it('reads a usable override as written', () => {
    process.env.OSHAL_BYO_RETRY_MAX_ATTEMPTS = '5';
    process.env.OSHAL_BYO_RETRY_BUDGET_MS = '30000';
    expect(sameEndpointRetryPlan(process.env)).toMatchObject({ maxAttempts: 5, budgetMs: 30_000 });
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('stops on the wall-clock ceiling even when attempts remain — a slow failure does not buy another try', async () => {
    let clock = 0;
    const run = vi.fn(async () => { clock += 9_000; throw new Error('429 too many requests'); });
    await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, {
      plan: { maxAttempts: 9, budgetMs: 15_000, baseDelayMs: 1_000, maxDelayMs: 4_000 },
      now: () => clock, sleep: async (ms: number) => { clock += ms; }, random: () => 0.5,
    })).rejects.toThrow('429');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially, capped, with symmetric jitter', () => {
    const plan = { maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 4_000, budgetMs: 15_000 };
    expect(sameEndpointBackoffMs(1, plan, () => 0.5)).toBe(1_000);
    expect(sameEndpointBackoffMs(2, plan, () => 0.5)).toBe(2_000);
    expect(sameEndpointBackoffMs(3, plan, () => 0.5)).toBe(4_000);
    expect(sameEndpointBackoffMs(4, plan, () => 0.5)).toBe(4_000); // capped, not 8_000
    expect(sameEndpointBackoffMs(1, plan, () => 0)).toBe(750);
    expect(sameEndpointBackoffMs(1, plan, () => 1)).toBe(1_250);
  });

  it('the default bound fits well inside the 75s decision race the conversational path already runs under', () => {
    const plan = DEFAULT_SAME_ENDPOINT_RETRY_PLAN;
    const worstBackoff = [...Array(plan.maxAttempts - 1)].reduce<number>(
      (total, _unused, index) => total + sameEndpointBackoffMs(index + 1, plan, () => 1), 0,
    );
    expect(worstBackoff).toBeLessThanOrEqual(plan.budgetMs);
    expect(plan.budgetMs).toBeLessThan(75_000 / 4);
  });
});
