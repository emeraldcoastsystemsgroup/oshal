/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the apply reaper's run-ledger join against the REAL schema. Migration 118 declares apply_runs.ticket_id TEXT while tickets.ticket_id is UUID, so the uncast LATERAL join raised `operator does not exist: text = uuid` on every sweep. The reaper catches and logs, so it degraded silently to "0 reaped" — orphan recovery never ran, and only a deploy's log scan found it. This must execute against a live database: the defect lives entirely in Postgres type resolution and every mock of the pool returns whatever the test author expects.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { STALE_APPLY_TICKETS_SQL } from '@/app/apply-enqueue';

const DSN =
  process.env.APPLY_LEDGER_TEST_DSN ??
  process.env.TEST_DATABASE_URL ??
  `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;

/** Strips the password out of a DSN so a connection failure message is safe to print. */
function safeDsn(dsn: string): string {
  return dsn.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}

let pool: Pool;

/** Bound parameter the production sweep passes: ORPHAN_AFTER_MS. Any positive value resolves types. */
const ORPHAN_MS = 2_100_000;

describe('apply reaper run-ledger join', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DSN, max: 2, connectionTimeoutMillis: 5_000 });
    // Fail LOUDLY rather than skipping. A guard that quietly disappears when the database is
    // absent is exactly how this defect reached a deploy in the first place.
    await pool.query('SELECT 1').catch((err: Error) => {
      throw new Error(
        `apply-reaper guard needs a live Postgres at ${safeDsn(DSN)} — ${err.message}. ` +
        'Start the stack (bash scripts/oshal-up.sh) or set APPLY_LEDGER_TEST_DSN.',
      );
    });
  }, 30_000);

  afterAll(async () => { await pool?.end(); });

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

  it('executes the PRODUCTION sweep SQL without a type-resolution error', async () => {
    // The imported string is the one the reaper runs. Remove the cast in apply-enqueue.ts and this
    // goes red — which a test carrying its own copy of the query would not.
    await expect(pool.query(STALE_APPLY_TICKETS_SQL, [ORPHAN_MS])).resolves.toBeDefined();
  });

  it('would throw 42883 uncast — the failure the sweep swallowed on every tick', async () => {
    // Pins the production failure mode, so this file proves what it claims rather than asserting
    // that some SQL, somewhere, runs.
    const uncast = STALE_APPLY_TICKETS_SQL.replace('t.ticket_id::text', 't.ticket_id');
    expect(uncast, 'cast missing from the production SQL').not.toEqual(STALE_APPLY_TICKETS_SQL);
    await expect(pool.query(uncast, [ORPHAN_MS])).rejects.toMatchObject({ code: '42883' });
  });
});
