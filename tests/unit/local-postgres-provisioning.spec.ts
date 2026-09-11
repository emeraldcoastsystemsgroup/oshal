/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual runtime-role provisioning against disposable PostgreSQL16 for local superuser and managed creator membership paths.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionRuntimeRoles } from '../../scripts/governance/provision-app-role.mjs';

const appPassword = randomBytes(24).toString('hex');
const botPassword = randomBytes(24).toString('hex');
const ownerPassword = randomBytes(24).toString('hex');
let container: string;
let started = false;
let pool: Pool;
let port: number;

/** @description Run Docker only for the uniquely named disposable database.
 * @param args Fixed test commands. @returns Trimmed command output.
 */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

/** @description Build a connection exclusively to the ephemeral loopback fixture.
 * @param user Fixture database role. @param password Generated fixture credential.
 * @returns Fixture connection URL, never logged.
 */
function databaseUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@127.0.0.1:${port}/role_fixture`;
}

/** @description Run the actual SQL and strict role verifier without historical app migrations.
 * @param bootstrapRole Fixture owner or managed creator. @returns Verified provisioning result.
 */
function provision(bootstrapRole = 'postgres') {
  return provisionRuntimeRoles({ bootstrapUrl: databaseUrl(bootstrapRole, ownerPassword),
    appUrl: databaseUrl('oshal_app', appPassword), botUrl: databaseUrl('oshal_bot', botPassword), phase: 'pre-migration' });
}

/** @description Reproduce the two existing local memberships with ADMIN absent.
 * @returns Completion after fixture-only role creation.
 */
async function existingLocalRoles(): Promise<void> {
  await pool.query(`CREATE ROLE oshal_app LOGIN NOSUPERUSER NOINHERIT;
    CREATE ROLE oshal_bot LOGIN NOSUPERUSER NOINHERIT;
    GRANT oshal_app TO postgres WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;
    GRANT oshal_bot TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`);
}

/** @description Read effective membership options without credentials or application data.
 * @returns Exact role, member and independent option tuples.
 */
async function memberships() {
  return (await pool.query(`SELECT role.rolname AS role, member.rolname AS member,
    bool_or(m.admin_option) AS admin, bool_or(m.inherit_option) AS inherit, bool_or(m.set_option) AS set
    FROM pg_auth_members m JOIN pg_roles role ON role.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
    WHERE role.rolname IN ('oshal_app','oshal_bot') GROUP BY role.rolname,member.rolname ORDER BY 1,2`)).rows;
}

beforeEach(async () => {
  container = `oshal-provision-fixture-${randomUUID().slice(0, 8)}`;
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data', '--env', `POSTGRES_PASSWORD=${ownerPassword}`,
    '--env', 'POSTGRES_DB=role_fixture', 'postgres:16-alpine']);
  started = true; port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  pool = new Pool({ connectionString: databaseUrl('postgres', ownerPassword), connectionTimeoutMillis: 500 });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await pool.query('SELECT 1'); return; } catch { await new Promise(done => setTimeout(done, 200)); }
  }
  throw new Error('Disposable PostgreSQL16 role fixture unavailable');
}, 90_000);

afterEach(async () => {
  await pool?.end();
  if (started) { docker(['rm', '--force', container]); started = false; }
});

describe('PostgreSQL16 runtime-role membership convergence', () => {
  it('repairs existing superuser grants and passes the unchanged verifier on repeated runs', async () => {
    await existingLocalRoles();
    expect((await memberships()).every(row => row.admin === false)).toBe(true);
    expect((await provision()).provisioned).toBe(true);
    expect(await memberships()).toEqual([
      { role: 'oshal_app', member: 'postgres', admin: true, inherit: true, set: true },
      { role: 'oshal_bot', member: 'postgres', admin: true, inherit: false, set: false },
    ]);
    expect((await provision()).provisioned).toBe(true);
    const roles = (await pool.query("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname IN ('oshal_app','oshal_bot')")).rows;
    expect(roles.every(role => !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole)).toBe(true);
  });

  it('preserves managed non-superuser creator ADMIN without the forbidden regrant', async () => {
    await pool.query(`CREATE ROLE fixture_admin LOGIN PASSWORD '${ownerPassword}' CREATEROLE CREATEDB BYPASSRLS;
      GRANT pg_signal_backend TO fixture_admin; ALTER DATABASE role_fixture OWNER TO fixture_admin`);
    expect((await provision('fixture_admin')).provisioned).toBe(true);
    expect((await provision('fixture_admin')).provisioned).toBe(true);
    expect(await memberships()).toEqual([
      { role: 'oshal_app', member: 'fixture_admin', admin: true, inherit: true, set: true },
      { role: 'oshal_bot', member: 'fixture_admin', admin: true, inherit: false, set: false },
    ]);
  });

  it('still rejects an unexpected principal membership and leaves worker login disabled', async () => {
    await existingLocalRoles();
    await pool.query('CREATE ROLE fixture_unexpected; GRANT oshal_bot TO fixture_unexpected');
    await expect(provision()).rejects.toThrow('unexpected app/bot role membership detected');
    expect((await pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='oshal_bot'")).rows[0].rolcanlogin).toBe(false);
  });
});
