/**
 * Trading gate-block ledger — the counterfactual record a safety gate needs to prove (or refute)
 * its own worth.
 *
 * A gate that silently drops candidates generates NO evidence about itself: logs are wiped on every
 * container recreate, and the decisions table only holds trades that were actually placed. So each
 * time a gate (first user: the TRADING_EARNINGS_GATE earnings blackout) suppresses a would-be entry,
 * we persist one row per (book, gate, symbol, ET day) with the reference price the entry would have
 * used. A scoring pass can then join blocked rows to later bars and ask the only question that
 * matters: what did the blocked entry actually do through the event? — judged, per the event-pop
 * doctrine, against a same-symbol random-time control before any claim is believed.
 *
 * Mirrors the self-healing pattern of the peaks / rotation / daily-equity stores (runtime-created
 * table, off the critical path; a failure here only loses evidence, never affects trading).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-(sub,mode,gate,symbol,ET-day) blocked-entry ledger so the earnings blackout (and future gates) accumulate scoreable counterfactual evidence instead of vanishing into recreate-wiped logs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-134 book re-key (PR1) + the RLS this table was missing by omission (schema-map finding): book_id column (trigger-before-backfill), book-scoped unique index, owner RLS at the DDL chokepoint. Accepts TradingBook or legacy mode.
 *
 * @module trading-gate-block-store
 */

import type { AppContext } from './composition-root';
import type { TradingBook, TradingMode } from '@/features/trading';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { ensureBooksSchema, legacyBook } from './trading-books-store';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-gate-block-store' });

/** US/Eastern calendar day (YYYY-MM-DD) for a given epoch-ms (default: now). Market days are ET. */
function etDay(ms: number = Date.now()): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** @description Create the gate-block table if absent (self-healing, like the sibling stores). */
export async function ensureGateBlockTable(pool: AppContext['pool']): Promise<void> {
  await ensureBooksSchema(pool);
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading gate blocks',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_gate_blocks (
        user_sub TEXT NOT NULL, mode TEXT NOT NULL, gate TEXT NOT NULL,
        symbol TEXT NOT NULL, et_day DATE NOT NULL,
        ref_price NUMERIC(18,4),
        first_blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_sub, mode, gate, symbol, et_day)
      )`,
      // ADR-134: RLS this table was missing by omission, + the book re-key.
      ...buildOwnerRlsPolicyStatements('oshal_trading_gate_blocks', 'user_sub'),
      'ALTER TABLE oshal_trading_gate_blocks ADD COLUMN IF NOT EXISTS book_id UUID',
      'DROP TRIGGER IF EXISTS trg_trd_gate_blocks_book_fill ON oshal_trading_gate_blocks',
      'CREATE TRIGGER trg_trd_gate_blocks_book_fill BEFORE INSERT ON oshal_trading_gate_blocks FOR EACH ROW EXECUTE FUNCTION oshal_trading_book_id_fill()',
      `UPDATE oshal_trading_gate_blocks SET book_id = md5('oshal-book:'||user_sub||':'||mode)::uuid WHERE book_id IS NULL`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_gate_blocks_book ON oshal_trading_gate_blocks (user_sub, book_id, gate, symbol, et_day)',
    ],
    requirements: [{ table: 'oshal_trading_gate_blocks', columns: ['user_sub', 'mode', 'book_id', 'gate', 'symbol', 'et_day'] }],
  });
}

/** One suppressed would-be entry. */
export interface GateBlock { symbol: string; refPrice: number | null; }

/**
 * @description Record entries a gate suppressed this fire — one row per symbol per ET day per book
 * (first fire of the day wins, keeping the earliest would-be entry price; later fires no-op). Never
 * throws: evidence collection must not be able to break a trading fire.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - Book (paper|live).
 * @param gate - Which gate suppressed them (e.g. 'earnings').
 * @param blocks - The suppressed candidates with their would-be entry prices.
 */
export async function recordGateBlocks(
  pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode, gate: string, blocks: GateBlock[],
): Promise<void> {
  if (!blocks.length) return;
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  try {
    await ensureGateBlockTable(pool);
    for (const b of blocks) {
      await pool.query(
        `INSERT INTO oshal_trading_gate_blocks (user_sub, mode, book_id, gate, symbol, et_day, ref_price)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7)
         ON CONFLICT (user_sub, book_id, gate, symbol, et_day) DO NOTHING`,
        [sub, book.kind, book.bookId, gate, b.symbol.toUpperCase(), etDay(), b.refPrice]);
    }
  } catch (err) {
    // Evidence-only path: a failed write must never fail the trading fire; the next fire retries.
    logger.error({ err, sub, mode: book.kind, bookRef: book.ref, gate, symbols: blocks.map((b) => b.symbol).join(',') }, 'gate-block ledger write failed — counterfactual evidence lost for this fire');
  }
}
