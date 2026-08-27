/**
 * Trading sleeve-rotation cadence store — remembers when the gravity rotation last rebalanced.
 *
 * The autopilot fires every 5 minutes, but the optional gravity-ranked sleeve rotation
 * (TRADING_SLEEVE_ROTATION) is a WEEKLY rebalance, not a per-fire action. This tiny store persists,
 * per (user_sub, mode), the timestamp of the last rotation so the dispatch can gate the rebalance on
 * a cadence (TRADING_ROTATION_EVERY_DAYS) instead of churning the book on every fire.
 *
 * Kept separate (mirrors trading-peaks-store.ts / trading-equity-guard.ts) and in the app layer
 * because it is orchestration/I-O around the rotation decision, not pure portfolio math. Off unless
 * TRADING_SLEEVE_ROTATION=true, so this table is only ever touched when the operator opts in.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-(sub,mode) last-rotated timestamp + load/save for the gravity sleeve-rotation cadence gate.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-134 book re-key (PR1): book_id column (trigger-before-backfill) + book-scoped unique index; load/save keyed (user_sub, book_id) — book-blind cadence would let one book's rebalance suppress another's weekly rotation. Accepts TradingBook or legacy mode.
 *
 * @module trading-rotation-store
 */

import type { AppContext } from './composition-root';
import type { TradingBook, TradingMode } from '@/features/trading';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { ensureBooksSchema, legacyBook } from './trading-books-store';

/** @description Create the rotation-state table if absent (self-healing, like the peaks/equity stores). */
export async function ensureRotationStateTable(pool: AppContext['pool']): Promise<void> {
  await ensureBooksSchema(pool);
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading rotation state',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_rotation_state (
        user_sub TEXT NOT NULL, mode TEXT NOT NULL,
        last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_sub, mode)
      )`,
      'ALTER TABLE oshal_trading_rotation_state ADD COLUMN IF NOT EXISTS book_id UUID',
      'DROP TRIGGER IF EXISTS trg_trd_rotation_state_book_fill ON oshal_trading_rotation_state',
      'CREATE TRIGGER trg_trd_rotation_state_book_fill BEFORE INSERT ON oshal_trading_rotation_state FOR EACH ROW EXECUTE FUNCTION oshal_trading_book_id_fill()',
      `UPDATE oshal_trading_rotation_state SET book_id = md5('oshal-book:'||user_sub||':'||mode)::uuid WHERE book_id IS NULL`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_rotation_book ON oshal_trading_rotation_state (user_sub, book_id)',
    ],
    requirements: [{ table: 'oshal_trading_rotation_state', columns: ['user_sub', 'mode', 'book_id', 'last_rotated_at'] }],
  });
}

/** @description Load the last rotation timestamp for a book. @returns The Date, or null if never rotated. */
export async function loadLastRotated(pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode): Promise<Date | null> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const row = (await pool.query(
    `SELECT last_rotated_at FROM oshal_trading_rotation_state WHERE user_sub=$1 AND book_id=$2`, [sub, book.bookId])).rows[0];
  return row?.last_rotated_at ? new Date(row.last_rotated_at) : null;
}

/** @description Stamp the last rotation as now() for a book (upsert on the book arbiter; mode still written). */
export async function saveLastRotated(pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  await pool.query(
    `INSERT INTO oshal_trading_rotation_state (user_sub, mode, book_id, last_rotated_at)
       VALUES ($1,$2,$3, now())
     ON CONFLICT (user_sub, book_id) DO UPDATE SET last_rotated_at = now()`,
    [sub, book.kind, book.bookId]);
}
