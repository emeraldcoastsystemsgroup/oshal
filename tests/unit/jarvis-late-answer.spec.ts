/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the false "my model provider did not respond in time" (live 2026-09-27): the cross-thread recall turn really recalled - conversation_query and conversation_fetch ran, its frames held the codeword - but the /ask route answered at its decision window with that sentence and the real answer, landing later, reached nobody. These cases drive the REAL router over the real memory-mode task and message stores with the decision window shortened: a conversation that outlives the window stays pending with the still-working note, and the SAME turn's late answer is written into the SAME thread and becomes the job's answer; a late turn that fails reports its own failure and never the "did not respond" sentence; and a work request past the window is still filed with the swarm exactly as before, its late model answer not written anywhere.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The decision window is read once when the orchestrator module loads, so it is set before imports.
vi.hoisted(() => { process.env.JARVIS_DECISION_TIMEOUT_MS = '150'; });

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
// No store may open a pool: the task and message stores are the real classes in memory mode, and no
// inherited DATABASE_URL is ever dialled. The rest of the barrel stays real.
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createOptionalPostgresPool: () => null,
  ensureConversationStoreSchema: async () => {},
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { ASK_JOB_TTL_MS, JARVIS_STILL_WORKING_NOTE, stillWorkingFields } from '@/app/routes/jarvis-late-answer';
import { BUILD_HANDOFF_ACK, detectBuildRequest, resetBuildHandoffClaims } from '@/app/routes/jarvis-build-handoff';
import { looksLikeWorkRequest } from '@/app/routes/jarvis-orchestrator';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import { configureProtectedResultAccess } from '@/shared/protected-results';

const OWNER = 'auth0|jarvis-late-answer-owner';
const QUESTION = 'Which codeword did I give you in my other conversation?';
const LATE_ANSWER = 'The codeword was TESTLAB-RECALL-0A0B0C0D.';
const FALSE_TIMEOUT = 'did not respond in time';

/** A bot turn the case finishes by hand, long after the shortened decision window. */
function gatedTurn() {
  let finish!: (value: { response: string }) => void;
  let fail!: (error: Error) => void;
  const turn = new Promise<{ response: string }>((resolve, reject) => { finish = resolve; fail = reject; });
  return { turn, finish, fail };
}

/** Test-only user-auth rail mirroring the req.oidc shape OIDC and PAT middleware produce. */
const testUserAuth: RequestHandler = (req, res, next) => {
  (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OWNER } };
  next();
};

/**
 * @description Serve the real Jarvis router over real memory-mode stores and hand the case its HTTP port.
 * @param run - The case, given the base URL and the ticket double.
 * @returns Whatever the case returned; the server is always closed.
 */
async function withJarvis<T>(run: (base: string, createTicket: ReturnType<typeof vi.fn>) => Promise<T>): Promise<T> {
  const createTicket = vi.fn(async () => ({ ticketId: 'late-answer-build-ticket' }));
  const ctx = {
    pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    orchestrator: { processMessage: vi.fn() },
    taskStore: new InMemoryTaskStore(),
    messageStore: new InMemoryMessageStore(),
    ticketService: {
      listTickets: vi.fn().mockResolvedValue([]),
      openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'late-answer-chat' }),
      createTicket,
      updateStatus: vi.fn(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', testUserAuth, createJarvisRoutes(ctx as never, process.cwd()));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`, createTicket);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** @returns The parsed JSON of one GET/POST against the router. */
async function call(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return await response.json() as Record<string, unknown>;
}

/** @returns The thread's turns exactly as the Jarvis surface re-renders them. */
async function threadTurns(base: string, sessionId: string): Promise<Array<{ role: string; text: string }>> {
  const history = await call(`${base}/history?sessionId=${encodeURIComponent(sessionId)}`);
  return (history.turns as Array<{ role: string; text: string }>).map(({ role, text }) => ({ role, text }));
}

/** @returns The job result once `accept` says so (polled). */
async function resultWhen(base: string, jobId: string, accept: (body: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await expect.poll(async () => { body = await call(`${base}/ask/result?jobId=${jobId}`); return accept(body); },
    { timeout: 10_000, interval: 20 }).toBe(true);
  return body;
}

describe('a Jarvis turn that outlives the /ask decision window', () => {
  beforeEach(() => {
    configureProtectedResultAccess(undefined);
    resetBuildHandoffClaims();
    executeBot.mockReset();
  });

  afterEach(() => {
    purgeJarvisAskJobsForOwner(OWNER);
    resetBuildHandoffClaims();
  });

  it('stays pending with the still-working note, then lands its own late answer in the SAME thread', async () => {
    expect(looksLikeWorkRequest(QUESTION), 'the precondition: a question, not work').toBe(false);
    const bot = gatedTurn();
    executeBot.mockReturnValue(bot.turn);
    await withJarvis(async (base, createTicket) => {
      const accepted = await call(`${base}/ask`, { message: QUESTION, sessionId: 'late-answer-thread' });
      const jobId = String(accepted.jobId);

      const pending = await resultWhen(base, jobId, (body) => typeof body.progress === 'string');
      expect(pending).toMatchObject({ status: 'pending', progress: JARVIS_STILL_WORKING_NOTE });
      expect(Number(pending.expiresInMs)).toBeGreaterThan(0);
      expect(Number(pending.expiresInMs)).toBeLessThanOrEqual(ASK_JOB_TTL_MS);
      // While the turn is still working nothing claims it failed, in the job or in the thread.
      expect(await threadTurns(base, 'late-answer-thread')).toEqual([{ role: 'user', text: QUESTION }]);

      bot.finish({ response: LATE_ANSWER });
      const done = await resultWhen(base, jobId, (body) => body.status !== 'pending');
      expect(done).toMatchObject({ status: 'done', answer: LATE_ANSWER, taskId: 'late-answer-thread' });
      expect(await threadTurns(base, 'late-answer-thread')).toEqual([
        { role: 'user', text: QUESTION },
        { role: 'jarvis', text: LATE_ANSWER },
      ]);
      expect(JSON.stringify(done)).not.toContain(FALSE_TIMEOUT);
      expect(executeBot).toHaveBeenCalledTimes(1);
      expect(createTicket, 'a question that ran long is not work to file').not.toHaveBeenCalled();
    });
  });

  it('reports the late turn\'s own failure, never "did not respond"', async () => {
    const bot = gatedTurn();
    executeBot.mockReturnValue(bot.turn);
    await withJarvis(async (base) => {
      const accepted = await call(`${base}/ask`, { message: QUESTION, sessionId: 'late-failure-thread' });
      const jobId = String(accepted.jobId);
      await resultWhen(base, jobId, (body) => typeof body.progress === 'string');

      bot.fail(new Error('Antigravity CLI error: the model returned no result'));
      const failed = await resultWhen(base, jobId, (body) => body.status !== 'pending');
      expect(failed).toMatchObject({ status: 'error', error: 'Antigravity CLI error: the model returned no result' });
      expect(await threadTurns(base, 'late-failure-thread')).toEqual([{ role: 'user', text: QUESTION }]);
      expect(JSON.stringify(failed)).not.toContain(FALSE_TIMEOUT);
    });
  });

  it('still files a work request with the swarm at the window, and writes no late model answer', async () => {
    const report = 'the trading dashboard has been blank since this morning';
    expect(looksLikeWorkRequest(report)).toBe(true);
    expect(detectBuildRequest(report), 'the precondition: it reaches the model turn').toBeNull();
    const bot = gatedTurn();
    executeBot.mockReturnValue(bot.turn);
    await withJarvis(async (base, createTicket) => {
      const accepted = await call(`${base}/ask`, { message: report, sessionId: 'late-work-thread' });
      const done = await resultWhen(base, String(accepted.jobId), (body) => body.status !== 'pending');
      expect(done).toMatchObject({ status: 'done', answer: BUILD_HANDOFF_ACK });
      expect(done.progress).toBeUndefined();
      expect(createTicket).toHaveBeenCalledTimes(1);

      bot.finish({ response: 'A late inline answer the swarm filing already replaced.' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await threadTurns(base, 'late-work-thread')).toEqual([
        { role: 'user', text: report },
        { role: 'jarvis', text: BUILD_HANDOFF_ACK },
      ]);
    });
  });
});

describe('stillWorkingFields', () => {
  it('adds nothing while the turn is inside the window', () => {
    expect(stillWorkingFields({ createdAt: 1_000 }, 2_000)).toEqual({});
  });

  it('carries the note and the job\'s remaining retention once the window passed, never negative', () => {
    expect(stillWorkingFields({ progress: JARVIS_STILL_WORKING_NOTE, createdAt: 1_000 }, 61_000))
      .toEqual({ progress: JARVIS_STILL_WORKING_NOTE, expiresInMs: ASK_JOB_TTL_MS - 60_000 });
    expect(stillWorkingFields({ progress: JARVIS_STILL_WORKING_NOTE, createdAt: 0 }, ASK_JOB_TTL_MS + 5)).toEqual({
      progress: JARVIS_STILL_WORKING_NOTE, expiresInMs: 0,
    });
  });
});
