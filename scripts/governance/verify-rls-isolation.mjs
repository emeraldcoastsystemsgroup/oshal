#!/usr/bin/env node
/**
 * Verifies owner-scoped Postgres RLS with two synthetic users.
 *
 * Default mode is the production gate: require enforce-stage policies.
 *
 *   npm run verify:rls
 *
 * Permissive rollout validation:
 *
 *   OSHAL_RLS_VERIFY_STAGE=permissive npm run verify:rls
 *
 * The script inserts synthetic A/B rows inside one transaction, stamps the same
 * GUCs used by the app, checks visibility as user A, user B, operator, and
 * anonymous, then rolls back. It fails if connected as a superuser/BYPASSRLS
 * role because that cannot prove tenant isolation.
 */

import crypto from 'node:crypto';
import pg from 'pg';

const tables = [
  {
    table: 'tickets',
    idColumn: 'ticket_id',
    ownerColumn: 'owner_sub',
    idType: 'uuid',
    requiredColumns: ['ticket_id', 'title', 'description', 'status', 'state_group', 'priority', 'labels', 'metadata', 'owner_sub'],
    enforcePolicies: ['tickets_owner_or_operator'],
    permissivePolicies: ['tickets_rls_permissive'],
  },
  {
    table: 'workspaces',
    idColumn: 'workspace_id',
    ownerColumn: 'owner_sub',
    idType: 'uuid',
    requiredColumns: ['workspace_id', 'name', 'path', 'metadata', 'owner_sub'],
    enforcePolicies: ['workspaces_owner_or_operator'],
    permissivePolicies: ['workspaces_rls_permissive'],
  },
  {
    table: 'access_audit_log',
    idColumn: 'audit_id',
    ownerColumn: 'actor_sub',
    idType: 'uuid',
    requiredColumns: ['audit_id', 'actor_sub', 'action', 'resource_type', 'resource_id', 'decision', 'metadata'],
    enforcePolicies: ['access_audit_select_owner_or_operator', 'access_audit_insert'],
    permissivePolicies: ['access_audit_rls_permissive'],
  },
  {
    table: 'chat_tasks',
    idColumn: 'task_id',
    ownerColumn: 'owner_sub',
    idType: 'text',
    requiredColumns: ['task_id', 'title', 'status', 'processing_mode', 'metadata', 'owner_sub'],
    enforcePolicies: ['chat_tasks_owner_or_operator'],
    permissivePolicies: ['chat_tasks_rls_permissive'],
  },
];

function usage() {
  return `verify-rls-isolation

Usage:
  npm run verify:rls
  OSHAL_RLS_VERIFY_STAGE=permissive npm run verify:rls

Environment:
  DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
  OSHAL_RLS_VERIFY_STAGE=permissive|enforce   default: enforce
  OSHAL_RLS_VERIFY_ALLOW_BYPASS=1             debug only; do not use as release proof

Exit codes:
  0 isolation proof passed for the requested stage
  1 isolation proof failed
  2 script usage/configuration error`;
}

function buildPoolConfig() {
  const url = process.env.DATABASE_URL;
  const ssl = ['true', '1', 'yes', 'on'].includes(String(process.env.PGSSL ?? process.env.POSTGRES_SSL ?? '').toLowerCase());
  if (url && url.trim()) return { connectionString: url.trim(), ssl };
  return {
    host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'postgres',
    ssl,
  };
}

function qident(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function idCast(table) {
  return table.idType === 'uuid' ? '::uuid' : '::text';
}

function asSortedText(values) {
  return values.map(String).sort();
}

function sameSet(actual, expected) {
  const a = asSortedText(actual);
  const e = asSortedText(expected);
  return a.length === e.length && a.every((value, index) => value === e[index]);
}

function readStageRequirement() {
  const stage = String(process.env.OSHAL_RLS_VERIFY_STAGE ?? 'enforce').trim().toLowerCase();
  if (!['permissive', 'enforce'].includes(stage)) {
    throw new Error(`OSHAL_RLS_VERIFY_STAGE must be permissive or enforce, got ${stage || '<empty>'}`);
  }
  return stage;
}

function describeError(error) {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors.map((item) => item?.message ?? String(item)).join('; ');
  }
  return error?.message ?? String(error);
}

async function readRole(client) {
  const result = await client.query(`
    SELECT current_user AS role_name, rolsuper, rolbypassrls
      FROM pg_roles
     WHERE rolname = current_user
     LIMIT 1
  `);
  return result.rows[0] ?? { role_name: null, rolsuper: false, rolbypassrls: false };
}

async function readSchemaState(client) {
  const names = tables.map((table) => table.table);
  const relResult = await client.query(`
    SELECT c.relname,
           n.nspname AS schema_name,
           pg_get_userbyid(c.relowner) AS owner_role,
           c.relrowsecurity,
           c.relforcerowsecurity,
           (c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owned_by_current_role
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname = ANY($1::text[])
  `, [names]);

  const policyResult = await client.query(`
    SELECT tablename, policyname, permissive, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY($1::text[])
     ORDER BY tablename, policyname
  `, [names]);

  const columnResult = await client.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
  `, [names]);

  const relations = new Map(relResult.rows.map((row) => [row.relname, row]));
  const policies = new Map();
  for (const row of policyResult.rows) {
    const list = policies.get(row.tablename) ?? [];
    list.push(row);
    policies.set(row.tablename, list);
  }
  const columns = new Map();
  for (const row of columnResult.rows) {
    const list = columns.get(row.table_name) ?? new Set();
    list.add(row.column_name);
    columns.set(row.table_name, list);
  }

  return tables.map((table) => {
    const relation = relations.get(table.table) ?? null;
    const tablePolicies = policies.get(table.table) ?? [];
    const tableColumns = columns.get(table.table) ?? new Set();
    const policyNames = new Set(tablePolicies.map((policy) => policy.policyname));
    const missingColumns = table.requiredColumns.filter((column) => !tableColumns.has(column));
    const hasEnforcePolicies = table.enforcePolicies.every((policy) => policyNames.has(policy));
    const hasPermissivePolicy = table.permissivePolicies.some((policy) => policyNames.has(policy));
    const stage = !relation?.relrowsecurity
      ? 'disabled'
      : relation.relforcerowsecurity && hasEnforcePolicies && !hasPermissivePolicy
        ? 'enforce'
        : hasPermissivePolicy
          ? 'permissive'
          : 'unknown';

    return {
      table: table.table,
      exists: Boolean(relation),
      ownerRole: relation?.owner_role ?? null,
      ownedByCurrentRole: Boolean(relation?.owned_by_current_role),
      rowSecurityEnabled: Boolean(relation?.relrowsecurity),
      forceRowSecurity: Boolean(relation?.relforcerowsecurity),
      policies: [...policyNames].sort(),
      missingColumns,
      stage,
    };
  });
}

async function setPrincipal(client, principal) {
  if (principal.kind === 'operator') {
    await client.query("SELECT set_config('oshal.current_sub', '', true)");
    await client.query("SELECT set_config('oshal.is_operator', 'on', true)");
    return;
  }
  if (principal.kind === 'anonymous') {
    await client.query("SELECT set_config('oshal.current_sub', '', true)");
    await client.query("SELECT set_config('oshal.is_operator', 'off', true)");
    return;
  }
  await client.query("SELECT set_config('oshal.current_sub', $1, true)", [principal.sub]);
  await client.query("SELECT set_config('oshal.is_operator', 'off', true)");
}

async function insertFixtures(client, run) {
  await setPrincipal(client, { kind: 'operator' });

  await client.query(`
    INSERT INTO tickets (
      ticket_id, title, description, status, state_group, priority, labels,
      metadata, owner_sub, created_at, updated_at
    )
    VALUES
      ($1::uuid, $2, 'RLS verification fixture A', 'approved', 'approved', 'medium',
       ARRAY['rls-verify']::text[], $3::jsonb, $4, now(), now()),
      ($5::uuid, $6, 'RLS verification fixture B', 'approved', 'approved', 'medium',
       ARRAY['rls-verify']::text[], $7::jsonb, $8, now(), now())
  `, [
    run.ids.tickets.a,
    `rls verify ticket A ${run.runId}`,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'A' }),
    run.userA,
    run.ids.tickets.b,
    `rls verify ticket B ${run.runId}`,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'B' }),
    run.userB,
  ]);

  await client.query(`
    INSERT INTO workspaces (
      workspace_id, name, path, project_name, metadata, owner_sub, created_at
    )
    VALUES
      ($1::uuid, $2, $3, 'rls-verifier', $4::jsonb, $5, now()),
      ($6::uuid, $7, $8, 'rls-verifier', $9::jsonb, $10, now())
  `, [
    run.ids.workspaces.a,
    `rls-verify-a-${run.shortId}`,
    `/tmp/oshal-rls-${run.shortId}-a`,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'A' }),
    run.userA,
    run.ids.workspaces.b,
    `rls-verify-b-${run.shortId}`,
    `/tmp/oshal-rls-${run.shortId}-b`,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'B' }),
    run.userB,
  ]);

  await client.query(`
    INSERT INTO access_audit_log (
      audit_id, actor_sub, action, resource_type, resource_id, decision, metadata, created_at
    )
    VALUES
      ($1::uuid, $2, 'rls.verify', 'ticket', $3, 'info', $4::jsonb, now()),
      ($5::uuid, $6, 'rls.verify', 'ticket', $7, 'info', $8::jsonb, now())
  `, [
    run.ids.access_audit_log.a,
    run.userA,
    run.ids.tickets.a,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'A' }),
    run.ids.access_audit_log.b,
    run.userB,
    run.ids.tickets.b,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'B' }),
  ]);

  await client.query(`
    INSERT INTO chat_tasks (
      task_id, title, status, processing_mode, agent_id, provider_id,
      total_cost, total_requests, metadata, owner_sub, created_at, updated_at
    )
    VALUES
      ($1, $2, 'created', 'agentic', 'rls-verifier', 'test',
       0.01, 1, $3::jsonb, $4, now(), now()),
      ($5, $6, 'created', 'agentic', 'rls-verifier', 'test',
       0.02, 1, $7::jsonb, $8, now(), now())
  `, [
    run.ids.chat_tasks.a,
    `rls verify task A ${run.runId}`,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'A' }),
    run.userA,
    run.ids.chat_tasks.b,
    `rls verify task B ${run.runId}`,
    JSON.stringify({ rlsVerifierRunId: run.runId, fixture: 'B' }),
    run.userB,
  ]);
}

async function visibleIds(client, table, ids) {
  const cast = idCast(table);
  const sql = `
    SELECT ${qident(table.idColumn)}::text AS id
      FROM ${qident(table.table)}
     WHERE ${qident(table.idColumn)} IN ($1${cast}, $2${cast})
     ORDER BY 1
  `;
  const result = await client.query(sql, [ids.a, ids.b]);
  return result.rows.map((row) => String(row.id));
}

async function runVisibilityChecks(client, run) {
  const principals = [
    { label: 'userA', kind: 'user', sub: run.userA, expected: 'a' },
    { label: 'userB', kind: 'user', sub: run.userB, expected: 'b' },
    { label: 'operator', kind: 'operator', expected: 'both' },
    { label: 'anonymous', kind: 'anonymous', expected: 'none' },
  ];

  const checks = [];
  for (const principal of principals) {
    await setPrincipal(client, principal);
    for (const table of tables) {
      const ids = run.ids[table.table];
      const actual = await visibleIds(client, table, ids);
      const expected = principal.expected === 'a'
        ? [ids.a]
        : principal.expected === 'b'
          ? [ids.b]
          : principal.expected === 'both'
            ? [ids.a, ids.b]
            : [];
      checks.push({
        principal: principal.label,
        table: table.table,
        expected,
        actual,
        ok: sameSet(actual, expected),
      });
    }
  }
  return checks;
}

function buildRun() {
  const runId = crypto.randomUUID();
  const shortId = runId.slice(0, 8);
  return {
    runId,
    shortId,
    userA: `rls-verify-user-a-${shortId}`,
    userB: `rls-verify-user-b-${shortId}`,
    ids: {
      tickets: { a: crypto.randomUUID(), b: crypto.randomUUID() },
      workspaces: { a: crypto.randomUUID(), b: crypto.randomUUID() },
      access_audit_log: { a: crypto.randomUUID(), b: crypto.randomUUID() },
      chat_tasks: { a: `rls-${shortId}-a`, b: `rls-${shortId}-b` },
    },
  };
}

function summarize({ role, schema, checks, requiredStage }) {
  const allowBypass = process.env.OSHAL_RLS_VERIFY_ALLOW_BYPASS === '1';
  const bypassesRls = Boolean(role.rolsuper || role.rolbypassrls);
  const schemaReady = schema.every((table) => table.exists && table.missingColumns.length === 0 && table.rowSecurityEnabled);
  const stageReady = requiredStage === 'enforce'
    ? schema.every((table) => table.stage === 'enforce')
    : schema.every((table) => table.stage === 'permissive' || table.stage === 'enforce');
  const visibilityPassed = checks.length > 0 && checks.every((check) => check.ok);
  const validConnection = !bypassesRls || allowBypass;
  const ok = schemaReady && stageReady && visibilityPassed && validConnection;

  const tableStages = Object.fromEntries(schema.map((table) => [table.table, table.stage]));
  const failedChecks = checks.filter((check) => !check.ok);
  const missingTables = schema.filter((table) => !table.exists).map((table) => table.table);
  const tablesMissingColumns = schema
    .filter((table) => table.missingColumns.length > 0)
    .map((table) => ({ table: table.table, missingColumns: table.missingColumns }));
  const disabledTables = schema.filter((table) => table.stage === 'disabled').map((table) => table.table);

  return {
    ok,
    requiredStage,
    mode: schema.every((table) => table.stage === 'enforce')
      ? 'enforce'
      : schema.every((table) => table.stage === 'permissive' || table.stage === 'enforce')
        ? 'permissive'
        : 'not-ready',
    connection: {
      role: role.role_name,
      superuser: Boolean(role.rolsuper),
      bypassRls: Boolean(role.rolbypassrls),
      validProofRole: validConnection,
    },
    schema,
    tableStages,
    summary: {
      schemaReady,
      stageReady,
      visibilityPassed,
      failedCheckCount: failedChecks.length,
      missingTables,
      tablesMissingColumns,
      disabledTables,
      syntheticRowsRolledBack: true,
    },
    failedChecks,
    checks,
    next: ok
      ? 'RLS isolation proof passed for the requested stage.'
      : 'Fix failed schema/stage/visibility items, connect with a non-superuser app role, then re-run.',
  };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }

  let requiredStage;
  try {
    requiredStage = readStageRequirement();
  } catch (error) {
    console.error(`[verify-rls-isolation] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }

  const pool = new pg.Pool(buildPoolConfig());
  let client = null;
  try {
    client = await pool.connect();
    const role = await readRole(client);
    const schema = await readSchemaState(client);
    const missing = schema.filter((table) => !table.exists || table.missingColumns.length > 0);
    if (missing.length > 0) {
      const report = summarize({ role, schema, checks: [], requiredStage });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 1;
      return;
    }

    const run = buildRun();
    let checks = [];
    await client.query('BEGIN');
    try {
      await insertFixtures(client, run);
      checks = await runVisibilityChecks(client, run);
    } finally {
      await client.query('ROLLBACK');
    }

    const report = summarize({ role, schema, checks, requiredStage });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    console.log(JSON.stringify({
      ok: false,
      requiredStage,
      error: describeError(error),
      next: 'Start the target Postgres profile or set DATABASE_URL/PG* to the active profile, then re-run.',
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[verify-rls-isolation] fatal:', error);
  process.exit(1);
});
