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
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { ChatSearchSource } from '@/features/global-search';
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
/** A word that appears in BOTH owners' conversations, so a leak would be visible as a hit. */
const SHARED_WORD = 'quarterly';
/**
 * Columns the tool never reads and the contract must not grant. total_cost is NOT a usable
 * sentinel: the pre-existing contract already grants it to oshal_bot for the cost rollup.
 */
const UNGRANTED_SENTINELS: ReadonlyArray<[table: string, column: string]> = [
  ['chat_tasks', 'turn_count'],
  ['chat_messages', 'content_blocks'],
];
const OWNS_TASK = 'oshal_owns_task(text)';

const database = new DisposablePostgres({
  purpose: 'bot-node-read-only-owner-scope',
  database: 'read_only_tools_fixture',
  memory: '320m',
  max: 4,
  connectionTimeoutMillis: 10_000,
  statementTimeoutMs: 60_000,
  roles: [{ name: OWNER_ROLE, max: 4 }, { name: BOT_ROLE, max: 4 }],
  // The real chat tables, so the column lists derived from the contract name real columns.
  migrations: ['005-conversation-history-and-usage.sql', '055-chat-tasks-owner-sub.sql'],
});

/**
 * The policies as the live database carries them over the shipped chat tables: the
 * owner-or-operator policy on the task row, and migration 094's derived-owner policy on messages
 * through oshal_owns_task, which is SECURITY DEFINER in production too - it must see past RLS to
 * answer at all. Nothing is granted to the bot role here; its grants are derived from the
 * governed contract below, and EXECUTE on the helper is revoked from PUBLIC exactly as the
 * governance SQL does so the derived grant is the only way the bot reaches it.
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
  for (const table of ['chat_tasks', 'chat_messages']) {
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

let fixtureAdmin: Pool;
const harnesses = new Map<Role, Harness>();
const savedStrict = process.env.OSHAL_DB_GUC_STRICT;
const savedGuc = process.env.OSHAL_DB_GUC;

/**
 * Wrap the role pool so that, on the SAME client the GUC wrapper just stamped, the moment the
 * adapter's chat_tasks SELECT arrives we first read back the GUC values the policy is about to
 * read. This observes the connection, not the adapter's result - the only way to tell an
 * operator stamp from a caller stamp when the adapter predicate scopes the rows either way.
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
            if (typeof text === 'string' && text.includes('FROM chat_tasks')) {
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

/** Run conversation_query exactly as a dispatch does: capture, authorize, execute the snapshot. */
async function conversationQueryAs(role: Role, sub: string, query: string): Promise<Array<Record<string, unknown>>> {
  const { registry } = harnesses.get(role)!;
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

/** Run the exact-id conversation fetch through the same capture/authorize/execute path. */
async function conversationFetchAs(role: Role, sub: string, taskId: string): Promise<Record<string, unknown> | null> {
  const { registry } = harnesses.get(role)!;
  const caps = captureDispatchCapabilities(
    registry,
    normalizeAllowedTools([BOT_NODE_CONVERSATION_FETCH_TOOL]),
    normalizeAuthorizedScopes([anyBotRuntimeToolScope(BOT_NODE_CONVERSATION_FETCH_TOOL)]),
  );
  const decision = authorizeCapability(caps, BOT_NODE_CONVERSATION_FETCH_TOOL);
  expect(decision.allowed, decision.error).toBe(true);
  const output = await registry.executeSnapshot(decision.snapshot, { taskId }, {
    extraEnv: { OSHAL_USER_SUB: sub },
  });
  return (output as { conversation: Record<string, unknown> | null }).conversation;
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
  await fixtureAdmin.query(
    `INSERT INTO chat_tasks (task_id, title, owner_sub) VALUES ($1,$2,$3), ($4,$5,$6)`,
    [ALICE_TASK, `Alice ${SHARED_WORD} plan`, ALICE, BOB_TASK, `Bob ${SHARED_WORD} notes`, BOB],
  );
  await fixtureAdmin.query(
    `INSERT INTO chat_messages (message_id, task_id, role, type, text)
     VALUES (gen_random_uuid(), $1, 'user', 'say', $2), (gen_random_uuid(), $3, 'user', 'say', $4)`,
    [ALICE_TASK, 'we agreed the budget lands in October', BOB_TASK, 'we agreed the budget lands in November'],
  );
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

  it("the tool's SELECT ran on a connection stamped with the CALLER, not the operator", async () => {
    // The adapter predicate would scope the rows even if the handler stamped the operator, so a
    // result assertion cannot see that mutation. This reads what PostgreSQL itself saw on the
    // connection at the moment the tool's own SELECT arrived.
    const { stamps } = harnesses.get(role)!;
    stamps.length = 0;
    await conversationQueryAs(role, ALICE, SHARED_WORD);
    expect(stamps.length, 'the tool must have reached chat_tasks at least once').toBeGreaterThan(0);
    for (const stamp of stamps) expect(stamp).toEqual({ sub: ALICE, op: 'off' });
  });

  it('identity A reads its own conversation by MESSAGE text, through oshal_owns_task', async () => {
    const hits = await conversationQueryAs(role, ALICE, 'lands in October');
    expect(hits.map((h) => h.taskId)).toEqual([ALICE_TASK]);
  });

  it('the list returns metadata only, then fetch returns the selected messages', async () => {
    const summaries = await conversationQueryAs(role, ALICE, 'lands in October');
    expect(summaries[0]).toMatchObject({ taskId: ALICE_TASK, title: `Alice ${SHARED_WORD} plan` });
    expect(summaries[0]).not.toHaveProperty('snippet');
    expect(summaries[0]).toHaveProperty('status');
    const detail = await conversationFetchAs(role, ALICE, ALICE_TASK);
    expect(detail).toMatchObject({ taskId: ALICE_TASK, title: `Alice ${SHARED_WORD} plan` });
    expect(detail?.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'we agreed the budget lands in October' }),
    ]);
  });

  it('a caller cannot fetch another owner task by guessing its id', async () => {
    expect(await conversationFetchAs(role, BOB, ALICE_TASK)).toBeNull();
  });

  it('identity B gets NOTHING of A, on a word that matches both conversations', async () => {
    const hits = await conversationQueryAs(role, BOB, SHARED_WORD);
    expect(hits.map((h) => h.taskId)).toEqual([BOB_TASK]);
    expect(hits.map((h) => h.taskId)).not.toContain(ALICE_TASK);
  });

  it("identity B asking for A's message text gets nothing", async () => {
    expect(await conversationQueryAs(role, BOB, 'lands in October')).toEqual([]);
  });

  it('the DATABASE is what refuses, not the adapter predicate', async () => {
    // The isolating case. ChatSearchSource also filters `owner_sub = $1` in SQL, so a two-identity
    // result alone cannot say WHICH layer refused. Here the adapter is handed ALICE as its owner
    // parameter while the connection carries BOB: the application predicate matches Alice's row
    // and the only thing standing between it and the caller is row-level security.
    const { gucPool } = harnesses.get(role)!;
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
    const { gucPool } = harnesses.get(role)!;
    const source = new ChatSearchSource(gucPool);
    expect(await source.search(ALICE, SHARED_WORD, 10)).toEqual([]);
  });
});

describe('oshal_bot reaches the conversation read through the governed contract and nothing wider', () => {
  it('its effective privileges are exactly the allowlist: every listed column readable, every other refused', async () => {
    for (const table of ['chat_tasks', 'chat_messages']) {
      const { rows: wide } = await fixtureAdmin.query(
        'SELECT has_table_privilege($1, $2, $3) AS granted', [BOT_ROLE, `public.${table}`, 'SELECT'],
      );
      expect(wide[0].granted, `${table}: a table-wide SELECT is wider than the contract`).toBe(false);
      const allowed = BOT_COLUMN_PRIVILEGES.get(table)!.SELECT;
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

  it("the tool reads its owner's conversation and still starves the other owner under exactly those grants", async () => {
    expect((await conversationQueryAs(BOT_ROLE, ALICE, 'lands in October')).map((h) => h.taskId)).toEqual([ALICE_TASK]);
    expect(await conversationQueryAs(BOT_ROLE, BOB, 'lands in October')).toEqual([]);
  });
});
