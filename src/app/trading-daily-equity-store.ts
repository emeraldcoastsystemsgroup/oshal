/**
 * Trading daily-equity store — our own per-day closing-equity snapshot, for an HONEST day P&L.
 *
 * Day P&L = current equity − the PRIOR session's closing equity. Alpaca's `account.lastEquity` (and the
 * latest row of its portfolio-history) can carry a phantom value that wildly misstates the day — observed
 * 2026-06-30: lastEquity $105,694 while the real prior close was ~$102,315 and the book was ~flat. So we
 * don't trust the broker's baseline; we record equity ourselves on every autopilot fire (and on each
 * ledger read), keyed by US/Eastern calendar day, keeping the latest value per day (≈ that day's close).
 * The prior session's close is then just the most recent row dated before today — unambiguous, phantom-proof.
 *
 * Mirrors the self-healing pattern of the peaks / rotation / equity-guard stores (runtime-created table,
 * off nobody's critical path; a failure here only degrades the day-P&L display, never trading).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-(sub,mode,ET-day) closing-equity snapshot + prior-close lookup for the honest consolidated day P&L.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | loadDailyEquitySeries: the recorded equity curve, ascending, optionally windowed. Backs the /performance fallback for the LIVE (Schwab) book — Schwab has no equity-curve endpoint, so the "Total return"/"vs S&P" tiles were blank; this store IS our curve.
 *
 * @module trading-daily-equity-store
 */

import type { AppContext } from './composition-root';
import type { TradingMode } from '@/features/trading';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

/** US/Eastern calendar day (YYYY-MM-DD) for a given epoch-ms (default: now). Market days are ET. */
function etDay(ms: number = Date.now()): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** @description Create the daily-equity table if absent (self-healing, like the peaks/guard stores). */
export async function ensureDailyEquityTable(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading daily equity',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_daily_equity (
        user_sub TEXT NOT NULL, mode TEXT NOT NULL, et_day DATE NOT NULL,
        equity NUMERIC(18,2) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_sub, mode, et_day)
      )`,
    ],
    requirements: [{ table: 'oshal_trading_daily_equity', columns: ['user_sub', 'mode', 'et_day', 'equity'] }],
  });
}

/**
 * @description Record current equity for today (ET), keeping the latest value seen today (≈ the close
 * once the last fire of the session lands). No-op on a non-positive/non-finite value.
 */
export async function recordDailyEquity(pool: AppContext['pool'], sub: string, mode: TradingMode, equity: number): Promise<void> {
  if (!Number.isFinite(equity) || equity <= 0) return;
  await ensureDailyEquityTable(pool);
  await pool.query(
    `INSERT INTO oshal_trading_daily_equity (user_sub, mode, et_day, equity)
       VALUES ($1,$2,$3::date,$4)
     ON CONFLICT (user_sub, mode, et_day) DO UPDATE SET equity=EXCLUDED.equity, updated_at=now()`,
    [sub, mode, etDay(), equity]);
}

/** One recorded day of closing equity. */
export interface DailyEquityPoint { etDay: string; equity: number; }

/**
 * @description The recorded closing-equity series for a book, ascending by ET day. This is OUR
 *   equity curve — the fallback the /performance view uses for the LIVE (Schwab) book, which has no
 *   broker equity-curve endpoint of its own. `sinceDays` bounds the window (0/undefined = all rows).
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - Book (paper|live).
 * @param sinceDays - How many ET days back to include (0 = the entire recorded history).
 * @returns Ascending [{ etDay, equity }]; empty when nothing has been recorded yet.
 */
export async function loadDailyEquitySeries(
  pool: AppContext['pool'], sub: string, mode: TradingMode, sinceDays = 0,
): Promise<DailyEquityPoint[]> {
  await ensureDailyEquityTable(pool);
  const where = sinceDays > 0
    ? `WHERE user_sub=$1 AND mode=$2 AND et_day >= (CURRENT_DATE - $3::int)`
    : `WHERE user_sub=$1 AND mode=$2`;
  const params = sinceDays > 0 ? [sub, mode, sinceDays] : [sub, mode];
  const rows = (await pool.query(
    `SELECT to_char(et_day,'YYYY-MM-DD') AS et_day, equity FROM oshal_trading_daily_equity
      ${where} ORDER BY et_day ASC`, params)).rows;
  return rows.map((r: any) => ({ etDay: String(r.et_day), equity: Number(r.equity) }));
}

/** @description The prior session's closing equity = the latest snapshot dated before today (ET). @returns equity or null if none yet. */
export async function loadPriorCloseEquity(pool: AppContext['pool'], sub: string, mode: TradingMode): Promise<number | null> {
  await ensureDailyEquityTable(pool);
  const row = (await pool.query(
    `SELECT equity FROM oshal_trading_daily_equity
      WHERE user_sub=$1 AND mode=$2 AND et_day < $3::date
      ORDER BY et_day DESC LIMIT 1`,
    [sub, mode, etDay()])).rows[0];
  return row ? Number(row.equity) : null;
}
