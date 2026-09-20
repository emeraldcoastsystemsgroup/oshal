/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The contract behind DisposablePostgres `roles:`, proven by BEHAVIOUR rather than by reading its DDL. A superuser bypasses row-level security unconditionally, so a fixture that handed back a superuser connection — or created the extra role WITH superuser or bypassrls — would make every RLS assertion written over it pass while the policy was never consulted. That is the failure this file exists to catch, so the central case is a real FORCE-RLS table read twice: the role sees only what its policy allows (and nothing at all with the setting unset), while the superuser on the same table sees every row. Alongside it: the role's own self-validation (current_user + rolsuper=false + rolbypassrls=false, the shape trading-book-report-scripts asserts), that the password is MINTED here rather than inherited — a run with PGPASSWORD, POSTGRES_PASSWORD and OSHAL_TEST_APP_DSN all naming another value still gets the fixture's own, and the decoy is REFUSED by the server — and that stop() removes the container whatever roles were created.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Client, type Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/** The role every case is about: a non-superuser the fixture creates for itself. */
const ROLE = 'oshal_app';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// No `row_security=off` — the superuser's unfiltered read is one half of the property under test,
// and that option would turn it into an error rather than a read.
const database = new DisposablePostgres({
  purpose: 'disposable-postgres-roles', database: 'roles_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 30_000, roles: [ROLE],
});
let superPool: Pool;

/** Whether Docker still knows this container at all — `--rm` plus `rm --force` should leave nothing. */
function containerExists(name: string): boolean {
  const out = execFileSync('docker', ['ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return out.trim().split(/\r?\n/).filter(Boolean).includes(name);
}

/** Fixtures a case starts for itself, torn down even when its assertions fail. */
const extra: DisposablePostgres[] = [];
const track = (fixture: DisposablePostgres): DisposablePostgres => { extra.push(fixture); return fixture; };
afterEach(async () => { while (extra.length) await extra.pop()!.stop(); });

beforeAll(async () => {
  superPool = await database.start();
  // One FORCE-RLS table, owned by the superuser, readable by the role only through its policy.
  await superPool.query(`CREATE TABLE guard_rows (owner text NOT NULL, note text NOT NULL)`);
  await superPool.query(`ALTER TABLE guard_rows ENABLE ROW LEVEL SECURITY`);
  await superPool.query(`ALTER TABLE guard_rows FORCE ROW LEVEL SECURITY`);
  await superPool.query(`CREATE POLICY guard_own ON guard_rows USING (owner = current_setting('spec.owner', true))`);
  await superPool.query(`GRANT SELECT ON guard_rows TO ${ROLE}`);
  await superPool.query(`INSERT INTO guard_rows (owner, note) VALUES ('alice','a'),('bob','b')`);
}, 180_000);

afterAll(async () => { await database.stop(); });

describe('DisposablePostgres roles — a NON-superuser the fixture minted, not a superuser in disguise', () => {
  it('the created role connects, and self-validates as neither superuser nor bypassrls', async () => {
    const result = await database.rolePool(ROLE).query(
      `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    // The exact self-validation trading-book-report-scripts makes before trusting its RLS reads.
    expect(result.rows[0]).toMatchObject({ current_user: ROLE, rolsuper: false, rolbypassrls: false });
    // The superuser pool is a genuinely different session, not the same connection renamed.
    const asSuper = await superPool.query(`SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user`);
    expect(asSuper.rows[0]).toMatchObject({ current_user: 'postgres', rolsuper: true });
  }, 60_000);

  it('a FORCE-RLS table is really enforced against the role, and not against the superuser', async () => {
    const client = await database.rolePool(ROLE).connect();
    try {
      // Nothing set: the policy compares against NULL, so an enforced read returns no rows at all.
      expect((await client.query(`SELECT count(*)::int AS n FROM guard_rows`)).rows[0].n).toBe(0);
      await client.query(`SELECT set_config('spec.owner', 'alice', false)`);
      const scoped = await client.query(`SELECT owner FROM guard_rows`);
      expect(scoped.rows.map(row => row.owner)).toEqual(['alice']);   // a bypassing role would list both
    } finally { client.release(); }

    // The same two rows, same table, same moment — the superuser is exempt from RLS, which is
    // exactly why handing a spec the superuser connection would prove nothing about the policy.
    const seenBySuper = await superPool.query(`SELECT owner FROM guard_rows ORDER BY owner`);
    expect(seenBySuper.rows.map(row => row.owner)).toEqual(['alice', 'bob']);
  }, 60_000);

  it('mints the role password instead of inheriting one the environment names', async () => {
    const decoy = 'decoy-password-from-the-environment';
    const before = {
      pg: process.env.PGPASSWORD, postgres: process.env.POSTGRES_PASSWORD, dsn: process.env.OSHAL_TEST_APP_DSN,
    };
    process.env.PGPASSWORD = decoy;
    process.env.POSTGRES_PASSWORD = decoy;
    process.env.OSHAL_TEST_APP_DSN = `postgresql://${ROLE}:${decoy}@127.0.0.1:5432/oshal`;
    const fixture = track(new DisposablePostgres({ purpose: 'roles-env', database: 'roles_env', roles: [ROLE] }));
    try {
      await fixture.start();
      const connection = fixture.roleConnection(ROLE);
      expect(connection.user).toBe(ROLE);
      expect(connection.password).not.toBe(decoy);
      expect(connection.password).toMatch(/^[0-9a-f-]{36}$/);        // minted here, like the superuser's
      expect(connection.password).not.toBe(fixture.connection.password);

      // Behavioural, not a string comparison: the server refuses the value the environment named.
      const impostor = new Client({ ...connection, password: decoy, connectionTimeoutMillis: 5_000 });
      const refusal = await impostor.connect().then(() => null, (error: unknown) => error as Error);
      await impostor.end().catch(() => { /* never connected */ });
      expect(refusal, 'the environment password was ACCEPTED — the fixture is not minting its own').toBeInstanceOf(Error);
      expect(refusal!.message).toMatch(/password authentication failed/i);

      // ...and the minted one is accepted.
      const owner = new Client({ ...connection, connectionTimeoutMillis: 5_000 });
      await owner.connect();
      try { expect((await owner.query('SELECT current_user')).rows[0].current_user).toBe(ROLE); }
      finally { await owner.end(); }
    } finally {
      if (before.pg === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = before.pg;
      if (before.postgres === undefined) delete process.env.POSTGRES_PASSWORD; else process.env.POSTGRES_PASSWORD = before.postgres;
      if (before.dsn === undefined) delete process.env.OSHAL_TEST_APP_DSN; else process.env.OSHAL_TEST_APP_DSN = before.dsn;
    }
  }, 180_000);

  it('stop() removes the container whatever roles were created, and the role handles go with it', async () => {
    // Tracked as well as stopped inline: a case that fails BEFORE its own stop() would otherwise
    // strand the container it started, which is the residue this whole helper exists to prevent.
    // stop() is safe to call again, and the assertions below pin that.
    const fixture = track(new DisposablePostgres({ purpose: 'roles-stop', database: 'roles_stop', roles: [ROLE, 'oshal_reader'] }));
    await fixture.start();
    expect(containerExists(fixture.containerName)).toBe(true);
    expect((await fixture.rolePool('oshal_reader').query('SELECT current_user')).rows[0].current_user).toBe('oshal_reader');

    await fixture.stop();
    expect(containerExists(fixture.containerName)).toBe(false);
    await fixture.stop();                                            // second call must not throw
    expect(() => fixture.roleConnection(ROLE)).toThrow(/not started/);
  }, 180_000);

  it('refuses a role name it would have to interpolate into DDL, and has no roles it was not given', () => {
    expect(() => new DisposablePostgres({ purpose: 'roles-bad', roles: ['oshal_app; DROP TABLE x'] })).toThrow(/role name/);
    expect(() => new DisposablePostgres({ purpose: 'roles-bad', roles: ['Oshal_App'] })).toThrow(/role name/);
    // The 20+ callers that declare no roles keep the API they had: nothing to name, nothing to hand back.
    expect(() => new DisposablePostgres({ purpose: 'roles-none' }).roleConnection(ROLE)).toThrow(/not started/);
    expect(() => database.roleConnection('never_declared')).toThrow(/has no role/);
  });
});
