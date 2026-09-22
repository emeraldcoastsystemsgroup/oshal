/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the bounded SAME-endpoint BYO retry (operator decision 2026-09-22): the invariant that an explicit BYO turn never rotates onto another provider, that a retryable wall IS replayed against the same endpoint across a REAL http boundary with the real TaskOrchestrator, that the excluded classes are not replayed, and that neither the attempt bound nor the wall-clock ceiling can be exceeded.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLMService,
  type LLMResponse,
  type SendRequestOptions,
} from '../../src/features/llm-provider/services/llm-service';
import {
  TaskOrchestrator,
  type TaskOrchestratorDeps,
} from '../../src/features/chat-orchestration/services/task-orchestrator';
import {
  executeBotOrInline,
  isExplicitByoTurn,
  retryHostedBrainTurn,
  swallowedTurnFailure,
} from '../../src/app/routes/inline-bot-execution';
import {
  DEFAULT_SAME_ENDPOINT_RETRY_PLAN,
  classifySameEndpointRetry,
  runWithSameEndpointRetry,
  sameEndpointBackoffMs,
  sameEndpointRetryPlan,
} from '../../src/app/routes/same-endpoint-retry';
import { reportResolvedLlmFailure } from '../../src/app/routes/free-tier-rotation';
import type { AppContext } from '../../src/app/composition/app-context';
import type { BotNodeClient, BotNodeRequest } from '../../src/features/agent-management';

const SECRET_KEY = 'sk-byo-retry-secret-4f2';

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

/** A REAL TaskOrchestrator over in-memory store/stream doubles (collaborators OUTSIDE the guarded boundary). */
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
  const streamManager = {
    associateTaskWithSession: () => {},
    broadcastTaskUpdate: () => {},
    broadcastMessage: () => {},
    broadcastError: () => {},
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
  return { orchestrator: new TaskOrchestrator(deps), getProvider, saved, recordUsage: taskStore.recordUsage };
}

const endpoint = createScriptedEndpoint();
let baseUrl = '';
/** No-op sleep: these guards assert the retry ARITHMETIC, not that the process can wait. */
const noSleep = async (): Promise<void> => {};

beforeAll(async () => {
  delete process.env.OSHAL_LLM_BUDGETS;
  baseUrl = await endpoint.listen();
});

afterAll(async () => { await endpoint.close(); });

beforeEach(() => { endpoint.reset(); });

afterEach(() => {
  delete process.env.OSHAL_BYO_RETRY_MAX_ATTEMPTS;
  delete process.env.OSHAL_BYO_RETRY_BASE_DELAY_MS;
  delete process.env.OSHAL_BYO_RETRY_MAX_DELAY_MS;
  delete process.env.OSHAL_BYO_RETRY_BUDGET_MS;
});

describe('THE INVARIANT — an explicit BYO turn is never rotated onto another provider', () => {
  const explicit = {
    baseUrl: 'https://byo.example.test/v1',
    apiKey: 'user-key',
    model: 'user-model',
    resolutionSource: 'explicit' as const,
  };

  it('reportResolvedLlmFailure refuses to authorise a rotation for an explicit connection, on every retryable wall', async () => {
    for (const wall of ['429 too many requests', '402 quota exceeded', 'ResourceExhausted', 'rate-limit hit']) {
      await expect(reportResolvedLlmFailure(null, explicit, new Error(wall))).resolves.toBe(false);
    }
  });

  it('retryHostedBrainTurn returns no next lane for an explicit connection — there is nowhere it may go', async () => {
    const resolveConnection = vi.fn(async () => ({ baseUrl: 'https://other.example.test/v1', apiKey: 'k', model: 'other-model' }));
    const next = await retryHostedBrainTurn(
      null as unknown as AppContext['pool'],
      'cli-bot',
      'user-1',
      explicit,
      new Error('429 too many requests'),
      { loadRegistry: () => [{ agentId: 'cli-bot', harnessType: 'claude-code' }], resolveConnection } as any,
    );
    expect(next).toBeNull();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('a retried BYO turn reaches ONLY the user endpoint — the rotation lane provider is never constructed', async () => {
    endpoint.setScript([
      { status: 429, payload: 'rate limited' },
      { status: 200, payload: textCompletion('answered-on-the-same-endpoint') },
    ]);
    const { orchestrator, getProvider } = buildOrchestrator();

    const result = await runWithSameEndpointRetry(
      { agentId: 'agent-1', baseUrl, model: 'user-model' },
      () => orchestrator.processMessage('task-invariant', 'hi', {
        agenticMode: true,
        autoApprove: false,
        source: 'test',
        agentId: 'agent-1',
        byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
      } as any),
      { failureOf: swallowedTurnFailure, sleep: noSleep },
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('answered-on-the-same-endpoint');
    expect(result.response).not.toContain('ROTATED');
    // The whole boundary, in one assertion: nothing but the user's own endpoint ever ran.
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('a retryable wall IS replayed against the SAME endpoint (real http boundary)', () => {
  it('replays the 429 on the identical host, key and model, and answers on the replay', async () => {
    endpoint.setScript([
      { status: 429, payload: 'rate limited' },
      { status: 200, payload: textCompletion('recovered') },
    ]);
    const { orchestrator } = buildOrchestrator();

    const result = await runWithSameEndpointRetry(
      { agentId: 'agent-1', baseUrl, model: 'user-model' },
      () => orchestrator.processMessage('task-retry-429', 'hi', {
        agenticMode: true,
        autoApprove: false,
        source: 'test',
        agentId: 'agent-1',
        byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
      } as any),
      { failureOf: swallowedTurnFailure, sleep: noSleep },
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('recovered');
    expect(endpoint.requests).toHaveLength(2);
    // SAME endpoint: same host:port, same bearer, same model on both attempts.
    expect(new Set(endpoint.requests.map((r) => r.host)).size).toBe(1);
    expect(endpoint.requests.every((r) => r.authorization === `Bearer ${SECRET_KEY}`)).toBe(true);
    expect(endpoint.requests.every((r) => r.model === 'user-model')).toBe(true);
  });

  it('replays a 402 spend-cap wall too — the operator case an intermittent cap produces', async () => {
    endpoint.setScript([
      { status: 402, payload: 'monthly quota exceeded' },
      { status: 200, payload: textCompletion('cap-was-transient') },
    ]);
    const { orchestrator } = buildOrchestrator();

    const result = await runWithSameEndpointRetry(
      { agentId: 'agent-1', baseUrl, model: 'user-model' },
      () => orchestrator.processMessage('task-retry-402', 'hi', {
        agenticMode: true, autoApprove: false, source: 'test', agentId: 'agent-1',
        byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
      } as any),
      { failureOf: swallowedTurnFailure, sleep: noSleep },
    );

    expect(result.success).toBe(true);
    expect(result.response).toBe('cap-was-transient');
    expect(endpoint.requests).toHaveLength(2);
  });

  it('a failed attempt records NO usage — the measured reason a replay cannot duplicate the cost ledger', async () => {
    endpoint.setScript([{ status: 429, payload: 'rate limited' }]);
    endpoint.setFallback(429, 'rate limited');
    const { orchestrator, recordUsage } = buildOrchestrator();

    const result = await orchestrator.processMessage('task-no-usage', 'hi', {
      agenticMode: true, autoApprove: false, source: 'test', agentId: 'agent-1',
      byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
    } as any);

    expect(result.success).toBe(false);
    expect(result.usageSummary).toBeUndefined();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('a NON-retryable failure is not replayed on the same endpoint', () => {
  it('a 403 authorization verdict runs exactly once', async () => {
    endpoint.setFallback(403, 'forbidden: key not permitted for this model');
    const { orchestrator } = buildOrchestrator();

    const result = await runWithSameEndpointRetry(
      { agentId: 'agent-1', baseUrl, model: 'user-model' },
      () => orchestrator.processMessage('task-403', 'hi', {
        agenticMode: true, autoApprove: false, source: 'test', agentId: 'agent-1',
        byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
      } as any),
      { failureOf: swallowedTurnFailure, sleep: noSleep },
    );

    expect(result.success).toBe(false);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('classifies each member of the shared vocabulary, and everything outside it', () => {
    expect(classifySameEndpointRetry(new Error('429 too many requests'))).toEqual({ retry: true, reason: 'rate-limit' });
    expect(classifySameEndpointRetry(new Error('rate-limit reached'))).toEqual({ retry: true, reason: 'rate-limit' });
    expect(classifySameEndpointRetry(new Error('request was throttled'))).toEqual({ retry: true, reason: 'rate-limit' });
    expect(classifySameEndpointRetry(new Error('402 payment required'))).toEqual({ retry: true, reason: 'quota' });
    expect(classifySameEndpointRetry(new Error('quota exceeded'))).toEqual({ retry: true, reason: 'quota' });
    // MEASURED: the shared vocabulary carries 'resourceexhausted' unseparated, so Google's canonical
    // RESOURCE_EXHAUSTED spelling is NOT a wall to either gate. Pinned as the behaviour that exists,
    // not widened here: that pattern is the ROTATION gate too and changing it is another decision.
    expect(classifySameEndpointRetry(new Error('ResourceExhausted'))).toEqual({ retry: true, reason: 'quota' });
    expect(classifySameEndpointRetry(new Error('RESOURCE_EXHAUSTED'))).toEqual({ retry: false, reason: 'not-a-provider-wall' });
    // Excluded: deterministic against this key, so a replay only spends the user's wait.
    expect(classifySameEndpointRetry(new Error('403 forbidden'))).toEqual({ retry: false, reason: 'authorization' });
    // Excluded: a 200 that was billed — rotation-only.
    expect(classifySameEndpointRetry(new Error('LLM endpoint returned no final answer')))
      .toEqual({ retry: false, reason: 'completed-empty' });
    expect(classifySameEndpointRetry(new Error('empty_final_answer')))
      .toEqual({ retry: false, reason: 'completed-empty' });
    // Not a wall at all.
    expect(classifySameEndpointRetry(new Error('tool schema invalid'))).toEqual({ retry: false, reason: 'not-a-provider-wall' });
    // A body carrying both reads as the authorization verdict, never as the wall.
    expect(classifySameEndpointRetry(new Error('403 forbidden: rate-limit policy'))).toEqual({ retry: false, reason: 'authorization' });
    // Vendors put the status on `code`; it is read exactly as the rotation gate reads it.
    expect(classifySameEndpointRetry(Object.assign(new Error('upstream said no'), { code: 429 })))
      .toEqual({ retry: true, reason: 'rate-limit' });
  });

  it('preserves failure semantics — a thrown run rethrows its ORIGINAL error, unwrapped', async () => {
    const original = Object.assign(new Error('403 forbidden'), { code: 'BYO_HOSTED_HTTP_ERROR' });
    const run = vi.fn(async () => { throw original; });

    await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, { sleep: noSleep })).rejects.toBe(original);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('the bounds cannot be exceeded', () => {
  it('stops at the attempt bound when the endpoint never recovers', async () => {
    endpoint.setFallback(429, 'rate limited');
    const { orchestrator } = buildOrchestrator();

    const result = await runWithSameEndpointRetry(
      { agentId: 'agent-1', baseUrl, model: 'user-model' },
      () => orchestrator.processMessage('task-bound', 'hi', {
        agenticMode: true, autoApprove: false, source: 'test', agentId: 'agent-1',
        byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
      } as any),
      { failureOf: swallowedTurnFailure, sleep: noSleep },
    );

    expect(result.success).toBe(false);
    expect(endpoint.requests).toHaveLength(DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts);
    expect(DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts).toBe(3);
  });

  it('never makes more than maxAttempts attempts, for any bound', async () => {
    for (const maxAttempts of [1, 2, 3, 5]) {
      const run = vi.fn(async () => { throw new Error('429 too many requests'); });
      await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, {
        plan: { maxAttempts, budgetMs: Number.MAX_SAFE_INTEGER }, sleep: noSleep,
      })).rejects.toThrow('429');
      expect(run).toHaveBeenCalledTimes(maxAttempts);
    }
  });

  it('stops on the wall-clock ceiling even when attempts remain — a slow failure does not buy another try', async () => {
    // Each attempt burns 9s of a 15s budget: attempt 1 ends at 9s, and 9s + the ~1s backoff still
    // fits, so attempt 2 runs; it ends at 18s, where no further retry may be scheduled.
    let clock = 0;
    const run = vi.fn(async () => { clock += 9_000; throw new Error('429 too many requests'); });

    await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, {
      plan: { maxAttempts: 9, budgetMs: 15_000, baseDelayMs: 1_000, maxDelayMs: 4_000 },
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      random: () => 0.5,
    })).rejects.toThrow('429');

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a budget that cannot fit even the first backoff allows exactly one attempt', async () => {
    let clock = 0;
    const run = vi.fn(async () => { throw new Error('429 too many requests'); });

    await expect(runWithSameEndpointRetry({ agentId: 'a' }, run, {
      plan: { maxAttempts: 5, budgetMs: 10, baseDelayMs: 1_000, maxDelayMs: 4_000 },
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      random: () => 0.5,
    })).rejects.toThrow('429');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially, capped, with symmetric jitter', () => {
    const plan = { maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 4_000, budgetMs: 15_000 };
    // random()=0.5 is the un-jittered centre.
    expect(sameEndpointBackoffMs(1, plan, () => 0.5)).toBe(1_000);
    expect(sameEndpointBackoffMs(2, plan, () => 0.5)).toBe(2_000);
    expect(sameEndpointBackoffMs(3, plan, () => 0.5)).toBe(4_000);
    expect(sameEndpointBackoffMs(4, plan, () => 0.5)).toBe(4_000); // capped, not 8_000
    // Jitter is +/-25% of the centre, both directions.
    expect(sameEndpointBackoffMs(1, plan, () => 0)).toBe(750);
    expect(sameEndpointBackoffMs(1, plan, () => 1)).toBe(1_250);
  });

  it('the default bound fits well inside the 75s decision race the conversational path already runs under', () => {
    const plan = DEFAULT_SAME_ENDPOINT_RETRY_PLAN;
    const worstBackoff = [...Array(plan.maxAttempts - 1)].reduce<number>(
      (total, _unused, index) => total + sameEndpointBackoffMs(index + 1, plan, () => 1), 0,
    );
    expect(worstBackoff).toBeLessThanOrEqual(plan.budgetMs);
    // jarvis-orchestrator's DECISION_TIMEOUT_MS default; the retry may not eat the turn's budget.
    expect(plan.budgetMs).toBeLessThan(75_000 / 4);
  });

  it('reads the bound from the environment, and ignores an override that is not a usable number', () => {
    process.env.OSHAL_BYO_RETRY_MAX_ATTEMPTS = '5';
    process.env.OSHAL_BYO_RETRY_BUDGET_MS = '30000';
    expect(sameEndpointRetryPlan(process.env)).toMatchObject({ maxAttempts: 5, budgetMs: 30_000 });

    process.env.OSHAL_BYO_RETRY_MAX_ATTEMPTS = 'three';
    process.env.OSHAL_BYO_RETRY_BUDGET_MS = '-1';
    expect(sameEndpointRetryPlan(process.env)).toMatchObject({
      maxAttempts: DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts,
      budgetMs: DEFAULT_SAME_ENDPOINT_RETRY_PLAN.budgetMs,
    });
  });
});

describe('the wiring — executeBotOrInline actually applies the retry, and only to an explicit endpoint', () => {
  const byoLlmConnection = { baseUrl: 'https://byo.example.test/v1', apiKey: 'user-key', model: 'user-model' };
  const request: BotNodeRequest = {
    text: 'draft the thing',
    taskId: 'inline-task',
    workspaceFolderId: 'inline-task',
    agentId: 'inline-agent',
    agenticMode: true,
    direct: true,
    userSub: 'user-1',
  };
  const inlineOnly = { hasEndpoint: vi.fn(() => false), execute: vi.fn() } as unknown as BotNodeClient;

  beforeEach(() => { process.env.OSHAL_BYO_RETRY_BASE_DELAY_MS = '0'; });

  it('replays a caller-threaded BYO turn on the SAME connection and answers on the replay', async () => {
    let call = 0;
    const processMessage = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { success: false, error: '429 too many requests', turnCount: 0, toolsUsed: [] }
        : { success: true, response: 'second-attempt-answer', turnCount: 1, toolsUsed: [] };
    });
    const ctx = { orchestrator: { processMessage } } as unknown as AppContext;

    const response = await executeBotOrInline(ctx, inlineOnly, 'inline-agent', { ...request, byoLlmConnection });

    expect(response.response).toBe('second-attempt-answer');
    expect(processMessage).toHaveBeenCalledTimes(2);
    // Both attempts carried the IDENTICAL connection — no rotation, not even a re-resolution.
    expect(processMessage.mock.calls[0][2].byoLlmConnection).toEqual(byoLlmConnection);
    expect(processMessage.mock.calls[1][2].byoLlmConnection).toEqual(byoLlmConnection);
  });

  it('does not replay a caller-threaded BYO turn whose failure is not a wall', async () => {
    const processMessage = vi.fn(async () => ({ success: false, error: 'tool schema invalid', turnCount: 0, toolsUsed: [] }));
    const ctx = { orchestrator: { processMessage } } as unknown as AppContext;

    await expect(executeBotOrInline(ctx, inlineOnly, 'inline-agent', { ...request, byoLlmConnection }))
      .rejects.toThrow('tool schema invalid');
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves a turn with no explicit endpoint on its existing single-shot path', async () => {
    const processMessage = vi.fn(async () => ({ success: false, error: '429 too many requests', turnCount: 0, toolsUsed: [] }));
    const ctx = { orchestrator: { processMessage } } as unknown as AppContext;

    await expect(executeBotOrInline(ctx, inlineOnly, 'inline-agent', request)).rejects.toThrow('429');
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it('isExplicitByoTurn names both shapes of an explicit choice and nothing else', () => {
    expect(isExplicitByoTurn(byoLlmConnection, undefined)).toBe(true);
    expect(isExplicitByoTurn(undefined, { ...byoLlmConnection, resolutionSource: 'explicit' } as any)).toBe(true);
    expect(isExplicitByoTurn(undefined, { ...byoLlmConnection, resolutionSource: 'free-tier' } as any)).toBe(false);
    expect(isExplicitByoTurn(undefined, { ...byoLlmConnection, resolutionSource: 'platform' } as any)).toBe(false);
    expect(isExplicitByoTurn(undefined, { ...byoLlmConnection, resolutionSource: 'operator-key' } as any)).toBe(false);
    expect(isExplicitByoTurn(undefined, undefined)).toBe(false);
  });
});
