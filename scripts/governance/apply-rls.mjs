#!/usr/bin/env node
/**
 * Staged, gated applier for Postgres RLS policies.
 *
 * Usage:
 *   node scripts/governance/apply-rls.mjs
 *   OSHAL_RLS_APPLY=apply-permissive node scripts/governance/apply-rls.mjs
 *   OSHAL_RLS_APPLY=apply-enforce node scripts/governance/apply-rls.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const stages = {
  'apply-permissive': path.resolve(here, '../../docs/governance/rls-policies.sql'),
  'apply-enforce': path.resolve(here, '../../docs/governance/rls-policies-enforce.sql'),
};

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

async function ensurePrerequisites(client) {
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS owner_sub TEXT');
  await client.query('CREATE INDEX IF NOT EXISTS idx_tickets_owner_sub ON tickets(owner_sub) WHERE owner_sub IS NOT NULL');
  await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_sub TEXT');
  await client.query('CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_sub) WHERE owner_sub IS NOT NULL');
  await client.query('ALTER TABLE chat_tasks ADD COLUMN IF NOT EXISTS owner_sub TEXT');
  await client.query('CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner ON chat_tasks(owner_sub) WHERE owner_sub IS NOT NULL');
  await client.query('CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner_updated ON chat_tasks(owner_sub, updated_at) WHERE owner_sub IS NOT NULL');
  await client.query(`CREATE TABLE IF NOT EXISTS access_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_sub TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    decision TEXT NOT NULL DEFAULT 'info',
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await client.query('CREATE INDEX IF NOT EXISTS idx_access_audit_actor ON access_audit_log (actor_sub, created_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_access_audit_resource ON access_audit_log (resource_type, resource_id, created_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_access_audit_created ON access_audit_log (created_at DESC)');
}

async function main() {
  const confirm = (process.env.OSHAL_RLS_APPLY ?? '').trim();
  const sqlPath = stages[confirm] ?? stages['apply-permissive'];

  if (!fs.existsSync(sqlPath)) {
    console.error(`[apply-rls] SQL file not found: ${sqlPath}`);
    process.exit(2);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');

  if (!stages[confirm]) {
    console.log('[apply-rls] DRY RUN - no changes made.');
    console.log('[apply-rls] To apply permissive: OSHAL_RLS_APPLY=apply-permissive node scripts/governance/apply-rls.mjs');
    console.log('[apply-rls] To apply enforce:    OSHAL_RLS_APPLY=apply-enforce node scripts/governance/apply-rls.mjs');
    console.log('[apply-rls] Read docs/governance/RLS-RUNBOOK.md first.');
    console.log('--- SQL that would be applied by default (permissive stage) ---');
    console.log(sql);
    return;
  }

  const pool = new pg.Pool(buildPoolConfig());
  const client = await pool.connect();
  try {
    console.log(`[apply-rls] Applying ${confirm} in a single transaction...`);
    await client.query('BEGIN');
    await ensurePrerequisites(client);
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[apply-rls] Applied. Verify normal-user and operator reads before proceeding.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[apply-rls] FAILED - rolled back, no changes:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[apply-rls] fatal:', err);
  process.exit(1);
});
