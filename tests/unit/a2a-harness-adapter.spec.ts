/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the outbound A2A harness (Plan F item 3) against a mocked global fetch: happy path (message/send → tasks/get polling → completed → artifact text + real usage mapped, recordCost called with the REAL numbers), synchronous message short-circuit, remote failure → one clean harness error with the remote detail and NO retry storm, JSON-RPC error objects surfaced cleanly, deadline timeout → clean failure, absent usage → zero-cost event with costUnknown=true + requestCount 0 + a WARN (never fabricated tokens), recordCost sink failures non-fatal, and construction-time config errors (missing endpoint / missing credential naming the exact A2A_OUTBOUND_TOKEN_<BOTKEY> env var — never mid-task).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the adapter's logger so the honesty WARN (no remote usage → costUnknown)
// and the non-fatal ERROR paths are assertable.
const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
}));

import {
  A2AHarnessAdapter,
  deriveA2ATokenEnvName,
  readRemoteUsage,
  type A2ACostEvent,
} from '@/features/llm-provider/services/a2a-harness-adapter';

const ENDPOINT = 'http://remote-agent.example:9999/a2a';
const MANAGED_ENV_KEYS = [
  'A2A_OUTBOUND_TOKEN',
  'A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT',
  'A2A_OUTBOUND_ALLOW_ANON',
  'A2A_OUTBOUND_TIMEOUT_MS',
  'A2A_OUTBOUND_POLL_MS',
];
const savedEnv = new Map<string, string | undefined>();

/** Builds a Response-shaped object carrying a JSON-RPC success result. */
function rpcOk(result: unknown): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'x', result }) };
}

/** Builds a Response-shaped object carrying a JSON-RPC error object. */
function rpcError(code: number, message: string): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { code, message } }) };
}

/** Installs a fetch mock returning the given responses in order (last repeats). */
function installFetch(responses: unknown[]): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Reads the parsed JSON-RPC body of the Nth fetch call. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[index][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function buildAdapter(recordCost?: (event: A2ACostEvent) => Promise<void>, over: Record<string, unknown> = {}): A2AHarnessAdapter {
  return new A2AHarnessAdapter({
    endpointUrl: ENDPOINT,
    botKey: 'a2a-sample-agent',
    authToken: 'test-token',
    timeoutMs: 1_000,
    pollIntervalMs: 5,
    remoteAgentLabel: 'sample',
    recordCost,
    ...over,
  });
}

const WORKING_TASK = { kind: 'task', id: 't-1', status: { state: 'working' } };

function completedTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'task',
    id: 't-1',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a-1', parts: [{ kind: 'text', text: 'remote deliverable' }] }],
    ...over,
  };
}

beforeEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('deriveA2ATokenEnvName — one deterministic per-bot credential env', () => {
  it('maps the registry bot name to A2A_OUTBOUND_TOKEN_<BOTKEY>', () => {
    expect(deriveA2ATokenEnvName('a2a-sample-agent')).toBe('A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT');
    expect(deriveA2ATokenEnvName('My Weird.Bot')).toBe('A2A_OUTBOUND_TOKEN_MY_WEIRD_BOT');
  });
});

describe('construction — config errors are clean and construction-time, never mid-task', () => {
  it('throws when no endpoint is configured, naming the endpoint env var', () => {
    expect(() => new A2AHarnessAdapter({ endpointEnvName: 'A2A_SAMPLE_AGENT_URL', authToken: 't' }))
      .toThrow(/A2A_SAMPLE_AGENT_URL/);
  });

  it('throws when no credential resolves, naming the exact per-bot token env var', () => {
    expect(() => new A2AHarnessAdapter({ endpointUrl: ENDPOINT, botKey: 'a2a-sample-agent' }))
      .toThrow(/A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT/);
  });

  it('accepts the per-bot token from env, and allows anonymous only when opted in', () => {
    process.env.A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT = 'env-token';
    expect(() => new A2AHarnessAdapter({ endpointUrl: ENDPOINT, botKey: 'a2a-sample-agent' })).not.toThrow();
    delete process.env.A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT;
    expect(() => new A2AHarnessAdapter({ endpointUrl: ENDPOINT, botKey: 'a2a-sample-agent', allowAnonymous: true })).not.toThrow();
    process.env.A2A_OUTBOUND_ALLOW_ANON = 'true';
    expect(() => new A2AHarnessAdapter({ endpointUrl: ENDPOINT, botKey: 'a2a-sample-agent' })).not.toThrow();
  });
});

describe('run — happy path (send → poll → completed → mapped result)', () => {
  it('sends message/send, polls tasks/get, and maps artifacts + REAL usage', async () => {
    const usage = { inputTokens: 120, outputTokens: 45, totalCostUsd: 0.0123 };
    const fetchMock = installFetch([
      rpcOk(WORKING_TASK),
      rpcOk(WORKING_TASK),
      rpcOk(completedTask({ metadata: { usage } })),
    ]);
    const recordCost = vi.fn(async () => undefined);
    const adapter = buildAdapter(recordCost);

    const result = await adapter.run({ prompt: 'do the thing', taskId: 'task-9', agentId: 'agent-9' });

    expect(result.text).toBe('remote deliverable');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(result.model).toBe('a2a/sample');
    expect(result.stopReason).toBe('end_turn');

    // Wire protocol: first call is message/send with the prompt; polls are tasks/get on the remote id.
    expect(sentBody(fetchMock, 0).method).toBe('message/send');
    const sendParams = sentBody(fetchMock, 0).params as { message: { parts: Array<{ text: string }> } };
    expect(sendParams.message.parts[0].text).toContain('do the thing');
    expect(sentBody(fetchMock, 1).method).toBe('tasks/get');
    expect((sentBody(fetchMock, 1).params as { id: string }).id).toBe('t-1');

    // Bearer credential rides every call; the token itself is never logged.
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer test-token');

    // Cost: remote-reported usage recorded with the REAL numbers — not fabricated, not unknown.
    expect(recordCost).toHaveBeenCalledTimes(1);
    const event = recordCost.mock.calls[0][0] as unknown as A2ACostEvent;
    expect(event).toMatchObject({
      taskId: 'task-9', agentId: 'agent-9', providerId: 'a2a', modelId: 'a2a/sample',
      inputTokens: 120, outputTokens: 45, totalCost: 0.0123,
      requestCount: 1, costUnknown: false,
    });
  });

  it('short-circuits on a synchronous message result (no polling)', async () => {
    const fetchMock = installFetch([
      rpcOk({ kind: 'message', role: 'agent', messageId: 'm-1', parts: [{ kind: 'text', text: 'sync answer' }] }),
    ]);
    const adapter = buildAdapter();
    const result = await adapter.run({ prompt: 'quick one' });
    expect(result.text).toBe('sync answer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('run — remote failure is ONE clean harness error (no retry storm)', () => {
  it('maps a failed terminal state to a clean error carrying the remote detail', async () => {
    const fetchMock = installFetch([
      rpcOk(WORKING_TASK),
      rpcOk({
        kind: 'task', id: 't-1',
        status: { state: 'failed', message: { parts: [{ kind: 'text', text: 'remote exploded' }] } },
      }),
    ]);
    const adapter = buildAdapter();
    await expect(adapter.run({ prompt: 'x', taskId: 't', agentId: 'a' }))
      .rejects.toThrow(/ended 'failed' — remote exploded/);
    // Terminal means STOP: exactly send + one poll, nothing after the failure.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a JSON-RPC error object as a clean error', async () => {
    installFetch([rpcError(-32600, 'bad request')]);
    const adapter = buildAdapter();
    await expect(adapter.run({ prompt: 'x' })).rejects.toThrow(/remote agent error -32600 .* bad request/);
  });
});

describe('run — timeout fails cleanly at the deadline', () => {
  it('gives up with a clean error when the remote never reaches a terminal state', async () => {
    const fetchMock = installFetch([rpcOk(WORKING_TASK)]); // every call: still working
    const adapter = buildAdapter(undefined, { timeoutMs: 60, pollIntervalMs: 30 });
    await expect(adapter.run({ prompt: 'x', taskId: 't', agentId: 'a' }))
      .rejects.toThrow(/did not reach a terminal state within 60ms/);
    // Bounded polling: no unbounded loop past the deadline.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('run — cost honesty when the remote reports no usage', () => {
  it('records a zero-cost event with costUnknown=true + requestCount 0 and WARNs', async () => {
    installFetch([rpcOk(completedTask())]); // completed immediately, NO metadata.usage
    const recordCost = vi.fn(async () => undefined);
    const adapter = buildAdapter(recordCost);

    const result = await adapter.run({ prompt: 'x', taskId: 'task-0', agentId: 'agent-0' });

    // Never fabricated: zeros flow out, flagged unknown — not silently "free".
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(recordCost).toHaveBeenCalledTimes(1);
    const event = recordCost.mock.calls[0][0] as unknown as A2ACostEvent;
    expect(event).toMatchObject({
      inputTokens: 0, outputTokens: 0, totalCost: 0,
      requestCount: 0, costUnknown: true,
    });
    expect(logSpies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-0', agentId: 'agent-0' }),
      expect.stringContaining('costUnknown=true'),
    );
  });

  it('treats a failing recordCost sink as non-fatal (logged at ERROR)', async () => {
    installFetch([rpcOk(completedTask({ metadata: { usage: { inputTokens: 1, outputTokens: 2 } } }))]);
    const recordCost = vi.fn(async () => { throw new Error('ledger down'); });
    const adapter = buildAdapter(recordCost);
    const result = await adapter.run({ prompt: 'x', taskId: 't', agentId: 'a' });
    expect(result.text).toBe('remote deliverable');
    expect(logSpies.error).toHaveBeenCalled();
  });
});

describe('readRemoteUsage — accepts common key spellings, never invents numbers', () => {
  it('parses snake_case usage and remote-reported cost', () => {
    const usage = readRemoteUsage({ metadata: { usage: { input_tokens: 10, output_tokens: 3, total_cost_usd: 0.5 } } });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 3, totalCostUsd: 0.5 });
  });

  it('returns null (unknown) when nothing usable is reported', () => {
    expect(readRemoteUsage({ metadata: {} })).toBeNull();
    expect(readRemoteUsage({ metadata: { usage: { vibes: 'good' } } })).toBeNull();
    expect(readRemoteUsage(undefined)).toBeNull();
  });
});
