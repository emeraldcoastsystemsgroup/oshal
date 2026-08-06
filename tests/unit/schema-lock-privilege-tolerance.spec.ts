/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard applyLockedSchema's privilege tolerance across the REAL owner/app role split. The defect was structural: one transaction, so the first owner-only statement rolled back every statement before it and skipped every statement after it — on the remote-task journal that silently dropped the immutability trigger and five tables' owner-RLS policies while the app served traffic. Both roles are real here on purpose. A mocked pool cannot raise 42501, cannot roll back to a savepoint, and would pass against the broken implementation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { applyLockedSchema, SCHEMA_LOCK_KEYS } from '@/shared/services/database/schema-lock';

const HOST = `127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}`;
/** Schema OWNER (superuser) — the role the migrator runs as. */
const OWNER_DSN = process.env.SCHEMA_LOCK_OWNER_DSN ?? `postgresql://oshal:oshal@${HOST}/oshal`;

/** Unique per run so a parallel run cannot collide on the fixture object names. */
const TAG = `slpt_${process.pid.toString(36)}`;
const FN = `${TAG}_owner_only_fn`;
const TBL = `${TAG}_bootstrap_table`;
/**
 * The non-owner side is a throwaway role this spec creates and drops, NOT the deployment's
 * oshal_app. Reusing oshal_app would make the guard depend on a deployment password it has no
 * business knowing, and a guard that cannot authenticate is a guard that silently stops running.
 * What is under test is the owner/non-owner mechanic, which any non-owner reproduces exactly.
 */
const APP_ROLE = `${TAG}_runtime`;
const APP_PASSWORD = 'schema-lock-guard-local-only';
const APP_DSN = `postgresql://${APP_ROLE}:${APP_PASSWORD}@${HOST}/oshal`;
/** Distinct from every SCHEMA_LOCK_KEYS value so this never serializes against a real bootstrap. */
const LOCK = 47119999;

let owner: Pool;
let app: Pool;

/** Strips the password so a connection failure is safe to print. */
const safe = (dsn: string) => dsn.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');

describe('applyLockedSchema privilege tolerance', () => {
  beforeAll(async () => {
    owner = new Pool({ connectionString: OWNER_DSN, max: 2, connectionTimeoutMillis: 5_000 });
    // Fail LOUDLY rather than skipping — the whole point is the two-role boundary, and a guard
    // that vanishes when the database is absent is not a guard.
    await owner.query('SELECT 1').catch((err: Error) => {
      throw new Error(
        `schema-lock guard needs the owner role at ${safe(OWNER_DSN)} — ${err.message}. ` +
        'Start the stack (bash scripts/oshal-up.sh).',
      );
    });
    // Mint the throwaway non-owner. LOGIN + the CREATE right on public (so it can make ITS OWN
    // objects) but no ownership of anything the owner creates — the exact ADR-076 posture.
    await owner.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await owner.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
    await owner.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${APP_ROLE}`);
    app = new Pool({ connectionString: APP_DSN, max: 2, connectionTimeoutMillis: 5_000 });
    // The owner creates a function only IT may replace. This is the shape that broke the journal.
    await owner.query(
      `CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$`,
    );
  }, 30_000);

  afterAll(async () => {
    await app?.end();
    await owner?.query(`DROP FUNCTION IF EXISTS ${FN}()`).catch(() => { /* best-effort */ });
    await owner?.query(`DROP TABLE IF EXISTS ${TBL}`).catch(() => { /* best-effort */ });
    await owner?.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => { /* best-effort */ });
    await owner?.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => { /* best-effort */ });
    await owner?.end();
  });

  it('confirms the two roles really are owner and non-owner', async () => {
    const { rows } = await owner.query<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = $1`,
      [FN],
    );
    expect(rows[0]?.owner).toBe('oshal');
    const who = await app.query<{ current_user: string }>('SELECT current_user');
    expect(who.rows[0]?.current_user, 'app pool is not connecting as the throwaway role').toBe(APP_ROLE);
  });

  it('applies what the app role CAN run and reports only what it cannot', async () => {
    // Owner-only statement sits FIRST, so the pre-savepoint implementation would roll back the
    // whole transaction and never reach the table — which is exactly how the journal lost its
    // trigger and RLS policies.
    const result = await applyLockedSchema(app, LOCK, [
      `CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE TABLE IF NOT EXISTS ${TBL} (id int primary key)`,
    ]);

    expect(result.privilegeDenied, 'the owner-only statement should be the only skip').toHaveLength(1);
    expect(result.privilegeDenied[0]).toContain(FN);

    // The statement AFTER the denied one must have committed. This is the assertion that fails
    // against the old all-or-nothing implementation.
    const { rows } = await owner.query(
      `SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${TBL}`],
    );
    expect(rows[0]?.present, 'statement after a privilege-denied one was lost').toBe(true);
  });

  it('still aborts on a non-privilege error — tolerance is scoped to 42501 only', async () => {
    // A syntax error is a real defect. Swallowing everything would turn this fix into a way to
    // ship a broken bootstrap quietly, which is the failure mode it exists to remove.
    await expect(
      applyLockedSchema(app, LOCK, [`CREATE TABLE ${TAG}_bad (this is not valid sql)`]),
    ).rejects.toThrow();
  });

  it('runs every statement as the OWNER with nothing denied', async () => {
    const result = await applyLockedSchema(owner, LOCK, [
      `CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$`,
    ]);
    expect(result.privilegeDenied, 'the owner should never be privilege-denied').toEqual([]);
  });

  it('keeps the runtime role a NON-owner of the live journal tamper guard', async () => {
    // The tempting "fix" for the boot error is ALTER FUNCTION … OWNER TO oshal_app. That hands the
    // app role — reachable from a compromised bot — ownership of the append-only trigger it is
    // supposed to be constrained by, so it could DROP or REPLACE its own guard. Pin the split on
    // the LIVE function, not the fixture: this is the one assertion about the deployment itself.
    const { rows } = await owner.query<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'oshal_reject_remote_task_event_mutation'`,
    );
    expect(rows[0]?.owner, 'remote-task journal guard function is missing').toBeDefined();
    expect(rows[0]?.owner, 'the runtime role must never own its own tamper guard').not.toBe('oshal_app');
  });
});
