/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the passive-learning dead step (live 2026-10-02 08:13 UTC on main bbf062ce): a Jarvis turn answered on the jarvis-bot node under the operator's CLI brain, then its fire-and-forget haven-learn step called the orchestrator directly on the controller, built the configured Antigravity CLI harness in-process and was refused (UNBROKERED_AUTONOMOUS_PROVIDER). Pins that every bounded step rides executeBotOrInline - the chokepoint that carries the caller's brain - with the stamp the turn ran on: the CLI provider+model on a CLI brain, the hosted trio on a hosted brain, and the retry's endpoint (CLI stamp dropped) when the turn fell back; and that the controller orchestrator is never called for it.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const executeBotOrInline = vi.fn();
const resolveUserBrain = vi.fn();
const resolveUserLlmConnection = vi.fn();
const reportResolvedLlmFailure = vi.fn();

/** What the (mocked) learn loop handed to the brain and what came back — the test awaits it, the turn does not. */
const learn: { run: Promise<string> | null; prompt: string } = { run: null, prompt: '' };

vi.mock('@/features/user-model', () => ({
  withHavenContext: async (_pool: unknown, _sub: string, message: string) => message,
  // The real learnFromExchange throttles, extracts and stores; the part under test is the one line that
  // runs the brain, so the double does exactly that and exposes the promise the turn fires and forgets.
  learnFromExchange: async (_pool: unknown, _sub: string, message: string, answer: string, runBrain: (p: string) => Promise<string>) => {
    learn.prompt = `EXTRACT ${message} | ${answer}`;
    learn.run = runBrain(learn.prompt);
    // Like the real loop, a brain failure is contained here; the test reads it off learn.run.
    await learn.run.catch(() => undefined);
  },
}));

vi.mock('@/app/routes/inline-bot-execution', () => ({
  executeBotOrInline: (...args: unknown[]) => executeBotOrInline(...args),
}));

vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: (...args: unknown[]) => resolveUserLlmConnection(...args),
  reportResolvedLlmFailure: (...args: unknown[]) => reportResolvedLlmFailure(...args),
  resolveLiveFreeTierConnection: async () => undefined,
}));

// PARTIAL mock on purpose: resolveUserBrain picks the lane; isRetryableCliBrainFailure stays real so the
// fallback case takes the orchestrator's genuine retry path.
vi.mock('@/app/routes/user-brain-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/routes/user-brain-resolution')>()),
  resolveUserBrain: (...args: unknown[]) => resolveUserBrain(...args),
}));

const processMessage = vi.fn();
const ctx = { pool: { query: async () => ({ rows: [] }) }, orchestrator: { processMessage } } as never;

const HOSTED_LANE = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: 'operator-key',
  model: 'gemini-2.5-flash',
  resolutionSource: 'operator-key' as const,
};
const LOGGED_OUT = 'Antigravity CLI task failed: Not logged in · Please run /login';

let runJarvisBot: typeof import('@/app/routes/jarvis-orchestrator')['runJarvisBot'];
let JARVIS_AGENT_ID: string;

// Loaded once: the orchestrator's module graph takes seconds to pull in (see jarvis-cli-lane-auth-fallback.spec.ts).
beforeAll(async () => {
  ({ runJarvisBot, JARVIS_AGENT_ID } = await import('@/app/routes/jarvis-orchestrator'));
}, 60_000);

beforeEach(() => {
  vi.resetAllMocks();
  learn.run = null;
  learn.prompt = '';
  resolveUserLlmConnection.mockResolvedValue(HOSTED_LANE);
  reportResolvedLlmFailure.mockResolvedValue(false);
});

/** The request of the one executeBotOrInline call whose task id is a haven-learn step. */
function learnDispatch(): { agentId: string; request: Record<string, unknown> } {
  const calls = executeBotOrInline.mock.calls.filter((c) => String((c[3] as { taskId?: string }).taskId).startsWith('jarvis-haven-learn-'));
  expect(calls).toHaveLength(1);
  return { agentId: calls[0][2] as string, request: calls[0][3] as Record<string, unknown> };
}

describe('Jarvis passive learning runs on the brain the turn ran on, through the same chokepoint', () => {
  it('a CLI-brain turn: the learn step is dispatched through executeBotOrInline with the CLI stamp, never the controller orchestrator', async () => {
    resolveUserBrain.mockResolvedValue({ kind: 'cli', providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low' });
    executeBotOrInline
      .mockResolvedValueOnce({ response: 'Paris.' })
      .mockResolvedValueOnce({ response: '[]' });

    const { answer } = await runJarvisBot(ctx, 'operator-sub', 'capital of France?', 'task-1');
    expect(answer).toBe('Paris.');
    expect(learn.run).not.toBeNull();
    await expect(learn.run).resolves.toBe('[]');

    const { agentId, request } = learnDispatch();
    expect(agentId).toBe(JARVIS_AGENT_ID);
    expect(request.taskId).toMatch(/^jarvis-haven-learn-operator-sub-/);
    expect(request.workspaceFolderId).toBe(request.taskId);
    expect(request.text).toBe(learn.prompt);
    expect(request).toMatchObject({ agentId: JARVIS_AGENT_ID, direct: true, agenticMode: true, userSub: 'operator-sub' });
    // The exact stamp the turn itself carried: this is what the node reconciles onto before executing.
    expect(request.providerId).toBe('antigravity-cli');
    expect(request.model).toBe('gemini-3.8-flash-low');
    expect(request.byoLlmConnection).toBeUndefined();
    // The failure shape: the step used to be ctx.orchestrator.processMessage on the controller.
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('a hosted-brain turn: the learn step carries the same hosted trio and no CLI stamp', async () => {
    resolveUserBrain.mockResolvedValue({ kind: 'hosted', connection: HOSTED_LANE });
    executeBotOrInline
      .mockResolvedValueOnce({ response: 'answered' })
      .mockResolvedValueOnce({ response: '[]' });

    await runJarvisBot(ctx, 'guest-sub', 'what can you do for me today?', 'task-2');
    await learn.run;

    const { request } = learnDispatch();
    expect(request.byoLlmConnection).toEqual({ baseUrl: HOSTED_LANE.baseUrl, apiKey: HOSTED_LANE.apiKey, model: HOSTED_LANE.model });
    expect(request.providerId).toBeUndefined();
    expect(request.model).toBeUndefined();
    // Controller-side metadata never rides on the step either.
    expect(request.byoLlmResolutionSource).toBeUndefined();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('when the turn fell back to the next hosted endpoint, the learn step runs on the endpoint that answered, CLI stamp dropped', async () => {
    resolveUserBrain.mockResolvedValue({ kind: 'cli', providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low' });
    executeBotOrInline
      .mockRejectedValueOnce(new Error(LOGGED_OUT))
      .mockResolvedValueOnce({ response: 'answered on the hosted lane' })
      .mockResolvedValueOnce({ response: '[]' });

    const { answer } = await runJarvisBot(ctx, 'operator-sub', 'what is on the board today?', 'task-3');
    expect(answer).toBe('answered on the hosted lane');
    await learn.run;

    expect(executeBotOrInline).toHaveBeenCalledTimes(3);
    const { request } = learnDispatch();
    expect(request.byoLlmConnection).toEqual({ baseUrl: HOSTED_LANE.baseUrl, apiKey: HOSTED_LANE.apiKey, model: HOSTED_LANE.model });
    expect(request.providerId).toBeUndefined();
    expect(request.model).toBeUndefined();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('a learn-step failure never reaches the person: the turn has already answered and the rejection stays on the fired promise', async () => {
    resolveUserBrain.mockResolvedValue({ kind: 'cli', providerId: 'antigravity-cli' });
    executeBotOrInline
      .mockResolvedValueOnce({ response: 'answered' })
      .mockRejectedValueOnce(new Error('node busy'));

    const { answer } = await runJarvisBot(ctx, 'operator-sub', 'hello there, what is new?', 'task-4');
    expect(answer).toBe('answered');
    await expect(learn.run).rejects.toThrow('node busy');
    expect(processMessage).not.toHaveBeenCalled();
  });
});
