/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The standing guard on "a GRANT that did nothing must not record as APPLIED". Migration 099 wrapped all six of its blocks in EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE, the runner writes the app_migrations row regardless, and the file sat in the ledger for seven weeks proving only that it had executed. Everything here runs the REAL scripts/migrations/099-bot-db-role.sql against a REAL disposable PostgreSQL as a REAL under-privileged login - no mocked pool can raise 42501, and none can produce the two shapes that raise nothing at all: a schema GRANT by a non-owner returns "WARNING: no privileges were granted" and succeeds, and a REVOKE by a grant-option holder that does not own the table succeeds silently while the grantee keeps every privilege. Those two are why the fix is a privilege VERIFICATION and not just a deleted handler, and the last two cases go red if the verification is removed even when the handler stays gone. The compose case covers the same swallow one level up: the api boot discarded the exit status of the migration runner, the RLS enforce and the app-role provision, so a loud failure was re-silenced by the thing that ran it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two holes in the guard itself. (1) The compose case was VACUOUS for two of the three steps it claimed: one stub failed EVERY `node` invocation in the branch, so the migration runner exited first and apply-rls.mjs / provision-app-role.mjs were never reached - a regression in either could not turn this file red. The stub now dispatches on argv and fails exactly ONE step per run, each case asserting the steps before it ran, the steps after it did not, and that the boot named the step it refused on. (2) The migration's RLS-exempt refusal had no case at all: the role-attribute block only raises when oshal_bot has actually drifted AND the runner cannot correct it, which needs a superuser to create and a NOCREATEROLE login to meet. Both new shapes were mutation-proven red against the restored defect.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/** The bot login the migration provisions. Real name, because the migration hard-codes it. */
const BOT_ROLE = 'oshal_bot';
/**
 * Stands in for every runner that is neither superuser nor the table owner. The migration's own
 * header called that configuration privilege-TOLERANT; this spec is the assertion that it is not.
 */
const RUNNER_ROLE = 'grantless_runner';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MIGRATION_PATH = resolve(REPO_ROOT, 'scripts', 'migrations', '099-bot-db-role.sql');
const COMPOSE_PATH = resolve(REPO_ROOT, 'docker-compose.oshal-local.yml');

/** The file under test, read from disk so restoring the swallow turns these cases red. */
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

/**
 * A PostgreSQL this file owns. `migrations: []` on purpose - 099 is applied by hand, per case, as a
 * chosen role, which is the whole subject. Neither `oshal` nor `oshal_app` exists here, so every
 * privileged run also exercises the two undefined_object tolerances a fresh install depends on.
 */
const database = new DisposablePostgres({
  purpose: 'bot-role-grant-fail-loud', database: 'bot_grant_fixture',
  memory: '256m', max: 2, connectionTimeoutMillis: 5_000, statementTimeoutMs: 60_000,
  roles: [{ name: BOT_ROLE, max: 2 }, { name: RUNNER_ROLE, max: 2 }],
});

let owner: Pool;
let runner: Pool;

beforeAll(async () => {
  owner = await database.start();
  runner = database.rolePool(RUNNER_ROLE);
}, 180_000);

// No cleanup SQL: the whole server is destroyed, so nothing can run anywhere it was not created.
afterAll(async () => { await database.stop(); });

/**
 * @description Return the public schema to a known shape - no tables, and the baseline privileges
 * the fixture handed out. Each case then builds only the ownership it needs, so a failure can never
 * be inherited from the case before it.
 * @returns Nothing.
 */
async function resetPublic(): Promise<void> {
  const { rows } = await owner.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  );
  for (const row of rows) await owner.query(`DROP TABLE public."${row.relname}" CASCADE`);
  await owner.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${BOT_ROLE}, ${RUNNER_ROLE}`);
  await owner.query(`GRANT CREATE ON SCHEMA public TO ${RUNNER_ROLE}`);
}

/**
 * @description Read one effective table privilege for the bot role, as the superuser, so the answer
 * is the catalog's rather than an inference from whether a statement raised.
 * @param table Schema-qualified table name.
 * @param privilege Privilege keyword, e.g. `SELECT`.
 * @returns Whether oshal_bot effectively holds it.
 */
async function botHas(table: string, privilege: string): Promise<boolean> {
  const { rows } = await owner.query<{ held: boolean }>(
    'SELECT has_table_privilege($1, $2, $3) AS held', [BOT_ROLE, table, privilege],
  );
  return rows[0]!.held;
}

/**
 * @description Run the migration and hand back the failure message, so a case can assert on what the
 * message NAMES rather than only that something was thrown.
 * @param pool The pool whose role applies the migration.
 * @returns The rejection message, or `''` when the migration resolved.
 */
async function migrationFailure(pool: Pool): Promise<string> {
  try {
    await pool.query(MIGRATION_SQL);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * @description Apply the real migration as the fixture superuser on its own connection, collecting
 * every NOTICE and WARNING the server sends. The collected text is what proves a block was TOLERATED
 * rather than never reached, which a resolved promise alone cannot distinguish.
 * @returns The `severity: message` lines the server emitted while the migration ran.
 */
async function applyAsSuperuserCollectingNotices(): Promise<string[]> {
  const client = new Client({ ...database.connection, statement_timeout: 60_000 });
  const collected: string[] = [];
  client.on('notice', (notice) => collected.push(`${notice.severity}: ${notice.message}`));
  await client.connect();
  try {
    await client.query(MIGRATION_SQL);
    return collected;
  } finally {
    await client.end().catch(() => {});
  }
}

describe('migration 099 refuses to report success on a grant that did nothing', () => {
  it('confirms the runner really is under-privileged, so every refusal below is non-vacuous', async () => {
    const who = await runner.query<{ current_user: string }>('SELECT current_user');
    expect(who.rows[0]?.current_user, 'the runner pool is not connecting as the under-privileged role').toBe(RUNNER_ROLE);

    const attributes = await owner.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      'SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = ANY($1)',
      [[BOT_ROLE, RUNNER_ROLE]],
    );
    expect(attributes.rowCount, 'both roles must exist before the migration runs').toBe(2);
    for (const role of attributes.rows) {
      expect(role.rolsuper, `${role.rolname} would bypass every check in this file`).toBe(false);
      expect(role.rolbypassrls, `${role.rolname} would bypass row-level security`).toBe(false);
      expect(role.rolcreaterole, `${role.rolname} must not be able to create or alter roles`).toBe(false);
    }

    // The migration hard-codes these two role names; neither exists here, which is also what a fresh
    // compose boot looks like when 099 runs before provision-app-role.mjs has created them.
    const absent = await owner.query('SELECT 1 FROM pg_roles WHERE rolname IN ($1, $2)', ['oshal', 'oshal_app']);
    expect(absent.rowCount, 'neither default-privilege target role may exist on this fixture').toBe(0);
  });

  it('REJECTS the run when the grants are refused, naming the table and the role that attempted them', async () => {
    await resetPublic();
    await owner.query('CREATE TABLE public.bot_reachable_table (id integer primary key)');

    const message = await migrationFailure(runner);
    expect(message, 'a run whose GRANTs were refused must not resolve - that is what recorded 099 as applied')
      .toMatch(/migration 099: oshal_bot DML grants were REFUSED/);
    expect(message, 'the failure must name the role it was attempted as').toContain(`"${RUNNER_ROLE}"`);
    expect(message, 'the failure must name what could not be granted').toContain('bot_reachable_table');

    expect(await botHas('public.bot_reachable_table', 'SELECT'),
      'the refusal must be real: oshal_bot must hold nothing on the table').toBe(false);
  });

  it('APPLIES cleanly as a privileged runner, tolerating the two absent default-privilege roles', async () => {
    await resetPublic();
    await owner.query('CREATE TABLE public.bot_reachable_table (id integer primary key)');

    const notices = await applyAsSuperuserCollectingNotices();

    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await botHas('public.bot_reachable_table', privilege),
        `a privileged run must leave oshal_bot holding ${privilege}`).toBe(true);
    }

    // Both ALTER DEFAULT PRIVILEGES blocks target roles that do not exist here. They must warn and
    // continue: failing on them would refuse every fresh install, which this guard must not permit
    // either.
    const warnings = notices.filter((line) => line.startsWith('WARNING'));
    expect(warnings.some((line) => line.includes('FOR ROLE oshal did NOT apply')),
      'the absent-role tolerance for `oshal` must warn rather than fail').toBe(true);
    expect(warnings.some((line) => line.includes('FOR ROLE oshal_app did NOT apply')),
      'the absent-role tolerance for `oshal_app` must warn rather than fail').toBe(true);
  });

  it('REJECTS a schema grant that warned instead of raising and granted nothing', async () => {
    await resetPublic();
    // The runner owns the only table, so the DML grants succeed and cannot mask the schema grant.
    await runner.query('CREATE TABLE public.runner_owned_table (id integer primary key)');
    // Strip the bot's schema usage from every source of it. GRANT USAGE ON SCHEMA public by a
    // non-owner then returns "WARNING: no privileges were granted" and SUCCEEDS - the exact shape
    // that deleting the exception handler does not catch.
    await owner.query(`REVOKE USAGE ON SCHEMA public FROM PUBLIC, ${BOT_ROLE}`);

    const message = await migrationFailure(runner);
    expect(message, 'a schema grant that landed nothing must fail the migration, not pass quietly')
      .toMatch(/GRANT USAGE ON SCHEMA public TO oshal_bot granted NOTHING/);

    const { rows } = await owner.query<{ held: boolean }>(
      'SELECT has_schema_privilege($1, $2, $3) AS held', [BOT_ROLE, 'public', 'USAGE'],
    );
    expect(rows[0]!.held, 'the guard must be observing a real absence of schema usage').toBe(false);
  });

  it('REJECTS a workload-authority revoke that reported success and removed nothing', async () => {
    await resetPublic();
    // Owned by the superuser, so the runner can never REVOKE the owner's grants - but CAN grant,
    // because it holds GRANT OPTION. That combination is why the revoke reports success.
    for (const table of ['oshal_workload_identities', 'oshal_user_delegations']) {
      await owner.query(`CREATE TABLE public.${table} (id integer primary key)`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO ${BOT_ROLE}`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO ${RUNNER_ROLE} WITH GRANT OPTION`);
    }

    const message = await migrationFailure(runner);
    expect(message, 'SEC-01: a revoke that leaves the bot holding the delegation ledger must fail the migration')
      .toMatch(/oshal_bot STILL holds privileges on/);

    expect(await botHas('public.oshal_workload_identities', 'SELECT'),
      'the guard must be observing a real surviving privilege').toBe(true);
  });

  it('REJECTS a run that leaves oshal_bot RLS-exempt because this runner may not ALTER ROLE it', async () => {
    await resetPublic();
    await owner.query('CREATE TABLE public.bot_reachable_table (id integer primary key)');

    // The one attribute drift that defeats the entire point of the role: Postgres exempts such a
    // role from row-level security unconditionally, so every bot connection becomes a bypass around
    // the per-user isolation. Only a superuser can set it and only a superuser can clear it - which
    // is exactly why a NOCREATEROLE runner that meets this shape must refuse rather than certify it.
    // Spelt out here and not in the migration: that file may not contain a non-NO-prefixed
    // occurrence of the keyword (tests/unit/bot-db-least-privilege.spec.ts:100 refuses one), so its
    // message says "RLS-exempt attribute" instead.
    await owner.query(`ALTER ROLE ${BOT_ROLE} BYPASSRLS`);
    try {
      const drifted = await owner.query<{ rolbypassrls: boolean }>(
        'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1', [BOT_ROLE],
      );
      expect(drifted.rows[0]?.rolbypassrls, 'the drift must be real or this case refuses nothing').toBe(true);

      const message = await migrationFailure(runner);
      expect(message, 'an RLS-exempt oshal_bot the runner cannot correct must fail the migration')
        .toMatch(/oshal_bot carries a superuser or RLS-exempt attribute/);
      expect(message, 'the failure must name the role it was attempted as').toContain(`"${RUNNER_ROLE}"`);
      expect(message, 'this must be the attribute refusal, not the DML-grant refusal further down')
        .not.toMatch(/DML grants were REFUSED/);

      expect(await botHas('public.bot_reachable_table', 'SELECT'),
        'the run must stop at the attribute block, before any grant is attempted').toBe(false);
      const after = await owner.query<{ rolbypassrls: boolean }>(
        'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1', [BOT_ROLE],
      );
      expect(after.rows[0]?.rolbypassrls,
        'the refusal must be real: the runner genuinely could not clear the attribute').toBe(true);
    } finally {
      // Restore the shape every other case in this file depends on, whatever happened above.
      await owner.query(`ALTER ROLE ${BOT_ROLE} NOBYPASSRLS`);
    }
  });
});

/** The three api-boot steps whose exit status compose used to discard. */
type BootStep = 'migrations' | 'rls' | 'provision';

/**
 * The same swallow, one level up. Making the migration fail is worth nothing if the boot command that
 * runs it discards the exit status - which is what compose did, while the Helm chart and the managed
 * one-shot both treated all three steps as fatal.
 */
describe('the compose api boot propagates a failed migration, RLS enforce or role provision', () => {
  /**
   * The three guarded steps of the bootstrap branch, in the order the boot runs them. `argv` is the
   * fragment that identifies that step's `node` invocation - the whole branch is `node`, so this is
   * what lets one step fail while the others succeed - and `refusal` is what the branch must print
   * when that step is the one that failed.
   */
  const BOOT_STEPS: readonly { step: BootStep; argv: string; refusal: string }[] = [
    { step: 'migrations', argv: 'DatabaseBootstrapService', refusal: 'Migrations FAILED' },
    { step: 'rls', argv: 'apply-rls.mjs', refusal: 'core RLS enforce FAILED' },
    { step: 'provision', argv: 'provision-app-role.mjs', refusal: 'app-role provision FAILED' },
  ];

  /**
   * @description Lift the app-role bootstrap branch out of the compose YAML and unescape it into the
   * `sh` the container actually runs: `\"` back to `"`, and compose's `$$` back to a literal `$`.
   * @returns The branch as one line of POSIX shell.
   */
  function bootstrapBranch(): string {
    const raw = readFileSync(COMPOSE_PATH, 'utf8');
    const start = raw.indexOf('if [ \\"$$OSHAL_APP_ROLE_BOOTSTRAP\\" = \\"true\\" ]; then');
    const end = raw.indexOf('sleep 2;', start);
    if (start < 0 || end < 0) throw new Error(`could not locate the api bootstrap branch in ${COMPOSE_PATH}`);
    return raw.slice(start, end).replace(/\\"/g, '"').replace(/\$\$/g, '$').replace(/\s*\r?\n\s*/g, ' ').trim();
  }

  /**
   * @description Stub `node` for one run, failing exactly ONE of the three guarded steps and letting
   * the others succeed. A single stub that returned the same status for every invocation proved only
   * the FIRST step: the migration runner exited the branch, so the RLS enforce and the provisioner
   * were never reached and a regression in either could not turn this file red. Dispatching on argv
   * is what makes each step independently provable. Each arm also echoes a marker, so a case can
   * assert which steps actually RAN rather than inferring it from the exit status.
   * @param failing The step whose `node` invocation returns non-zero, or `'none'` for a healthy boot.
   * @returns The stub, as a POSIX shell function definition.
   */
  function stubNode(failing: BootStep | 'none'): string {
    const arms = BOOT_STEPS.map(({ step, argv }) =>
      `    *${argv}*) echo "STEP:${step}"; return ${failing === step ? 1 : 0} ;;`).join('\n');
    // The `*)` arm is the password read in the provision step's command substitution: a helper, not
    // a guarded step, so it always succeeds and stays silent (its output is captured into a variable).
    return `node() {\n  case "$*" in\n${arms}\n    *) return 0 ;;\n  esac\n}`;
  }

  /**
   * @description Run the branch in a real POSIX shell - the fixture's own container, so nothing on the
   * machine is touched - against that selective stub.
   * @param failing The step to fail, or `'none'`.
   * @returns The shell's exit status and everything it printed.
   */
  function runBranch(failing: BootStep | 'none'): { status: number; output: string } {
    const script = [stubNode(failing), 'OSHAL_APP_ROLE_BOOTSTRAP=true', bootstrapBranch(), 'exit 0'].join('\n');
    try {
      const output = execFileSync('docker', ['exec', database.containerName, 'sh', '-c', script],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      return { status: 0, output };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status !== 'number') throw error;
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      return { status, output: `${stdout ?? ''}${stderr ?? ''}` };
    }
  }

  it.each(BOOT_STEPS)('stops the api boot when the $step step fails, and names it', ({ step, refusal }) => {
    const { status, output } = runBranch(step);

    expect(status, `a failed ${step} step must stop the api boot`).not.toBe(0);
    expect(output, 'the boot must name the step it refused on').toContain(refusal);

    const index = BOOT_STEPS.findIndex((candidate) => candidate.step === step);
    // Non-vacuity: every EARLIER step must have run and passed, or this case exited on someone else's
    // guard and proves nothing about this one. That is precisely how the single-stub version was
    // vacuous for the second and third steps.
    for (const earlier of BOOT_STEPS.slice(0, index)) {
      expect(output, `the ${earlier.step} step must have run before ${step}`).toContain(`STEP:${earlier.step}`);
      expect(output, `${earlier.step} succeeded here, so its refusal must not appear`).not.toContain(earlier.refusal);
    }
    expect(output, `the ${step} step itself must have been reached`).toContain(`STEP:${step}`);
    // And nothing after it may run: the api must not provision a role on a half-applied schema.
    for (const later of BOOT_STEPS.slice(index + 1)) {
      expect(output, `${later.step} must not run once ${step} failed`).not.toContain(`STEP:${later.step}`);
    }
  });

  it('reaches the server start when all three steps succeed', () => {
    const { status, output } = runBranch('none');

    expect(status, 'a healthy boot must still reach the server start').toBe(0);
    for (const { step, refusal } of BOOT_STEPS) {
      expect(output, `the ${step} step must run on a healthy boot`).toContain(`STEP:${step}`);
      expect(output, `a healthy boot must not print the ${step} refusal`).not.toContain(refusal);
    }
  });
});
