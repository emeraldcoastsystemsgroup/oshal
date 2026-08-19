#!/usr/bin/env node
/**
 * Fail-closed one-shot initializer for DigitalOcean Managed PostgreSQL 18.
 *
 * All static URL/identity/TLS checks complete before the first connection and
 * every server-side check completes before the first mutation. The long-lived
 * API never receives this process's doadmin URL or runtime-role passwords.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { provisionRuntimeRoles, runtimeCredentials } from './provision-app-role.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const MIGRATION_RUNNER = path.join(root, 'dist/features/tool-registry/services/database-bootstrap-service.js');
const MIGRATIONS_DIR = path.join(root, 'scripts/migrations');
const RLS_APPLIER = path.join(root, 'scripts/governance/apply-rls.mjs');
const ROLE_SQL = path.join(root, 'docs/governance/app-role-provisioning.sql');
const PRIVATE_DO_HOST = /^private-[a-z0-9.-]+\.db\.ondigitalocean\.com$/i;

function fail(message) {
  throw new Error(message);
}

function decodeUrlPart(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${label} contains invalid percent encoding`);
  }
}

function portOf(url) {
  return url.port || '5432';
}

function databaseOf(url, label) {
  const database = decodeUrlPart(url.pathname.replace(/^\//, ''), `${label} database`);
  if (!database || database.includes('/')) fail(`${label} must select exactly one database`);
  return database;
}

function requireSingleQueryValue(url, key, expected, label) {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || values[0] !== expected) {
    fail(`${label} must set exactly ${key}=${expected}`);
  }
}

function validateQueryKeys(url, label) {
  const allowed = new Set(['sslmode', 'sslrootcert', 'application_name']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) fail(`${label} contains unsupported query parameter: ${key}`);
  }
  const applicationNames = url.searchParams.getAll('application_name');
  if (applicationNames.length > 1 || applicationNames.some((value) => !value.trim())) {
    fail(`${label} may set at most one non-empty application_name`);
  }
}

export function validateManagedConfiguration(env = process.env) {
  const bootstrapUrl = env.BOOTSTRAP_DATABASE_URL || '';
  const appUrl = env.DATABASE_URL || '';
  const botUrl = env.BOT_DATABASE_URL || '';
  const caPath = env.POSTGRES_CA_CERT_PATH || '/app/config-seed/do-postgres-ca.pem';
  const credentials = runtimeCredentials({ bootstrapUrl, appUrl, botUrl });
  const entries = [
    ['BOOTSTRAP_DATABASE_URL', credentials.bootstrap, 'doadmin'],
    ['DATABASE_URL', credentials.app, 'oshal_app'],
    ['BOT_DATABASE_URL', credentials.bot, 'oshal_bot'],
  ];

  for (const [label, url, expectedUser] of entries) {
    if (decodeUrlPart(url.username, `${label} username`) !== expectedUser) {
      fail(`${label} must authenticate exactly as ${expectedUser}`);
    }
    if (!url.password) fail(`${label} must include a password`);
    if (url.hash) fail(`${label} must not contain a URL fragment`);
  }

  const host = credentials.bootstrap.hostname;
  const local = host === 'oshal-db';
  if (!local && !PRIVATE_DO_HOST.test(host)) {
    fail('BOOTSTRAP_DATABASE_URL must use the DigitalOcean private/VPC endpoint (public endpoints are rejected)');
  }

  const expectedPort = portOf(credentials.bootstrap);
  const expectedDatabase = databaseOf(credentials.bootstrap, 'BOOTSTRAP_DATABASE_URL');
  if (!local && expectedPort !== '25060') fail('DigitalOcean managed PostgreSQL must use port 25060');
  if (expectedDatabase !== 'oshal') fail('all managed deployment URLs must select the dedicated oshal database');
  for (const [label, url] of entries.slice(1)) {
    if (url.hostname !== host || portOf(url) !== expectedPort || databaseOf(url, label) !== expectedDatabase) {
      fail(`${label} must use the same private host, port, and database as BOOTSTRAP_DATABASE_URL`);
    }
  }

  if (new Set([bootstrapUrl, appUrl, botUrl]).size !== 3) fail('all three database URLs must be distinct');
  const passwords = entries.map(([label, url]) => decodeUrlPart(url.password, `${label} password`));
  if (new Set(passwords).size !== 3) fail('bootstrap, app, and bot passwords must be distinct');

  if (!local) {
    for (const [label, url] of entries) {
      validateQueryKeys(url, label);
      requireSingleQueryValue(url, 'sslmode', 'verify-full', label);
      requireSingleQueryValue(url, 'sslrootcert', caPath, label);
    }
    if (!path.isAbsolute(caPath)) fail('POSTGRES_CA_CERT_PATH must be an absolute container path');
    if (!existsSync(caPath)) {
      fail(`PostgreSQL CA file is missing or empty: ${caPath}`);
    }
    const caStat = lstatSync(caPath);
    const requestedCaPath = path.resolve(caPath);
    const resolvedCaPath = realpathSync(caPath);
    const sameResolvedPath = process.platform === 'win32'
      ? resolvedCaPath.toLowerCase() === requestedCaPath.toLowerCase()
      : resolvedCaPath === requestedCaPath;
    if (!caStat.isFile() || caStat.isSymbolicLink() || caStat.size === 0 || !sameResolvedPath) {
      fail(`PostgreSQL CA file must be a non-empty regular, non-symlink file: ${caPath}`);
    }
    const caPem = readFileSync(caPath, 'utf8');
    try {
      new X509Certificate(caPem);
    } catch {
      fail(`PostgreSQL CA file is not a PEM certificate: ${caPath}`);
    }
  }

  return { bootstrapUrl, appUrl, botUrl, caPath, host, port: expectedPort, database: expectedDatabase, local };
}

function validateRuntimeAssets() {
  if (!existsSync(MIGRATION_RUNNER)) {
    fail(`compiled migration runner is missing: ${MIGRATION_RUNNER}`);
  }
  if (!existsSync(MIGRATIONS_DIR) || !statSync(MIGRATIONS_DIR).isDirectory()) {
    fail(`migration directory is missing: ${MIGRATIONS_DIR}`);
  }
  if (!existsSync(RLS_APPLIER)) fail(`RLS applier is missing: ${RLS_APPLIER}`);
  if (!existsSync(ROLE_SQL)) fail(`role provisioning SQL is missing: ${ROLE_SQL}`);
}

async function inspectServer(config) {
  const attempts = Math.max(1, Math.min(30, Number(process.env.OSHAL_BOOTSTRAP_CONNECT_ATTEMPTS || 30)) || 30);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = new pg.Client({ connectionString: config.bootstrapUrl, connectionTimeoutMillis: 5_000 });
    let retainClient = false;
    try {
      await client.connect();
      const posture = await client.query(`
        SELECT current_user AS role_name, current_database() AS database_name,
               current_setting('server_version_num')::int AS version_num,
               r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
               pg_has_role(current_user, 'pg_signal_backend', 'MEMBER') AS can_signal_backend,
               COALESCE(s.ssl, false) AS ssl
          FROM pg_roles r
          LEFT JOIN pg_stat_ssl s ON s.pid = pg_backend_pid()
         WHERE r.rolname = current_user
      `);
      const row = posture.rows[0];
      if (!row || row.role_name !== 'doadmin' || row.database_name !== config.database) {
        fail('bootstrap connection resolved to an unexpected role or database');
      }
      if (row.version_num < 180000 || row.version_num >= 190000) {
        fail(`managed database must run PostgreSQL 18.x; server_version_num=${row.version_num}`);
      }
      if (!row.rolcreaterole || !row.rolcreatedb || (!row.rolsuper && !row.rolbypassrls)) {
        fail('doadmin must have CREATEDB, CREATEROLE, and SUPERUSER/BYPASSRLS posture');
      }
      if (!row.rolsuper && !row.can_signal_backend) {
        fail('doadmin must have pg_signal_backend membership to terminate stale bot sessions safely');
      }
      if (!config.local && !row.ssl) fail('bootstrap connection did not negotiate TLS');

      const extensions = await client.query(`
        SELECT name, default_version
          FROM pg_available_extensions
         WHERE name IN ('pgcrypto', 'pg_trgm', 'vector')
         ORDER BY name
      `);
      const available = new Set(extensions.rows.filter((entry) => entry.default_version).map((entry) => entry.name));
      const missing = ['pgcrypto', 'pg_trgm', 'vector'].filter((name) => !available.has(name));
      if (missing.length) fail(`required PostgreSQL extensions unavailable: ${missing.join(', ')}`);

      const lock = await client.query(`
        SELECT pg_try_advisory_lock(hashtextextended('oshal:managed-postgres-bootstrap:v1', 0)) AS acquired
      `);
      if (!lock.rows[0]?.acquired) fail('another managed PostgreSQL bootstrap holds the deployment lock');
      retainClient = true;
      return client;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /must run PostgreSQL|unexpected role|required PostgreSQL|CREATEDB|CREATEROLE|pg_signal_backend|did not negotiate|deployment lock/.test(error.message)) {
        throw error;
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000));
    } finally {
      if (!retainClient) await client.end().catch(() => {});
    }
  }
  fail(`managed database was not ready after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function safeChildEnv(overrides) {
  const env = { ...process.env };
  delete env.BOOTSTRAP_DATABASE_URL;
  delete env.DATABASE_URL;
  delete env.BOT_DATABASE_URL;
  delete env.OSHAL_APP_DB_PASSWORD;
  delete env.OSHAL_BOT_DB_PASSWORD;
  return { ...env, ...overrides };
}

function runNodeStep(label, args, env) {
  console.log(`[managed-postgres] ${label}...`);
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}

function runMigrations(config) {
  const source = `
    const { Pool } = require('pg');
    const { DatabaseBootstrapService } = require(${JSON.stringify(MIGRATION_RUNNER)});
    const pool = new Pool({ connectionString: process.env.BOOTSTRAP_DATABASE_URL, max: 1 });
    new DatabaseBootstrapService(pool).applyMigrations()
      .then((files) => console.log('[managed-postgres] migrations applied:', files.length))
      .then(() => pool.end())
      .catch((error) => pool.end().finally(() => { console.error('[managed-postgres] migration failure:', error.message); process.exitCode = 1; }));
  `;
  runNodeStep('applying migrations', ['-e', source], safeChildEnv({
    BOOTSTRAP_DATABASE_URL: config.bootstrapUrl,
    RUN_MIGRATIONS: 'true',
    OSHAL_SCHEMA_BOOTSTRAP: 'apply',
  }));
}

function applyRls(config) {
  runNodeStep('enforcing core RLS', [RLS_APPLIER], safeChildEnv({
    DATABASE_URL: config.bootstrapUrl,
    OSHAL_RLS_APPLY: 'apply-enforce',
  }));
}

async function proveRuntime(url, expectedRole) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query(`
      SELECT current_user AS role_name, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit
        FROM pg_roles WHERE rolname = current_user
    `);
    const role = result.rows[0];
    if (!role || role.role_name !== expectedRole || role.rolsuper || role.rolcreaterole
      || role.rolcreatedb || role.rolbypassrls || role.rolinherit) {
      fail(`${expectedRole} runtime proof returned an unexpected identity or attribute posture`);
    }
    return role.role_name;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const config = validateManagedConfiguration();
  if (process.argv.includes('--preflight-only')) {
    console.log(JSON.stringify({ valid: true, host: config.host, port: config.port, database: config.database, local: config.local }));
    return;
  }

  validateRuntimeAssets();
  const lockClient = await inspectServer(config); // all read-only checks precede the first mutation
  try {
    await provisionRuntimeRoles({ ...config, phase: 'pre-migration' });
    runMigrations(config);
    applyRls(config);
    await provisionRuntimeRoles({ ...config, phase: 'final' });

    const [appRole, botRole] = await Promise.all([
      proveRuntime(config.appUrl, 'oshal_app'),
      proveRuntime(config.botUrl, 'oshal_bot'),
    ]);
    if (appRole === botRole) fail('application and bot runtime identities must be distinct');
    console.log(JSON.stringify({ initialized: true, database: config.database, postgresMajor: 18, appRole, botRole }));
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended('oshal:managed-postgres-bootstrap:v1', 0))`).catch(() => {});
    await lockClient.end().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[managed-postgres] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
