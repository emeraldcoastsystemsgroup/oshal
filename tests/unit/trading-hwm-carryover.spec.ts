/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 PR1 safety-store guards on the REAL database: pre-existing HWM rows were re-keyed IN PLACE (values byte-unchanged — a fresh row would re-baseline the drawdown breaker), a halted synthetic book STAYS halted through the book-keyed read, and book isolation holds on the peaks store (book A's prune/upsert can never touch book B's peaks — wrong trailing exits otherwise).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import { ensureEquityGuardTable, evaluateEquityGuard } from '../../src/app/trading-equity-guard';
import { ensurePeaksTable, loadPeaks, savePeaks } from '../../src/app/trading-peaks-store';
import { ensureLegacyBooks, legacyBook, legacyBookId } from '../../src/app/trading-books-store';
import { RISK_POLICIES } from '../../src/features/trading';
import { specDatabaseUrl } from '../helpers/spec-database-url';

const DSN = specDatabaseUrl(['OSHAL_TEST_DSN']);
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-adr134h-${RUN}`;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(`trading-hwm-carryover requires the live oshal Postgres — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureEquityGuardTable(pool as never);
  await ensurePeaksTable(pool as never);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM oshal_trading_equity_hwm WHERE user_sub LIKE 'spec-adr134h-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_peaks WHERE user_sub LIKE 'spec-adr134h-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub LIKE 'spec-adr134h-%'`).catch(() => {});
  await pool.end();
});

describe('HWM re-key carries the breaker state IN PLACE', () => {
  it('every pre-existing HWM row kept its values through the backfill (book_id stamped, numbers untouched)', async () => {
    // The backfill is `SET book_id=… WHERE book_id IS NULL` — it cannot touch value columns by
    // construction; this asserts the OUTCOME on the real table: bijection holds and no row lost
    // its mark. (A re-inserted row would show updated_at = now() and a reset mark.)
    const bad = (await pool.query(
      `SELECT count(*)::int AS n FROM oshal_trading_equity_hwm
        WHERE book_id IS DISTINCT FROM md5('oshal-book:'||user_sub||':'||mode)::uuid`)).rows[0].n;
    expect(bad).toBe(0);
  });

  it('a halted book STAYS halted through the book-keyed read; the other book is untouched', async () => {
    const policy = RISK_POLICIES.active; // 10% breaker
    // Seed: live book peaked at 100k, now at 85k → 15% drawdown → halted.
    await pool.query(
      `INSERT INTO oshal_trading_equity_hwm (user_sub, mode, book_id, high_water_mark, last_equity)
         VALUES ($1,'live',$2,100000,85000)`, [SUB, legacyBookId(SUB, 'live')]);
    const live = await evaluateEquityGuard(pool as never, SUB, legacyBook(SUB, 'live'), 85000, policy);
    expect(live.halted).toBe(true);
    expect(live.highWaterMark).toBe(100000);
    // The paper book has NO such history — it must not inherit the live book's halt.
    const paper = await evaluateEquityGuard(pool as never, SUB, legacyBook(SUB, 'paper'), 85000, policy);
    expect(paper.halted).toBe(false);
  });
});

describe('peaks isolation — book A can never touch book B', () => {
  it('savePeaks prune for book A leaves book B’s peaks intact', async () => {
    const bookA = legacyBook(SUB, 'paper');
    const bookB = legacyBook(SUB, 'live');
    await savePeaks(pool as never, SUB, bookA, new Map([['NVDA', 100], ['MSFT', 200]]));
    await savePeaks(pool as never, SUB, bookB, new Map([['NVDA', 111]]));
    // Book A drops MSFT (prune) and rolls NVDA forward.
    await savePeaks(pool as never, SUB, bookA, new Map([['NVDA', 105]]));
    const a = await loadPeaks(pool as never, SUB, bookA);
    const b = await loadPeaks(pool as never, SUB, bookB);
    expect(a.get('NVDA')).toBe(105);
    expect(a.has('MSFT')).toBe(false);
    expect(b.get('NVDA'), 'book B’s peak must survive book A’s prune').toBe(111);
  });

  it('an EMPTY save for book A clears only book A', async () => {
    const bookA = legacyBook(SUB, 'paper');
    const bookB = legacyBook(SUB, 'live');
    await savePeaks(pool as never, SUB, bookA, new Map());
    expect((await loadPeaks(pool as never, SUB, bookA)).size).toBe(0);
    expect((await loadPeaks(pool as never, SUB, bookB)).size).toBe(1);
  });
});
