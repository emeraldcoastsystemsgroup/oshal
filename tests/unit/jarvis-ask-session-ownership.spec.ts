/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the branch that answered 404 session_not_found out of POST /api/jarvis/ask with nothing written down. Two other guards sat red on that 404 and neither could say which half of the gate refused, because the route logged nothing and ensureSessionTask called its own failure "non-fatal" while the caller turned it into a hard refusal. These cases drive each shape through the REAL route: the owner is admitted, a foreign-owned session id is refused quietly, a store that cannot hand back an owner-bound task is refused (the 2026-09-11 rule, so restoring the old `!created ||` reading goes red here), a store that THROWS is refused and reported at ERROR, and a session that writes but will not read back is refused as the read-back half. Nothing here weakens a gate - every case asserts the refusal - what it pins is that the refusals stay distinguishable.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Preflight protected-result admission before a fresh Jarvis session is persisted, so a deterministic refusal cannot strand a `chat_tasks.status='created'` row.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeBot = vi.hoisted(() => vi.fn());
vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: executeBot }));
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/app/routes/free-tier-rotation', () => ({
  resolveUserLlmConnection: vi.fn().mockResolvedValue(null),
  reportResolvedLlmFailure: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => prompt),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
// PARTIAL mock, like the specs this guard was written for: a factory that LISTS the barrel's
// exports goes red the moment the barrel grows one the spec never asked about.
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

/** One structured line a Jarvis module wrote while this case ran. */
interface CapturedLog { module: string; level: string; payload: Record<string, unknown>; message: string }

// The refusal is only distinguishable through the log, so the log has to be observable. PARTIAL
// mock again: `logger` and LOG_REDACT_OPTIONS stay real for every module that imports them.
const logSink = vi.hoisted(() => ({ entries: [] as Array<Record<string, unknown>> }));
vi.mock('@/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const build = (module: string) => {
    const record = (level: string) => (first: unknown, second?: unknown) => {
      logSink.entries.push({
        module,
        level,
        payload: typeof first === 'object' && first !== null ? first : {},
        message: typeof first === 'string' ? first : String(second ?? ''),
      });
    };
    const child: Record<string, unknown> = {
      info: record('info'), warn: record('warn'), error: record('error'),
      debug: record('debug'), trace: record('trace'), fatal: record('fatal'), level: 'info',
    };
    child.child = () => child;
    return child;
  };
  return {
    ...actual,
    createChildLogger: (bindings: { module?: string } = {}) => build(String(bindings.module ?? '')),
  };
});

import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { JARVIS_AGENT_ID } from '@/app/routes/jarvis-orchestrator';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import {
  createAmnesiacTaskStore,
  createForeignOwnerTaskStore,
  createMemoryOnlyTaskStore,
  createUnavailableTaskStore,
  type JarvisSessionTaskStore,
} from '../helpers/jarvis-session-task-store';

const OWNER = 'auth0|jarvis-session-gate-owner';
const OTHER = 'auth0|jarvis-session-gate-other';
const STORE_FAULT = new Error('connection terminated unexpectedly');

/** Test-only user-auth rail mirroring the req.oidc shape OIDC and PAT middleware produce. */
const testUserAuth: RequestHandler = (req, res, next) => {
  const sub = req.header('x-test-authenticated-sub');
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
  next();
};

/**
 * @description Mount the real Jarvis router over the given session store and ask it one question.
 * Only the model, the ticket service and the persistence pool are doubles; the route, the ownership
 * gate and the store handed in are the shipped code.
 * @param taskStore - The session store whose behaviour this case is about.
 * @param sessionId - The conversation thread id to ask on.
 * @returns The HTTP status and parsed body of the ask.
 */
async function askWith(
  taskStore: JarvisSessionTaskStore, sessionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctx = {
    pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    orchestrator: { processMessage: vi.fn() },
    taskStore,
    messageStore: { save: vi.fn(), getByTask: vi.fn().mockResolvedValue([]) },
    ticketService: {
      listTickets: vi.fn().mockResolvedValue([]),
      openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'session-gate-chat' }),
      createTicket: vi.fn(),
      updateStatus: vi.fn(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', testUserAuth, createJarvisRoutes(ctx as never, process.cwd()));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/jarvis/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-authenticated-sub': OWNER },
      body: JSON.stringify({ message: 'Hello Jarvis', sessionId }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

/** The refusal line the route writes, if it wrote one. */
const refusals = (): CapturedLog[] => logSink.entries
  .filter((entry) => entry.message === 'jarvis /ask refused: session_not_found') as unknown as CapturedLog[];

/** Every ERROR any Jarvis module logged in this case. */
const errors = (): CapturedLog[] => logSink.entries
  .filter((entry) => entry.level === 'error') as unknown as CapturedLog[];

describe('POST /api/jarvis/ask session ownership gate', () => {
  beforeEach(() => {
    configureProtectedResultAccess(undefined);
    logSink.entries.length = 0;
    executeBot.mockReset();
    executeBot.mockResolvedValue({ response: 'Hello. What can I help with?' });
  });

  afterEach(() => {
    configureProtectedResultAccess(undefined);
    purgeJarvisAskJobsForOwner(OWNER);
    purgeJarvisAskJobsForOwner(OTHER);
  });

  it('admits the owner through the REAL store and records no refusal', async () => {
    const taskStore = createMemoryOnlyTaskStore();

    const accepted = await askWith(taskStore, 'session-gate-owner');

    expect(accepted.status).toBe(202);
    expect(accepted.body.jobId).toEqual(expect.any(String));
    // The write half really happened: the session task exists and is bound to the caller.
    expect(await taskStore.get('session-gate-owner')).toMatchObject({
      taskId: 'session-gate-owner',
      ownerSub: OWNER,
      metadata: expect.objectContaining({ origin: 'jarvis-chat' }),
    });
    expect(refusals()).toHaveLength(0);
    expect(errors()).toHaveLength(0);
  });

  it('does not persist a fresh session that protected-result admission refuses', async () => {
    configureProtectedResultAccess({
      assertResultAccess: async () => undefined,
      assertTaskResultAccess: async () => undefined,
      hasTaskResults: async () => false,
      linkResult: async () => undefined,
      isProtectedAgent: async (agentId) => agentId === JARVIS_AGENT_ID,
    });
    const taskStore = createMemoryOnlyTaskStore();
    const create = vi.spyOn(taskStore, 'create');

    const result = await askWith(taskStore, 'session-gate-protected-fresh');

    expect(result).toEqual({ status: 404, body: { error: 'session_not_found' } });
    expect(create).not.toHaveBeenCalled();
    expect(await taskStore.get('session-gate-protected-fresh')).toBeNull();
    expect(executeBot).not.toHaveBeenCalled();
  });

  it('refuses a session id another owner holds, and never reaches the model', async () => {
    const result = await askWith(createForeignOwnerTaskStore(OTHER), 'session-gate-foreign');

    expect(result).toEqual({ status: 404, body: { error: 'session_not_found' } });
    expect(executeBot).not.toHaveBeenCalled();
    // A denial is not a fault: it is recorded once, as the ownership half, and not as an error.
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]?.payload).toMatchObject({ sessionId: 'session-gate-foreign', refusedBy: 'ownership' });
    expect(errors()).toHaveLength(0);
  });

  it('refuses a store that cannot hand back an owner-bound task rather than assuming agreement', async () => {
    // The exact shape that left two guards red: a store answering nothing to create(). Until
    // 2026-09-11 ensureSessionTask read `return !created || created.ownerSub === sub`, so this
    // passed the gate. It must not — nothing here proves who owns the session.
    const silentStore = {
      get: async () => null,
      create: async () => undefined,
      updateStatus: async () => undefined,
      incrementMessageCount: async () => undefined,
      incrementTurnCount: async () => undefined,
    } as unknown as JarvisSessionTaskStore;

    const result = await askWith(silentStore, 'session-gate-silent');

    expect(result).toEqual({ status: 404, body: { error: 'session_not_found' } });
    expect(executeBot).not.toHaveBeenCalled();
    expect(refusals()[0]?.payload).toMatchObject({ refusedBy: 'ownership' });
  });

  it('still fails closed when the store THROWS, and reports the cause at ERROR', async () => {
    const result = await askWith(createUnavailableTaskStore(STORE_FAULT), 'session-gate-unavailable');

    // Fail-closed is preserved. This is the half that must never regress.
    expect(result).toEqual({ status: 404, body: { error: 'session_not_found' } });
    // And it is no longer indistinguishable from a denial: an undetermined check is reported.
    const reported = errors().filter((entry) => entry.module === 'jarvis-thread-tickets');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.payload).toMatchObject({ err: STORE_FAULT, sessionId: 'session-gate-unavailable' });
    expect(reported[0]?.message).toContain('UNDETERMINED');
  });

  it('separates the read-back half from the ownership half in the record it leaves', async () => {
    const result = await askWith(createAmnesiacTaskStore(OWNER), 'session-gate-amnesiac');

    expect(result).toEqual({ status: 404, body: { error: 'session_not_found' } });
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]?.payload).toMatchObject({ sessionId: 'session-gate-amnesiac', refusedBy: 'read-back' });
  });
});
