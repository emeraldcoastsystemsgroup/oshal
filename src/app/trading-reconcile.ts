/**
 * Trading order reconciliation — turn submit-time order rows into their true fill state.
 *
 * A market order returns `pending_new` / `accepted` at submit and FILLS asynchronously at the
 * venue seconds-to-minutes later. The submit path (placeDecisionOrder → recordOrder) records
 * that initial status and never looks again, so without this loop the ledger freezes at
 * `pending` while the broker actually shows `filled`. That is exactly what stranded the
 * 2026-06-23 open-burst paper orders at `pending_new` even though Alpaca had filled them.
 *
 * reconcileOpenOrders re-fetches every still-open order for a (sub, book) from the broker and
 * upserts its current state via the SAME recordOrder the submit path uses (so status,
 * filled_qty, filled_avg_price, reject_reason all land consistently). It is owner+mode scoped
 * and cheap — it touches only non-terminal rows — so the autopilot calls it on every fire.
 *
 * Lives in the app layer (not features/) because it composes recordOrder, which owns the order
 * upsert + the signal→decision→order invariant and sits in app/trading-engine.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — reconcileOpenOrders polls every non-terminal order for a book from the broker and persists the real fill/terminal state via recordOrder; wired into the every-5-min autopilot fire so the ledger reflects venue reality.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Thread `sub` into the adapter and switch to getBrokerReader. getBrokerAdapter(mode) was called WITHOUT the sub, so the per-user Schwab token resolver returned null and every live-book getOrder threw "Schwab account not connected" — swallowed by the per-order catch. The LIVE ledger therefore never reconciled at all (a real AMD sell sat at pending_new for hours after Schwab had already filled it) while paper reconciled fine, because Alpaca ignores the sub. Reader, not Adapter: reconciliation is a READ and must keep syncing the ledger even when TRADING_LIVE_ENABLED is flipped off to halt trading.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — recordOrder now comes from app/trading-engine.ts instead of the carvable route surface. Zero behavior change.
 *
 * @module trading-reconcile
 */

import type { AppContext } from './composition-root';
import { getBrokerReader, type TradingBook, type TradingMode } from '@/features/trading';
import { recordOrder } from './trading-engine';
// CHANGE LOG addendum (ADR-134 PR1): reconcileOpenOrders accepts a TradingBook (or legacy mode),
// scopes its ledger read to the book, binds the reader to the book's account, and deliberately
// serves DISABLED books too — their working orders still need fills booked.
import { legacyBook } from './trading-books-store';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-reconcile' });

/** Non-terminal order statuses still worth polling the broker for (terminal = filled/canceled/rejected/expired). */
const OPEN_STATUSES = ['pending', 'accepted', 'partially_filled'];

/** Most orders to reconcile in one pass — bounds the broker API calls per fire. */
const RECONCILE_LIMIT = 200;

/**
 * @description Re-fetch every still-open order for a book from the broker and persist its
 * current fill/terminal state via the shared recordOrder upsert. Without this the ledger stays
 * frozen at the submit-time status (`pending_new`) while the venue has already filled.
 * @param pool - Postgres pool.
 * @param sub - Owner sub (caller-scoped — only this user's orders are touched).
 * @param mode - Book (paper|live).
 * @returns Count of orders checked and how many changed status this pass.
 */
export async function reconcileOpenOrders(
  pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode,
): Promise<{ checked: number; updated: number }> {
  // ADR-134: a legacy mode normalizes to its legacy book; a real book scopes the ledger read AND
  // binds the reader to the book's account. Reconcile deliberately runs for DISABLED books too —
  // a disabled book's working orders still need their fills booked (dispatch passes every book).
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  // `sub` is REQUIRED here: the Schwab (live) adapter resolves that user's brokered OAuth token from
  // it. Omit it and configured() still passes (it only checks the app's client id/secret) while every
  // getOrder throws — a silently non-reconciling live book.
  const broker = getBrokerReader(mode, sub, book.accountNumber ? { accountNumber: book.accountNumber, connectionKey: book.connectionKey } : undefined);
  if (!broker.configured()) return { checked: 0, updated: 0 };
  const open = (await pool.query(
    `SELECT decision_id, client_order_id, broker_order_id, status
       FROM oshal_trading_orders
      WHERE user_sub=$1 AND book_id=$2 AND broker_order_id IS NOT NULL AND status = ANY($3)
      LIMIT ${RECONCILE_LIMIT}`,
    [sub, book.bookId, OPEN_STATUSES])).rows;
  let updated = 0;
  for (const o of open) {
    try {
      const result = await broker.getOrder(String(o.broker_order_id));
      await recordOrder(pool, sub, book, String(o.decision_id), String(o.client_order_id), result);
      if (result.status !== o.status) updated += 1;
    } catch (e) {
      // One bad order id must not abort the whole pass — log and continue.
      logger.warn({ err: e, brokerOrderId: o.broker_order_id }, 'order reconcile failed');
    }
  }
  if (open.length) logger.info({ sub, mode, bookRef: book.ref, checked: open.length, updated }, 'reconciled open orders');
  return { checked: open.length, updated };
}
