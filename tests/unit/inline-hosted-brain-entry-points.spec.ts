/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the two chat ENTRY POINTS of the ADR-127 inline hosted brain. The first review of this fix proved the provider, the orchestrator branch, and the shared helper individually — and then showed that deleting the wiring in executeBotOrInline or handleSendMessage left every suite green, because the lazy '@/…' registry require failed under vitest and turned the condition into a silent no-op. That require is now RELATIVE (loads the REAL registry here and in dist identically), and these cases drive the real entry points end to end: the inline branch threads the resolved connection into processMessage, send-message does the same over HTTP before creating a ticket, and an empty ladder answers the friendly 422 NO_HOSTED_BRAIN — never the raw SEC-05 refusal.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Swallowed-failure leg: the deployed catch-based failover never fired live because task-orchestrator.handleError RESOLVES agentic provider errors as { success:false, error } — new cases pin both entry points replaying that result shape through the same retryHostedBrainTurn, the pure swallowedTurnFailure predicate rows, and the non-wall failed result staying failed (mutation kill for an unconditional retry).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ONE-CHOKEPOINT node dispatch: with a dynamically registered node-bound bot and a REAL local HTTP node, POST /api/send-message routes the turn to the node through executeBotOrInline — the demo operator's turn arrives with the CLI providerId STAMPED (the ADR-127 carve, env-stubbed), a plain caller's with the resolved hosted connection threaded — the controller orchestrator is never called, and both turns persist to the message store the history route replays. This is the route the live 2026-08-11 failure ran (a node-backed bot's chat dying on an exhausted hosted key), crossed at the real dispatch boundary.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ladder is the ONE collaborator doubled here: these guards pin the entry-point wiring,
// and the ladder's own resolution order has its own suites. Everything else — the router, the
// executeBotOrInline chokepoint, the swarm registry the condition reads — is real.
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/free-tier-rotation')>();
  return {
    ...actual,
    resolveUserLlmConnection: vi.fn(async () => undefined),
    reportResolvedLlmFailure: vi.fn(async () => false),
  };
});
vi.mock('@/features/chat-orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/chat-orchestration')>();
  return {
    ...actual,
    resolveProjectManagerTicketExecutionContext: vi.fn(async (_deps: unknown, input: { requestedTaskId: string; source: string }) => ({
      taskId: input.requestedTaskId,
      source: input.source,
      ticketCreated: false,
      ticketId: null,
      ticketStatus: null,
      ticketTitle: null,
      ticketContext: undefined,
    })),
  };
});
vi.mock('@/features/cost-governance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/cost-governance')>();
  return {
    ...actual,
    BudgetService: class { async checkBudget(): Promise<{ allowed: boolean }> { return { allowed: true }; } },
  };
});

const USER_SUB = 'auth0|hosted-brain-user';
const TASK_ID = 'f2b7a9d0-0000-4000-8000-000000000002';
const CONNECTION = { baseUrl: 'https://hosted.example.test/v1', apiKey: 'sk-test-never-logged', model: 'test-model' };

const servers: Array<{ close: (cb: () => void) => void }> = [];
let processMessage: ReturnType<typeof vi.fn>;
let messageSave: ReturnType<typeof vi.fn>;

beforeEach(() => {
  processMessage = vi.fn(async () => ({ success: true, response: 'ok', usageSummary: undefined }));
  messageSave = vi.fn(async () => ({}));
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
  vi.clearAllMocks();
});

/** Resolves a REAL claude-code inline bot from the active registry — the exact population the fix serves. */
async function pickCliHarnessAgentId(): Promise<string> {
  const { getActiveRegistry } = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const entry = getActiveRegistry().find((bot) => {
    const roles = (bot as { accessRoles?: string[] }).accessRoles;
    const open = !roles || roles.length === 0;
    return Boolean(bot.agentId) && bot.harnessType === 'claude-code' && open;
  });
  if (!entry?.agentId) throw new Error('no open claude-code registry bot found');
  return entry.agentId;
}

/** Arms the doubled ladder for one test. */
async function armLadder(connection: typeof CONNECTION | undefined): Promise<ReturnType<typeof vi.fn>> {
  const rotation = await import('../../src/app/routes/free-tier-rotation');
  const doubled = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
  doubled.mockImplementation(async () => (connection ? { ...connection, resolutionSource: 'explicit' } : undefined));
  return doubled;
}

/** Boots the REAL message router with the same identity stamping the OIDC middleware produces. */
async function bootSendMessageApp(): Promise<string> {
  const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
  const ctx = {
    taskStore: {
      get: async () => null,
      incrementMessageCount: async () => undefined,
      incrementTurnCount: async () => undefined,
    },
    workspaceService: { resolveTaskOwner: async () => null },
    ticketService: {},
    pool: {},
    orchestrator: { processMessage },
    messageStore: { save: messageSave },
  } as unknown as Parameters<typeof createMessageRoutes>[0];

  const app = express();
  app.use(express.json());
  app.use(((req: Request, _res: Response, next: NextFunction) => {
    const sub = req.header('x-test-sub');
    if (sub) {
      (req as Request & { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub, email: `${sub}@example.test` },
      };
    }
    next();
  }));
  app.use('/api', createMessageRoutes(ctx));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}/api`;
}

describe('executeBotOrInline — the INLINE branch resolves and threads the hosted brain', () => {
  it('a CLI-harness inline bot with no threaded connection rides the resolved ladder connection', async () => {
    const agentId = await pickCliHarnessAgentId();
    const ladder = await armLadder(CONNECTION);
    const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
    const ctx = { pool: {}, orchestrator: { processMessage } } as never;
    const botClient = { hasEndpoint: () => false } as never;

    const result = await executeBotOrInline(ctx, botClient, agentId, {
      text: 'hello', taskId: TASK_ID, agentId, userSub: USER_SUB,
    } as never);

    expect(result.success).toBe(true);
    expect(ladder).toHaveBeenCalledTimes(1);
    const options = processMessage.mock.calls[0][2] as { byoLlmConnection?: typeof CONNECTION };
    // Exactly the wire trio — resolver metadata must not travel on.
    expect(options.byoLlmConnection).toEqual(CONNECTION);
  });

  it('a caller-threaded connection wins — the ladder is never walked', async () => {
    const agentId = await pickCliHarnessAgentId();
    const ladder = await armLadder(CONNECTION);
    const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
    const ctx = { pool: {}, orchestrator: { processMessage } } as never;
    const botClient = { hasEndpoint: () => false } as never;
    const threaded = { baseUrl: 'https://mine.example.test', apiKey: 'sk-mine', model: 'my-model' };

    await executeBotOrInline(ctx, botClient, agentId, {
      text: 'hello', taskId: TASK_ID, agentId, userSub: USER_SUB, byoLlmConnection: threaded,
    } as never);

    expect(ladder).not.toHaveBeenCalled();
    const options = processMessage.mock.calls[0][2] as { byoLlmConnection?: typeof threaded };
    expect(options.byoLlmConnection).toEqual(threaded);
  });

  it('an empty ladder surfaces NO_HOSTED_BRAIN, not the raw SEC refusal', async () => {
    const agentId = await pickCliHarnessAgentId();
    await armLadder(undefined);
    const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
    const ctx = { pool: {}, orchestrator: { processMessage } } as never;
    const botClient = { hasEndpoint: () => false } as never;

    await expect(executeBotOrInline(ctx, botClient, agentId, {
      text: 'hello', taskId: TASK_ID, agentId, userSub: USER_SUB,
    } as never)).rejects.toMatchObject({ code: 'NO_HOSTED_BRAIN', message: expect.stringContaining('Settings → AI Providers') });
    expect(processMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/send-message — direct chat resolves the hosted brain over HTTP', () => {
  it('threads the resolved connection into processMessage for a CLI-harness bot', async () => {
    const agentId = await pickCliHarnessAgentId();
    await armLadder(CONNECTION);
    const base = await bootSendMessageApp();

    const res = await fetch(`${base}/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    const options = processMessage.mock.calls[0][2] as { byoLlmConnection?: typeof CONNECTION };
    expect(options.byoLlmConnection).toEqual(CONNECTION);
  });

  it('answers 422 NO_HOSTED_BRAIN with the friendly Settings message when the ladder is empty — and never creates the turn', async () => {
    const agentId = await pickCliHarnessAgentId();
    await armLadder(undefined);
    const base = await bootSendMessageApp();

    const res = await fetch(`${base}/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { success: boolean; error: string; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('NO_HOSTED_BRAIN');
    // The `error` field is what the cockpit chat panel renders — it must be the actionable text.
    expect(body.error).toContain('Settings → AI Providers');
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('an identity-less caller never walks the ladder — no override, unchanged pre-feature behavior', async () => {
    const agentId = await pickCliHarnessAgentId();
    const ladder = await armLadder(CONNECTION);
    const base = await bootSendMessageApp();

    const res = await fetch(`${base}/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    // The gate sits BEFORE the ladder: no identity ⇒ no resolution ⇒ the platform lane can
    // never serve an anonymous turn. The turn itself proceeds exactly as before the feature
    // (internal/swarm-dispatch callers carry no user and must not break).
    expect(res.status).toBe(200);
    expect(ladder).not.toHaveBeenCalled();
    const options = processMessage.mock.calls[0][2] as { byoLlmConnection?: unknown };
    expect(options.byoLlmConnection).toBeUndefined();
  });

  it('a ladder FAILURE degrades to no override instead of a user-facing refusal', async () => {
    const agentId = await pickCliHarnessAgentId();
    const rotation = await import('../../src/app/routes/free-tier-rotation');
    (rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => { throw new Error('db down'); });
    const base = await bootSendMessageApp();

    const res = await fetch(`${base}/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(200);
    const options = processMessage.mock.calls[0][2] as { byoLlmConnection?: unknown };
    expect(options.byoLlmConnection).toBeUndefined();
  });
});

describe('turn-time failover — a lane that 429s mid-turn replays once on the next lane', () => {
  const QUOTA_429 = Object.assign(
    new Error('byo-hosted endpoint generativelanguage.googleapis.com returned HTTP 429: quota exceeded'),
    { code: 'BYO_HOSTED_HTTP_ERROR' },
  );
  const SECOND = { baseUrl: 'https://groq.example.test/v1', apiKey: 'sk-second', model: 'second-model' };

  it('executeBotOrInline: reports the failure, re-resolves, and the retried turn answers', async () => {
    const agentId = await pickCliHarnessAgentId();
    const rotation = await import('../../src/app/routes/free-tier-rotation');
    const ladder = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
    // First resolution → Gemini-shaped lane; after the report, the re-resolution → the next vendor.
    ladder.mockImplementationOnce(async () => ({ ...CONNECTION, resolutionSource: 'operator-key' }));
    ladder.mockImplementationOnce(async () => ({ ...SECOND, resolutionSource: 'operator-key' }));
    const report = (rotation.reportResolvedLlmFailure as unknown as ReturnType<typeof vi.fn>);
    report.mockImplementation(async () => true);
    // The FIRST turn dies on the provider wall; the SECOND answers.
    processMessage.mockImplementationOnce(async () => { throw QUOTA_429; });
    const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
    const ctx = { pool: {}, orchestrator: { processMessage } } as never;
    const botClient = { hasEndpoint: () => false } as never;

    const result = await executeBotOrInline(ctx, botClient, agentId, {
      text: 'hello', taskId: TASK_ID, agentId, userSub: USER_SUB,
    } as never);

    expect(result.success).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(2);
    const retryOptions = processMessage.mock.calls[1][2] as { byoLlmConnection?: typeof SECOND };
    expect(retryOptions.byoLlmConnection).toEqual(SECOND);
  });

  it('send-message: the cockpit gets the retried answer, not the 429', async () => {
    const agentId = await pickCliHarnessAgentId();
    const rotation = await import('../../src/app/routes/free-tier-rotation');
    const ladder = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
    ladder.mockImplementationOnce(async () => ({ ...CONNECTION, resolutionSource: 'operator-key' }));
    ladder.mockImplementationOnce(async () => ({ ...SECOND, resolutionSource: 'operator-key' }));
    (rotation.reportResolvedLlmFailure as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => true);
    processMessage.mockImplementationOnce(async () => { throw QUOTA_429; });
    const base = await bootSendMessageApp();

    const res = await fetch(`${base}/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(2);
    const retryOptions = processMessage.mock.calls[1][2] as { byoLlmConnection?: typeof SECOND };
    expect(retryOptions.byoLlmConnection).toEqual(SECOND);
  });

  it('no retry when the report says the failure is not a provider wall, or the same lane resolves again', async () => {
    const agentId = await pickCliHarnessAgentId();
    const rotation = await import('../../src/app/routes/free-tier-rotation');
    const ladder = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
    const report = rotation.reportResolvedLlmFailure as unknown as ReturnType<typeof vi.fn>;
    const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
    const ctx = { pool: {}, orchestrator: { processMessage } } as never;
    const botClient = { hasEndpoint: () => false } as never;

    // Non-wall failure: report answers false — the original error surfaces, one turn only.
    ladder.mockImplementation(async () => ({ ...CONNECTION, resolutionSource: 'operator-key' }));
    report.mockImplementation(async () => false);
    processMessage.mockImplementationOnce(async () => { throw new Error('genuine content failure'); });
    await expect(executeBotOrInline(ctx, botClient, agentId, {
      text: 'x', taskId: TASK_ID, agentId, userSub: USER_SUB,
    } as never)).rejects.toThrow('genuine content failure');
    expect(processMessage).toHaveBeenCalledTimes(1);

    // Same lane re-resolves: a replay would reproduce the wall — original error surfaces.
    processMessage.mockClear();
    report.mockImplementation(async () => true);
    processMessage.mockImplementationOnce(async () => { throw QUOTA_429; });
    await expect(executeBotOrInline(ctx, botClient, agentId, {
      text: 'x', taskId: TASK_ID, agentId, userSub: USER_SUB,
    } as never)).rejects.toThrow('429');
    expect(processMessage).toHaveBeenCalledTimes(1);
  });
});

describe('turn-time failover — SWALLOWED provider errors (the orchestrator resolves { success:false })', () => {
  // task-orchestrator.handleError catches every agentic-turn error, marks the task failed, and
  // RESOLVES with this exact shape — no throw ever reaches the route. This was the LIVE
  // 2026-08-11 path where the Gemini 429 became the chat answer with the catch-based failover
  // already deployed. These cases pin the result-shape leg of the same failover.
  const FAILED_429_RESULT = {
    success: false,
    error: 'byo-hosted endpoint generativelanguage.googleapis.com returned HTTP 429: quota exceeded',
    turnCount: 0,
  };
  const SECOND = { baseUrl: 'https://groq.example.test/v1', apiKey: 'sk-second', model: 'second-model' };

  it('swallowedTurnFailure: only a failed result with error text becomes an Error', async () => {
    const { swallowedTurnFailure } = await import('../../src/app/routes/inline-bot-execution');
    expect(swallowedTurnFailure({ success: true })).toBeUndefined();
    expect(swallowedTurnFailure(undefined)).toBeUndefined();
    expect(swallowedTurnFailure({ success: false, error: '   ' })).toBeUndefined();
    expect(swallowedTurnFailure(FAILED_429_RESULT)?.message).toContain('HTTP 429');
  });

  it('executeBotOrInline: a resolved-failed 429 cools the lane and the replay answers', async () => {
    const agentId = await pickCliHarnessAgentId();
    const rotation = await import('../../src/app/routes/free-tier-rotation');
    const ladder = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
    ladder.mockImplementationOnce(async () => ({ ...CONNECTION, resolutionSource: 'operator-key' }));
    ladder.mockImplementationOnce(async () => ({ ...SECOND, resolutionSource: 'operator-key' }));
    const report = rotation.reportResolvedLlmFailure as unknown as ReturnType<typeof vi.fn>;
    report.mockImplementation(async () => true);
    // The first turn RESOLVES failed (no throw) — the live shape; the replay succeeds.
    processMessage.mockImplementationOnce(async () => FAILED_429_RESULT);
    const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
    const ctx = { pool: {}, orchestrator: { processMessage } } as never;
    const botClient = { hasEndpoint: () => false } as never;

    const result = await executeBotOrInline(ctx, botClient, agentId, {
      text: 'hello', taskId: TASK_ID, agentId, userSub: USER_SUB,
    } as never);

    expect(result.success).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(2);
    const retryOptions = processMessage.mock.calls[1][2] as { byoLlmConnection?: typeof SECOND };
    expect(retryOptions.byoLlmConnection).toEqual(SECOND);
  });

  it('send-message: a resolved-failed 429 replays — the cockpit gets the answer, not the quota text', async () => {
    const agentId = await pickCliHarnessAgentId();
    const rotation = await import('../../src/app/routes/free-tier-rotation');
    const ladder = rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>;
    ladder.mockImplementationOnce(async () => ({ ...CONNECTION, resolutionSource: 'operator-key' }));
    ladder.mockImplementationOnce(async () => ({ ...SECOND, resolutionSource: 'operator-key' }));
    (rotation.reportResolvedLlmFailure as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => true);
    processMessage.mockImplementationOnce(async () => FAILED_429_RESULT);
    const base = await bootSendMessageApp();

    const res = await fetch(`${base}/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ taskId: TASK_ID, text: 'hello', agentId }),
    });

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(2);
    const retryOptions = processMessage.mock.calls[1][2] as { byoLlmConnection?: typeof SECOND };
    expect(retryOptions.byoLlmConnection).toEqual(SECOND);
  });

  it('a resolved-failed result that is NOT a provider wall stays failed — one turn only', async () => {
    const agentId = await pickCliHarnessAgentId();
    const rotation = await import('../../src/app/routes/free-tier-rotation');
    (rotation.resolveUserLlmConnection as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => ({ ...CONNECTION, resolutionSource: 'operator-key' }));
    (rotation.reportResolvedLlmFailure as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => false);
    processMessage.mockImplementationOnce(async () => ({ success: false, error: 'genuine content failure', turnCount: 0 }));
    const { executeBotOrInline } = await import('../../src/app/routes/inline-bot-execution');
    const ctx = { pool: {}, orchestrator: { processMessage } } as never;
    const botClient = { hasEndpoint: () => false } as never;

    await expect(executeBotOrInline(ctx, botClient, agentId, {
      text: 'x', taskId: TASK_ID, agentId, userSub: USER_SUB,
    } as never)).rejects.toThrow('genuine content failure');
    expect(processMessage).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/send-message — a node-bound bot dispatches AT its node through the chokepoint', () => {
  const NODE_AGENT = 'cb999999-0000-4000-8000-000000000042';
  const NODE_APP = 'spec-node-app';

  /** A REAL local HTTP "bot node" — the dispatch boundary the fix claims to cross. */
  async function bootStubNode(): Promise<{ port: number; bodies: Array<Record<string, any>> }> {
    const bodies: Array<Record<string, any>> = [];
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        bodies.push({ url: req.url, ...(raw ? JSON.parse(raw) : {}) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, response: 'node answer' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stub node did not bind');
    return { port: address.port, bodies };
  }

  /** Registers the node-bound bot the way the manifest loader does, resolving to the stub. */
  async function registerNodeBot(port: number): Promise<() => void> {
    const registry = await import('../../src/app/extensions/swarm/swarm-bot-registry');
    const { warmBotEndpointRegistry } = await import('../../src/features/agent-management/services/bot-node-client');
    // The resolver's synchronous require cannot load the .ts registry here — warm the
    // dynamic-import cache first, exactly what the loader's fallback does on its own.
    await warmBotEndpointRegistry();
    registry.registerAppBots(NODE_APP, [{
      agentId: NODE_AGENT, name: 'spec-node-bot', port, container: 'spec-node-bot',
      role: '', capabilities: [], harnessType: 'claude-code', apiType: 'claude-code',
    } as never]);
    return () => registry.unregisterAppBots(NODE_APP);
  }

  it('a plain caller\'s turn arrives at the node with the resolved hosted connection — the controller orchestrator never runs', async () => {
    const node = await bootStubNode();
    const release = await registerNodeBot(node.port);
    try {
      await armLadder(CONNECTION);
      const base = await bootSendMessageApp();

      const res = await fetch(`${base}/send-message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
        body: JSON.stringify({ taskId: TASK_ID, text: 'hello node', agentId: NODE_AGENT }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { response: string };
      expect(body.response).toBe('node answer');
      expect(processMessage).not.toHaveBeenCalled();
      expect(node.bodies).toHaveLength(1);
      expect(node.bodies[0].url).toBe('/api/swarm-execute');
      // Exactly the wire trio — resolver metadata must not ride to the node.
      expect(node.bodies[0].byoLlmConnection).toEqual(CONNECTION);
      expect(node.bodies[0].providerId).toBeUndefined();
      // The controller owns thread durability for remote turns: both persisted for replay.
      expect(messageSave).toHaveBeenCalledTimes(2);
      expect(messageSave.mock.calls[0][0]).toMatchObject({ role: 'user', text: 'hello node' });
      expect(messageSave.mock.calls[1][0]).toMatchObject({ role: 'assistant', text: 'node answer' });
    } finally {
      release();
    }
  });

  it('the demo operator\'s turn arrives with the CLI providerId STAMPED (ADR-127 carve) — no hosted override', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', USER_SUB);
    const node = await bootStubNode();
    const release = await registerNodeBot(node.port);
    try {
      const ladder = await armLadder(CONNECTION);
      const base = await bootSendMessageApp();

      const res = await fetch(`${base}/send-message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
        body: JSON.stringify({ taskId: TASK_ID, text: 'tighten my resume summary', agentId: NODE_AGENT }),
      });

      expect(res.status).toBe(200);
      expect(processMessage).not.toHaveBeenCalled();
      expect(node.bodies).toHaveLength(1);
      // The mounted-login lane: stamped as the ADR-034 authoritative provider, no hosted override,
      // and the hosted ladder never walked — the exact opposite of the live 2026-08-11 failure.
      expect(node.bodies[0].providerId).toBe('claude-code');
      expect(node.bodies[0].byoLlmConnection).toBeUndefined();
      expect(ladder).not.toHaveBeenCalled();
    } finally {
      release();
      vi.unstubAllEnvs();
    }
  });
});
