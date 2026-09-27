/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for the /ask session gate's honesty. On 2026-09-27 the first post-deploy Jarvis ask answered 404 session_not_found because the task store's pool timed out ("Connection terminated due to connection timeout") during a 36-bot cold start - a database that could not answer was reported in the words for a session somebody else owns. These cases run the REAL route over the REAL PostgreSQL-backed task store on a private server: the owner is admitted and the row is really written; a thread another owner holds is refused 404 with nothing sent to the model; and with the store's own pool genuinely exhausted (its clients held by statements waiting on a table lock) the pool's acquire timeout makes /ask answer a retryable 503 session_unavailable that writes nothing, and /ask/result answer 503 instead of 'expired'. Nothing here is a mocked throw: the timeout is pg-pool's own.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
// Only the route-level Jarvis tables' bootstrap is doubled (the route's own pool is a double); the
// task store under test keeps the real conversation-schema bootstrap against the private server.
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...await importOriginal<object>(),
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
  buildOwnerRlsPolicyStatements: vi.fn().mockReturnValue([]),
}));

/** One structured line a Jarvis module wrote while this case ran. */
interface CapturedLog { module: string; level: string; payload: Record<string, unknown>; message: string }

const logSink = vi.hoisted(() => ({ entries: [] as Array<Record<string, unknown>> }));
vi.mock('@/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const build = (module: string) => {
    const record = (level: string) => (first: unknown, second?: unknown) => {
      logSink.entries.push({ module, level, payload: typeof first === 'object' && first !== null ? first : {},
        message: typeof first === 'string' ? first : String(second ?? '') });
    };
    const child: Record<string, unknown> = {
      info: record('info'), warn: record('warn'), error: record('error'),
      debug: record('debug'), trace: record('trace'), fatal: record('fatal'), level: 'info',
    };
    child.child = () => child;
    return child;
  };
  return { ...actual, createChildLogger: (bindings: { module?: string } = {}) => build(String(bindings.module ?? '')) };
});

import { createJarvisRoutes, purgeJarvisAskJobsForOwner } from '@/app/routes/jarvis-routes';
import { JARVIS_SESSION_UNAVAILABLE_MESSAGE } from '@/app/routes/jarvis-thread-tickets';
import { InMemoryTaskStore } from '@/entities/task';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// A pool acquire timeout is 5 s by construction (optional-postgres-pool), so a case that waits for one
// needs more than vitest's default 5 s.
vi.setConfig({ testTimeout: 60_000 });

const OWNER = 'auth0|jarvis-gate-pg-owner';
const OTHER = 'auth0|jarvis-gate-pg-other';
/** The store's application_name (optional-postgres-pool: `oshal-api-<owner>`), used to watch its clients. */
const STORE_APPLICATION = 'oshal-api-task-store';

const database = new DisposablePostgres({
  purpose: 'jarvis-ask-session-gate',
  database: 'jarvis_ask_session_gate',
  migrations: ['005-conversation-history-and-usage.sql', '055-chat-tasks-owner-sub.sql'],
});

let admin: Pool;
let taskStore: InMemoryTaskStore;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let base = '';

/** Test-only user-auth rail mirroring the req.oidc shape OIDC and PAT middleware produce. */
const testUserAuth: RequestHandler = (req, res, next) => {
  const sub = req.header('x-test-authenticated-sub');
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
  next();
};

/** @returns The captured lines with this exact message. */
const logged = (message: string): CapturedLog[] => logSink.entries.filter((entry) => entry.message === message) as unknown as CapturedLog[];

/**
 * @description Ask Jarvis one question as OWNER on the given thread through the real router.
 * @param sessionId - The conversation thread id.
 * @returns Status, Retry-After header and parsed body.
 */
async function ask(sessionId: string): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/jarvis/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-authenticated-sub': OWNER },
    body: JSON.stringify({ message: 'Hello Jarvis', sessionId }),
  });
  return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() as Record<string, unknown> };
}

/**
 * @description Read one ask job as OWNER.
 * @param jobId - The job id POST /ask returned.
 * @returns Status and parsed body.
 */
async function result(jobId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`, { headers: { 'x-test-authenticated-sub': OWNER } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/**
 * @description Exhaust the task store's REAL pool: an admin transaction takes an exclusive lock on
 * chat_tasks, then as many store reads as the pool has clients each take a client and wait on it. Any
 * further store call must wait for a client, and pg-pool's own acquire timeout ends that wait.
 * @param run - What to do while the pool is exhausted.
 * @returns Whatever `run` returned; the lock is always released and the held reads always settle.
 */
async function withExhaustedStorePool<T>(run: () => Promise<T>): Promise<T> {
  const locker = await admin.connect();
  await locker.query('BEGIN');
  await locker.query('LOCK TABLE chat_tasks IN ACCESS EXCLUSIVE MODE');
  const held = [taskStore.get('gate-hold-1'), taskStore.get('gate-hold-2')].map((read) => read.catch(() => null));
  try {
    await expect.poll(async () => Number((await admin.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
      [STORE_APPLICATION])).rows[0].n), { timeout: 15_000, interval: 100 }).toBe(2);
    return await run();
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    await Promise.all(held);
  }
}

beforeAll(async () => {
  admin = await database.start();
  const conn = database.connection;
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'auto');
  // The smallest pool the sizing allows, so two held reads exhaust it (optional-postgres-pool floors it at 2).
  vi.stubEnv('PGPOOL_MAX', '2');
  vi.stubEnv('PGAPPNAME', '');
  vi.stubEnv('DATABASE_URL', `postgres://${conn.user}:${encodeURIComponent(conn.password)}@${conn.host}:${conn.port}/${conn.database}`);
  taskStore = new InMemoryTaskStore();
  expect(await taskStore.get('gate-warmup')).toBeNull();
  const ctx = {
    pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    orchestrator: { processMessage: vi.fn() },
    taskStore,
    messageStore: { save: vi.fn(), getByTask: vi.fn().mockResolvedValue([]) },
    ticketService: {
      listTickets: vi.fn().mockResolvedValue([]),
      openChatTicket: vi.fn().mockResolvedValue({ ticketId: 'gate-pg-chat' }),
      createTicket: vi.fn(),
      updateStatus: vi.fn(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', testUserAuth, createJarvisRoutes(ctx as never, process.cwd()));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await database.stop();
  vi.unstubAllEnvs();
}, 120_000);

beforeEach(() => {
  configureProtectedResultAccess(undefined);
  logSink.entries.length = 0;
  executeBot.mockReset();
  executeBot.mockResolvedValue({ response: 'Hello. What can I help with?' });
});

afterEach(() => {
  purgeJarvisAskJobsForOwner(OWNER);
});

describe('POST /api/jarvis/ask session gate over a real PostgreSQL task store', () => {
  it('admits the owner and really writes the owner-bound thread', async () => {
    const accepted = await ask('gate-pg-owner-thread');

    expect(accepted.status).toBe(202);
    await expect.poll(async () => (await result(String(accepted.body.jobId))).body.status, { timeout: 15_000, interval: 50 }).toBe('done');
    const rows = (await admin.query('SELECT owner_sub FROM chat_tasks WHERE task_id = $1', ['gate-pg-owner-thread'])).rows;
    expect(rows).toEqual([{ owner_sub: OWNER }]);
    expect(logged('jarvis /ask refused: session_not_found')).toHaveLength(0);
    expect(logged('jarvis /ask deferred: session_unavailable')).toHaveLength(0);
  });

  it('refuses a thread another owner holds with 404, and never reaches the model', async () => {
    await taskStore.create({ taskId: 'gate-pg-foreign-thread', title: 'theirs', processingMode: 'agentic', ownerSub: OTHER, metadata: { origin: 'jarvis-chat' } });

    const refused = await ask('gate-pg-foreign-thread');

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'session_not_found' });
    expect(executeBot).not.toHaveBeenCalled();
    expect(logged('jarvis /ask refused: session_not_found').map((entry) => entry.payload.refusedBy)).toEqual(['ownership']);
    expect(logSink.entries.filter((entry) => entry.level === 'error' && entry.module === 'jarvis-thread-tickets')).toHaveLength(0);
    const rows = (await admin.query('SELECT owner_sub FROM chat_tasks WHERE task_id = $1', ['gate-pg-foreign-thread'])).rows;
    expect(rows).toEqual([{ owner_sub: OTHER }]);
  });

  it('answers a retryable 503, not 404, when the store pool times out - and writes nothing', async () => {
    const deferred = await withExhaustedStorePool(() => ask('gate-pg-timeout-thread'));

    expect(deferred.status).toBe(503);
    expect(deferred.body).toEqual({ error: 'session_unavailable', message: JARVIS_SESSION_UNAVAILABLE_MESSAGE, retryable: true });
    expect(deferred.retryAfter).toBe('5');
    expect(executeBot).not.toHaveBeenCalled();
    // The cause is the pool's own acquire timeout, reported as undetermined - not a denial.
    const undetermined = logSink.entries.filter((entry) => entry.level === 'error' && entry.module === 'jarvis-thread-tickets') as unknown as CapturedLog[];
    expect(undetermined).toHaveLength(1);
    expect(String((undetermined[0]?.payload.err as Error | undefined)?.message)).toMatch(/timeout/i);
    expect(undetermined[0]?.message).toContain('UNDETERMINED');
    expect(logged('jarvis /ask refused: session_not_found')).toHaveLength(0);
    expect(logged('jarvis /ask deferred: session_unavailable')).toHaveLength(1);
    const rows = (await admin.query('SELECT count(*)::int AS n FROM chat_tasks WHERE task_id = $1', ['gate-pg-timeout-thread'])).rows;
    expect(rows[0].n).toBe(0);
  });

  it('answers /ask/result with a retryable 503 instead of "expired" while the store pool times out', async () => {
    const accepted = await ask('gate-pg-result-thread');
    const jobId = String(accepted.body.jobId);
    await expect.poll(async () => (await result(jobId)).body.status, { timeout: 15_000, interval: 50 }).toBe('done');

    const during = await withExhaustedStorePool(() => result(jobId));

    expect(during).toEqual({ status: 503, body: { error: 'result_unavailable', retryable: true } });
    const after = await result(jobId);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ status: 'done', answer: 'Hello. What can I help with?' });
  });
});
