/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The owner-scoping half of the read-only question tools, proven over a REAL PostgreSQL rather than asserted. conversation_query reads another person's conversations for a living, so the claim that it cannot is only worth what the database does: this file starts its own server, mints the NOSUPERUSER NOBYPASSRLS role production runs as, creates chat_tasks/chat_messages with migration 094's policies and oshal_owns_task verbatim, hands the tables to that role, and drives the REAL registered handler through the REAL ToolRegistry snapshot path. The last case is the one that matters - it asks for identity A's rows while the CONNECTION carries identity B, so the adapter's own owner predicate says yes and only row-level security can say no. Nothing here points at a deployment: the address is invented at start() and the container is force-removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { ChatSearchSource } from '@/features/global-search';
import {
  BOT_NODE_CONVERSATION_QUERY_TOOL,
  registerBotNodeReadOnlyTools,
  type BotNodeReadOnlyToolDeps,
  type ReadOnlyToolRegistration,
} from '@/app/bot-node-read-only-tools';
import { anyBotRuntimeToolScope } from '@/shared/llm-runtime';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/* eslint-disable @typescript-eslint/no-require-imports */
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const {
  authorizeCapability,
  captureDispatchCapabilities,
  normalizeAuthorizedScopes,
} = require('../../any-bot/server/utils/dispatch-capabilities');
const { normalizeAllowedTools } = require('../../any-bot/server/utils/untrusted-content');
/* eslint-enable @typescript-eslint/no-require-imports */

/** The NOSUPERUSER NOBYPASSRLS identity production connects as; a superuser would bypass RLS. */
const ENFORCING_ROLE = 'oshal_app';

const ALICE = 'auth0|conversation-owner-alice';
const BOB = 'auth0|conversation-owner-bob';
const ALICE_TASK = 'task-alice-quarterly-plan';
const BOB_TASK = 'task-bob-unrelated';
/** A word that appears in BOTH owners' conversations, so a leak would be visible as a hit. */
const SHARED_WORD = 'quarterly';

const database = new DisposablePostgres({
  purpose: 'bot-node-read-only-owner-scope',
  database: 'read_only_tools_fixture',
  memory: '320m',
  max: 4,
  connectionTimeoutMillis: 10_000,
  statementTimeoutMs: 60_000,
  roles: [{ name: ENFORCING_ROLE, max: 4 }],
});

/**
 * chat_tasks + chat_messages as the live database carries them: the owner-or-operator policy on
 * the task row, and migration 094's derived-owner policy on messages through oshal_owns_task.
 * oshal_owns_task is SECURITY DEFINER in production too — it must see past RLS to answer at all.
 */
const SCHEMA_DDL = `
  CREATE TABLE chat_tasks (
    task_id TEXT PRIMARY KEY,
    title TEXT,
    owner_sub TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE chat_messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id TEXT NOT NULL,
    text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION oshal_owns_task(p_task text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM chat_tasks t
      WHERE t.task_id = p_task AND t.owner_sub = current_setting('oshal.current_sub', true)
    );
  $$;
  REVOKE ALL ON FUNCTION oshal_owns_task(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION oshal_owns_task(text) TO PUBLIC;

  ALTER TABLE chat_tasks OWNER TO ${ENFORCING_ROLE};
  ALTER TABLE chat_tasks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_tasks FORCE ROW LEVEL SECURITY;
  CREATE POLICY chat_tasks_owner_or_operator ON chat_tasks
    AS PERMISSIVE FOR ALL
    USING ((owner_sub = current_setting('oshal.current_sub', true))
           OR (current_setting('oshal.is_operator', true) = 'on'))
    WITH CHECK ((owner_sub = current_setting('oshal.current_sub', true))
           OR (current_setting('oshal.is_operator', true) = 'on'));

  ALTER TABLE chat_messages OWNER TO ${ENFORCING_ROLE};
  ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
  CREATE POLICY chat_messages_task_owner_or_operator ON chat_messages
    AS PERMISSIVE FOR ALL
    USING (current_setting('oshal.is_operator', true) = 'on' OR oshal_owns_task(task_id))
    WITH CHECK (current_setting('oshal.is_operator', true) = 'on' OR oshal_owns_task(task_id));
`;

let fixtureAdmin: Pool;
let gucPool: Pool;
let registry: InstanceType<typeof ToolRegistry>;
const savedStrict = process.env.OSHAL_DB_GUC_STRICT;
const savedGuc = process.env.OSHAL_DB_GUC;

/** Run conversation_query exactly as a dispatch does: capture, authorize, execute the snapshot. */
async function conversationQueryAs(sub: string, query: string): Promise<Array<{ taskId: string; title: string }>> {
  const caps = captureDispatchCapabilities(
    registry,
    normalizeAllowedTools([BOT_NODE_CONVERSATION_QUERY_TOOL]),
    normalizeAuthorizedScopes([anyBotRuntimeToolScope(BOT_NODE_CONVERSATION_QUERY_TOOL)]),
  );
  const decision = authorizeCapability(caps, BOT_NODE_CONVERSATION_QUERY_TOOL);
  expect(decision.allowed, decision.error).toBe(true);
  const output = await registry.executeSnapshot(decision.snapshot, { query }, {
    extraEnv: { OSHAL_USER_SUB: sub },
  });
  return (output as { conversations: Array<{ taskId: string; title: string }> }).conversations;
}

beforeAll(async () => {
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  fixtureAdmin = await database.start();
  await fixtureAdmin.query(SCHEMA_DDL);
  await fixtureAdmin.query(
    `INSERT INTO chat_tasks (task_id, title, owner_sub) VALUES ($1,$2,$3), ($4,$5,$6)`,
    [ALICE_TASK, `Alice ${SHARED_WORD} plan`, ALICE, BOB_TASK, `Bob ${SHARED_WORD} notes`, BOB],
  );
  await fixtureAdmin.query(
    `INSERT INTO chat_messages (task_id, text) VALUES ($1,$2), ($3,$4)`,
    [ALICE_TASK, 'we agreed the budget lands in October', BOB_TASK, 'we agreed the budget lands in November'],
  );
  gucPool = wrapPoolWithGuc(database.rolePool(ENFORCING_ROLE));
  registry = new ToolRegistry();
  registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
    pool: gucPool,
    // Not this file's boundary: nothing below reaches RAG or the graph.
    ragService: { search: async () => [], searchAllCollections: async () => [] } as unknown as BotNodeReadOnlyToolDeps['ragService'],
    graphConnector: null,
  });
}, 180_000);

afterAll(async () => {
  await database.stop();
  if (savedStrict === undefined) delete process.env.OSHAL_DB_GUC_STRICT; else process.env.OSHAL_DB_GUC_STRICT = savedStrict;
  if (savedGuc === undefined) delete process.env.OSHAL_DB_GUC; else process.env.OSHAL_DB_GUC = savedGuc;
}, 120_000);

describe('conversation_query owner scoping is the database, over a real PostgreSQL', () => {
  it('the role the tool connects as really is subject to row-level security', async () => {
    // Without this, every case below could pass for the wrong reason: a superuser (or a BYPASSRLS
    // role) ignores every policy, and the assertions would be vacuous.
    const { rows } = await fixtureAdmin.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ENFORCING_ROLE],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('the caller identity reaches the CONNECTION, which is what the policy reads', async () => {
    const stamped = await runWithRequestIdentity({ sub: ALICE, isOperator: false }, () =>
      gucPool.query(`SELECT current_setting('oshal.current_sub', true) AS sub,
                            current_setting('oshal.is_operator', true) AS op`));
    expect(stamped.rows[0]).toEqual({ sub: ALICE, op: 'off' });
  });

  it('identity A reads its OWN conversation', async () => {
    const hits = await conversationQueryAs(ALICE, SHARED_WORD);
    expect(hits.map((h) => h.taskId)).toEqual([ALICE_TASK]);
  });

  it('identity A reads its own conversation by MESSAGE text, through oshal_owns_task', async () => {
    const hits = await conversationQueryAs(ALICE, 'lands in October');
    expect(hits.map((h) => h.taskId)).toEqual([ALICE_TASK]);
  });

  it('identity B gets NOTHING of A, on a word that matches both conversations', async () => {
    const hits = await conversationQueryAs(BOB, SHARED_WORD);
    expect(hits.map((h) => h.taskId)).toEqual([BOB_TASK]);
    expect(hits.map((h) => h.taskId)).not.toContain(ALICE_TASK);
  });

  it("identity B asking for A's message text gets nothing", async () => {
    expect(await conversationQueryAs(BOB, 'lands in October')).toEqual([]);
  });

  it('the DATABASE is what refuses, not the adapter predicate', async () => {
    // The isolating case. ChatSearchSource also filters `owner_sub = $1` in SQL, so a two-identity
    // result alone cannot say WHICH layer refused. Here the adapter is handed ALICE as its owner
    // parameter while the connection carries BOB: the application predicate matches Alice's row
    // and the only thing standing between it and the caller is row-level security.
    const source = new ChatSearchSource(gucPool);
    const asAlice = await runWithRequestIdentity({ sub: ALICE, isOperator: false }, () =>
      source.search(ALICE, SHARED_WORD, 10));
    expect(asAlice.map((h) => h.id), 'the same query must succeed for the right identity').toEqual([ALICE_TASK]);

    const asBob = await runWithRequestIdentity({ sub: BOB, isOperator: false }, () =>
      source.search(ALICE, SHARED_WORD, 10));
    expect(asBob, "an app-layer owner filter alone would have returned Alice's row here").toEqual([]);
  });

  it('a read with NO identity established is starved, not fallen open to operator', async () => {
    // OSHAL_DB_GUC_STRICT=deny stamps an identity-less query anonymous non-operator. This is what
    // makes dropping the runWithRequestIdentity wrapper in the handler fail loudly rather than
    // quietly returning every owner's rows.
    const source = new ChatSearchSource(gucPool);
    expect(await source.search(ALICE, SHARED_WORD, 10)).toEqual([]);
  });
});
