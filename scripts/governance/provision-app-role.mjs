#!/usr/bin/env node
/**
 * One-command, idempotent bootstrap of the least-privilege `oshal_app` runtime role (ADR-076).
 *
 * This wraps docs/governance/app-role-provisioning.sql (the single source of truth) so the
 * ADR-076 cutover — creating oshal_app, granting DML, and reassigning table/sequence/view
 * ownership to it while the SECURITY DEFINER tenant helper stays owned by the superuser — is a
 * repeatable command instead of a hand-run psql artifact. Safe to run repeatedly: the SQL uses
 * IF NOT EXISTS, defensive ALTERs, and ownership loops that converge.
 *
 * It does NOT flip any committed default. After running it, point the app's runtime DATABASE_URL
 * at the printed oshal_app URL (operator .env) and recreate the api. RLS only enforces once the
 * runtime connects as oshal_app (Postgres exempts the superuser).
 *
 * Env:
 *   BOOTSTRAP_DATABASE_URL  superuser (oshal) connection; falls back to DATABASE_URL.
 *   OSHAL_APP_DB_PASSWORD   password to set for oshal_app (required; never logged).
 *
 * Flags: --dry-run (print the transformed SQL, connect to nothing).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(here, '../../docs/governance/app-role-provisioning.sql');
const dryRun = process.argv.includes('--dry-run');

const superUrl = process.env.BOOTSTRAP_DATABASE_URL || process.env.DATABASE_URL;
const appPw = process.env.OSHAL_APP_DB_PASSWORD;

function fail(msg) {
  console.error(`[provision-app-role] ${msg}`);
  process.exit(1);
}

if (!appPw) fail('OSHAL_APP_DB_PASSWORD is required (e.g. `openssl rand -hex 24`).');
if (!superUrl && !dryRun) fail('BOOTSTRAP_DATABASE_URL (or DATABASE_URL) to the superuser must be set.');

// Transform the psql artifact into a driver-runnable script: drop psql meta-commands (\set …)
// and inline the password literal that psql would have expanded from :'app_pw'.
const raw = readFileSync(sqlPath, 'utf8');
const sql = raw
  .split('\n')
  .filter((line) => !/^\s*\\/.test(line))
  .join('\n')
  .replace(/:'app_pw'/g, `'${appPw.replace(/'/g, "''")}'`);

if (dryRun) {
  console.log(sql.replace(new RegExp(appPw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***'));
  console.log('\n[provision-app-role] dry run — nothing executed.');
  process.exit(0);
}

const client = new pg.Client({ connectionString: superUrl });
try {
  await client.connect();
  await client.query(sql);

  const role = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'oshal_app'`,
  );
  const owned = await client.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner='oshal_app'`,
  );
  const r = role.rows[0];
  if (!r) fail('oshal_app was not created.');
  if (r.rolsuper || r.rolbypassrls) fail('oshal_app must be NOSUPERUSER + NOBYPASSRLS for RLS to enforce.');

  const su = new URL(superUrl);
  console.log('[provision-app-role] ok:');
  console.log(`  oshal_app: login=${r.rolcanlogin} superuser=${r.rolsuper} bypassrls=${r.rolbypassrls}`);
  console.log(`  tables now owned by oshal_app: ${owned.rows[0].n}`);
  console.log(`  next: point the app runtime DATABASE_URL at oshal_app on ${su.host}${su.pathname}`);
  console.log('  (use your OSHAL_APP_DB_PASSWORD; keep it in .env only, never commit it)');
} catch (err) {
  fail(`provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await client.end().catch(() => {});
}
