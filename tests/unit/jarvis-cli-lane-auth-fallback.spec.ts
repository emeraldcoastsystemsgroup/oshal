/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the logged-out-CLI dead end (live 2026-08-11): a Jarvis turn on the ADR-127 CLI brain failed with "Not logged in · Please run /login" and the operator saw that string AS THE ANSWER. Two independent gaps produced it — the classifier did not recognize a logged-out CLI as an auth failure (so the provider returned it as content instead of throwing), and reportResolvedLlmFailure refuses every connection-less lane, which is EVERY CLI turn (so the bounded retry never ran). Pins both, plus the invariants that keep the fix honest: the retry is hosted (CLI stamp dropped), a genuine content failure is still NOT retried, and an explicit BYO endpoint is still never silently replayed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const executeBotOrInline = vi.fn();
const resolveUserBrain = vi.fn();
const resolveUserLlmConnection = vi.fn();
const reportResolvedLlmFailure = vi.fn();

vi.mock('@/features/user-model', () => ({
  withHavenContext: async (_pool: unknown, _sub: string, message: string) => message,
  learnFromExchange: async () => undefined,
}));

vi.mock('@/app/routes/inline-bot-execution', () => ({
  executeBotOrInline: (...args: unknown[]) => executeBotOrInline(...args),
  runInline: async () => ({ response: '' }),
}));

vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: (...args: unknown[]) => resolveUserLlmConnection(...args),
  reportResolvedLlmFailure: (...args: unknown[]) => reportResolvedLlmFailure(...args),
  resolveLiveFreeTierConnection: async () => undefined,
}));

// PARTIAL mock on purpose: resolveUserBrain is a stub so the test can pick the lane, but
// isRetryableCliBrainFailure is the REAL implementation — it is the logic under test.
vi.mock('@/app/routes/user-brain-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/routes/user-brain-resolution')>()),
  resolveUserBrain: (...args: unknown[]) => resolveUserBrain(...args),
}));

const ctx = { pool: { query: async () => ({ rows: [] }) } } as never;

/** The exact text the Claude Code CLI emits when its mounted OAuth login is expired or absent. */
const LOGGED_OUT = 'Claude Code CLI task failed: Not logged in · Please run /login';

const HOSTED_LANE = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: 'operator-key',
  model: 'gemini-2.5-flash',
  resolutionSource: 'operator-key' as const,
};

let runJarvisBot: typeof import('@/app/routes/jarvis-orchestrator')['runJarvisBot'];
let isRetryableCliBrainFailure: typeof import('@/app/routes/user-brain-resolution')['isRetryableCliBrainFailure'];

// Loaded ONCE: the orchestrator's module graph takes seconds to pull in, and paying that inside the
// first `it` blew its timeout — which left that test's turn still running, so its late second call
// landed in the NEXT test's recorded calls and made the stamp assertion read the wrong request.
beforeAll(async () => {
  ({ runJarvisBot } = await import('@/app/routes/jarvis-orchestrator'));
  ({ isRetryableCliBrainFailure } = await import('@/app/routes/user-brain-resolution'));
}, 60_000);

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: clear leaves queued *Once implementations in place, so one
  // test's unconsumed rejection would fire inside the next one.
  vi.resetAllMocks();
  resolveUserBrain.mockResolvedValue({ kind: 'cli', providerId: 'claude-code' });
  resolveUserLlmConnection.mockResolvedValue(HOSTED_LANE);
  reportResolvedLlmFailure.mockResolvedValue(false);
});

describe('Jarvis CLI lane: a logged-out CLI falls back instead of answering with the error', () => {
  it('retries on the hosted lane and returns a real answer', async () => {
    executeBotOrInline
      .mockRejectedValueOnce(new Error(LOGGED_OUT))
      .mockResolvedValueOnce({ response: 'Kalshi is showing three markets above 60%.' });

    const { answer } = await runJarvisBot(ctx, 'operator-sub', 'what is on the board?', 'task-1');

    expect(answer).toBe('Kalshi is showing three markets above 60%.');
    expect(answer).not.toContain('/login');
    expect(executeBotOrInline).toHaveBeenCalledTimes(2);
  });

  it('drops the CLI stamp on the retry and carries the hosted endpoint', async () => {
    // The failure being recovered from may BE that harness, so replaying with the same providerId
    // would reproduce it — and a SEC-05 node only ever accepts a hosted endpoint anyway.
    executeBotOrInline
      .mockRejectedValueOnce(new Error(LOGGED_OUT))
      .mockResolvedValueOnce({ response: 'answered' });

    await runJarvisBot(ctx, 'operator-sub', 'hello', 'task-2');

    const first = executeBotOrInline.mock.calls[0][3] as Record<string, unknown>;
    const retry = executeBotOrInline.mock.calls[1][3] as Record<string, unknown>;
    expect(first.providerId).toBe('claude-code');
    expect(retry.providerId).toBeUndefined();
    expect(retry.byoLlmConnection).toMatchObject({ model: 'gemini-2.5-flash' });
  });

  it('does NOT consult reportResolvedLlmFailure for a CLI lane — it refuses every connection-less turn', async () => {
    // The original dead end: reportResolvedLlmFailure returns false whenever there is no hosted
    // connection to cool, so routing the CLI lane through it made the retry unreachable.
    executeBotOrInline
      .mockRejectedValueOnce(new Error(LOGGED_OUT))
      .mockResolvedValueOnce({ response: 'answered' });

    await runJarvisBot(ctx, 'operator-sub', 'hello', 'task-3');

    expect(reportResolvedLlmFailure).not.toHaveBeenCalled();
  });

  it('still surfaces a genuine content failure rather than burning a second brain on it', async () => {
    executeBotOrInline.mockRejectedValueOnce(new Error('the requested ticket does not exist'));

    await expect(runJarvisBot(ctx, 'operator-sub', 'hello', 'task-4')).rejects.toThrow('does not exist');
    expect(executeBotOrInline).toHaveBeenCalledTimes(1);
  });

  it('leaves the hosted lanes on their existing contract — an explicit BYO failure is never replayed', async () => {
    // reportResolvedLlmFailure owns that refusal (a user-selected endpoint is a privacy/billing
    // boundary). The CLI carve must not become a way around it.
    resolveUserBrain.mockResolvedValue({
      kind: 'hosted',
      connection: { ...HOSTED_LANE, resolutionSource: 'explicit' },
    });
    executeBotOrInline.mockRejectedValueOnce(new Error(LOGGED_OUT));

    await expect(runJarvisBot(ctx, 'operator-sub', 'hello', 'task-5')).rejects.toThrow('Not logged in');
    expect(reportResolvedLlmFailure).toHaveBeenCalledTimes(1);
    expect(executeBotOrInline).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableCliBrainFailure', () => {
  it('classifies the harness failures a hosted lane can survive', async () => {
    expect(isRetryableCliBrainFailure(new Error(LOGGED_OUT))).toBe(true);
    expect(isRetryableCliBrainFailure(new Error('Codex CLI error: 401 Unauthorized'))).toBe(true);
    expect(isRetryableCliBrainFailure(new Error('429 too many requests'))).toBe(true);
    expect(isRetryableCliBrainFailure(new Error('INACTIVITY CIRCUIT BREAKER - no output for 180s'))).toBe(true);
  });

  it('does not retry a failure a second brain would only reproduce', async () => {
    expect(isRetryableCliBrainFailure(new Error('business rule rejected the request'))).toBe(false);
    expect(isRetryableCliBrainFailure(new Error('the requested ticket does not exist'))).toBe(false);
  });
});
