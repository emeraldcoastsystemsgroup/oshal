/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the return leg's failure half against a real PostgreSQL shelf and a real conversation store: a terminal ticket closes its durable work row, says so exactly once in the thread it was asked in, and stops being injected as "in progress".
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

const fixturePool = vi.hoisted(() => ({ current: null as unknown }));
const automatic = vi.hoisted(() => ({ summaries: vi.fn(async () => {}), visuals: vi.fn(async () => {}) }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
// The conversation stores build their OWN pool out of the environment. Pinning that factory to the
// disposable fixture pool is what keeps this suite off any deployment database while still writing
// real chat_tasks/chat_messages rows through the real store — the turn that was never persisted is
// half of the defect under test, so it is not doubled.
vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => fixturePool.current }));
// The success half calls a model. Only its CLAIM matters here, so it is observed, not executed.
vi.mock('@/app/routes/jarvis-orchestrator', async importOriginal => ({ ...await importOriginal<object>(),
  maskPendingComplexSummaries: automatic.summaries, repairCompletedTaskTableVisuals: automatic.visuals }));

import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import type { AppContext } from '@/app/composition/app-context';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';
import { buildOpenWorkBlock, ensureJarvisSchema, finishTask, saveTaskPending } from '@/app/routes/jarvis-task-store';

const OWNER = 'jarvis-terminal-return-owner';

/** Copied byte-for-byte from the live ticket 816dc7a7 ("How did we do in the stock market today?",
 *  2026-09-15) whose Jarvis work row then sat at 'queued' with a NULL error for 18 hours. `message`
 *  is the free-text half that must never reach a conversation turn. */
const LIVE_ESCALATION_TRANSITION = {
  reason: 'manifest_worker_dispatch_failed',
  source: 'dispatch-manifest-worker',
  status: 'escalated',
  message: 'authorization_remote_execution_failed',
  routedBy: 'keyword',
  severity: 'medium',
  ticketId: '816dc7a7-7225-4a6e-bf4e-3d0d88ccd639',
  workerBot: 'trading-analyst',
  nextAction: 'operator_review_required',
  escalatedAt: '2026-09-15T22:37:13.651Z',
  workerAgentId: 'a0000000-0000-0000-0000-000000000046',
  previousStatus: 'approved',
};

const ESCALATED_SENTENCE = 'This one did not finish — a step failed and the run stopped there.'
  + ' Nothing was made up in its place; open the ticket for the details.'
  + ' The app that owns this work would not accept the handoff.';
const QUARANTINED_SENTENCE = 'This one stopped for good — it failed repeatedly and was quarantined for review.'
  + ' Nothing was made up in its place; open the ticket for the details.';
const CANCELLED_SENTENCE = 'This one was cancelled before it finished.';

const TERMINAL_CASES = [
  { ticketStatus: 'escalated', transition: LIVE_ESCALATION_TRANSITION, sentence: ESCALATED_SENTENCE },
  { ticketStatus: 'dead_letter', sentence: QUARANTINED_SENTENCE,
    transition: { status: 'dead_letter', reason: 'escalation_loop_poison', source: 'dead-letter-service', attempts: 3 } },
  { ticketStatus: 'cancelled', sentence: CANCELLED_SENTENCE,
    transition: { status: 'cancelled', reason: 'operator_cancelled', source: 'cockpit' } },
];

interface FixtureTicket { ticketId: string; status: string; metadata: Record<string, unknown> }

const database = new DisposableAlertPostgres();
let pool: Pool;
let ctx: AppContext;
let tickets: FixtureTicket[];
let server: Server;
let base = '';
let sequence = 0;

beforeAll(async () => {
  pool = await database.start();
  fixturePool.current = pool;
  await ensureJarvisSchema(pool);
}, 180_000);

afterAll(async () => { await database.stop(); }, 60_000);

beforeEach(async () => {
  await pool.query('TRUNCATE jarvis_tasks');
  tickets = [];
  ctx = {
    pool,
    taskStore: new InMemoryTaskStore(),
    messageStore: new InMemoryMessageStore(),
    ticketService: { listTickets: async () => tickets.map(ticket => ({ ...ticket })) },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OWNER } };
    next();
  });
  app.use('/api/jarvis', createJarvisRoutes(ctx as never, resolve('src/api'), async () => new Map()));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  vi.clearAllMocks();
});

/** Files one handed-off work item exactly as /ask does: a real session task, then the real
 *  saveTaskPending, so the row starts at 'queued' the way every live row did. */
async function fileWorkItem(ticketStatus: string, transition: Record<string, unknown>) {
  sequence += 1;
  const item = { id: `work-${sequence}`, sessionId: `jarvis-session-${sequence}`, ticketId: `ticket-${sequence}` };
  await ctx.taskStore.create({ taskId: item.sessionId, ownerSub: OWNER, agentId: 'jarvis' });
  expect(await saveTaskPending(pool as never, item.id, OWNER, item.sessionId,
    'How did we do in the stock market today?', 'complex', item.ticketId)).toBe(true);
  tickets.push({ ticketId: item.ticketId, status: ticketStatus, metadata: { lastStatusTransition: transition } });
  return item;
}

async function poll(): Promise<Array<{ id: string; status: string; error: string | null }>> {
  const response = await fetch(`${base}/api/jarvis/tasks`);
  expect(response.status).toBe(200);
  return (await response.json()).tasks;
}

async function shelfRow(id: string) {
  return (await pool.query('SELECT status, error, result, finished_at FROM jarvis_tasks WHERE id = $1', [id])).rows[0];
}

async function assistantTurns(sessionId: string) {
  return (await ctx.messageStore.getByTask(sessionId)).filter(message => message.role === 'assistant');
}

async function erroredRowCount(): Promise<number> {
  return Number((await pool.query("SELECT count(*)::int AS total FROM jarvis_tasks WHERE status = 'error'")).rows[0].total);
}

it.each(TERMINAL_CASES)('closes a $ticketStatus ticket in the durable shelf and says so once in its thread',
  async ({ ticketStatus, transition, sentence }) => {
    const item = await fileWorkItem(ticketStatus, transition);
    expect((await shelfRow(item.id)).status).toBe('queued');

    expect((await poll()).find(task => task.id === item.id)?.status).toBe('error');

    const closed = await shelfRow(item.id);
    expect(closed.status).toBe('error');
    expect(closed.error).toBe(sentence);
    expect(closed.finished_at).not.toBeNull();
    expect(await assistantTurns(item.sessionId)).toHaveLength(1);
    expect((await assistantTurns(item.sessionId))[0].text).toBe(sentence);

    // A second poll must not re-announce it: the guarded UPDATE is the once-only guard.
    await poll();
    expect(await assistantTurns(item.sessionId)).toHaveLength(1);
    expect((await shelfRow(item.id)).error).toBe(sentence);

    const block = await buildOpenWorkBlock(ctx, OWNER);
    expect(block).toContain(`[${item.id}]`);
    expect(block).not.toContain('in progress');
  }, 60_000);

it('names the reason the escalation actually recorded and never echoes its free-text message', async () => {
  const item = await fileWorkItem('escalated', LIVE_ESCALATION_TRANSITION);
  await poll();

  const closed = await shelfRow(item.id);
  expect(closed.error).toContain('The app that owns this work would not accept the handoff.');
  expect(closed.error).not.toContain('authorization_remote_execution_failed');
  expect(closed.error).not.toContain('trading-analyst');
  const [turn] = await assistantTurns(item.sessionId);
  expect(turn.text).toBe(ESCALATED_SENTENCE);
  expect(turn.text).not.toContain('\n');
  expect(turn.metadata).toMatchObject({ sourceJarvisTaskId: item.id, sourceTicketId: item.ticketId });
}, 60_000);

it('still writes the thread turn for a row already marked delivered', async () => {
  const item = await fileWorkItem('escalated', LIVE_ESCALATION_TRANSITION);
  await pool.query('UPDATE jarvis_tasks SET delivered = TRUE WHERE id = $1', [item.id]);

  await poll();

  expect((await shelfRow(item.id)).status).toBe('error');
  expect(await assistantTurns(item.sessionId)).toHaveLength(1);
}, 60_000);

it('leaves a row a summarizer claimed under three minutes ago alone, so nothing overwrites a posted failure', async () => {
  const item = await fileWorkItem('escalated', LIVE_ESCALATION_TRANSITION);
  await pool.query("UPDATE jarvis_tasks SET status = 'summarizing', summarize_started_at = NOW() WHERE id = $1", [item.id]);

  await poll();

  expect((await shelfRow(item.id)).status).toBe('summarizing');
  expect(await assistantTurns(item.sessionId)).toHaveLength(0);

  // finishTask carries no status guard of its own: had the row been claimed here, this call would
  // have put it back to 'done' underneath a failure turn that had already posted.
  await finishTask(pool as never, item.id, true, 'The team finished — here is the summary.');
  const finished = await shelfRow(item.id);
  expect(finished.status).toBe('done');
  expect(finished.result).toBe('The team finished — here is the summary.');
  await poll();
  expect((await shelfRow(item.id)).status).toBe('done');
  expect(await assistantTurns(item.sessionId)).toHaveLength(0);
}, 60_000);

it('claims a summarize that was abandoned more than three minutes ago', async () => {
  const item = await fileWorkItem('escalated', LIVE_ESCALATION_TRANSITION);
  await pool.query(
    "UPDATE jarvis_tasks SET status = 'summarizing', summarize_started_at = NOW() - INTERVAL '4 minutes' WHERE id = $1",
    [item.id]);

  await poll();

  expect((await shelfRow(item.id)).status).toBe('error');
  expect(await assistantTurns(item.sessionId)).toHaveLength(1);
}, 60_000);

it('leaves a completed ticket to the summarizer and writes no failure turn', async () => {
  const item = await fileWorkItem('complete', { status: 'complete', source: 'dispatch-manifest-worker' });

  await poll();

  expect(automatic.summaries).toHaveBeenCalledTimes(1);
  expect(automatic.summaries.mock.calls.at(-1)?.[2].map((task: { id: string }) => task.id)).toContain(item.id);
  const row = await shelfRow(item.id);
  expect(row.status).toBe('queued');
  expect(row.error).toBeNull();
  expect(await assistantTurns(item.sessionId)).toHaveLength(0);
}, 60_000);

it('drains a backlog three per poll and never dates a note into a two-week-old thread', async () => {
  const fresh = [];
  for (let index = 0; index < 5; index += 1) fresh.push(await fileWorkItem('escalated', LIVE_ESCALATION_TRANSITION));
  for (const [index, item] of fresh.entries()) {
    await pool.query("UPDATE jarvis_tasks SET created_at = NOW() - ($2 || ' minutes')::interval WHERE id = $1",
      [item.id, String(index)]);
  }
  const ancient = await fileWorkItem('escalated', LIVE_ESCALATION_TRANSITION);
  await pool.query("UPDATE jarvis_tasks SET created_at = NOW() - INTERVAL '16 days' WHERE id = $1", [ancient.id]);

  await poll();
  expect(await erroredRowCount()).toBe(3);
  await poll();
  expect(await erroredRowCount()).toBe(5);
  await poll();
  expect(await erroredRowCount()).toBe(5);

  const stale = await shelfRow(ancient.id);
  expect(stale.status).toBe('queued');
  expect(stale.error).toBeNull();
  expect(await assistantTurns(ancient.sessionId)).toHaveLength(0);
}, 90_000);
