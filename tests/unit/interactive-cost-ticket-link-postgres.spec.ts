/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-19 part A. The bot node REWRITES the cost task id to `${workspaceFolderId}::${agentId}` while ticket_task_links holds the THREAD's task id, so every interactive call wrote a real cost row that the trace join and the ticket/app budget joins could not see - measured on the box as 0 of 123 chat tickets carrying an llm-call span, and spend caps blind to interactive spend. The claim is a JOIN, so the guard runs the done-when's OWN query against a real postgres with the shipped migrations rather than doubling the database: a mocked store would have proven nothing about a foreign key, an ON CONFLICT, or an RLS-shaped write. The negative cases are what keep the fix honest - a sibling with no chat_tasks row must not be linked (task_id carries a foreign key), a thread that belongs to no ticket must not invent one, and a re-run must add nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { executeBotOrInline } from '../../src/app/routes/inline-bot-execution';
import { canonicalBotWorkspaceId } from '../../src/app/bot-node-request-scope';

const AGENT = '11111111-2222-3333-4444-555555555555';
const OWNER = 'auth0|ckr19-owner';

const fixture = new DisposablePostgres({
  purpose: 'interactive-cost-link',
  migrations: [
    '001-multi-agent-foundation.sql',
    '005-conversation-history-and-usage.sql',
    '078-cost-governance.sql',
    '100-ticket-family-base-schema.sql',
  ],
});

let pool: Pool;

beforeAll(async () => { pool = await fixture.start(); }, 180_000);
afterAll(async () => { await fixture.stop(); }, 120_000);

beforeEach(async () => {
  await pool.query('DELETE FROM ticket_task_links');
  await pool.query('DELETE FROM chat_tasks');
  await pool.query('DELETE FROM tickets');
});

/** A chat ticket with its thread task linked, exactly as a chat surface leaves it. */
async function seedThread(threadTaskId: string): Promise<string> {
  const { rows } = await pool.query<{ ticket_id: string }>(
    `INSERT INTO tickets (ticket_id, title, description, ticket_type, status, owner_sub)
     VALUES (gen_random_uuid(), 'a chat thread', 'ckr19', 'chat', 'backlog', $1) RETURNING ticket_id`,
    [OWNER],
  );
  const ticketId = rows[0].ticket_id;
  await pool.query(`INSERT INTO chat_tasks (task_id, status) VALUES ($1, 'processing')`, [threadTaskId]);
  await pool.query(
    `INSERT INTO ticket_task_links (ticket_id, task_id, role) VALUES ($1, $2, 'primary')`,
    [ticketId, threadTaskId],
  );
  return ticketId;
}

/** The row the bot node writes for its own rewritten task id while it works. */
async function seedBotNodeCostTask(siblingTaskId: string): Promise<void> {
  await pool.query(`INSERT INTO chat_tasks (task_id, status) VALUES ($1, 'processing')`, [siblingTaskId]);
}

/** The id the bot node will record its cost under, derived the way the controller must derive it. */
function siblingIdFor(workspaceFolderId: string): string {
  return `${canonicalBotWorkspaceId(workspaceFolderId)}::${AGENT}`;
}

/**
 * @description Runs the real executeBotOrInline down its REMOTE branch with the bot node itself
 * doubled — the node's HTTP call is the one seam that cannot run here, and it is not the claim.
 * @param workspaceFolderId - Workspace scope the controller dispatches with.
 * @param threadTaskId - The chat thread's task id.
 * @param success - What the doubled node reports.
 * @returns Resolves when the dispatch (and the settle that follows it) has finished.
 */
async function dispatch(workspaceFolderId: string, threadTaskId: string, success = true): Promise<void> {
  const botClient = {
    hasEndpoint: () => true,
    execute: async () => ({
      success,
      response: 'done',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0.01,
      model: 'test-model',
      provider: 'test',
      durationMs: 1,
      taskId: 'a-value-the-node-chose-to-echo',
    }),
  } as never;

  await executeBotOrInline({ pool } as never, botClient, AGENT, {
    text: 'hello',
    taskId: threadTaskId,
    workspaceFolderId,
    agentId: AGENT,
    userSub: OWNER,
    direct: true,
  } as never);
}

/** The done-when's own query: chat tickets reachable from a cost-bearing task link. */
async function chatTicketsWithLinkedCostTask(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tickets t
      WHERE t.ticket_type = 'chat'
        AND EXISTS (SELECT 1 FROM ticket_task_links l WHERE l.ticket_id = t.ticket_id
                      AND l.task_id <> $1)`,
    ['unused'],
  );
  return Number(rows[0].count);
}

describe('CKR-19 — the bot node rewrites the cost task id, and the ticket now follows it', () => {
  it('self-check: the fixture really has the schema these assertions depend on', async () => {
    // Every case below is about a JOIN across three tables and a foreign key. A fixture missing any
    // of them would let the assertions pass, or fail, for reasons that have nothing to do with the fix.
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('tickets', 'chat_tasks', 'ticket_task_links')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(['chat_tasks', 'ticket_task_links', 'tickets']);
    const { rows: fk } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.table_constraints
        WHERE table_name = 'ticket_task_links' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(Number(fk[0].count), 'the foreign keys the EXISTS guard exists for are missing').toBeGreaterThan(0);
  });

  it('the sibling cost task is linked to the thread\'s ticket', async () => {
    const threadTaskId = 'chat-thread-ckr19';
    const workspaceFolderId = 'ws-ckr19';
    const ticketId = await seedThread(threadTaskId);
    await seedBotNodeCostTask(siblingIdFor(workspaceFolderId));

    expect(await chatTicketsWithLinkedCostTask(), 'the thread link alone already counts').toBe(1);

    await dispatch(workspaceFolderId, threadTaskId);

    const { rows } = await pool.query<{ task_id: string; role: string }>(
      'SELECT task_id, role FROM ticket_task_links WHERE ticket_id = $1 ORDER BY task_id',
      [ticketId],
    );
    expect(rows.map((r) => r.task_id).sort()).toEqual([siblingIdFor(workspaceFolderId), threadTaskId].sort());
    expect(rows.find((r) => r.task_id === siblingIdFor(workspaceFolderId))?.role).toBe('swarm-execution');
  });

  it('the sibling task stops sitting in processing forever', async () => {
    // done-when (B): persistCostEvent hard-codes 'processing' and nothing ever closed these.
    const threadTaskId = 'chat-thread-status';
    const workspaceFolderId = 'ws-status';
    await seedThread(threadTaskId);
    await seedBotNodeCostTask(siblingIdFor(workspaceFolderId));

    await dispatch(workspaceFolderId, threadTaskId);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM chat_tasks WHERE task_id = $1', [siblingIdFor(workspaceFolderId)],
    );
    expect(rows[0].status).toBe('completed');
  });

  it('a failed turn closes the sibling task as failed, not completed', async () => {
    const threadTaskId = 'chat-thread-failed';
    const workspaceFolderId = 'ws-failed';
    await seedThread(threadTaskId);
    await seedBotNodeCostTask(siblingIdFor(workspaceFolderId));

    await dispatch(workspaceFolderId, threadTaskId, false);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM chat_tasks WHERE task_id = $1', [siblingIdFor(workspaceFolderId)],
    );
    expect(rows[0].status).toBe('failed');
  });

  it('a sibling with no cost row is NOT linked — task_id carries a foreign key', async () => {
    const threadTaskId = 'chat-thread-nocost';
    const workspaceFolderId = 'ws-nocost';
    const ticketId = await seedThread(threadTaskId);
    // Deliberately no seedBotNodeCostTask: a call that recorded nothing has no row to link.

    await dispatch(workspaceFolderId, threadTaskId);

    const { rows } = await pool.query('SELECT task_id FROM ticket_task_links WHERE ticket_id = $1', [ticketId]);
    expect(rows).toHaveLength(1);
  });

  it('a thread that belongs to no ticket does not get one invented', async () => {
    const threadTaskId = 'orphan-thread';
    const workspaceFolderId = 'ws-orphan';
    await pool.query(`INSERT INTO chat_tasks (task_id, status) VALUES ($1, 'processing')`, [threadTaskId]);
    await seedBotNodeCostTask(siblingIdFor(workspaceFolderId));

    await dispatch(workspaceFolderId, threadTaskId);

    const { rows } = await pool.query('SELECT 1 FROM ticket_task_links');
    expect(rows, 'an attribution was invented for a thread with no ticket').toHaveLength(0);
  });

  it('a second dispatch adds nothing — the link write is idempotent', async () => {
    const threadTaskId = 'chat-thread-twice';
    const workspaceFolderId = 'ws-twice';
    const ticketId = await seedThread(threadTaskId);
    await seedBotNodeCostTask(siblingIdFor(workspaceFolderId));

    await dispatch(workspaceFolderId, threadTaskId);
    await dispatch(workspaceFolderId, threadTaskId);

    const { rows } = await pool.query('SELECT task_id FROM ticket_task_links WHERE ticket_id = $1', [ticketId]);
    expect(rows).toHaveLength(2);
  });

  it('the id is DERIVED, never read off the response the node chose to echo', async () => {
    // Trusting BotNodeResponse.taskId would make a remote node the authority over which ticket its
    // spend lands on. The doubled node above echoes a value that is nobody's task id; nothing links
    // to it, and the derived sibling links instead.
    const threadTaskId = 'chat-thread-derived';
    const workspaceFolderId = 'ws-derived';
    const ticketId = await seedThread(threadTaskId);
    await seedBotNodeCostTask(siblingIdFor(workspaceFolderId));

    await dispatch(workspaceFolderId, threadTaskId);

    const { rows } = await pool.query<{ task_id: string }>(
      'SELECT task_id FROM ticket_task_links WHERE ticket_id = $1', [ticketId],
    );
    expect(rows.map((r) => r.task_id)).not.toContain('a-value-the-node-chose-to-echo');
    expect(rows.map((r) => r.task_id)).toContain(siblingIdFor(workspaceFolderId));
  });
});
