/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The bot grant contract, proved by RUNNING the statements. Three gaps were open on the box at once and every one of them was caught and swallowed: the ticket_task_links upsert answered permission denied inside a warn-level catch, the ticket_agent_assignments upsert would have done the same the moment a bot reached it, and durable swarm-memory recall failed closed to "no memory" behind one warning. No existing guard could see any of them, because every guard over this contract reads the allowlist and compares it to itself - and a column allowlist that is missing a column is perfectly self-consistent. This one provisions a real oshal_bot on a private server from the SHIPPED grant text, then issues each statement the bot runtime actually issues and requires it to succeed; a statement needing a privilege the allowlist does not carry raises 42501 and the case is red. The allowlist's two halves (the SQL that grants and the map that verifies) are compared to each other here as well, so updating one and not the other is also red.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The reader helper had to be able to say WITHHELD. Returning only the permitted rows made a row the database refused this reader look exactly like a work item with no ledger row - and the recall path lets a missing row through, so the memory came back judged only by the metadata copied into the vector index at index time. Two cases cover it: the helper answers for every id that exists and marks each answer readable or withheld while disclosing nothing but the identifier of a withheld one, and the real recall path over the real oshal_bot pool DENIES a withheld row, still returns an absent-row memory untrusted, and reaches the same verdict as the controller's untouched table reach on the same three work items.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | The contract gained its first OPTIONAL table: rag_chunks exists only where the vector extension does, and this fixture is postgres:16-alpine, which has none. A grant on an absent table would fail the whole suite at setup, so grants are now applied only where their table exists on the fixture, and the set skipped must be EXACTLY the exported OPTIONAL_BOT_CONTRACT_TABLES - a typo'd table name cannot be skipped silently. Also drives the bot-node conversation read (chat-search-source.ts) as oshal_bot, so the contract change that admits it is measured here the way every other bot statement is.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { SwarmMemoryService } from '../../src/features/agent-management';
import type { RagSearchResult, RagService } from '../../src/features/rag';
import {
  BOT_COLUMN_PRIVILEGES,
  BOT_TABLE_PRIVILEGES,
  OPTIONAL_BOT_CONTRACT_TABLES,
} from '../../scripts/governance/provision-app-role.mjs';

const root = process.cwd();
const roleSql = fs.readFileSync(path.resolve(root, 'docs/governance/app-role-provisioning.sql'), 'utf8');

/** Only the final phase grants; the pre-migration phase is stripped by the provisioner wrapper. */
const finalPhase = roleSql.slice(
  roleSql.indexOf('-- OSHAL_FINAL_PHASE_BEGIN'),
  roleSql.indexOf('-- OSHAL_FINAL_PHASE_END'),
);

/** Every `GRANT <verb> [(cols)] ON TABLE public.<t> TO oshal_bot;` in the shipped role SQL. */
const TABLE_GRANT = /GRANT\s+(SELECT|INSERT|UPDATE)\s*(?:\(([^)]*)\))?\s*ON TABLE public\.(\w+) TO oshal_bot;/g;
/** The two non-table grants the bot contract carries. */
const OTHER_BOT_GRANTS = /GRANT (?:USAGE ON SEQUENCE|EXECUTE ON FUNCTION) [^;]*? TO (?:oshal_app, )?oshal_bot;/g;

interface ParsedGrant { verb: string; columns: string[] | null; table: string; statement: string }

/** @description Reads the shipped bot grants out of the role SQL so the fixture is provisioned
 * with the deployment's own text rather than a copy of it.
 * @returns One entry per GRANT statement naming oshal_bot, in file order.
 */
function parseTableGrants(): ParsedGrant[] {
  const grants: ParsedGrant[] = [];
  for (const match of finalPhase.matchAll(TABLE_GRANT)) {
    grants.push({
      verb: match[1],
      columns: match[2] ? match[2].split(',').map((c) => c.trim()).filter(Boolean) : null,
      table: match[3],
      statement: match[0],
    });
  }
  return grants;
}

const tableGrants = parseTableGrants();
const otherGrants = [...finalPhase.matchAll(OTHER_BOT_GRANTS)].map((m) => m[0]);
/**
 * Helpers the SQL grants to oshal_bot whose defining migration (094-derived-owner-rls.sql) also
 * walls tables this fixture does not carry, so it is not in the migration list above. The grant
 * is skipped here and exercised over the real helper by
 * tests/unit/bot-node-read-only-tools-owner-scope-postgres.spec.ts.
 */
const HELPERS_OUTSIDE_THIS_FIXTURE = new Set(['public.oshal_owns_task(text)']);

const fixture = new DisposablePostgres({
  purpose: 'bot-statement-privileges',
  memory: '512m',
  // oshal_app exists only because the shipped EXECUTE grants name both roles in one
  // statement; the subject of this guard is oshal_bot.
  roles: ['oshal_bot', 'oshal_app'],
  migrations: [
    '001-multi-agent-foundation.sql',
    '002-layer1-tools-framework.sql',
    '005-conversation-history-and-usage.sql',
    '007-work-items.sql',
    '008-seed-swarm-agents.sql',
    '009-persona-layers.sql',
    '022-swarm-applications.sql',
    '055-chat-tasks-owner-sub.sql',
    '078-cost-governance.sql',
    '090-cost-event-tokens-duration.sql',
    '100-ticket-family-base-schema.sql',
    '113-derived-owner-rls-ticket-family.sql',
    '117-swarm-memory-provenance.sql',
    '127-application-authorization.sql',
    '142-application-execution-claims-helper.sql',
    '152-swarm-memory-reader-helper.sql',
    '158-narrow-application-execution-claims-helper.sql',
  ],
});

const AGENT = 'a0000000-0000-0000-0000-000000000001';
const OWNER = 'auth0|bot-contract-owner';
const OTHER_OWNER = 'auth0|bot-contract-stranger';
const SHA = 'b'.repeat(64);
const TASK = 'bot-contract-task';
const WORKLOAD_SHARED = 'wi-shared';
const WORKLOAD_MINE = 'wi-mine';
const WORKLOAD_THEIRS = 'wi-theirs';
/** Deliberately never inserted: a retrieved memory whose ledger row does not exist at all. */
const WORKLOAD_ABSENT = 'wi-absent';

/** One answer from oshal_swarm_memory_readable: the mapped columns plus the readable marker. */
interface HelperRow {
  work_item_id: string;
  readable: boolean;
  [column: string]: unknown;
}

let owner: Pool;
let bot: Pool;
let ticketId: string;
let workItemId: string;

/**
 * @description Runs one statement as oshal_bot under the identity stamp every bot database path
 * takes (the system sentinel, which is operator-stamped), inside one transaction so the
 * transaction-local settings apply to the statement itself.
 * @param sql - The statement, verbatim from the runtime.
 * @param params - Bound parameters.
 * @returns The refusal, or null when the statement completed.
 */
async function asBot(sql: string, params: unknown[] = []): Promise<Error & { code?: string } | null> {
  const client: PoolClient = await bot.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('oshal.is_operator', 'on', true)");
    await client.query("SELECT set_config('oshal.current_sub', $1, true)", [OWNER]);
    await client.query(sql, params);
    await client.query('COMMIT');
    return null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return error as Error & { code?: string };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  owner = await fixture.start();
  // The fixture hands every declared role CREATE on schema public so a migration can grant to it.
  // The deployment does the opposite (app-role-provisioning.sql REVOKEs it), and a bot that could
  // create a table could create one outside the allowlist entirely.
  await owner.query('REVOKE CREATE ON SCHEMA public FROM oshal_bot');
  await owner.query('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM oshal_bot');
  await owner.query('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM oshal_bot');
  await owner.query('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, oshal_bot');
  // A contract table this image cannot host (rag_chunks needs the vector extension) is skipped,
  // and only that: the skipped set must be exactly the exported optional set, so a misspelled
  // table in the SQL fails here rather than vanishing from the fixture unnoticed.
  const skipped = new Set<string>();
  for (const grant of tableGrants) {
    const exists = (await owner.query('SELECT to_regclass($1) AS oid', [`public.${grant.table}`])).rows[0].oid;
    if (exists) await owner.query(grant.statement);
    else skipped.add(grant.table);
  }
  expect([...skipped].sort()).toEqual([...OPTIONAL_BOT_CONTRACT_TABLES.keys()].sort());
  // Same discipline for helpers: a function grant whose helper this fixture does not carry is
  // skipped only if it is named in HELPERS_OUTSIDE_THIS_FIXTURE, never silently.
  for (const grant of otherGrants) {
    const helper = /ON FUNCTION (public\.\w+\([^)]*\))/.exec(grant)?.[1];
    if (helper) {
      const exists = (await owner.query('SELECT to_regprocedure($1) AS oid', [helper])).rows[0].oid;
      if (!exists) {
        expect(HELPERS_OUTSIDE_THIS_FIXTURE.has(helper), `${helper} is granted in the SQL but absent on this fixture`).toBe(true);
        continue;
      }
    }
    await owner.query(grant);
  }
  bot = fixture.rolePool('oshal_bot');

  ticketId = (await owner.query<{ ticket_id: string }>(
    `INSERT INTO tickets (ticket_id, title, description, ticket_type, status, owner_sub)
     VALUES (gen_random_uuid(), 'bot contract', 'seed', 'chat', 'backlog', $1) RETURNING ticket_id`,
    [OWNER],
  )).rows[0].ticket_id;
  workItemId = (await owner.query<{ work_item_id: string }>(
    `INSERT INTO work_items (work_item_id, swarm_run_id, external_id, provider, unit_id, title, status)
     VALUES (gen_random_uuid(), 'run', 'ext', 'oshal', 'unit', 'seed', 'pending')
     RETURNING work_item_id`,
  )).rows[0].work_item_id;
  await owner.query(
    `INSERT INTO chat_tasks (task_id, status, owner_sub) VALUES ($1, 'processing', $2)`,
    [TASK, OWNER],
  );
  await owner.query(
    `INSERT INTO ticket_task_links (task_id, ticket_id, role) VALUES ($1, $2, 'primary')`,
    [TASK, ticketId],
  );
  await owner.query(
    `INSERT INTO ticket_agent_assignments (ticket_id, agent_id, role, phase) VALUES ($1, $2, 'executor', 'build')`,
    [ticketId, AGENT],
  );

  const ledger = await owner.connect();
  try {
    await ledger.query('BEGIN');
    await ledger.query("SELECT set_config('oshal.swarm_memory_ledger_broker', 'on', true)");
    for (const [id, ownerSub] of [[WORKLOAD_MINE, OWNER], [WORKLOAD_THEIRS, OTHER_OWNER]] as const) {
      await ledger.query(
        `INSERT INTO oshal_swarm_memory
           (work_item_id, title, document, content_sha256, owner_sub, visibility, trust_level, source, created_by_workload)
         VALUES ($1, $1, 'doc', $2, $3, 'private', 'untrusted', 'test', 'workload')`,
        [id, SHA, ownerSub],
      );
    }
    await ledger.query(
      `INSERT INTO oshal_swarm_memory
         (work_item_id, title, document, content_sha256, owner_sub, visibility, trust_level, source,
          created_by_workload, approved_by_sub, approval_content_sha256)
       VALUES ($1, $1, 'doc', $2, NULL, 'shared', 'approved', 'test', 'workload', 'auth0|operator', $2)`,
      [WORKLOAD_SHARED, SHA],
    );
    await ledger.query('COMMIT');
  } finally {
    ledger.release();
  }
}, 300_000);

afterAll(async () => { await fixture.stop(); }, 120_000);

describe('the bot grant allowlist has exactly one definition', () => {
  it('the SQL that grants and the map that verifies name the same columns', () => {
    const fromSql = new Map<string, Record<string, string[]>>();
    const tableWide = new Map<string, Set<string>>();
    for (const grant of tableGrants) {
      if (!grant.columns) {
        if (!tableWide.has(grant.table)) tableWide.set(grant.table, new Set());
        tableWide.get(grant.table)!.add(grant.verb);
        continue;
      }
      if (!fromSql.has(grant.table)) fromSql.set(grant.table, {});
      fromSql.get(grant.table)![grant.verb] = [...grant.columns].sort();
    }
    const normalize = (source: Map<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [table, privileges] of source) {
        out[table] = privileges instanceof Set
          ? [...privileges].sort()
          : Object.fromEntries(Object.entries(privileges as Record<string, Set<string> | string[]>)
            .map(([verb, columns]) => [verb, [...columns].sort()])
            .sort(([a], [b]) => a.localeCompare(b)));
      }
      return out;
    };
    expect(
      normalize(fromSql as Map<string, unknown>),
      'docs/governance/app-role-provisioning.sql and BOT_COLUMN_PRIVILEGES disagree — the api '
        + 'grants from the SQL and verifies against the map on every boot, so a change to one and '
        + 'not the other either fails provisioning or silently grants something unverified',
    ).toEqual(normalize(BOT_COLUMN_PRIVILEGES as Map<string, unknown>));
    expect(normalize(tableWide as Map<string, unknown>))
      .toEqual(normalize(BOT_TABLE_PRIVILEGES as Map<string, unknown>));
  });

  it('provisions the bot with column privileges, never whole tables it can only read in part', async () => {
    const { rows } = await bot.query<{ current_user: string }>('SELECT current_user');
    expect(rows[0].current_user).toBe('oshal_bot');
    const create = await asBot('CREATE TABLE bot_should_not_create (id int)');
    expect(create?.code, 'oshal_bot must not hold CREATE on schema public').toBe('42501');
    const owns = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public' AND r.rolname = 'oshal_bot'`,
    );
    expect(owns.rows[0].count, 'oshal_bot must own nothing — an owner is exempt from non-FORCE RLS').toBe('0');
  });
});

/**
 * Every statement a bot container issues against PostgreSQL, traced from the two bot entrypoints
 * through the one place bot repositories are constructed (src/app/bot-node-runtime.ts). Each is the
 * statement text from its call site; the guard's job is that the shipped allowlist can run it.
 */
const BOT_STATEMENTS: Array<{ name: string; site: string; sql: string; params: () => unknown[] }> = [
  {
    name: 'agents — profile read',
    site: 'src/entities/agent/repositories/agent-profile-repository.ts',
    sql: `SELECT agent_id, name, status, api_provider_id, model_id, persona, metadata,
            base_capabilities, base_selector_descriptor, base_routing_keywords, updated_at
          FROM agents WHERE agent_id = $1`,
    params: () => [AGENT],
  },
  {
    name: 'tickets — terminal check',
    site: 'src/app/bot-node-server.ts',
    sql: 'SELECT status FROM tickets WHERE ticket_id = $1 LIMIT 1',
    params: () => [ticketId],
  },
  {
    name: 'work_items — read children',
    site: 'src/entities/work-item/repositories/work-item-repository.ts',
    sql: 'SELECT * FROM work_items WHERE parent_id=$1 ORDER BY created_at',
    params: () => [null],
  },
  {
    name: 'work_items — status and assignment',
    site: 'src/entities/work-item/repositories/work-item-repository.ts',
    sql: `UPDATE work_items
          SET status=$1,
              assigned_agent_id=COALESCE(NULLIF($2, ''), assigned_agent_id),
              updated_at=NOW()
          WHERE work_item_id=$3`,
    params: () => ['executing', AGENT, workItemId],
  },
  {
    name: 'work_items — execution output',
    site: 'src/entities/work-item/repositories/work-item-repository.ts',
    sql: 'UPDATE work_items SET execution_output=$1, updated_at=NOW() WHERE work_item_id=$2',
    params: () => [JSON.stringify({ ok: true }), workItemId],
  },
  {
    name: 'tickets — status transition',
    site: 'src/features/ticketing/services/ticket-store-postgres.ts',
    sql: `UPDATE tickets
          SET status = $1, state_group = $2, execution_phase = $3, updated_at = $4,
              metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb
          WHERE ticket_id = $5`,
    params: () => ['in_process_build', 'in_process', 'build', new Date().toISOString(), ticketId, '{}'],
  },
  {
    name: 'chat_tasks — close tasks linked to a terminal ticket',
    site: 'src/features/ticketing/services/ticket-store-postgres.ts',
    sql: `UPDATE chat_tasks AS ct
          SET status = $1, updated_at = $2::timestamptz,
              metadata = COALESCE(ct.metadata, '{}'::jsonb) || jsonb_build_object(
                'ticketTerminalSyncAt', ($2::timestamptz)::text,
                'ticketTerminalSyncReason', 'linked_ticket_terminal',
                'ticketTerminalStatus', $3::text,
                'ticketTerminalId', $4::text)
          FROM ticket_task_links ttl
          WHERE ttl.task_id = ct.task_id AND ttl.ticket_id = $4
            AND ct.status IN ('created', 'active', 'processing')`,
    params: () => ['completed', new Date().toISOString(), 'complete', ticketId],
  },
  {
    name: 'ticket_status_history — append',
    site: 'src/features/ticketing/services/ticket-store-postgres.ts',
    sql: `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, changed_by_label, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)`,
    params: () => [ticketId, 'backlog', 'in-progress', AGENT, 'System', '{}'],
  },
  {
    name: 'ticket_agent_assignments — upsert',
    site: 'src/features/ticketing/services/ticket-store-postgres.ts',
    sql: `INSERT INTO ticket_agent_assignments (ticket_id, agent_id, role, phase) VALUES ($1,$2,$3,$4)
          ON CONFLICT (ticket_id, agent_id, role) DO UPDATE SET phase = COALESCE(EXCLUDED.phase, ticket_agent_assignments.phase)`,
    params: () => [ticketId, AGENT, 'executor', 'review'],
  },
  {
    name: 'ticket_task_links — upsert (the spend-to-ticket join)',
    site: 'src/features/ticketing/services/ticket-store-postgres.ts',
    sql: `INSERT INTO ticket_task_links (task_id, ticket_id, role) VALUES ($1, $2, $3)
          ON CONFLICT (task_id, ticket_id) DO UPDATE SET role = EXCLUDED.role`,
    params: () => [TASK, ticketId, 'swarm-execution'],
  },
  {
    name: 'oshal_application_execution_claims — the ADR-149 posture answer',
    site: 'src/app/application-execution-ownership.ts',
    sql: 'SELECT app, protected FROM oshal_application_execution_claims($1, $2, $3)',
    params: () => ['bots', AGENT, true],
  },
  {
    name: 'persona_layers — global layers',
    site: 'src/features/agent-management/services/persona-layer-store.ts',
    sql: `SELECT layer_type, scope, priority, prompt_fragment, metadata
          FROM persona_layers WHERE scope = 'global' AND enabled = true ORDER BY priority ASC`,
    params: () => [],
  },
  {
    name: 'chat_tasks + chat_messages — the bot-node conversation read',
    site: 'src/features/global-search/services/chat-search-source.ts',
    sql: `SELECT t.task_id, t.title, t.title AS body, TRUE AS matched_title, t.updated_at AS ts
            FROM chat_tasks t
           WHERE t.owner_sub = $1 AND t.title ILIKE $2 ESCAPE '\'
           UNION ALL
          SELECT t.task_id, t.title, m.text AS body, FALSE AS matched_title, m.created_at AS ts
            FROM chat_messages m
            JOIN chat_tasks t ON t.task_id = m.task_id AND t.owner_sub = $1
           WHERE m.text ILIKE $2 ESCAPE '\'
           ORDER BY ts DESC
           LIMIT $3`,
    params: () => [OWNER, '%contract%', 10],
  },
  {
    name: 'chat_tasks + chat_messages — metadata-only conversation list',
    site: 'src/features/global-search/services/chat-search-source.ts',
    sql: `SELECT t.task_id, t.title, t.status, t.processing_mode,
                 t.metadata->>'kind' AS metadata_kind, t.created_at, t.updated_at
            FROM chat_tasks t
           WHERE t.owner_sub = $1
             AND (t.title ILIKE $2 ESCAPE '\\'
                  OR EXISTS (
                    SELECT 1 FROM chat_messages m
                     WHERE m.task_id = t.task_id AND m.text ILIKE $2 ESCAPE '\\'
                  ))
           ORDER BY t.updated_at DESC
           LIMIT $3`,
    params: () => [OWNER, '%contract%', 10],
  },
  {
    name: 'chat_tasks — exact conversation fetch',
    site: 'src/features/global-search/services/chat-search-source.ts',
    sql: `SELECT task_id, title, status, processing_mode, metadata->>'kind' AS metadata_kind,
                 created_at, updated_at
            FROM chat_tasks
           WHERE task_id = $1 AND owner_sub = $2
           LIMIT 1`,
    params: () => [TASK, OWNER],
  },
  {
    name: 'chat_messages — exact conversation message fetch',
    site: 'src/features/global-search/services/chat-search-source.ts',
    sql: `SELECT role, text, created_at
            FROM chat_messages
           WHERE task_id = $1
           ORDER BY created_at ASC
           LIMIT $2`,
    params: () => [TASK, 100],
  },
  {
    name: 'chat_tasks — read the cost rollup',
    site: 'src/features/operational-intelligence/services/cost-tracking-service.ts',
    sql: `SELECT agent_id, provider_id, total_input_tokens, total_output_tokens,
            total_input_cost, total_output_cost, total_cost, total_requests,
            cost_currency, usage_by_model, owner_sub
          FROM chat_tasks WHERE task_id = $1 LIMIT 1`,
    params: () => [TASK],
  },
  {
    name: 'chat_tasks — open the cost rollup',
    site: 'src/features/operational-intelligence/services/cost-tracking-service.ts',
    sql: `INSERT INTO chat_tasks (
            task_id, title, status, processing_mode, agent_id, provider_id,
            message_count, turn_count, total_input_tokens, total_output_tokens,
            total_input_cost, total_output_cost, total_cost, total_requests,
            cost_currency, usage_by_model, metadata, owner_sub, created_at, updated_at
          ) VALUES (
            $1, $2, 'processing', 'agentic', $3, $4, 0, 0, $5, $6,
            $7, $8, $9, $10, $11, $12::jsonb, '{}'::jsonb, $13, NOW(), NOW()
          )`,
    params: () => [`${TASK}-new`, 'title', AGENT, 'openai', 1, 1, 0.1, 0.1, 0.2, 1, 'USD', '{}', OWNER],
  },
  {
    name: 'chat_tasks — accumulate the cost rollup',
    site: 'src/features/operational-intelligence/services/cost-tracking-service.ts',
    sql: `UPDATE chat_tasks SET agent_id = $2, provider_id = $3,
            total_input_tokens = $4, total_output_tokens = $5,
            total_input_cost = $6, total_output_cost = $7, total_cost = $8,
            total_requests = $9, cost_currency = $10, usage_by_model = $11::jsonb,
            owner_sub = COALESCE(owner_sub, $12), updated_at = NOW()
          WHERE task_id = $1`,
    params: () => [TASK, AGENT, 'openai', 2, 2, 0.2, 0.2, 0.4, 2, 'USD', '{}', OWNER],
  },
  {
    name: 'oshal_cost_events — append one event',
    site: 'src/features/operational-intelligence/services/cost-tracking-service.ts',
    sql: `INSERT INTO oshal_cost_events
            (task_id, owner_sub, agent_id, provider_id, model_id, cost_usd, input_tokens, output_tokens, duration_ms)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    params: () => [TASK, OWNER, AGENT, 'openai', 'gpt-5.5', 0.2, 10, 20, 1500],
  },
  {
    name: 'oshal_swarm_memory_readable — durable recall',
    site: 'src/features/agent-management/services/swarm-memory-service.ts',
    sql: 'SELECT * FROM oshal_swarm_memory_readable($1::text[], $2)',
    params: () => [[WORKLOAD_MINE, WORKLOAD_SHARED], OWNER],
  },
];

describe('every statement the bot runtime issues runs under the shipped allowlist', () => {
  for (const statement of BOT_STATEMENTS) {
    it(`${statement.name} is not refused`, async () => {
      const refusal = await asBot(statement.sql, statement.params());
      expect(
        refusal && `${refusal.code} ${refusal.message}`,
        `${statement.name} (${statement.site}) needs a privilege the allowlist does not carry. `
          + 'Add the exact columns this statement names to BOT_COLUMN_PRIVILEGES in '
          + 'scripts/governance/provision-app-role.mjs AND to docs/governance/app-role-provisioning.sql '
          + '— a hand-typed GRANT is revoked at the next api boot.',
      ).toBeNull();
    }, 30_000);
  }

  it('the agent_tools join reads only columns the allowlist carries', async () => {
    // The join reads from both tables, so its refusal would not name which side is short. The
    // column list is the repository's, verbatim, because the contract has to cover what the
    // statement actually selects and not a convenient subset of it.
    const refusal = await asBot(
      `SELECT
         at.agent_id, at.tool_id, at.auth_mode, at.installed, at.install_verified, at.tool_config,
         at.created_at AS agent_tool_created_at, at.updated_at AS agent_tool_updated_at,
         t.name, t.type, t.display_name, t.description, t.category, t.install_spec, t.version,
         t.skills, t.selector_fragment, t.routing_tags, t.input_schema, t.output_schema,
         t.usage_instructions, t.examples, t.auth_group, t.default_auth_mode, t.requires_approval,
         t.timeout_ms, t.tags, t.enabled, t.registered_by, t.registered_at,
         t.created_at AS tool_created_at, t.updated_at AS tool_updated_at
       FROM agent_tools at
       INNER JOIN tools t ON at.tool_id = t.tool_id
       WHERE at.agent_id = $1
       ORDER BY t.name ASC`,
      [AGENT],
    );
    expect(
      refusal && `${refusal.code} ${refusal.message}`,
      'src/entities/tool/repositories/agent-tool-repository.ts selects a column the allowlist '
        + 'does not carry',
    ).toBeNull();
  });
});

describe('the allowlist stops where the contract says it stops', () => {
  it('a bot cannot write its own agents row — that record is owned elsewhere', async () => {
    // Deliberate, and recorded in docs/security/bot-database-access-and-rls-gaps.md: which
    // component owns an agents row is a design question, not a column allowlist question, and
    // agents carries no RLS that would confine a bot to its own row if INSERT were granted. If
    // this case goes green, someone widened the contract — decide it, do not discover it.
    const refusal = await asBot(
      `INSERT INTO agents (agent_id, name, status, api_provider_id, persona, base_capabilities,
         base_selector_descriptor, base_routing_keywords, metadata)
       VALUES ($1::uuid, $2, 'active', 'auto', $3::jsonb, $4::text[], $5, $6::text[], $7::jsonb)
       ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status`,
      [AGENT, 'seeded', '{}', [], 'descriptor', [], '{}'],
    );
    expect(refusal?.code).toBe('42501');
  });

  it('a bot cannot read oshal_swarm_memory itself, only the rows the helper hands it', async () => {
    const direct = await asBot(
      'SELECT * FROM oshal_swarm_memory WHERE work_item_id = ANY($1::text[])',
      [[WORKLOAD_MINE, WORKLOAD_THEIRS, WORKLOAD_SHARED]],
    );
    expect(direct?.code, 'a plain GRANT here would let every bot read every owner\'s memories').toBe('42501');

    const client = await bot.connect();
    try {
      const readable = await client.query<HelperRow>(
        'SELECT * FROM oshal_swarm_memory_readable($1::text[], $2)',
        [[WORKLOAD_MINE, WORKLOAD_THEIRS, WORKLOAD_SHARED], OWNER],
      );
      expect(readable.rows.filter((r) => r.readable).map((r) => r.work_item_id).sort())
        .toEqual([WORKLOAD_MINE, WORKLOAD_SHARED].sort());
      expect(Object.keys(readable.rows[0]), 'the seventeen mapped columns plus the readable marker')
        .toHaveLength(18);

      const anonymous = await client.query<HelperRow>(
        'SELECT * FROM oshal_swarm_memory_readable($1::text[], $2)',
        [[WORKLOAD_MINE, WORKLOAD_THEIRS, WORKLOAD_SHARED], null],
      );
      expect(anonymous.rows.filter((r) => r.readable).map((r) => r.work_item_id), 'no reader subject means shared memories only')
        .toEqual([WORKLOAD_SHARED]);
    } finally {
      client.release();
    }
  });

  it('the helper tells a withheld row from a row that does not exist, and withholds its content', async () => {
    // The caller lets a memory with no ledger row through — bindDurableTrust returns it untrusted
    // rather than dropping it. So the helper answering with the permitted rows ALONE made a
    // withheld row indistinguishable from an absent one, and the entry was let through. Three
    // states have to be three answers, and this is the source they come from.
    const client = await bot.connect();
    try {
      const { rows } = await client.query<HelperRow>(
        'SELECT * FROM oshal_swarm_memory_readable($1::text[], $2)',
        [[WORKLOAD_MINE, WORKLOAD_THEIRS, WORKLOAD_SHARED, WORKLOAD_ABSENT], OWNER],
      );
      const byId = new Map(rows.map((row) => [row.work_item_id, row]));

      expect(byId.get(WORKLOAD_MINE)?.readable, 'the reader own memory is readable').toBe(true);
      expect(byId.get(WORKLOAD_SHARED)?.readable, 'a shared memory is readable').toBe(true);
      expect(
        byId.get(WORKLOAD_THEIRS)?.readable,
        'another owner private memory must come back marked withheld — omitting it is what made it '
          + 'look like a memory with no ledger row, which the recall path lets through',
      ).toBe(false);
      expect(
        byId.has(WORKLOAD_ABSENT),
        'a work item with no ledger row must produce NO answer, so absence stays a distinct state',
      ).toBe(false);

      const heldBack = byId.get(WORKLOAD_THEIRS)!;
      const disclosed = Object.entries(heldBack)
        .filter(([column]) => column !== 'work_item_id' && column !== 'readable')
        .filter(([, value]) => value !== null);
      expect(
        disclosed,
        'a withheld answer carries the identifier the caller already supplied and nothing else',
      ).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('the real recall path returns the caller memories over the real role and grants', async () => {
    // The whole service, not the statement: a doubled vector index (the one seam that cannot run
    // here and is not the claim), the real SwarmMemoryService, the real oshal_bot pool, the real
    // grants. Reading the table instead of the helper makes queryRelevant's own catch return an
    // empty list — which is exactly how this failed on the box without anyone noticing.
    const hits: RagSearchResult[] = [WORKLOAD_MINE, WORKLOAD_THEIRS, WORKLOAD_SHARED].map((id) => ({
      id,
      text: 'doc',
      score: 0.9,
      collection: 'swarm-memory',
      metadata: {
        work_item_id: id,
        owner_sub: id === WORKLOAD_MINE ? OWNER : (id === WORKLOAD_THEIRS ? OTHER_OWNER : ''),
        visibility: id === WORKLOAD_SHARED ? 'shared' : 'private',
        source: 'test',
        created_by_workload: 'workload',
      },
    }));
    const ragDouble = { search: async () => hits } as unknown as RagService;
    const service = new SwarmMemoryService(ragDouble, bot, 'reader-helper');
    const recalled = await service.queryRelevant('anything', 5, {
      userSub: OWNER, isOperator: false, allowPublic: true,
    });
    expect(
      recalled.map((entry) => entry.metadata.work_item_id).sort(),
      'the bot recalled nothing — the durable ledger read was refused and swallowed',
    ).toEqual([WORKLOAD_MINE, WORKLOAD_SHARED].sort());
  }, 30_000);

  it('a withheld ledger row DENIES the memory; an absent one keeps the behaviour it always had', async () => {
    // The fail-open this case closes. The vector index is a COPY of the ledger taken at index
    // time, and it drifts: a memory re-scoped to private after it was indexed still carries the
    // metadata it was indexed with. That metadata clears the first filter in queryRelevant, so
    // the ledger row is the only thing standing between a bot and another owner's memory — and
    // when the helper answered with the permitted rows alone, a withheld row fell out of the
    // answer, reached the `!ledger` arm that exists for memories with NO ledger row, and was
    // returned. Three hits, one of each state, over the real oshal_bot pool and the real grants.
    const hits: RagSearchResult[] = [WORKLOAD_MINE, WORKLOAD_THEIRS, WORKLOAD_ABSENT].map((id) => ({
      id,
      text: 'doc',
      score: 0.9,
      collection: 'swarm-memory',
      // Every hit claims to be shared, so every hit clears canReadRagMetadata and the verdict is
      // the durable ledger's alone. For WORKLOAD_THEIRS that claim is a lie the index is telling:
      // its ledger row is private to another owner.
      metadata: {
        work_item_id: id,
        owner_sub: '',
        visibility: 'shared',
        source: 'test',
        created_by_workload: 'workload',
      },
    }));
    const ragDouble = { search: async () => hits } as unknown as RagService;
    const access = { userSub: OWNER, isOperator: false, allowPublic: true };

    const viaHelper = await new SwarmMemoryService(ragDouble, bot, 'reader-helper')
      .queryRelevant('anything', 5, access);
    expect(
      viaHelper.map((entry) => entry.metadata.work_item_id).sort(),
      `${WORKLOAD_THEIRS} has a ledger row private to another owner and the database withheld it. `
        + 'A withheld row must DENY. If it appears here, a refusal is being read as an absence and '
        + 'the memory is coming back on its indexed metadata alone — fail-open on an authorization '
        + 'check, which is the defect this whole contract exists to remove.',
    ).toEqual([WORKLOAD_ABSENT, WORKLOAD_MINE].sort());
    expect(
      viaHelper.find((entry) => entry.metadata.work_item_id === WORKLOAD_ABSENT)?.provenance.trustLevel,
      'a memory with no ledger row is still returned, still untrusted — unchanged',
    ).toBe('untrusted');

    // The same three hits down the controller's untouched table reach, which withholds nothing
    // because oshal_swarm_memory's only policy carries no owner predicate. Same verdict on all
    // three ids: the helper reach now agrees with the path it was derived from, and the
    // absent-row arm is demonstrably the behaviour that was already there.
    const viaTable = await new SwarmMemoryService(ragDouble, owner, 'table')
      .queryRelevant('anything', 5, access);
    expect(
      viaTable.map((entry) => entry.metadata.work_item_id).sort(),
      'the controller reach must reach the same verdict — and it is unchanged by this fix',
    ).toEqual([WORKLOAD_ABSENT, WORKLOAD_MINE].sort());
  }, 30_000);

  it('a bot node is wired to the helper reach, not the table', () => {
    // Located by CALL rather than by line, and required to be the only construction under src/app,
    // so a second bot entrypoint built the other way is a failure too.
    const constructions: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('new SwarmMemoryService(')) {
          constructions.push(fs.readFileSync(full, 'utf8'));
        }
      }
    };
    walk(path.resolve(root, 'src/app'));
    const botRuntime = fs.readFileSync(path.resolve(root, 'src/app/bot-node-runtime.ts'), 'utf8');
    expect(constructions.length, 'exactly one bot-side construction of SwarmMemoryService').toBe(2);
    expect(
      /new SwarmMemoryService\([^;]*'reader-helper'\)/.test(botRuntime),
      'src/app/bot-node-runtime.ts must construct SwarmMemoryService with the reader-helper reach — '
        + 'oshal_bot has no privilege on oshal_swarm_memory, so the table read fails closed to no memory',
    ).toBe(true);
  });

  it('a bot cannot reach the tables behind the helpers it may execute', async () => {
    for (const table of ['oshal_authorization_applications', 'swarm_applications']) {
      const { rows } = await owner.query<{ allowed: boolean }>(
        `SELECT has_table_privilege('oshal_bot', $1, 'SELECT') AS allowed`,
        [`public.${table}`],
      );
      expect(rows[0].allowed, `oshal_bot must not read ${table} directly`).toBe(false);
    }
  });
});
