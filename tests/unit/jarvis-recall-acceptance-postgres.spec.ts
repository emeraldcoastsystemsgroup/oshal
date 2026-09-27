/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the recall acceptance case over a real PostgreSQL with the shipped chat schema and row-level security: the seed goes through the REAL task and message stores as the owner-scoped app role (the same classes the Test Lab card and the live proof use), the REAL conversation_query/conversation_fetch tools running as the bot role find that thread and its codeword for the owner and nothing for another owner, and the case's own residue read over the same policies proves exact cleanup and turns a surviving row red.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The stand-in server writes Jarvis's answer into thread B through the REAL message store as the owner and serves it back through /api/jarvis/history, because the case now judges delivery into the thread (read through the owner's own row-level policies) rather than the job's first answer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';
import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { InMemoryTaskStore } from '@/entities/task/services/in-memory-task-store';
import { InMemoryMessageStore } from '@/entities/message/services/in-memory-message-store';
import {
  BOT_NODE_CONVERSATION_FETCH_TOOL,
  BOT_NODE_CONVERSATION_QUERY_TOOL,
  registerBotNodeReadOnlyTools,
  type BotNodeReadOnlyToolDeps,
  type ReadOnlyToolRegistration,
} from '@/app/bot-node-read-only-tools';
import { anyBotRuntimeToolScope } from '@/shared/llm-runtime';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { BOT_COLUMN_PRIVILEGES, BOT_HELPERS } from '../../scripts/governance/provision-app-role.mjs';

const requireCjs = createRequire(import.meta.url);
const acceptance = requireCjs('../../scripts/lib/jarvis-recall-acceptance.js');
/* eslint-disable @typescript-eslint/no-require-imports */
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const { authorizeCapability, captureDispatchCapabilities, normalizeAuthorizedScopes } = require('../../any-bot/server/utils/dispatch-capabilities');
const { normalizeAllowedTools } = require('../../any-bot/server/utils/untrusted-content');
/* eslint-enable @typescript-eslint/no-require-imports */

const APP_ROLE = 'oshal_app';
const BOT_ROLE = 'oshal_bot';
const ALICE = 'auth0|recall-acceptance-alice';
const BOB = 'auth0|recall-acceptance-bob';

const database = new DisposablePostgres({
  purpose: 'jarvis-recall-acceptance',
  database: 'jarvis_recall_acceptance',
  memory: '320m',
  max: 4,
  connectionTimeoutMillis: 10_000,
  statementTimeoutMs: 60_000,
  roles: [{ name: APP_ROLE, max: 4 }, { name: BOT_ROLE, max: 4 }],
  migrations: [
    '005-conversation-history-and-usage.sql',
    '055-chat-tasks-owner-sub.sql',
    '100-jarvis-tasks-base-schema.sql',
    '100-ticket-family-base-schema.sql',
  ],
});

/** The live policies over the shipped tables (as the owner-scope guard carries them). */
const SCHEMA_DDL = `
  CREATE OR REPLACE FUNCTION oshal_owns_task(p_task text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM chat_tasks t
         WHERE t.task_id = p_task AND t.owner_sub = current_setting('oshal.current_sub', true)); $$;
  REVOKE ALL ON FUNCTION oshal_owns_task(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION oshal_owns_task(text) TO ${APP_ROLE};
  ALTER TABLE chat_tasks OWNER TO ${APP_ROLE};
  ALTER TABLE chat_tasks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_tasks FORCE ROW LEVEL SECURITY;
  CREATE POLICY chat_tasks_owner_or_operator ON chat_tasks AS PERMISSIVE FOR ALL
    USING ((owner_sub = current_setting('oshal.current_sub', true)) OR (current_setting('oshal.is_operator', true) = 'on'))
    WITH CHECK ((owner_sub = current_setting('oshal.current_sub', true)) OR (current_setting('oshal.is_operator', true) = 'on'));
  ALTER TABLE chat_messages OWNER TO ${APP_ROLE};
  ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
  CREATE POLICY chat_messages_task_owner_or_operator ON chat_messages AS PERMISSIVE FOR ALL
    USING (current_setting('oshal.is_operator', true) = 'on' OR oshal_owns_task(task_id))
    WITH CHECK (current_setting('oshal.is_operator', true) = 'on' OR oshal_owns_task(task_id));
  ALTER TABLE jarvis_tasks OWNER TO ${APP_ROLE};
  ALTER TABLE tickets OWNER TO ${APP_ROLE};
`;

let admin: Pool;
let appPool: Pool;
let registry: InstanceType<typeof ToolRegistry>;
let taskStore: InMemoryTaskStore;
let messageStore: InMemoryMessageStore;

/** @returns The bot role's grants, derived from the governed contract (never hand-typed). */
function derivedBotGrants(): string[] {
  const grants = ['chat_tasks', 'chat_messages', 'jarvis_tasks'].map((table) => {
    const select = BOT_COLUMN_PRIVILEGES.get(table)?.SELECT;
    if (!select?.size) throw new Error(`${table} carries no SELECT allowlist`);
    return `GRANT SELECT (${[...select].join(', ')}) ON TABLE public.${table} TO ${BOT_ROLE}`;
  });
  if (!BOT_HELPERS.has('oshal_owns_task(text)')) throw new Error('oshal_owns_task(text) is not in BOT_HELPERS');
  return [...grants, `GRANT EXECUTE ON FUNCTION public.oshal_owns_task(text) TO ${BOT_ROLE}`];
}

/** Ports as the live proof binds them: real stores, the app-role pool, the caller's identity. */
function portsFor(owner: string, api: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>) {
  return {
    ownerSub: owner, api, taskStore, messageStore,
    query: (sql: string, params: unknown[]) => appPool.query(sql, params),
    withOwner: <T>(fn: () => Promise<T>) => runWithRequestIdentity({ sub: owner, isOperator: false }, fn),
    agentId: 'a0000000-0000-0000-0000-000000000050',
    workspaceRoot: null,
    sleep: async () => undefined,
  };
}

/** Run one recall tool exactly as a bot-node dispatch does, as the bot role. */
async function runTool(tool: string, sub: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const caps = captureDispatchCapabilities(registry, normalizeAllowedTools([tool]), normalizeAuthorizedScopes([anyBotRuntimeToolScope(tool)]));
  const decision = authorizeCapability(caps, tool);
  expect(decision.allowed, decision.error).toBe(true);
  return registry.executeSnapshot(decision.snapshot, input, { extraEnv: { OSHAL_USER_SUB: sub } });
}

/** Delete what the fake routes would delete, through the same real stores. */
async function deleteThread(owner: string, id: string): Promise<void> {
  await runWithRequestIdentity({ sub: owner, isOperator: false }, async () => {
    await messageStore.deleteByTask(id);
    await taskStore.delete(id);
  });
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_DB_GUC', 'on');
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'auto');
  admin = await database.start();
  await admin.query(SCHEMA_DDL);
  await admin.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${BOT_ROLE}`);
  for (const grant of derivedBotGrants()) await admin.query(grant);
  const app = database.roleConnection(APP_ROLE);
  vi.stubEnv('DATABASE_URL', `postgres://${app.user}:${encodeURIComponent(app.password)}@${app.host}:${app.port}/${app.database}`);
  appPool = wrapPoolWithGuc(database.rolePool(APP_ROLE));
  taskStore = new InMemoryTaskStore();
  messageStore = new InMemoryMessageStore();
  registry = new ToolRegistry();
  registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
    pool: wrapPoolWithGuc(database.rolePool(BOT_ROLE)),
    ragService: { search: async () => [], searchAllCollections: async () => [] } as unknown as BotNodeReadOnlyToolDeps['ragService'],
    graphConnector: null,
  });
}, 180_000);

afterAll(async () => {
  await database.stop();
  vi.unstubAllEnvs();
}, 120_000);

describe('recall acceptance over the real stores and row-level security', () => {
  it('the app role the seed writes as is really subject to row-level security', async () => {
    const { rows } = await admin.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname', [[APP_ROLE, BOT_ROLE]]);
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }, { rolsuper: false, rolbypassrls: false }]);
  });

  it('seeds a durable owner-bound thread that the real recall tools return to its owner and to no one else', async () => {
    const fixture = acceptance.createRecallFixture();
    const ports = portsFor(ALICE, async () => ({ status: 500, json: {} }));
    await acceptance.seedRecallThread(ports, fixture);
    const owned = await admin.query('SELECT owner_sub, agent_id, metadata FROM chat_tasks WHERE task_id = $1', [fixture.threadA]);
    expect(owned.rows[0]).toMatchObject({ owner_sub: ALICE, agent_id: 'a0000000-0000-0000-0000-000000000050',
      metadata: { origin: 'jarvis-chat', testLabFixture: fixture.marker } });

    const aliceList = await runTool(BOT_NODE_CONVERSATION_QUERY_TOOL, ALICE, { query: fixture.title }) as { conversations: Array<{ taskId: string }> };
    expect(aliceList.conversations.map((c) => c.taskId)).toEqual([fixture.threadA]);
    expect(JSON.stringify(aliceList)).not.toContain(fixture.codeword);
    const aliceFetch = await runTool(BOT_NODE_CONVERSATION_FETCH_TOOL, ALICE, { taskId: fixture.threadA }) as { conversation: { messages: Array<{ text: string }> } };
    expect(aliceFetch.conversation.messages.map((m) => m.text).join(' ')).toContain(fixture.codeword);

    const bobList = await runTool(BOT_NODE_CONVERSATION_QUERY_TOOL, BOB, { query: fixture.title }) as { conversations: unknown[] };
    expect(bobList.conversations).toEqual([]);
    expect(await runTool(BOT_NODE_CONVERSATION_FETCH_TOOL, BOB, { taskId: fixture.threadA })).toEqual({ conversation: null, task: null });

    expect(await acceptance.readResidue(ports, [fixture.threadA])).toEqual({ chatTasks: 1, chatMessages: 2, chatTickets: 0, workItems: 0 });
    expect(await acceptance.readResidue(portsFor(BOB, ports.api), [fixture.threadA])).toEqual({ chatTasks: 0, chatMessages: 0, chatTickets: 0, workItems: 0 });
    await deleteThread(ALICE, fixture.threadA);
    expect(await acceptance.readResidue(ports, [fixture.threadA])).toEqual({ chatTasks: 0, chatMessages: 0, chatTickets: 0, workItems: 0 });
  });

  it('a whole run leaves no chat task, message, chat ticket or work item behind', async () => {
    const run = await acceptance.runJarvisRecallAcceptance(portsFor(ALICE, recallingServer(ALICE)));
    expect(run.state, run.detail).toBe('degraded');
    expect(run.detail).toContain('no Token Chase capture');
    expect(run.evidence.cleanupErrors).toEqual([]);
    const left = await admin.query('SELECT count(*)::int AS n FROM chat_tasks WHERE task_id = ANY($1)', [[run.evidence.threadA, run.evidence.threadB]]);
    expect(left.rows[0].n).toBe(0);
    const tickets = await admin.query("SELECT count(*)::int AS n FROM tickets WHERE metadata->>'taskId' = ANY($1)", [[run.evidence.threadA, run.evidence.threadB]]);
    expect(tickets.rows[0].n).toBe(0);
  });

  it('a surviving chat ticket and work item turn the run red, read through the owner\'s own policies', async () => {
    const run = await acceptance.runJarvisRecallAcceptance(portsFor(ALICE, recallingServer(ALICE, { leaveTicket: true, fileWorkItem: true })));
    expect(run.state).toBe('fail');
    expect(run.detail).toMatch(/CLEANUP INCOMPLETE: residue remains .*chatTickets=1, workItems=1/);
    await admin.query("DELETE FROM tickets WHERE metadata->>'taskId' = $1", [run.evidence.threadB]);
    await admin.query('DELETE FROM jarvis_tasks WHERE session_id = $1', [run.evidence.threadB]);
  });
});

/**
 * A stand-in for the running server's routes, backed by the SAME real stores and database: the ask
 * creates thread B and its chat ticket exactly as /api/jarvis/ask does, "Jarvis" answers by really
 * calling conversation_query then conversation_fetch as the bot role, and the delete routes delete
 * through the real stores and ticket table.
 */
function recallingServer(owner: string, options: { leaveTicket?: boolean; fileWorkItem?: boolean } = {}) {
  let answer = '';
  let threadB = '';
  let delivered = false;
  return async (method: string, route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const input = (body ?? {}) as { sessionId?: string; message?: string };
    if (method === 'POST' && route === '/api/jarvis/ask') {
      await runWithRequestIdentity({ sub: owner, isOperator: false }, async () => {
        await taskStore.create({ taskId: input.sessionId!, title: input.message!.slice(0, 90), processingMode: 'agentic', ownerSub: owner, metadata: { origin: 'jarvis-chat' } });
        await messageStore.save({ taskId: input.sessionId!, role: 'user', type: 'task', text: input.message!, contentBlocks: [], metadata: {} });
      });
      await admin.query(`INSERT INTO tickets (ticket_id, title, owner_sub, ticket_type, metadata) VALUES (gen_random_uuid(), 'chat', $1, 'chat', $2::jsonb)`,
        [owner, JSON.stringify({ kind: 'chat-thread', taskId: input.sessionId })]);
      if (options.fileWorkItem) {
        await admin.query(`INSERT INTO jarvis_tasks (id, user_sub, session_id, title) VALUES (gen_random_uuid()::text, $1, $2, 'filed')`, [owner, input.sessionId]);
      }
      const title = /titled "([^"]+)"/.exec(input.message!)![1];
      const list = await runTool(BOT_NODE_CONVERSATION_QUERY_TOOL, owner, { query: title }) as { conversations: Array<{ taskId: string }> };
      const other = list.conversations.find((c) => c.taskId !== input.sessionId);
      const fetched = other ? await runTool(BOT_NODE_CONVERSATION_FETCH_TOOL, owner, { taskId: other.taskId }) as { conversation: { messages: Array<{ text: string }> } } : null;
      answer = `The codeword was ${acceptance.extractCodewords(fetched?.conversation.messages.map((m) => m.text).join(' '))[0] ?? 'unknown'}.`;
      threadB = input.sessionId!;
      return { status: 202, json: { jobId: 'job-1', sessionId: input.sessionId!, chatTicketId: 'unused' } };
    }
    if (route.startsWith('/api/jarvis/ask/result')) {
      // Like the route, the answer lands in the asked thread (once) before the job reports it.
      if (answer && !delivered) {
        delivered = true;
        await runWithRequestIdentity({ sub: owner, isOperator: false }, () => messageStore.save({ taskId: threadB, role: 'assistant', type: 'say', text: answer, contentBlocks: [], metadata: {} }));
      }
      return { status: 200, json: { status: 'done', answer } };
    }
    if (route.startsWith('/api/jarvis/history?sessionId=')) {
      const taskId = decodeURIComponent(route.slice('/api/jarvis/history?sessionId='.length));
      const messages = await runWithRequestIdentity({ sub: owner, isOperator: false }, () => messageStore.getByTask(taskId));
      return { status: 200, json: { turns: messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'jarvis', text: m.text })) } };
    }
    if (route.startsWith('/api/token-chase/')) return { status: 200, json: { frames: [] } };
    if (method === 'DELETE' && route.startsWith('/api/tasks/')) {
      await deleteThread(owner, decodeURIComponent(route.slice(11)));
      if (!options.leaveTicket) await admin.query("DELETE FROM tickets WHERE owner_sub = $1 AND metadata->>'taskId' = $2", [owner, decodeURIComponent(route.slice(11))]);
      return { status: 204, json: {} };
    }
    return { status: 200, json: { ok: true } };
  };
}
