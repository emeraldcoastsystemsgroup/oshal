/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard applyLockedSchema's privilege tolerance across the REAL owner/app role split. The defect was structural: one transaction, so the first owner-only statement rolled back every statement before it and skipped every statement after it — on the remote-task journal that silently dropped the immutability trigger and five tables' owner-RLS policies while the app served traffic. Both roles are real here on purpose. A mocked pool cannot raise 42501, cannot roll back to a savepoint, and would pass against the broken implementation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | This file now STARTS its own PostgreSQL and removes it, instead of resolving an address at all. Refusing an unpointed run made the 2026-09-14 accident impossible, but it refused at MODULE scope — `specDatabaseUrl` ran in a top-level `const`, nothing in the repo sets SCHEMA_LOCK_OWNER_DSN or OSHAL_TEST_DSN, so vitest reported a Failed Suite with ZERO cases executed and this guard has never run in any gate. Refusal is the right verdict on a dangerous address and still the wrong shape of answer, because the savepoint fix it watches was then watched by nothing: the all-or-nothing bootstrap could have been reinstated and every gate would have stayed green. Owning the server removes the question — there is no value a caller can supply that would reach a deployment, and the DROP FUNCTION / DROP TABLE / DROP OWNED BY / DROP ROLE teardown goes with it, since the container is destroyed and no cleanup SQL runs anywhere. `roles: ['oshal_app']` replaces the throwaway role the file used to mint: the reason for a throwaway was that reusing oshal_app meant depending on a deployment password, and the fixture mints that password itself, so the privilege mechanic is now exercised against the role ADR-076 actually names, self-validated NOSUPERUSER + NOBYPASSRLS in the first case. `migrations: ['115-durable-remote-task-journal.sql']` supplies the journal tamper guard: the last case used to read the LIVE deployment's function, which a private server does not have, so it now asserts over the product of the deployment's OWN migration — an `ALTER FUNCTION ... OWNER TO oshal_app` added to that file turns it red. That file is only ONE of the TWO places the function is created, which the first draft of this entry got wrong: src/shared/services/database/remote-task-journal-schema.ts builds the same statement and applies it through runRuntimeSchemaBootstrap, and THAT is the path that raises the 42501 boot error the tempting fix responds to. A fifth case now drives ensureRemoteTaskJournalSchema against the fixture and repeats the ownership assertion, so neither site can hand the runtime role its own tamper guard unseen. The role is declared as `roles: [{ name: APP_ROLE, max: 2 }]`, the object form, not a bare name. It no longer observes a deployment that drifted by hand after migration; that claim left with the shared address. The `'oshal'` literal in the owner check became the fixture's superuser for the same reason.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { applyLockedSchema, SCHEMA_LOCK_KEYS } from '@/shared/services/database/schema-lock';
import { ensureRemoteTaskJournalSchema } from '@/shared/services/database/remote-task-journal-schema';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/**
 * The runtime role under ADR-076: deliberately NOT the schema owner. It is the deployment's own
 * name rather than a throwaway because the fixture mints its password — the reason this file used
 * to invent a role was that reusing oshal_app meant knowing a deployment credential, and there is
 * no deployment here to know one of.
 */
const APP_ROLE = 'oshal_app';

/**
 * A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
 * No libpq `options` — neither pool this replaces declared any, and `-c row_security=off` on the
 * non-superuser role would turn an enforced read into an error rather than a filtered result.
 * The migration is the deployment's own: it is what creates the remote-task journal's append-only
 * trigger function, which the last case asserts the runtime role does not own.
 */
const database = new DisposablePostgres({
  purpose: 'schema-lock-privilege-tolerance', database: 'schema_lock_fixture',
  memory: '256m', max: 2, connectionTimeoutMillis: 5_000, statementTimeoutMs: 60_000,
  migrations: ['115-durable-remote-task-journal.sql'],
  roles: [{ name: APP_ROLE, max: 2 }],
});

/** Names the fixture objects. The server is private, so this is legibility, not collision control. */
const TAG = `slpt_${process.pid.toString(36)}`;
const FN = `${TAG}_owner_only_fn`;
const TBL = `${TAG}_bootstrap_table`;
/** Distinct from every SCHEMA_LOCK_KEYS value so this never serializes against a real bootstrap. */
const LOCK = 47119999;

let owner: Pool;
let app: Pool;

describe('applyLockedSchema privilege tolerance', () => {
  beforeAll(async () => {
    owner = await database.start();
    app = database.rolePool(APP_ROLE);
    // The owner creates a function only IT may replace. This is the shape that broke the journal.
    await owner.query(
      `CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$`,
    );
  }, 120_000);

  // No cleanup pass: the whole server goes away, so there is nothing to drop and nowhere to drop it.
  afterAll(async () => { await database.stop(); });

  it('confirms the two roles really are owner and non-owner', async () => {
    const { rows } = await owner.query<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = $1`,
      [FN],
    );
    expect(rows[0]?.owner, 'the owner-only function must belong to the schema owner').toBe(database.connection.user);
    const who = await app.query<{ current_user: string }>('SELECT current_user');
    expect(who.rows[0]?.current_user, 'app pool is not connecting as the runtime role').toBe(APP_ROLE);
    // The role is supplied by the fixture now, so pin what makes every 42501 below non-vacuous:
    // a superuser is denied nothing, and would pass this file against the broken implementation.
    const privilege = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(privilege.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
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

  it('keeps the runtime role a NON-owner of the journal tamper guard its own migration creates', async () => {
    // The tempting "fix" for the boot error is ALTER FUNCTION … OWNER TO oshal_app. That hands the
    // app role — reachable from a compromised bot — ownership of the append-only trigger it is
    // supposed to be constrained by, so it could DROP or REPLACE its own guard. The function here
    // is the product of scripts/migrations/115-durable-remote-task-journal.sql, applied to a server
    // where oshal_app really exists: an ALTER OWNER added to that file would SUCCEED and be caught
    // here, rather than failing for the unrelated reason that the role was absent.
    const { rows } = await owner.query<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'oshal_reject_remote_task_event_mutation'`,
    );
    expect(rows[0]?.owner, 'remote-task journal guard function is missing').toBeDefined();
    expect(rows[0]?.owner, 'the runtime role must never own its own tamper guard').not.toBe(APP_ROLE);
  });

  it('keeps it a non-owner through the RUNTIME bootstrap too, which is where the boot error is raised', async () => {
    // The case above watches scripts/migrations/115. That is only ONE of the two places this
    // function is created: src/shared/services/database/remote-task-journal-schema.ts builds the
    // same CREATE OR REPLACE and applies it through runRuntimeSchemaBootstrap. That path is the
    // one that actually RAISES the 42501 boot error, so it is where the tempting
    // `ALTER FUNCTION ... OWNER TO oshal_app` would most naturally be added — and an ALTER OWNER
    // added there would have left the migration-only check above completely green.
    await ensureRemoteTaskJournalSchema(owner);
    const { rows } = await owner.query<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'oshal_reject_remote_task_event_mutation'`,
    );
    expect(rows[0]?.owner, 'the bootstrap did not leave the tamper guard in place').toBeDefined();
    expect(rows[0]?.owner, 'the runtime bootstrap handed the runtime role its own tamper guard').not.toBe(APP_ROLE);
  });
});
