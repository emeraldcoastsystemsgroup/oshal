#!/usr/bin/env node
/**
 * Provisions a non-superuser Postgres role suitable for RLS proof and app use.
 *
 * Dry-run by default:
 *   node scripts/governance/provision-rls-app-role.mjs
 *
 * Apply:
 *   OSHAL_DB_ROLE_APPLY=apply OSHAL_APP_DB_ROLE=oshal_app OSHAL_APP_DB_PASSWORD=... \
 *     node scripts/governance/provision-rls-app-role.mjs
 */

import pg from 'pg';

function usage() {
  return `provision-rls-app-role

Usage:
  node scripts/governance/provision-rls-app-role.mjs
  OSHAL_DB_ROLE_APPLY=apply OSHAL_APP_DB_ROLE=oshal_app OSHAL_APP_DB_PASSWORD=... node scripts/governance/provision-rls-app-role.mjs

Environment:
  DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE  admin/owner connection
  OSHAL_DB_ROLE_APPLY=apply                                  required to change DB state
  OSHAL_APP_DB_ROLE=oshal_app                                role to create/update
  OSHAL_APP_DB_PASSWORD=...                                  required in apply mode; never printed

The provisioned role is LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS,
with public-schema table/sequence grants and default privileges.`;
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

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readRoleName() {
  const role = String(process.env.OSHAL_APP_DB_ROLE || 'oshal_app').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
    throw new Error('OSHAL_APP_DB_ROLE must be a simple Postgres identifier, e.g. oshal_app');
  }
  return role;
}

function readPassword(apply) {
  const password = String(process.env.OSHAL_APP_DB_PASSWORD || '');
  if (!apply) return password;
  if (password.length < 16) {
    throw new Error('OSHAL_APP_DB_PASSWORD must be at least 16 characters in apply mode');
  }
  return password;
}

async function currentRole(client) {
  const result = await client.query(`
    SELECT current_database() AS database_name,
           current_user AS role_name,
           rolsuper,
           rolcreaterole
      FROM pg_roles
     WHERE rolname = current_user
     LIMIT 1
  `);
  return result.rows[0] ?? {};
}

async function provision(client, role, password) {
  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1', [role]);
  if (existing.rowCount) {
    await client.query(`
      ALTER ROLE ${qident(role)}
      WITH LOGIN PASSWORD ${literal(password)}
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS
    `);
  } else {
    await client.query(`
      CREATE ROLE ${qident(role)}
      WITH LOGIN PASSWORD ${literal(password)}
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS
    `);
  }

  const db = await client.query('SELECT current_database() AS name');
  await client.query(`GRANT CONNECT ON DATABASE ${qident(db.rows[0].name)} TO ${qident(role)}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${qident(role)}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${qident(role)}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${qident(role)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qident(role)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${qident(role)}`);
  await client.query(`ALTER ROLE ${qident(role)} SET search_path = public`);

  const result = await client.query(`
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
      FROM pg_roles
     WHERE rolname = $1
  `, [role]);
  return result.rows[0];
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }

  let role;
  let password;
  const apply = String(process.env.OSHAL_DB_ROLE_APPLY || '').trim() === 'apply';
  try {
    role = readRoleName();
    password = readPassword(apply);
  } catch (error) {
    console.error(`[provision-rls-app-role] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }

  if (!apply) {
    console.log(JSON.stringify({
      applied: false,
      role,
      grants: [
        'CONNECT on current database',
        'USAGE on schema public',
        'SELECT/INSERT/UPDATE/DELETE on all public tables',
        'USAGE/SELECT/UPDATE on all public sequences',
        'matching default privileges for future public tables/sequences',
      ],
      flags: ['LOGIN', 'NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOBYPASSRLS'],
      next: 'Dry-run only. Re-run with OSHAL_DB_ROLE_APPLY=apply and OSHAL_APP_DB_PASSWORD set.',
    }, null, 2));
    return;
  }

  const pool = new pg.Pool(buildPoolConfig());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admin = await currentRole(client);
    if (!admin.rolsuper && !admin.rolcreaterole) {
      throw new Error(`current role ${admin.role_name || '<unknown>'} cannot create/alter roles`);
    }
    const provisioned = await provision(client, role, password);
    await client.query('COMMIT');
    console.log(JSON.stringify({
      applied: true,
      database: admin.database_name,
      adminRole: admin.role_name,
      provisionedRole: provisioned,
      next: 'Use this role in DATABASE_URL for npm run verify:rls and, after verification, for the app runtime.',
    }, null, 2));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[provision-rls-app-role] FAILED - rolled back:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[provision-rls-app-role] fatal:', error);
  process.exit(1);
});
