#!/usr/bin/env node
/**
 * Backfills owner_sub for legacy rows before restrictive RLS is applied.
 *
 * Dry-run by default:
 *   node scripts/governance/backfill-owner-sub.mjs
 *
 * Apply inferred ownership:
 *   OSHAL_OWNER_BACKFILL=apply node scripts/governance/backfill-owner-sub.mjs
 *
 * Mark remaining legacy null-owner rows as operator-only:
 *   OSHAL_OWNER_QUARANTINE=apply node scripts/governance/backfill-owner-sub.mjs
 *
 * Apply both:
 *   OSHAL_OWNER_BACKFILL=apply OSHAL_OWNER_QUARANTINE=apply node scripts/governance/backfill-owner-sub.mjs
 */

import pg from 'pg';

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

const TABLES = ['tickets', 'workspaces', 'chat_tasks'];

async function countOwnership(client, table) {
  const result = await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE owner_sub IS NULL OR owner_sub = '')::int AS unowned,
       COUNT(*) FILTER (WHERE metadata->>'ownerDisposition' = 'operator_only')::int AS operator_only
     FROM ${table}`,
  );
  return result.rows[0];
}

async function ensureOwnershipColumns(client) {
  await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS owner_sub TEXT');
  await client.query('CREATE INDEX IF NOT EXISTS idx_tickets_owner_sub ON tickets(owner_sub) WHERE owner_sub IS NOT NULL');
  await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_sub TEXT');
  await client.query('CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_sub) WHERE owner_sub IS NOT NULL');
  await client.query('ALTER TABLE chat_tasks ADD COLUMN IF NOT EXISTS owner_sub TEXT');
  await client.query('CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner ON chat_tasks(owner_sub) WHERE owner_sub IS NOT NULL');
  await client.query('CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner_updated ON chat_tasks(owner_sub, updated_at) WHERE owner_sub IS NOT NULL');
}

async function runBackfills(client) {
  const updates = {};

  updates.ticketsFromDirectChatTasks = (await client.query(`
    UPDATE tickets t
    SET owner_sub = ct.owner_sub
    FROM chat_tasks ct
    WHERE (t.owner_sub IS NULL OR t.owner_sub = '')
      AND ct.owner_sub IS NOT NULL
      AND ct.owner_sub <> ''
      AND ct.task_id = t.ticket_id::text
  `)).rowCount ?? 0;

  updates.ticketsFromLinkedChatTasks = (await client.query(`
    WITH candidates AS (
      SELECT ttl.ticket_id, MIN(ct.owner_sub) AS owner_sub
      FROM ticket_task_links ttl
      JOIN chat_tasks ct ON ct.task_id = ttl.task_id
      WHERE ct.owner_sub IS NOT NULL AND ct.owner_sub <> ''
      GROUP BY ttl.ticket_id
      HAVING COUNT(DISTINCT ct.owner_sub) = 1
    )
    UPDATE tickets t
    SET owner_sub = candidates.owner_sub
    FROM candidates
    WHERE (t.owner_sub IS NULL OR t.owner_sub = '')
      AND t.ticket_id = candidates.ticket_id
  `)).rowCount ?? 0;

  updates.workspacesFromTicketWorkspaceId = (await client.query(`
    WITH candidates AS (
      SELECT t.workspace_id, MIN(t.owner_sub) AS owner_sub
      FROM tickets t
      WHERE t.workspace_id IS NOT NULL
        AND t.owner_sub IS NOT NULL
        AND t.owner_sub <> ''
      GROUP BY t.workspace_id
      HAVING COUNT(DISTINCT t.owner_sub) = 1
    )
    UPDATE workspaces w
    SET owner_sub = candidates.owner_sub
    FROM candidates
    WHERE (w.owner_sub IS NULL OR w.owner_sub = '')
      AND w.workspace_id = candidates.workspace_id
  `)).rowCount ?? 0;

  updates.workspacesFromTicketWorkspaceLinks = (await client.query(`
    WITH candidates AS (
      SELECT twl.workspace_id, MIN(t.owner_sub) AS owner_sub
      FROM ticket_workspace_links twl
      JOIN tickets t ON t.ticket_id = twl.ticket_id
      WHERE t.owner_sub IS NOT NULL AND t.owner_sub <> ''
      GROUP BY twl.workspace_id
      HAVING COUNT(DISTINCT t.owner_sub) = 1
    )
    UPDATE workspaces w
    SET owner_sub = candidates.owner_sub
    FROM candidates
    WHERE (w.owner_sub IS NULL OR w.owner_sub = '')
      AND w.workspace_id = candidates.workspace_id
  `)).rowCount ?? 0;

  updates.ticketsFromWorkspaceId = (await client.query(`
    UPDATE tickets t
    SET owner_sub = w.owner_sub
    FROM workspaces w
    WHERE (t.owner_sub IS NULL OR t.owner_sub = '')
      AND w.owner_sub IS NOT NULL
      AND w.owner_sub <> ''
      AND t.workspace_id = w.workspace_id
  `)).rowCount ?? 0;

  updates.ticketsFromWorkspaceLinks = (await client.query(`
    WITH candidates AS (
      SELECT twl.ticket_id, MIN(w.owner_sub) AS owner_sub
      FROM ticket_workspace_links twl
      JOIN workspaces w ON w.workspace_id = twl.workspace_id
      WHERE w.owner_sub IS NOT NULL AND w.owner_sub <> ''
      GROUP BY twl.ticket_id
      HAVING COUNT(DISTINCT w.owner_sub) = 1
    )
    UPDATE tickets t
    SET owner_sub = candidates.owner_sub
    FROM candidates
    WHERE (t.owner_sub IS NULL OR t.owner_sub = '')
      AND t.ticket_id = candidates.ticket_id
  `)).rowCount ?? 0;

  updates.directChatTasksFromTickets = (await client.query(`
    UPDATE chat_tasks ct
    SET owner_sub = t.owner_sub
    FROM tickets t
    WHERE (ct.owner_sub IS NULL OR ct.owner_sub = '')
      AND t.owner_sub IS NOT NULL
      AND t.owner_sub <> ''
      AND ct.task_id = t.ticket_id::text
  `)).rowCount ?? 0;

  updates.linkedChatTasksFromTickets = (await client.query(`
    WITH candidates AS (
      SELECT ttl.task_id, MIN(t.owner_sub) AS owner_sub
      FROM ticket_task_links ttl
      JOIN tickets t ON t.ticket_id = ttl.ticket_id
      WHERE t.owner_sub IS NOT NULL AND t.owner_sub <> ''
      GROUP BY ttl.task_id
      HAVING COUNT(DISTINCT t.owner_sub) = 1
    )
    UPDATE chat_tasks ct
    SET owner_sub = candidates.owner_sub
    FROM candidates
    WHERE (ct.owner_sub IS NULL OR ct.owner_sub = '')
      AND ct.task_id = candidates.task_id
  `)).rowCount ?? 0;

  return updates;
}

async function quarantineRemaining(client) {
  const quarantinedAt = new Date().toISOString();
  const payload = JSON.stringify({
    ownerDisposition: 'operator_only',
    ownerDispositionReason: 'legacy_unowned_no_safe_backfill',
    ownerDispositionAt: quarantinedAt,
  });
  const updates = {};

  for (const table of TABLES) {
    const result = await client.query(
      `UPDATE ${table}
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE (owner_sub IS NULL OR owner_sub = '')
         AND COALESCE(metadata->>'ownerDisposition', '') <> 'operator_only'`,
      [payload],
    );
    updates[table] = result.rowCount ?? 0;
  }

  return { quarantinedAt, updates };
}

async function main() {
  const applyBackfill = (process.env.OSHAL_OWNER_BACKFILL ?? '').trim() === 'apply';
  const applyQuarantine = (process.env.OSHAL_OWNER_QUARANTINE ?? '').trim() === 'apply';
  const dryRun = !applyBackfill && !applyQuarantine;
  const pool = new pg.Pool(buildPoolConfig());
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureOwnershipColumns(client);

    const before = {};
    for (const table of TABLES) before[table] = await countOwnership(client, table);

    const backfills = (applyBackfill || dryRun) ? await runBackfills(client) : {};
    const quarantine = (applyQuarantine || dryRun) ? await quarantineRemaining(client) : { quarantinedAt: null, updates: {} };

    const after = {};
    for (const table of TABLES) after[table] = await countOwnership(client, table);

    if (applyBackfill || applyQuarantine) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }

    console.log(JSON.stringify({
      appliedBackfill: applyBackfill,
      appliedQuarantine: applyQuarantine,
      dryRun,
      backfills,
      quarantine,
      before,
      after,
      next: dryRun
        ? 'Dry-run only. Re-run with OSHAL_OWNER_BACKFILL=apply and/or OSHAL_OWNER_QUARANTINE=apply to write changes.'
        : 'Run verify:rls and verify:runtime-schema, then run signed-in two-user API/UI privacy proof.',
    }, null, 2));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[backfill-owner-sub] FAILED - rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[backfill-owner-sub] fatal:', err);
  process.exit(1);
});
