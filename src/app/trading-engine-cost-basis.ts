/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The engine's OWN average cost per position, replayed from its own filled orders, so a stop-loss can tell a real loss from a wash-sale artifact. Schwab reports the wash-sale-adjusted basis; on 2026-09-14 the live book stop-lossed 10 names and all 10 were within 5% of what the engine had actually paid (two were up). Book-scoped by (user_sub, book_id) because the paper and live books trade the same symbols at different fills — replaying them together produces a basis neither book ever had. Trusted only when the replayed quantity equals the venue quantity.
 */

import type { AppContext } from './composition-root';
import type { Position, TradingBook, TradingMode } from '@/features/trading';
import { legacyBook } from './trading-books-store';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-engine-cost-basis' });

/** Quantity tolerance for fractional-share rounding between the ledger and the venue. */
const QTY_EPSILON = 1e-6;

/** One filled order row as read from `oshal_trading_orders`. */
export interface EngineFillRow {
  side: string;
  filled_qty: number | string | null;
  filled_avg_price: number | string | null;
}

/** The engine's running position for one symbol after replaying its fills. */
export interface EngineCostReplay {
  qty: number;
  avg: number;
}

/**
 * @description Replay the engine's own fills for ONE symbol, average-cost style, oldest first.
 *
 * A sell reduces cost proportionally (average cost, not FIFO), and reaching flat RESETS the basis,
 * so a re-buy starts fresh. That reset is exactly what the venue's wash-sale-adjusted average does
 * not do, and it is the whole point: the engine's economic cost of a re-bought position is what it
 * paid for the re-buy, not that price plus a disallowed loss from the previous round-trip.
 *
 * @param rows - Filled orders for one symbol and one book, in chronological order.
 * @returns The remaining quantity and its average cost; `{qty:0, avg:0}` when flat.
 */
export function replayEngineCost(rows: readonly EngineFillRow[]): EngineCostReplay {
  let qty = 0;
  let cost = 0;
  for (const r of rows) {
    const q = Number(r.filled_qty ?? 0);
    const px = Number(r.filled_avg_price ?? 0);
    if (!(q > 0) || !(px > 0) || !Number.isFinite(q) || !Number.isFinite(px)) continue;
    if (r.side === 'buy') {
      qty += q;
      cost += q * px;
    } else if (r.side === 'sell' && qty > 0) {
      const take = Math.min(q, qty);
      cost -= (cost / qty) * take;
      qty -= take;
      if (qty <= QTY_EPSILON) { qty = 0; cost = 0; }
    }
  }
  return qty > 0 ? { qty, avg: cost / qty } : { qty: 0, avg: 0 };
}

/**
 * @description Decide whether a replay can stand in for the venue basis of a position.
 *
 * Only when the engine's ledger accounts for the WHOLE venue quantity. If the venue holds more, the
 * position includes lots the engine did not buy (the operator's own trades land in the same armed
 * book) and their cost is unknowable from here. If the engine thinks it holds more, its ledger is
 * out of step with the venue. Either way the answer is "no engine basis", which leaves the venue
 * decision — today's behaviour — untouched.
 *
 * @param replay - The engine's replayed position for the symbol.
 * @param venueQty - The quantity the venue reports.
 * @returns The engine's average cost, or undefined when it cannot be trusted.
 */
export function engineCostBasisFor(replay: EngineCostReplay, venueQty: number): number | undefined {
  if (!(replay.qty > 0) || !(replay.avg > 0) || !Number.isFinite(replay.avg)) return undefined;
  if (!(venueQty > 0) || Math.abs(replay.qty - venueQty) > QTY_EPSILON) return undefined;
  return replay.avg;
}

/**
 * @description Attach the engine's own average cost to each long position it fully accounts for.
 *
 * Reads THIS book's filled orders only — `(user_sub, book_id)`, the same key every other book-scoped
 * trading store uses (ADR-134) — because replaying the paper and live books together yields a basis
 * neither book ever had. Positions the engine cannot fully account for are returned unchanged. A
 * failed read degrades to "no engine basis" and logs, so the stop decision falls back to the venue
 * rather than the autopilot losing a fire.
 *
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param bookOrMode - The book, or the legacy mode (normalizes to its legacy book).
 * @param positions - Venue positions for this book.
 * @returns The positions, with `engineAvgCost` set where the engine's ledger covers them.
 */
export async function withEngineCostBasis(
  ctx: Pick<AppContext, 'pool'>, sub: string, bookOrMode: TradingBook | TradingMode, positions: Position[],
): Promise<Position[]> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const longs = positions.filter((p) => p.qty > 0).map((p) => p.symbol.toUpperCase());
  if (!longs.length) return positions;
  const started = Date.now();
  let rows: Array<EngineFillRow & { symbol: string }>;
  try {
    rows = (await ctx.pool.query(
      `SELECT upper(symbol) AS symbol, side, filled_qty, filled_avg_price
         FROM oshal_trading_orders
        WHERE user_sub = $1 AND book_id = $2 AND status = 'filled'
          AND upper(symbol) = ANY($3::text[])
        ORDER BY upper(symbol), created_at, order_id`,
      [sub, book.bookId, longs])).rows;
  } catch (err) {
    logger.error({ err, bookId: book.bookId, symbols: longs.length }, 'engine cost basis unavailable — stops fall back to the venue basis');
    return positions;
  }
  const bySymbol = new Map<string, EngineFillRow[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }
  let covered = 0;
  const out = positions.map((p) => {
    if (!(p.qty > 0)) return p;
    const basis = engineCostBasisFor(replayEngineCost(bySymbol.get(p.symbol.toUpperCase()) ?? []), p.qty);
    if (basis === undefined) return p;
    covered += 1;
    return { ...p, engineAvgCost: basis };
  });
  logger.info({ bookId: book.bookId, longs: longs.length, covered, ms: Date.now() - started }, 'engine cost basis attached');
  return out;
}
