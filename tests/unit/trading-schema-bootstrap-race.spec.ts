/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The guard for the trading schema bootstrap race. Running the trading unit specs without `--no-file-parallelism` failed three of them in `beforeAll` with `trigger "trg_trd_signals_book_fill" for relation "oshal_trading_signals" already exists`: every trading bootstrap took the NO-LOCK path of runRuntimeSchemaBootstrap, so two vitest workers sharing one database interleaved their DDL. This spec reproduces that against a REAL PostgreSQL it starts itself - `vi.resetModules()` mints independent copies of the memoizing modules, which is what a second worker process is - and asserts every concurrent bootstrapper succeeds, on an empty database and again on an already-built one. On the unlocked tree it reports the three collision classes by SQLSTATE: 42710 on the DROP/CREATE TRIGGER pair and on the check-then-CREATE POLICY pair, and 23505 on pg_type_typname_nsp_index / pg_class_relname_nsp_index because CREATE TABLE IF NOT EXISTS is not race-safe. It is green under the advisory lock, so the race cannot come back unnoticed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Correct SEQ 1 and build the workers ONE AT A TIME. vi.resetModules() clears the registry synchronously, so constructing four copies with Promise.all left all four sharing ONE module instance - measured as one distinct copy per ensure function. The eight memoised bootstraps therefore ran once each and could not race themselves; the only genuine concurrency was ensurePeaksTable, the one with no memo, which is why this file stayed green with the lock removed from sixteen of seventeen modules including trading-schema.ts. Sequential construction measures four. And because even four real workers are staggered by the locked books/accounts prologue, coverage of the OTHER sixteen is asserted statically in trading-schema-lock-coverage.spec.ts rather than hoped for here.
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
 * @description Load a FRESH copy of every trading schema module, so its per-module `schemaReady`
 * memo is minted anew and two bootstraps of the same schema can race inside one test run.
 *
 * MUST be awaited one at a time. `vi.resetModules()` clears the registry synchronously, so calling
 * it four times before any import resolves leaves all four callers sharing ONE instance — measured
 * as one distinct copy per ensure function, which is why this guard once passed with the lock
 * removed from sixteen of seventeen modules. Sequential construction measures four.
 * @returns The ensure functions of one independent module instance, named for failure messages.
 */
async function freshTradingModules(): Promise<TradingBootstrapModules> {
  vi.resetModules();
  // Sequential on purpose: Promise.all here resolves every import against whichever registry state
  // the last resetModules left, collapsing the workers into one instance.
  const schema = await import('../../src/app/trading-schema');
  const pinned = await import('../../src/app/trading-pinned-lots');
  const plans = await import('../../src/app/trading-event-plans');
  const dated = await import('../../src/app/trading-dated-orders');
  const equity = await import('../../src/app/trading-equity-guard');
  const daily = await import('../../src/app/trading-daily-equity-store');
  const gate = await import('../../src/app/trading-gate-block-store');
  const rotation = await import('../../src/app/trading-rotation-store');
  const peaks = await import('../../src/app/trading-peaks-store');
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
    const workers: TradingBootstrapModules[] = [];
    // One at a time — see freshTradingModules: parallel construction yields one shared copy.
    for (let i = 0; i < WORKERS; i += 1) workers.push(await freshTradingModules());
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
    const workers: TradingBootstrapModules[] = [];
    // One at a time — see freshTradingModules: parallel construction yields one shared copy.
    for (let i = 0; i < WORKERS; i += 1) workers.push(await freshTradingModules());
    const failures = await bootstrapConcurrently(workers);
    expect(failures, `concurrent re-bootstrap failed:\n${failures.join('\n')}`).toEqual([]);

    const trigger = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_trd_signals_book_fill' AND NOT tgisinternal`,
    );
    expect(trigger.rows[0].n).toBe(1);
  }, 300_000);
});
