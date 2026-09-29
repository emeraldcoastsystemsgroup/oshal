/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The boot sequence, end to end, on a disposable server: the real migration runner applies the whole scripts/migrations tree, apply-rls.mjs enforces, and the real provisioner runs its final phase. Migrations 174-178 added 24 SECURITY DEFINER functions that the approved-helper list did not carry, and nothing went red: the provisioning fixture seeds its helpers FROM that list, and the location fixture grants with a hand-written stand-in for the provisioner, so neither crossed the migration-to-provisioner boundary. The api then exited at boot on the first database that had applied them. No collaborator is doubled here.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseBootstrapService } from '@/features/tool-registry';
import { EXPECTED_HELPERS, provisionRuntimeRoles } from '../../scripts/governance/provision-app-role.mjs';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/** The live stack's datastore image (docker-compose.oshal-local.yml), so migration 070 does not self-skip. */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const REPO_ROOT = resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'scripts', 'migrations');

/** The provisioner's own helper census predicate, so this spec counts what the final phase counts. */
const HELPER_CENSUS = `
  SELECT p.oid::regprocedure::text AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (
       p.prosecdef
       OR p.proname IN ('oshal_is_tenant_member', 'oshal_owns_task', 'oshal_owns_ticket',
                        'oshal_application_execution_claims', 'oshal_swarm_memory_readable')
     )
   ORDER BY signature`;

const appPassword = randomBytes(24).toString('hex');
const botPassword = randomBytes(24).toString('hex');
const savedEnv = { RUN_MIGRATIONS: process.env.RUN_MIGRATIONS, OSHAL_SCHEMA_BOOTSTRAP: process.env.OSHAL_SCHEMA_BOOTSTRAP };
const db = new DisposablePostgres({
  purpose: 'provisioner-migrated-helpers',
  image: POSTGRES_IMAGE,
  database: 'oshal',
  memory: '512m',
  max: 4,
  statementTimeoutMs: 120_000,
});

/**
 * @description A connection URL to the private fixture server, never to a deployment.
 * @param user - The role that connects.
 * @param password - That role's generated credential.
 * @returns The URL; it is never logged.
 */
function fixtureUrl(user: string, password: string): string {
  const { host, port, database } = db.connection;
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/**
 * @description The superuser URL the boot sequence calls BOOTSTRAP_DATABASE_URL.
 * @returns The fixture owner's URL.
 */
function bootstrapUrl(): string {
  const { user, password } = db.connection;
  return fixtureUrl(user, password);
}

/**
 * @description Enforce core RLS with the real script, as the api does between migrating and
 * provisioning. The child receives the fixture address only; no inherited DSN reaches it.
 * @returns Nothing; throws when the script exits non-zero.
 */
function enforceRls(): void {
  execFileSync(process.execPath, ['scripts/governance/apply-rls.mjs'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: bootstrapUrl(), OSHAL_RLS_APPLY: 'apply-enforce' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/**
 * @description Run the real provisioner's final phase against the fixture.
 * @returns The provisioner's verified result.
 */
function provisionFinal() {
  return provisionRuntimeRoles({
    bootstrapUrl: bootstrapUrl(),
    appUrl: fixtureUrl('oshal_app', appPassword),
    botUrl: fixtureUrl('oshal_bot', botPassword),
    phase: 'final',
  });
}

/**
 * @description The privileged functions present on the migrated server.
 * @returns Their signatures, as the provisioner reads them.
 */
async function helpersOnServer(): Promise<string[]> {
  return (await db.pool.query<{ signature: string }>(HELPER_CENSUS)).rows.map((row) => row.signature);
}

describe('the final provisioning phase over the whole migration tree', () => {
  beforeAll(async () => {
    await db.start();
    process.env.RUN_MIGRATIONS = 'true';
    delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    await new DatabaseBootstrapService(db.pool, MIGRATIONS_DIR).applyMigrations();
    enforceRls();
  }, 420_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await db.stop();
  }, 90_000);

  it('finds every privileged function the migrations create on the approved list, and nothing approved missing', async () => {
    const found = await helpersOnServer();
    expect(found.filter((signature) => !EXPECTED_HELPERS.has(signature))).toEqual([]);
    expect([...EXPECTED_HELPERS].filter((signature) => !found.includes(signature))).toEqual([]);
  }, 60_000);

  it('passes on the migrated server, and again on the next boot', async () => {
    expect((await provisionFinal()).provisioned).toBe(true);
    expect((await provisionFinal()).provisioned).toBe(true);
  }, 240_000);

  it('refuses to boot when a migration adds a privileged function that was never registered', async () => {
    await db.pool.query(`CREATE FUNCTION fixture_unregistered_definer() RETURNS boolean LANGUAGE sql
      SECURITY DEFINER SET search_path = public, pg_temp AS 'SELECT false'`);
    try {
      await expect(provisionFinal()).rejects.toThrow(
        `final provisioning requires exactly ${EXPECTED_HELPERS.size} approved helpers; found ${EXPECTED_HELPERS.size + 1}`,
      );
    } finally {
      await db.pool.query('DROP FUNCTION fixture_unregistered_definer()');
    }
    expect((await provisionFinal()).provisioned).toBe(true);
  }, 240_000);
});
