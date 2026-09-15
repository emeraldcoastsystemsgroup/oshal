/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The engine's OWN average cost per position, replayed from its own filled orders, so a stop-loss can tell a real loss from a wash-sale artifact. Schwab reports the wash-sale-adjusted basis; on 2026-09-14 the live book stop-lossed 10 names and all 10 were within 5% of what the engine had actually paid (two were up). Book-scoped by (user_sub, book_id) because the paper and live books trade the same symbols at different fills — replaying them together produces a basis neither book ever had. Trusted only when the replayed quantity equals the venue quantity.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Price realized P&L on the engine's own cost: replayEngineRealized (pure, per sell, same average-cost reset-on-flat replay) and engineRealizedForBook (book-scoped read). The stored realized_pnl uses the venue's wash-sale-adjusted average and counts each disallowed loss twice (-6,451.61 against -1,540.50 of actual cash on the live book's flat names); reports read this instead. A sell the ledger cannot cover gets no figure rather than a guessed one. No decision path reads realized P&L, and none changes here.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-159: a long the ledger does not cover is now MARKED `unmanaged` instead of being returned unchanged, and the attachment log line carries the count. The engine reads the venue's positions, so a share bought by hand lands in the armed book and acquires an engine decision measured against a basis the engine never paid. The mark is what lets every order-decision path withhold for it while exposure, capital and drawdown keep counting it. A failed read still degrades to "no engine basis" and marks NOTHING, so a database blip cannot silently unmanage a whole book.
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
 * neither book ever had.
 *
 * ADR-159: a long the ledger does NOT cover is marked `unmanaged` rather than returned unchanged.
 * That mark is the single definition of "the engine cannot account for this" — no second heuristic,
 * no second source of truth — and every order-decision path reads it. A failed read degrades to "no
 * engine basis" and marks nothing, so the stop decision falls back to the venue exactly as it does
 * today rather than a database blip silently unmanaging the whole book.
 *
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param bookOrMode - The book, or the legacy mode (normalizes to its legacy book).
 * @param positions - Venue positions for this book.
 * @returns The positions, with `engineAvgCost` set on every long the engine's ledger covers and
 * `unmanaged: true` on every long it does not.
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
    // OPEN QUESTION (operator): this read fails OPEN. A pool failure returns the positions unmarked,
    // so for that fire NOTHING is withheld and the engine manages the whole book against the venue
    // basis — the opposite of the positions/account/equity-guard reads, which fail CLOSED and skip
    // the fire. It is deliberate today (a database blip must not silently unmanage a whole book and
    // strip its protective exits), and it is the operator's call to keep or change. Not decided here.
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
  let unmanaged = 0;
  const out = positions.map((p) => {
    if (!(p.qty > 0)) return p;
    const basis = engineCostBasisFor(replayEngineCost(bySymbol.get(p.symbol.toUpperCase()) ?? []), p.qty);
    // No basis = the engine's own fills do not account for this quantity (shares bought outside it,
    // or a ledger that no longer explains the holding). ADR-159: monitored, never managed.
    if (basis === undefined) {
      unmanaged += 1;
      return { ...p, unmanaged: true };
    }
    covered += 1;
    return { ...p, engineAvgCost: basis };
  });
  // `unmanaged` rides this line so a ledger-drift bug that wrongly unmanages a covered position is
  // visible in the stream instead of silently costing the book its protective exits.
  logger.info({ bookId: book.bookId, longs: longs.length, covered, unmanaged, ms: Date.now() - started }, 'engine cost basis attached');
  return out;
}

/** One filled order row with its identity, for pricing each sell on the engine's own cost. */
export interface EngineSaleRow extends EngineFillRow {
  order_id: string;
}

/** The engine's realized result for one sell. */
export interface EngineRealizedSale {
  /** Average cost of the shares this sell closed, from the engine's own fills. */
  costBasis: number;
  /** (fill - costBasis) x qty: what the round trip actually made or lost. */
  realizedPnl: number;
}

/**
 * @description Price every sell for ONE symbol against the engine's own average cost at that moment:
 * the same average-cost, reset-on-flat replay as `replayEngineCost`.
 *
 * The stored `realized_pnl` uses the venue's average price, which after a wash sale carries the
 * disallowed loss - so each disallowed loss is counted twice, once at the loss sale and again through
 * the re-buy's inflated basis. On the live book that made -6,451.61 out of -1,540.50 of actual cash on
 * the names that went back to flat. This replay is the economic figure: a symbol that returns to flat
 * realizes exactly its sells minus its buys. The venue's column stays as it is (it is what the venue
 * reported); reports read this.
 *
 * A sell the replay cannot fully cover - the ledger shows fewer shares than were sold, from ledger
 * drift or shares the engine did not buy - gets no entry: its cost is unknowable from here, and a
 * guessed figure would be reported as fact.
 *
 * @param rows - Filled orders for one symbol and one book, in chronological order.
 * @returns The realized result for each sell the engine's own fills fully cover, by order id.
 */
export function replayEngineRealized(rows: readonly EngineSaleRow[]): Map<string, EngineRealizedSale> {
  const sales = new Map<string, EngineRealizedSale>();
  let qty = 0;
  let cost = 0;
  for (const r of rows) {
    const q = Number(r.filled_qty ?? 0);
    const px = Number(r.filled_avg_price ?? 0);
    if (!(q > 0) || !(px > 0) || !Number.isFinite(q) || !Number.isFinite(px)) continue;
    if (r.side === 'buy') {
      qty += q;
      cost += q * px;
      continue;
    }
    if (r.side !== 'sell') continue;
    if (qty > 0 && qty + QTY_EPSILON >= q) {
      const avg = cost / qty;
      sales.set(r.order_id, { costBasis: avg, realizedPnl: (px - avg) * q });
    }
    const take = Math.min(q, qty);
    if (take > 0) {
      cost -= (cost / qty) * take;
      qty -= take;
    }
    if (qty <= QTY_EPSILON) { qty = 0; cost = 0; }
  }
  return sales;
}

/**
 * @description The engine's realized result for the sells in ONE book, keyed by order id, read from
 * the book's own filled orders. Book-scoped by `(user_sub, book_id)` like every trading store, because
 * replaying two books together prices a sale against lots it never held. A failed read throws: a
 * report must not print a number it could not compute.
 *
 * @param ctx - Anything carrying the pool.
 * @param sub - Owner sub.
 * @param bookId - The book.
 * @param symbols - Optional symbols to limit the replay to (their full history is still read).
 * @returns Realized results for every fully covered sell.
 */
export async function engineRealizedForBook(
  ctx: Pick<AppContext, 'pool'>, sub: string, bookId: string, symbols?: readonly string[],
): Promise<Map<string, EngineRealizedSale>> {
  const scoped = symbols && symbols.length ? [...new Set(symbols.map((s) => s.toUpperCase()))] : null;
  const rows = (await ctx.pool.query(
    `SELECT order_id::text AS order_id, upper(symbol) AS symbol, side, filled_qty, filled_avg_price
       FROM oshal_trading_orders
      WHERE user_sub = $1 AND book_id = $2 AND status = 'filled'
        ${scoped ? 'AND upper(symbol) = ANY($3::text[])' : ''}
      ORDER BY upper(symbol), created_at, order_id`,
    scoped ? [sub, bookId, scoped] : [sub, bookId])).rows as Array<EngineSaleRow & { symbol: string }>;
  const bySymbol = new Map<string, EngineSaleRow[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }
  const out = new Map<string, EngineRealizedSale>();
  for (const list of bySymbol.values()) {
    for (const [orderId, sale] of replayEngineRealized(list)) out.set(orderId, sale);
  }
  return out;
}
