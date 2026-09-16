/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The guard for the trading schema bootstrap race. Running the trading unit specs without `--no-file-parallelism` failed three of them in `beforeAll` with `trigger "trg_trd_signals_book_fill" for relation "oshal_trading_signals" already exists`: every trading bootstrap took the NO-LOCK path of runRuntimeSchemaBootstrap, so two vitest workers sharing one database interleaved their DDL. This spec reproduces that against a REAL PostgreSQL it starts itself - `vi.resetModules()` mints independent copies of the memoizing modules, which is what a second worker process is - and asserts every concurrent bootstrapper succeeds, on an empty database and again on an already-built one. On the unlocked tree it reports the three collision classes by SQLSTATE: 42710 on the DROP/CREATE TRIGGER pair and on the check-then-CREATE POLICY pair, and 23505 on pg_type_typname_nsp_index / pg_class_relname_nsp_index because CREATE TABLE IF NOT EXISTS is not race-safe. It is green under the advisory lock, so the race cannot come back unnoticed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// Generous pool/statement budgets because the point of the spec is that many bootstrappers QUEUE
// on one advisory lock — a short acquire timeout would fail the run for waiting, not for racing.
const database = new DisposablePostgres({
  purpose: 'trading-schema-race',
  database: 'trading_fixture',
  memory: '384m',
  max: 32,
  connectionTimeoutMillis: 120_000,
  statementTimeoutMs: 180_000,
});

/** How many independent copies of the bootstrap modules race each other. */
const WORKERS = 4;

let pool: Pool;

beforeAll(async () => {
  pool = await database.start();
}, 180_000);

afterAll(async () => {
  await database.stop();
});

/** One worker's view of the trading schema modules: its own module instances, its own memo state. */
interface TradingBootstrapModules {
  ensure: readonly { name: string; run: (p: never) => Promise<unknown> }[];
}

/**
 * @description Load a FRESH copy of every trading schema module, the way a second vitest worker
 * process would have one. `vi.resetModules()` clears the module registry, so the per-module
 * `schemaReady` memo that normally makes the bootstrap run once is minted anew — which is exactly
 * the state a separate process is in, and the only way to make two bootstraps of the same schema
 * race inside one test run.
 * @returns The ensure functions of one independent module instance, named for failure messages.
 */
async function freshTradingModules(): Promise<TradingBootstrapModules> {
  vi.resetModules();
  const [schema, pinned, plans, dated, equity, daily, gate, rotation, peaks] = await Promise.all([
    import('../../src/app/trading-schema'),
    import('../../src/app/trading-pinned-lots'),
    import('../../src/app/trading-event-plans'),
    import('../../src/app/trading-dated-orders'),
    import('../../src/app/trading-equity-guard'),
    import('../../src/app/trading-daily-equity-store'),
    import('../../src/app/trading-gate-block-store'),
    import('../../src/app/trading-rotation-store'),
    import('../../src/app/trading-peaks-store'),
  ]);
  return {
    ensure: [
      { name: 'ensureTradingSchema', run: schema.ensureTradingSchema },
      { name: 'ensurePinnedLotsSchema', run: pinned.ensurePinnedLotsSchema },
      { name: 'ensureEventPlansSchema', run: plans.ensureEventPlansSchema },
      { name: 'ensureDatedOrdersSchema', run: dated.ensureDatedOrdersSchema },
      { name: 'ensureEquityGuardTable', run: equity.ensureEquityGuardTable },
      { name: 'ensureDailyEquityTable', run: daily.ensureDailyEquityTable },
      { name: 'ensureGateBlockTable', run: gate.ensureGateBlockTable },
      { name: 'ensureRotationStateTable', run: rotation.ensureRotationStateTable },
      { name: 'ensurePeaksTable', run: peaks.ensurePeaksTable },
    ],
  };
}

/**
 * @description Run every trading bootstrap of every worker at once and collect the failures rather
 * than letting the first one mask the rest. The collected message is what names the colliding
 * object when this guard goes red.
 * @param workers - Independent module instances to bootstrap from.
 * @returns One line per rejected bootstrap (`worker/function: message`); empty when all succeeded.
 */
async function bootstrapConcurrently(workers: readonly TradingBootstrapModules[]): Promise<string[]> {
  const attempts = workers.flatMap((worker, index) => worker.ensure.map(async (entry) => {
    try {
      await entry.run(pool as never);
      return null;
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'no-sqlstate';
      return `worker ${index}/${entry.name}: [${code}] ${(error as Error).message}`;
    }
  }));
  const settled = await Promise.all(attempts);
  return settled.filter((line): line is string => line !== null);
}

describe('the trading schema bootstrap is safe to run concurrently against one database', () => {
  it('four independent bootstrappers build the schema on an EMPTY database without colliding', async () => {
    const workers = await Promise.all(Array.from({ length: WORKERS }, () => freshTradingModules()));
    const failures = await bootstrapConcurrently(workers);
    expect(failures, `concurrent bootstrap failed:\n${failures.join('\n')}`).toEqual([]);

    // The schema really is there — a bootstrap that "succeeded" by skipping everything is the
    // false green this assertion exists to refuse.
    const trigger = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_trd_signals_book_fill' AND NOT tgisinternal`,
    );
    expect(trigger.rows[0].n).toBe(1);
    const tables = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'r' AND relname = ANY($1::text[])`,
      [['oshal_trading_books', 'oshal_trading_signals', 'oshal_trading_decisions', 'oshal_trading_orders',
        'oshal_trading_pinned_lots', 'oshal_trading_event_plans', 'oshal_trading_dated_orders',
        'oshal_trading_peaks']],
    );
    expect(tables.rows[0].n).toBe(8);
  }, 300_000);

  it('four more bootstrappers re-run over the ALREADY-built schema without colliding', async () => {
    // The reported failure shape: the trigger already exists, so every worker issues
    // `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` and two of them interleave.
    const workers = await Promise.all(Array.from({ length: WORKERS }, () => freshTradingModules()));
    const failures = await bootstrapConcurrently(workers);
    expect(failures, `concurrent re-bootstrap failed:\n${failures.join('\n')}`).toEqual([]);

    const trigger = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_trd_signals_book_fill' AND NOT tgisinternal`,
    );
    expect(trigger.rows[0].n).toBe(1);
  }, 300_000);
});
