/**
 * Trading position-peak store — the trailing stop's memory across fires.
 *
 * A trailing stop needs the high-water-mark price reached while a position was held, but the broker
 * position object only carries the current price + average entry. This tiny store persists, per
 * (user_sub, mode, symbol), the peak price the autopilot has seen — rolled forward every fire by
 * portfolio.nextPeaks — so trailingExits can decide whether a winner has given back enough from its
 * peak to exit. Closed names are pruned so a re-entry starts a fresh peak.
 *
 * Kept separate (not in trading-routes.ts, which is at the line cap) and in the app layer because it
 * is orchestration/I-O around the pure portfolio math in features/trading.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-(sub,mode,symbol) high-water-mark table + load/save(prune) for the trailing stop.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Tier-1 RLS at the lazy-DDL chokepoint (A1.2 follow-up): ensurePeaksTable now runs buildOwnerRlsPolicyStatements for oshal_trading_peaks after the CREATE, so a fresh database is never left policy-less between table creation and a migration-060 re-run.
 *
 * @module trading-peaks-store
 */

import type { AppContext } from './composition-root';
import type { TradingMode } from '@/features/trading';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-peaks-store' });

/** @description Create the peaks table if absent (idempotent, cheap — called before each use). */
export async function ensurePeaksTable(pool: AppContext['pool']): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS oshal_trading_peaks (
       user_sub   text        NOT NULL,
       mode       text        NOT NULL,
       symbol     text        NOT NULL,
       peak_price numeric     NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (user_sub, mode, symbol)
     )`);
  /* ── owner-scoped RLS (A1.2): applied at the lazy-DDL chokepoint so a
     fresh database enforces isolation the moment this table is created,
     instead of waiting for migration 060 to re-run (it skips absent tables).
     Inert while the runtime connects as a superuser role. ─────────────── */
  for (const statement of buildOwnerRlsPolicyStatements('oshal_trading_peaks', 'user_sub')) {
    await pool.query(statement);
  }
}

/** @description Load the stored peak price per symbol for a book. @returns Map of UPPER symbol → peak. */
export async function loadPeaks(pool: AppContext['pool'], sub: string, mode: TradingMode): Promise<Map<string, number>> {
  const rows = (await pool.query(
    `SELECT symbol, peak_price FROM oshal_trading_peaks WHERE user_sub=$1 AND mode=$2`, [sub, mode])).rows;
  return new Map(rows.map((r) => [String(r.symbol).toUpperCase(), Number(r.peak_price)]));
}

/**
 * @description Persist the rolled-forward peaks and prune symbols no longer held (so a re-entry
 * starts a fresh high-water-mark). One upsert per held name + one prune delete.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - Book (paper|live).
 * @param peaks - The current peak per held symbol (from nextPeaks).
 */
export async function savePeaks(pool: AppContext['pool'], sub: string, mode: TradingMode, peaks: Map<string, number>): Promise<void> {
  const symbols = [...peaks.keys()];
  for (const [symbol, peak] of peaks) {
    await pool.query(
      `INSERT INTO oshal_trading_peaks (user_sub, mode, symbol, peak_price, updated_at)
         VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (user_sub, mode, symbol) DO UPDATE SET peak_price = EXCLUDED.peak_price, updated_at = now()`,
      [sub, mode, symbol, peak]);
  }
  // Prune peaks for names no longer held (empty list → clear all this book's peaks).
  await pool.query(
    `DELETE FROM oshal_trading_peaks WHERE user_sub=$1 AND mode=$2 AND NOT (symbol = ANY($3))`,
    [sub, mode, symbols.length ? symbols : ['']]);
  logger.info({ sub, mode, tracked: symbols.length }, 'persisted position peaks');
}
