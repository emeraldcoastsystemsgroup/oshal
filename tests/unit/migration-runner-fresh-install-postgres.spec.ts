/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fresh-install gate on a disposable PostgreSQL (the live stack's pgvector/pgvector:pg16 image): the real migration runner applies the whole scripts/migrations tree, every file ends with exactly one app_migrations row, and migrations 127-137 - which carried their own BEGIN;/COMMIT; and so committed the runner's transaction before the history INSERT - now travel the runner-owned-transaction path on a checked-out client, while the four legacy self-managed files still take the direct pool path (so the observation is proven to tell the two apart). Fails LOUDLY without Docker; a skipping guard is no guard.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseBootstrapService } from '@/features/tool-registry';

/** The live stack's datastore image (docker-compose.oshal-local.yml), so migration 070 does not self-skip. */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'scripts', 'migrations');

/** Files that carried a top-level BEGIN;/COMMIT; pair until they were made runner-owned, with one relation each creates. */
const RUNNER_OWNED_SINCE_FIX: Record<string, string> = {
  '127-application-authorization.sql': 'oshal_authorization_applications',
  '129-verified-principal-directory.sql': 'oshal_verified_principals',
  '130-jarvis-briefing-preferences.sql': 'jarvis_briefing_sources',
  '131-authorization-audit-indexes.sql': 'authorization_audit_revision',
  '132-application-remote-executions.sql': 'oshal_application_remote_executions',
  '133-queued-application-principals.sql': 'oshal_queued_application_principals',
  '134-principal-registrations.sql': 'oshal_principal_registrations',
  '135-external-tenant-memberships.sql': 'oshal_external_tenant_memberships',
  '136-test-lab-runs.sql': 'oshal_test_lab_runs',
  '137-test-lab-local-schedules.sql': 'oshal_test_lab_schedules',
};

/** Legacy files that still self-manage transactions; the runner sends them straight to pool.query. */
const LEGACY_SELF_MANAGED = [
  '060-platform-rls-tenancy.sql',
  '068-visual-response-artifacts.sql',
  '080-data-lifecycle.sql',
  '093-spatial-scans.sql',
];

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

const content = (file: string): string => readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');

/**
 * Records which path each SQL text took through the runner: `query` is the self-managed path
 * (pool-level, no runner transaction); a checked-out client is the runner-owned-transaction path.
 * Only the two members the runner uses are implemented; the cast keeps the real Pool type at the seam.
 */
class ObservedPool {
  readonly direct: string[] = [];
  readonly onClient: string[] = [];

  constructor(private readonly inner: Pool) {}

  query(text: string, values?: unknown[]) {
    this.direct.push(text);
    return this.inner.query(text, values);
  }

  async connect(): Promise<PoolClient> {
    const client = await this.inner.connect();
    const observed = {
      query: (text: string, values?: unknown[]) => {
        this.onClient.push(text);
        return client.query(text, values);
      },
      release: () => client.release(),
    };
    return observed as unknown as PoolClient;
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

const container = `oshal-migration-fixture-${randomUUID()}`;
let started = false;
let pool: Pool;
let observed: ObservedPool;
let applied: string[] = [];
const savedEnv = { RUN_MIGRATIONS: process.env.RUN_MIGRATIONS, OSHAL_SCHEMA_BOOTSTRAP: process.env.OSHAL_SCHEMA_BOOTSTRAP };

async function startPostgres(): Promise<Pool> {
  const password = randomUUID();
  docker(['run', '--detach', '--rm', '--name', container, '--label', 'oshal.test-fixture=migration-postgres',
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', '--memory', '512m', '--cpus', '1',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=oshal', POSTGRES_IMAGE]);
  started = true;
  const match = /:(\d+)$/.exec(docker(['port', container, '5432/tcp']));
  if (!match) throw new Error('Disposable PostgreSQL must publish exactly one loopback port');
  const fresh = new Pool({ host: '127.0.0.1', port: Number(match[1]), user: 'postgres', password, database: 'oshal', max: 4, connectionTimeoutMillis: 1_000 });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { await fresh.query('SELECT 1'); return fresh; }
    catch { await new Promise((tick) => setTimeout(tick, 400)); }
  }
  throw new Error('Disposable PostgreSQL did not become ready');
}

describe('fresh install: the real runner applies the whole migration tree on a disposable PostgreSQL', () => {
  beforeAll(async () => {
    pool = await startPostgres();
    observed = new ObservedPool(pool);
    process.env.RUN_MIGRATIONS = 'true';
    delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    applied = await new DatabaseBootstrapService(observed.asPool(), MIGRATIONS_DIR).applyMigrations();
  }, 300_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try { await pool?.end(); } finally { if (started) docker(['rm', '--force', container]); }
  }, 60_000);

  it('applies every file once and records exactly one app_migrations row per file', async () => {
    const tree = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
    expect(applied).toEqual(tree);
    const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM app_migrations ORDER BY filename');
    expect(rows.map((row) => row.filename)).toEqual(tree);
  });

  it('migrations 127-137 run on the runner-owned client, never on the self-managed pool path', () => {
    for (const file of Object.keys(RUNNER_OWNED_SINCE_FIX)) {
      expect(observed.onClient, `${file} must run inside the runner-owned transaction`).toContain(content(file));
      expect(observed.direct, `${file} must not take the self-managed path`).not.toContain(content(file));
    }
  });

  it('the four legacy self-managed files still take the direct path, so the observation tells the paths apart', () => {
    for (const file of LEGACY_SELF_MANAGED) {
      expect(observed.direct, `${file} is self-managed and must bypass the runner transaction`).toContain(content(file));
      expect(observed.onClient).not.toContain(content(file));
    }
  });

  it('each of 127-137 left the relation it creates on the fresh database', async () => {
    for (const [file, relation] of Object.entries(RUNNER_OWNED_SINCE_FIX)) {
      const { rows } = await pool.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${relation}`]);
      expect(rows[0].present, `${file} must have created ${relation}`).toBe(true);
    }
  });
});
