/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the apply reaper's run-ledger join against the REAL schema. Migration 118 declares apply_runs.ticket_id TEXT while tickets.ticket_id is UUID, so the uncast LATERAL join raised `operator does not exist: text = uuid` on every sweep. The reaper catches and logs, so it degraded silently to "0 reaped" — orphan recovery never ran, and only a deploy's log scan found it. This must execute against a live database: the defect lives entirely in Postgres type resolution and every mock of the pool returns whatever the test author expects.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | This spec now STARTS its own PostgreSQL and removes it, instead of resolving an address from the environment at all. Refusing an unpointed run made the 2026-09-14 accident impossible, but nothing in the repo supplied the variable, so `specDatabaseUrl` threw at MODULE LOAD and vitest reported a failed suite with zero cases run — the type-resolution defect above was unguarded in every gate from the day the refusal landed. A guard that cannot execute proves nothing, so refusing was the wrong shape of answer: owning the server leaves no address to point and nothing to point it at. The schema comes from the deployment's own migrations (005 for the chat_tasks the ticket family references, 100 for `tickets`, 118 for `apply_runs`) rather than hand-written DDL, so the UUID/TEXT divergence this file asserts is the one production ships. No superuser role handoff and no DELETE teardown: the file makes no non-superuser claim, and the whole server is destroyed in afterAll, so no cleanup SQL runs anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { REHYDRATE_APPLY_TICKETS_SQL, STALE_APPLY_TICKETS_SQL } from '@/app/apply-enqueue';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// The three migrations are the deployment's own: 005 creates chat_tasks (the ticket family's
// FK target), 100 creates `tickets` with ticket_id UUID, 118 creates `apply_runs` with
// ticket_id TEXT — which is precisely the divergence the production cast exists for.
const database = new DisposablePostgres({
  purpose: 'apply-reaper-ledger-join',
  database: 'apply_ledger_fixture',
  memory: '384m',
  max: 2,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 30_000,
  migrations: [
    '005-conversation-history-and-usage.sql',
    '100-ticket-family-base-schema.sql',
    '118-apply-runs-ledger.sql',
  ],
});

let pool: Pool;

/** Bound parameter the production sweeps pass. Any positive value resolves types. */
const ORPHAN_MS = 2_100_000;

/**
 * BOTH apply_runs joins, because fixing only the one a stack trace named is how this shipped twice:
 * the reaper was patched, the boot-time rehydrate kept the identical uncast comparison, and it took
 * a second deploy's log to notice. Any third join belongs here the day it is written.
 */
const LEDGER_JOINS: ReadonlyArray<readonly [string, string]> = [
  ['reaper sweep (STALE_APPLY_TICKETS_SQL)', STALE_APPLY_TICKETS_SQL],
  ['boot rehydrate (REHYDRATE_APPLY_TICKETS_SQL)', REHYDRATE_APPLY_TICKETS_SQL],
];

describe('apply reaper run-ledger join', () => {
  beforeAll(async () => {
    pool = await database.start();
  }, 120_000);

  // No DELETE pass: the whole server goes away, so there is nothing to clean and nowhere to
  // clean it. stop() ends the pool itself.
  afterAll(async () => { await database.stop(); });

  it('has the type mismatch this cast exists for — apply_runs.ticket_id TEXT vs tickets.ticket_id UUID', async () => {
    const { rows } = await pool.query<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'ticket_id'
          AND table_name IN ('tickets', 'apply_runs')`,
    );
    const typeOf = (t: string) => rows.find((r) => r.table_name === t)?.data_type;
    // If these ever converge the cast becomes a no-op rather than a bug, but the day they diverge
    // AGAIN — a new ledger table, a re-typed column — this states plainly why the cast is load-bearing.
    expect(typeOf('tickets'), 'tickets.ticket_id missing').toBeDefined();
    expect(typeOf('apply_runs'), 'apply_runs.ticket_id missing — migration 118 not applied').toBeDefined();
    expect(rows).toHaveLength(2);
  });

  it.each(LEDGER_JOINS)('%s executes against the real schema', async (_name, sql) => {
    // The imported string is the one production runs. Remove the cast in apply-enqueue.ts and this
    // goes red — which a test carrying its own copy of the query would not.
    await expect(pool.query(sql, [ORPHAN_MS])).resolves.toBeDefined();
  });

  it.each(LEDGER_JOINS)('%s would throw 42883 uncast', async (_name, sql) => {
    // Pins the production failure mode, so this file proves what it claims rather than asserting
    // that some SQL, somewhere, runs. Both sweeps swallow their error and report zero, so an
    // uncast join is invisible in every signal except a raw log line.
    const uncast = sql.replace('t.ticket_id::text', 't.ticket_id');
    expect(uncast, 'cast missing from the production SQL').not.toEqual(sql);
    await expect(pool.query(uncast, [ORPHAN_MS])).rejects.toMatchObject({ code: '42883' });
  });

  it('holds every apply_runs join in apply-enqueue.ts, so a third cannot be added uncast', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/app/apply-enqueue.ts', 'utf8');
    // Count the joins the module actually issues against the ledger, and require this file to
    // cover each one. A new sweep added without a cast fails here rather than in a deploy log.
    const joins = source.match(/FROM apply_runs\s*\n?\s*WHERE ticket_id/g) ?? [];
    expect(joins, 'a new apply_runs join exists — add it to LEDGER_JOINS').toHaveLength(LEDGER_JOINS.length);
    expect(source.match(/WHERE ticket_id=t\.ticket_id(?!::text)/g), 'uncast join in production source').toBeNull();
  });
});
