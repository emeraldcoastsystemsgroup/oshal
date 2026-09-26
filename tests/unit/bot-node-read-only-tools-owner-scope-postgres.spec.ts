/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The owner-scoping half of the read-only question tools, proven over a REAL PostgreSQL rather than asserted. conversation_query reads another person's conversations for a living, so the claim that it cannot is only worth what the database does: this file starts its own server, mints the NOSUPERUSER NOBYPASSRLS role production runs as, creates chat_tasks/chat_messages with migration 094's policies and oshal_owns_task verbatim, hands the tables to that role, and drives the REAL registered handler through the REAL ToolRegistry snapshot path. The last case is the one that matters - it asks for identity A's rows while the CONNECTION carries identity B, so the adapter's own owner predicate says yes and only row-level security can say no. Nothing here points at a deployment: the address is invented at start() and the container is force-removed in afterAll.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial verification corrections. (1) The header called oshal_app "the role production connects as" - true of the api, wrong for the bot-node these tools run on: docker-compose.oshal-local.yml wires every bot to oshal_bot through BOT_DATABASE_URL, and oshal_bot is a NON-owner, so the isolation it gets is plain ENABLE RLS rather than FORCE. Every case now runs for BOTH roles, each a minted NOSUPERUSER NOBYPASSRLS LOGIN role. (2) The scoping is two layers, not one - ChatSearchSource carries its own owner_sub predicate - so a mutation that stamped the OPERATOR instead of the caller went red on nothing: the adapter still scoped. Added the case that reads the GUC values PostgreSQL itself saw on the tool's connection, through a recording proxy on the role pool, so operator-stamping goes red on its own.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The bot role now holds ONLY what the governed contract grants it, derived from BOT_COLUMN_PRIVILEGES and BOT_HELPERS at run time rather than hand-listed - so the spec and the provisioner cannot drift apart without this file going red. The chat tables come from the shipped migrations (005, 055) so the derived column lists name real columns. Three claims added for oshal_bot: its effective privileges are exactly the allowlist and nothing table-wide; a column outside the list (turn_count - total_cost was already granted for the cost rollup, so it is not a sentinel) is refused 42501 when read directly; and the tool's read still succeeds and still starves identity B under exactly those grants. Removing one granted column from the map reddens the read; adding the sentinel reddens the refusal.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Seq 3 swapped the hand-built chat_messages for shipped migration 005 and left the seed inserting only (task_id, text) - but 005's message_id, role and type are NOT NULL with no defaults, so beforeAll raised 23502 and every case SKIPPED on every run, here and on the verifier's fixture alike. A guard that cannot start proves nothing. The seed now supplies message_id (gen_random_uuid()), role ('user', the CHECK allows user|assistant) and type ('say'; no CHECK). Measured by the verifier with only this change: 20 passed; removing title from the map reddens 5 (the four bot reads and the positive control of the database-refuses case); adding turn_count reddens 1; stamping the operator reddens 2.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prove the metadata-only conversation list and exact-id fetch over both non-superuser roles, including a foreign-task null result and message-body retrieval only after a caller-owned task is selected.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Three gaps closed. (1) The only database-only case called the legacy search(), which the tools stopped calling; it now runs on the EXACT statements the tools run (imported from the adapters, never copied): list, fetch, and the message read, which has no owner predicate at all, each handed identity A while the connection carries identity B, each paired with the same call under A so a deny-everyone policy cannot pass. (2) Jarvis work items: jarvis_tasks comes from the shipped migration 100-jarvis-tasks-base-schema.sql with its owner policy, the bot's grants derive from the contract, and the tool path proves A lists metadata only (never result) and fetches her own result, B gets nothing of A's by title or result text and cannot fetch A's id, and the database alone refuses on the work-item statements too. (3) The protected-result boundary: a caller-owned conversation carrying protected execution lineage, and a work item filed from it, are left out of the list and come back withheld from fetch, while the paired control shows both rows are the caller's own and visible under her identity - so the refusal is the boundary, not row-level security; another owner fetching the same ids gets plain nulls, no withheld marker.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  CONVERSATION_MESSAGES_SQL,
  ChatSearchSource,
  JarvisTaskRecallSource,
  MAX_CONVERSATION_MESSAGES,
} from '@/features/global-search';
import {
  BOT_NODE_CONVERSATION_FETCH_TOOL,
  BOT_NODE_CONVERSATION_QUERY_TOOL,
  registerBotNodeReadOnlyTools,
  type BotNodeReadOnlyToolDeps,
  type ReadOnlyToolRegistration,
} from '@/app/bot-node-read-only-tools';
import { anyBotRuntimeToolScope } from '@/shared/llm-runtime';
import { PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { BOT_COLUMN_PRIVILEGES, BOT_HELPERS } from '../../scripts/governance/provision-app-role.mjs';

/* eslint-disable @typescript-eslint/no-require-imports */
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const {
  authorizeCapability,
  captureDispatchCapabilities,
  normalizeAuthorizedScopes,
} = require('../../any-bot/server/utils/dispatch-capabilities');
const { normalizeAllowedTools } = require('../../any-bot/server/utils/untrusted-content');
/* eslint-enable @typescript-eslint/no-require-imports */

/** The api's role: owns the tables, so only FORCE ROW LEVEL SECURITY binds it. */
const OWNER_ROLE = 'oshal_app';
/** The bot-node's role (compose BOT_DATABASE_URL): a non-owner, bound by plain ENABLE RLS. */
const BOT_ROLE = 'oshal_bot';
const ROLES = [OWNER_ROLE, BOT_ROLE] as const;
type Role = (typeof ROLES)[number];

const ALICE = 'auth0|conversation-owner-alice';
const BOB = 'auth0|conversation-owner-bob';
const ALICE_TASK = 'task-alice-quarterly-plan';
const BOB_TASK = 'task-bob-unrelated';
/** Alice's Jarvis work items: an ordinary one, and one filed from her protected conversation. */
const ALICE_JOB = 'job-alice-quarterly-forecast';
const BOB_JOB = 'job-bob-quarterly-forecast';
const ALICE_PROTECTED_TASK = 'task-alice-confidential-thread';
const ALICE_PROTECTED_JOB = 'job-alice-confidential-summary';
/** A word that appears in BOTH owners' conversations and work items, so a leak would be visible as a hit. */
const SHARED_WORD = 'quarterly';
/** A word only Alice's protected records carry, so the protected cases never disturb the others. */
const PROTECTED_WORD = 'confidential';
const ALICE_RESULT = 'the forecast said heavy rain on Tuesday';
const BOB_RESULT = 'the forecast said clear skies on Friday';
/**
 * Columns the tool never reads and the contract must not grant. total_cost is NOT a usable
 * sentinel: the pre-existing contract already grants it to oshal_bot for the cost rollup.
 */
const UNGRANTED_SENTINELS: ReadonlyArray<[table: string, column: string]> = [
  ['chat_tasks', 'turn_count'],
  ['chat_messages', 'content_blocks'],
  ['jarvis_tasks', 'visual'],
  ['jarvis_tasks', 'principal_issuer'],
];
/** Every table the recall tools read, and therefore every table the bot grants are derived for. */
const RECALL_TABLES = ['chat_tasks', 'chat_messages', 'jarvis_tasks'] as const;
const OWNS_TASK = 'oshal_owns_task(text)';

const database = new DisposablePostgres({
  purpose: 'bot-node-read-only-owner-scope',
  database: 'read_only_tools_fixture',
  memory: '320m',
  max: 4,
  connectionTimeoutMillis: 10_000,
  statementTimeoutMs: 60_000,
  roles: [{ name: OWNER_ROLE, max: 4 }, { name: BOT_ROLE, max: 4 }],
  // The real tables, so the column lists derived from the contract name real columns. jarvis_tasks
  // and its owner policy come from the shipped base-schema migration, not a copy.
  migrations: [
    '005-conversation-history-and-usage.sql',
    '055-chat-tasks-owner-sub.sql',
    '100-jarvis-tasks-base-schema.sql',
  ],
});

/**
 * The policies as the live database carries them over the shipped chat tables: the
 * owner-or-operator policy on the task row, and migration 094's derived-owner policy on messages
 * through oshal_owns_task, which is SECURITY DEFINER in production too - it must see past RLS to
 * answer at all. jarvis_tasks already carries its policy and FORCE from the migration; it is only
 * handed to the owner role here, as the provisioner does. Nothing is granted to the bot role here;
 * its grants are derived from the governed contract below, and EXECUTE on the helper is revoked
 * from PUBLIC exactly as the governance SQL does so the derived grant is the only way the bot
 * reaches it.
 */
const SCHEMA_DDL = `
  CREATE OR REPLACE FUNCTION oshal_owns_task(p_task text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM chat_tasks t
      WHERE t.task_id = p_task AND t.owner_sub = current_setting('oshal.current_sub', true)
    );
  $$;
  REVOKE ALL ON FUNCTION oshal_owns_task(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION oshal_owns_task(text) TO ${OWNER_ROLE};

  ALTER TABLE chat_tasks OWNER TO ${OWNER_ROLE};
  ALTER TABLE chat_tasks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_tasks FORCE ROW LEVEL SECURITY;
  CREATE POLICY chat_tasks_owner_or_operator ON chat_tasks
    AS PERMISSIVE FOR ALL
    USING ((owner_sub = current_setting('oshal.current_sub', true))
           OR (current_setting('oshal.is_operator', true) = 'on'))
    WITH CHECK ((owner_sub = current_setting('oshal.current_sub', true))
           OR (current_setting('oshal.is_operator', true) = 'on'));

  ALTER TABLE chat_messages OWNER TO ${OWNER_ROLE};
  ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
  CREATE POLICY chat_messages_task_owner_or_operator ON chat_messages
    AS PERMISSIVE FOR ALL
    USING (current_setting('oshal.is_operator', true) = 'on' OR oshal_owns_task(task_id))
    WITH CHECK (current_setting('oshal.is_operator', true) = 'on' OR oshal_owns_task(task_id));

  ALTER TABLE jarvis_tasks OWNER TO ${OWNER_ROLE};
`;

/**
 * The bot role's grants, derived from the governed contract rather than typed here. This is the
 * drift guard: a column the tool needs that the provisioner would not grant reddens the read
 * below, and a column the provisioner grants that the tool does not need widens what this file
 * measures rather than hiding behind a hand-typed list.
 * @returns GRANT statements in the shape docs/governance/app-role-provisioning.sql applies.
 */
function derivedBotGrants(): string[] {
  const grants: string[] = [];
  for (const table of RECALL_TABLES) {
    const select = BOT_COLUMN_PRIVILEGES.get(table)?.SELECT;
    if (!select?.size) throw new Error(`${table} carries no SELECT allowlist in BOT_COLUMN_PRIVILEGES`);
    grants.push(`GRANT SELECT (${[...select].join(', ')}) ON TABLE public.${table} TO ${BOT_ROLE}`);
  }
  if (!BOT_HELPERS.has(OWNS_TASK)) throw new Error(`${OWNS_TASK} is not in BOT_HELPERS; the chat_messages policy calls it`);
  grants.push(`GRANT EXECUTE ON FUNCTION public.${OWNS_TASK} TO ${BOT_ROLE}`);
  return grants;
}

/** What PostgreSQL saw on the connection at the moment the tool's own SELECT ran. */
interface Stamp { sub: string; op: string }

/** Per role: the GUC-wrapped pool the tool reads through, its registry, and the stamps observed. */
interface Harness { gucPool: Pool; registry: InstanceType<typeof ToolRegistry>; stamps: Stamp[] }

/** The whole output of conversation_query. */
interface RecallList {
  conversations: Array<{ taskId: string; source: string } & Record<string, unknown>>;
  tasks: Array<{ taskId: string; source: string } & Record<string, unknown>>;
}

/** The whole output of conversation_fetch. */
interface RecallFetch {
  conversation: Record<string, unknown> | null;
  task: Record<string, unknown> | null;
  withheld?: string;
}

let fixtureAdmin: Pool;
const harnesses = new Map<Role, Harness>();
const savedStrict = process.env.OSHAL_DB_GUC_STRICT;
const savedGuc = process.env.OSHAL_DB_GUC;

/**
 * Wrap the role pool so that, on the SAME client the GUC wrapper just stamped, the moment one of
 * the recall SELECTs arrives we first read back the GUC values the policy is about to read. This
 * observes the connection, not the adapter's result - the only way to tell an operator stamp from
 * a caller stamp when the adapter predicate scopes the rows either way.
 */
function recordingPool(raw: Pool, stamps: Stamp[]): Pool {
  const patched = new WeakSet<PoolClient>();
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop !== 'connect') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        if (!patched.has(client)) {
          patched.add(client);
          const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
            const first = args[0];
            const text = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text;
            if (typeof text === 'string' && /FROM (chat_tasks|jarvis_tasks)/.test(text)) {
              const seen = await original(
                "SELECT current_setting('oshal.current_sub', true) AS sub, current_setting('oshal.is_operator', true) AS op",
              ) as { rows: Stamp[] };
              stamps.push(seen.rows[0]);
            }
            return original(...args);
          };
        }
        return client;
      };
    },
  });
}

/**
 * Run one recall tool exactly as a dispatch does: capture, authorize, execute the snapshot.
 * @param role - Which role's harness to run through.
 * @param tool - Runtime tool name.
 * @param sub - Caller subject the trusted context carries.
 * @param input - Model-supplied input.
 * @returns The handler's output.
 */
async function runTool(role: Role, tool: string, sub: string, input: Record<string, unknown>): Promise<unknown> {
  const { registry } = harnesses.get(role)!;
  const caps = captureDispatchCapabilities(
    registry,
    normalizeAllowedTools([tool]),
    normalizeAuthorizedScopes([anyBotRuntimeToolScope(tool)]),
  );
  const decision = authorizeCapability(caps, tool);
  expect(decision.allowed, decision.error).toBe(true);
  return registry.executeSnapshot(decision.snapshot, input, { extraEnv: { OSHAL_USER_SUB: sub } });
}

/** conversation_query's whole output. */
async function recallQueryAs(role: Role, sub: string, query: string): Promise<RecallList> {
  return await runTool(role, BOT_NODE_CONVERSATION_QUERY_TOOL, sub, { query }) as RecallList;
}

/** conversation_query's conversation summaries only, as the original cases read them. */
async function conversationQueryAs(role: Role, sub: string, query: string): Promise<RecallList['conversations']> {
  return (await recallQueryAs(role, sub, query)).conversations;
}

/** conversation_fetch's whole output. */
async function recallFetchAs(role: Role, sub: string, taskId: string, source?: string): Promise<RecallFetch> {
  return await runTool(role, BOT_NODE_CONVERSATION_FETCH_TOOL, sub, source ? { taskId, source } : { taskId }) as RecallFetch;
}

/** conversation_fetch's conversation only, as the original cases read it. */
async function conversationFetchAs(role: Role, sub: string, taskId: string): Promise<Record<string, unknown> | null> {
  return (await recallFetchAs(role, sub, taskId)).conversation;
}

/** Seed both owners' conversations and work items, plus Alice's protected pair, as the superuser. */
async function seed(): Promise<void> {
  await fixtureAdmin.query(
    `INSERT INTO chat_tasks (task_id, title, owner_sub, metadata) VALUES
       ($1, $2, $3, '{}'::jsonb), ($4, $5, $6, '{}'::jsonb), ($7, $8, $3, $9::jsonb)`,
    [ALICE_TASK, `Alice ${SHARED_WORD} plan`, ALICE, BOB_TASK, `Bob ${SHARED_WORD} notes`, BOB,
      ALICE_PROTECTED_TASK, `Alice ${PROTECTED_WORD} thread`,
      JSON.stringify({ [PROTECTED_RESULT_EXECUTIONS]: ['exec-alice-protected-1'] })],
  );
  await fixtureAdmin.query(
    `INSERT INTO chat_messages (message_id, task_id, role, type, text)
     VALUES (gen_random_uuid(), $1, 'user', 'say', $2), (gen_random_uuid(), $3, 'user', 'say', $4),
            (gen_random_uuid(), $5, 'user', 'say', $6)`,
    [ALICE_TASK, 'we agreed the budget lands in October', BOB_TASK, 'we agreed the budget lands in November',
      ALICE_PROTECTED_TASK, `the ${PROTECTED_WORD} payload`],
  );
  await fixtureAdmin.query(
    `INSERT INTO jarvis_tasks (id, user_sub, session_id, title, status, kind, result, finished_at) VALUES
       ($1, $2, $3, $4, 'done', 'simple', $5, NOW()),
       ($6, $7, $8, $9, 'done', 'simple', $10, NOW()),
       ($11, $2, $12, $13, 'done', 'simple', $14, NOW())`,
    [ALICE_JOB, ALICE, ALICE_TASK, `Alice ${SHARED_WORD} forecast`, ALICE_RESULT,
      BOB_JOB, BOB, BOB_TASK, `Bob ${SHARED_WORD} forecast`, BOB_RESULT,
      ALICE_PROTECTED_JOB, ALICE_PROTECTED_TASK, `Alice ${PROTECTED_WORD} summary`, `the ${PROTECTED_WORD} answer`],
  );
}

beforeAll(async () => {
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  fixtureAdmin = await database.start();
  await fixtureAdmin.query(SCHEMA_DDL);
  // The fixture hands declared roles broad defaults so a migration can grant to them; the
  // deployment does the opposite. Strip everything, then apply exactly the contract.
  await fixtureAdmin.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${BOT_ROLE}`);
  for (const grant of derivedBotGrants()) await fixtureAdmin.query(grant);
  await seed();
  for (const role of ROLES) {
    const stamps: Stamp[] = [];
    const gucPool = wrapPoolWithGuc(recordingPool(database.rolePool(role), stamps));
    const registry = new ToolRegistry();
    registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
      pool: gucPool,
      // Not this file's boundary: nothing below reaches RAG or the graph.
      ragService: { search: async () => [], searchAllCollections: async () => [] } as unknown as BotNodeReadOnlyToolDeps['ragService'],
      graphConnector: null,
    });
    harnesses.set(role, { gucPool, registry, stamps });
  }
}, 180_000);

afterAll(async () => {
  await database.stop();
  if (savedStrict === undefined) delete process.env.OSHAL_DB_GUC_STRICT; else process.env.OSHAL_DB_GUC_STRICT = savedStrict;
  if (savedGuc === undefined) delete process.env.OSHAL_DB_GUC; else process.env.OSHAL_DB_GUC = savedGuc;
}, 120_000);

/**
 * @description Run one read with the connection carrying `connectionSub`, whatever the adapter is handed.
 * @param connectionSub - The identity stamped onto the connection.
 * @param read - The read to run.
 * @returns The read's result.
 */
function asConnection<T>(connectionSub: string, read: () => Promise<T>): Promise<T> {
  return runWithRequestIdentity({ sub: connectionSub, isOperator: false }, read);
}

describe.each(ROLES)('conversation_query owner scoping is the database, over a real PostgreSQL, as %s', (role) => {
  it('the role the tool connects as really is subject to row-level security', async () => {
    // Without this, every case below could pass for the wrong reason: a superuser (or a BYPASSRLS
    // role) ignores every policy, and the assertions would be vacuous.
    const { rows } = await fixtureAdmin.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('identity A reads its OWN conversation', async () => {
    const hits = await conversationQueryAs(role, ALICE, SHARED_WORD);
    expect(hits.map((h) => h.taskId)).toEqual([ALICE_TASK]);
  });

  it("the tool's SELECTs ran on a connection stamped with the CALLER, not the operator", async () => {
    // The adapter predicate would scope the rows even if the handler stamped the operator, so a
    // result assertion cannot see that mutation. This reads what PostgreSQL itself saw on the
    // connection at the moment each of the tool's own SELECTs arrived.
    const { stamps } = harnesses.get(role)!;
    stamps.length = 0;
    await recallQueryAs(role, ALICE, SHARED_WORD);
    await recallFetchAs(role, ALICE, ALICE_JOB);
    expect(stamps.length, 'the tool must have reached chat_tasks/jarvis_tasks').toBeGreaterThan(2);
    for (const stamp of stamps) expect(stamp).toEqual({ sub: ALICE, op: 'off' });
  });

  it('identity A reads its own conversation by MESSAGE text, through oshal_owns_task', async () => {
    const hits = await conversationQueryAs(role, ALICE, 'lands in October');
    expect(hits.map((h) => h.taskId)).toEqual([ALICE_TASK]);
  });

  it('the list returns metadata only, then fetch returns the selected messages', async () => {
    const summaries = await conversationQueryAs(role, ALICE, 'lands in October');
    expect(summaries[0]).toMatchObject({ source: 'conversation', taskId: ALICE_TASK, title: `Alice ${SHARED_WORD} plan` });
    expect(summaries[0]).not.toHaveProperty('snippet');
    expect(summaries[0]).not.toHaveProperty('messages');
    expect(summaries[0]).toHaveProperty('status');
    const detail = await conversationFetchAs(role, ALICE, ALICE_TASK);
    expect(detail).toMatchObject({ taskId: ALICE_TASK, title: `Alice ${SHARED_WORD} plan` });
    expect(detail?.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'we agreed the budget lands in October' }),
    ]);
  });

  it('a caller cannot fetch another owner task by guessing its id', async () => {
    expect(await recallFetchAs(role, BOB, ALICE_TASK)).toEqual({ conversation: null, task: null });
  });

  it('identity B gets NOTHING of A, on a word that matches both conversations', async () => {
    const hits = await conversationQueryAs(role, BOB, SHARED_WORD);
    expect(hits.map((h) => h.taskId)).toEqual([BOB_TASK]);
    expect(hits.map((h) => h.taskId)).not.toContain(ALICE_TASK);
  });

  it("identity B asking for A's message text gets nothing", async () => {
    expect(await conversationQueryAs(role, BOB, 'lands in October')).toEqual([]);
  });

  it('a read with NO identity established is starved, not fallen open to operator', async () => {
    // OSHAL_DB_GUC_STRICT=deny stamps an identity-less query anonymous non-operator. This is what
    // makes dropping the runWithRequestIdentity wrapper in the handler fail loudly rather than
    // quietly returning every owner's rows.
    const { gucPool } = harnesses.get(role)!;
    expect(await new ChatSearchSource(gucPool).search(ALICE, SHARED_WORD, 10)).toEqual([]);
    expect(await new ChatSearchSource(gucPool).list(ALICE, SHARED_WORD, 10)).toEqual([]);
    expect(await new JarvisTaskRecallSource(gucPool).list(ALICE, SHARED_WORD, 10)).toEqual([]);
  });
});

describe.each(ROLES)('the DATABASE refuses on the exact statements the tools run, as %s', (role) => {
  // The isolating cases. Each adapter also filters on its owner column in SQL, so a two-identity
  // result alone cannot say WHICH layer refused. Here every adapter is handed ALICE as its owner
  // parameter while the connection carries BOB: the application predicate matches Alice's rows and
  // the only thing between them and the caller is row-level security. Each is paired with the
  // same call on Alice's connection, so a policy that denies everyone cannot pass as a refusal.
  it('conversation list: A-can, and B handed A gets []', async () => {
    const source = new ChatSearchSource(harnesses.get(role)!.gucPool);
    const asAlice = await asConnection(ALICE, () => source.list(ALICE, SHARED_WORD, 10));
    expect(asAlice.map((c) => c.taskId), 'the same call must succeed for the right identity').toEqual([ALICE_TASK]);
    expect(await asConnection(BOB, () => source.list(ALICE, SHARED_WORD, 10))).toEqual([]);
  });

  it('conversation fetch: A-can, and B handed A gets no record', async () => {
    const source = new ChatSearchSource(harnesses.get(role)!.gucPool);
    const asAlice = await asConnection(ALICE, () => source.fetch(ALICE, ALICE_TASK));
    expect(asAlice.record?.taskId, 'the same call must succeed for the right identity').toBe(ALICE_TASK);
    expect(await asConnection(BOB, () => source.fetch(ALICE, ALICE_TASK))).toEqual({ record: null });
  });

  it('the message read carries NO owner predicate, and still B gets no row of A', async () => {
    // CONVERSATION_MESSAGES_SQL filters on task_id alone: chat_messages' oshal_owns_task policy is
    // the ONLY wall. Running the shipped text directly is what makes that wall observable.
    const { gucPool } = harnesses.get(role)!;
    const read = () => gucPool.query(CONVERSATION_MESSAGES_SQL, [ALICE_TASK, MAX_CONVERSATION_MESSAGES]);
    const asAlice = await asConnection(ALICE, read);
    expect(asAlice.rows.map((r: { text: string }) => r.text), 'the same statement must succeed for the owner')
      .toEqual(['we agreed the budget lands in October']);
    expect((await asConnection(BOB, read)).rows).toEqual([]);
  });

  it('work-item list: A-can, and B handed A gets []', async () => {
    const source = new JarvisTaskRecallSource(harnesses.get(role)!.gucPool);
    const asAlice = await asConnection(ALICE, () => source.list(ALICE, SHARED_WORD, 10));
    expect(asAlice.map((t) => t.taskId), 'the same call must succeed for the right identity').toEqual([ALICE_JOB]);
    expect(await asConnection(BOB, () => source.list(ALICE, SHARED_WORD, 10))).toEqual([]);
  });

  it('work-item fetch: A-can, and B handed A gets no record', async () => {
    const source = new JarvisTaskRecallSource(harnesses.get(role)!.gucPool);
    const asAlice = await asConnection(ALICE, () => source.fetch(ALICE, ALICE_JOB));
    expect(asAlice.record?.result, 'the same call must succeed for the right identity').toBe(ALICE_RESULT);
    expect(await asConnection(BOB, () => source.fetch(ALICE, ALICE_JOB))).toEqual({ record: null });
  });
});

describe.each(ROLES)('Jarvis work items through the tools, over a real PostgreSQL, as %s', (role) => {
  it('identity A lists its OWN work item by title, metadata only - never the result', async () => {
    const { tasks } = await recallQueryAs(role, ALICE, SHARED_WORD);
    expect(tasks.map((t) => t.taskId)).toEqual([ALICE_JOB]);
    expect(tasks[0]).toMatchObject({ source: 'jarvis-task', title: `Alice ${SHARED_WORD} forecast`, status: 'done', sessionId: ALICE_TASK });
    expect(tasks[0]).not.toHaveProperty('result');
    expect(tasks[0]).not.toHaveProperty('error');
    expect(JSON.stringify(tasks), 'no part of the result may ride along in the list').not.toContain('heavy rain');
  });

  it('identity A finds its work item by RESULT text without the list carrying it', async () => {
    const { tasks } = await recallQueryAs(role, ALICE, 'heavy rain');
    expect(tasks.map((t) => t.taskId)).toEqual([ALICE_JOB]);
    expect(JSON.stringify(tasks)).not.toContain('heavy rain');
  });

  it('fetch returns the selected work item with its result, and only for its owner', async () => {
    const output = await recallFetchAs(role, ALICE, ALICE_JOB);
    expect(output.conversation).toBeNull();
    expect(output.task).toMatchObject({ source: 'jarvis-task', taskId: ALICE_JOB, result: ALICE_RESULT, error: null });
    expect(output).not.toHaveProperty('withheld');
    expect(await recallFetchAs(role, ALICE, ALICE_JOB, 'jarvis-task')).toMatchObject({ task: { taskId: ALICE_JOB } });
    expect(await recallFetchAs(role, ALICE, ALICE_JOB, 'conversation'), 'source narrows to one family')
      .toEqual({ conversation: null, task: null });
  });

  it('identity B gets NOTHING of A, on a word that matches both work items', async () => {
    const { tasks } = await recallQueryAs(role, BOB, SHARED_WORD);
    expect(tasks.map((t) => t.taskId)).toEqual([BOB_JOB]);
  });

  it("identity B asking for A's result text gets nothing", async () => {
    expect((await recallQueryAs(role, BOB, 'heavy rain')).tasks).toEqual([]);
  });

  it("identity B cannot fetch A's work item by guessing its id", async () => {
    expect(await recallFetchAs(role, BOB, ALICE_JOB)).toEqual({ conversation: null, task: null });
  });
});

describe.each(ROLES)('the protected-result boundary on recall, as %s', (role) => {
  it("control: the protected records are the caller's own and visible to her under row-level security", async () => {
    // Without this, the cases below could pass because RLS hid the rows, not because the boundary
    // refused them.
    const { gucPool } = harnesses.get(role)!;
    const hits = await asConnection(ALICE, () => new ChatSearchSource(gucPool).search(ALICE, PROTECTED_WORD, 10));
    expect(hits.map((h) => h.id)).toEqual([ALICE_PROTECTED_TASK]);
    const job = await asConnection(ALICE, () => gucPool.query('SELECT id FROM jarvis_tasks WHERE id = $1', [ALICE_PROTECTED_JOB]));
    expect(job.rows).toEqual([{ id: ALICE_PROTECTED_JOB }]);
  });

  it('the list leaves out a protected conversation and a work item filed from it', async () => {
    expect(await recallQueryAs(role, ALICE, PROTECTED_WORD)).toEqual({ conversations: [], tasks: [] });
  });

  it("fetch withholds the caller's own protected conversation and never returns its messages", async () => {
    expect(await recallFetchAs(role, ALICE, ALICE_PROTECTED_TASK))
      .toEqual({ conversation: null, task: null, withheld: 'protected_result' });
  });

  it("fetch withholds the caller's own work item whose conversation carries protected lineage", async () => {
    expect(await recallFetchAs(role, ALICE, ALICE_PROTECTED_JOB))
      .toEqual({ conversation: null, task: null, withheld: 'protected_result' });
  });

  it('another owner fetching the protected ids gets plain nulls - no withheld marker to learn from', async () => {
    expect(await recallFetchAs(role, BOB, ALICE_PROTECTED_TASK)).toEqual({ conversation: null, task: null });
    expect(await recallFetchAs(role, BOB, ALICE_PROTECTED_JOB)).toEqual({ conversation: null, task: null });
  });
});

describe('oshal_bot reaches the recall reads through the governed contract and nothing wider', () => {
  it('its effective privileges are exactly the allowlist: every listed column readable, every other refused', async () => {
    for (const table of RECALL_TABLES) {
      const { rows: wide } = await fixtureAdmin.query(
        'SELECT has_table_privilege($1, $2, $3) AS granted', [BOT_ROLE, `public.${table}`, 'SELECT'],
      );
      expect(wide[0].granted, `${table}: a table-wide SELECT is wider than the contract`).toBe(false);
      const allowed = BOT_COLUMN_PRIVILEGES.get(table)?.SELECT ?? new Set<string>();
      const { rows: columns } = await fixtureAdmin.query<{ attname: string; granted: boolean }>(
        `SELECT a.attname, has_column_privilege($1, c.oid, a.attnum, 'SELECT') AS granted
           FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.oid = $2::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [BOT_ROLE, `public.${table}`],
      );
      expect(columns.length, `${table} has no columns on the fixture`).toBeGreaterThan(allowed.size);
      for (const column of columns) {
        expect(column.granted, `${table}.${column.attname}`).toBe(allowed.has(column.attname));
      }
    }
  });

  it.each(UNGRANTED_SENTINELS)('a column outside the list (%s.%s) is refused 42501 when read directly', async (table, column) => {
    const client = await database.rolePool(BOT_ROLE).connect();
    try {
      await expect(client.query(`SELECT ${column} FROM ${table} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });

  it("the tools read their owner's records and still starve the other owner under exactly those grants", async () => {
    expect((await conversationQueryAs(BOT_ROLE, ALICE, 'lands in October')).map((h) => h.taskId)).toEqual([ALICE_TASK]);
    expect(await conversationQueryAs(BOT_ROLE, BOB, 'lands in October')).toEqual([]);
    expect((await recallFetchAs(BOT_ROLE, ALICE, ALICE_JOB)).task).toMatchObject({ result: ALICE_RESULT });
    expect((await recallQueryAs(BOT_ROLE, BOB, 'heavy rain')).tasks).toEqual([]);
  });
});
