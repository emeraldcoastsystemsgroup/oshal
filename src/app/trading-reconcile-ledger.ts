/**
 * Ledger reconcile against the broker's own transaction history — books closes that happened OUTSIDE
 * the engine (a manual sell) so the ledger's derived position + realized P&L match the broker. Read
 * authority is the venue: getTransactions() is the truth, the ledger is corrected to it. NEVER places
 * an order — it only writes historical ledger rows (recordOrder), clearly marked + reversible.
 *
 * Every safety property here came from an adversarial design review (2026-07-15) of a real-money
 * reconcile — the comments name the failure mode each guard closes.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — transaction-based ledger reconcile (dry-run default). Matches every Schwab TRADE sell against ALL ledger sells (orderId OR qty+price+date, never filtering broker_order_id IS NOT NULL — the clobber/NULL case), books only truly-unbooked closes with FIFO cost basis from a full-history replay, and REFUSES any symbol where the unbooked-sell shares don't sum exactly to the excess (the SKHYV when-issued→regular-way ticker-conversion case). A separate operator-confirmed manualCloses path books a synthetic close a commingled venue history can't auto-map. created_at = the real trade date (never now()).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — recordOrder now comes from app/trading-engine.ts instead of the carvable route surface. Zero behavior change.
 *
 * @module trading-reconcile-ledger
 */

import type { AppContext } from './composition-root';
import { getBrokerReader, type BrokerTransaction, type TradingMode } from '@/features/trading';
import { recordOrder } from './trading-engine';
import { createChildLogger } from '@/shared/logger';
import * as crypto from 'crypto';

const logger = createChildLogger({ module: 'trading-reconcile-ledger' });

const EPS = 1e-6;
/** Tolerances for matching a Schwab sell to an already-booked ledger sell when the order id is unusable. */
const PRICE_TOL = 0.02; // $/share
const TIME_TOL_MS = 6 * 60 * 60 * 1000; // same-session proximity (venue tradeDate vs our created_at)

/** A close the reconcile would (or did) book. */
export interface ReconcileBooking {
  symbol: string; qty: number; price: number; costBasis: number; realizedPnl: number;
  tradeDate: string; clientOrderId: string; source: 'txn' | 'manual';
}
/** Per-symbol outcome. */
export interface ReconcileSymbol {
  symbol: string; ledgerNet: number; schwabQty: number; excess: number;
  action: 'book' | 'refuse' | 'skip-short' | 'already-clean' | 'manual';
  reason?: string; bookings: ReconcileBooking[];
}
/** An operator-confirmed synthetic close for a symbol whose venue history can't be auto-mapped. */
export interface ManualClose { symbol: string; qty: number; price: number; costBasis: number; tradeDate: string; reason: string; }
/** The whole reconcile result. */
export interface ReconcileReport {
  mode: TradingMode; apply: boolean; symbols: ReconcileSymbol[];
  totalRealized: number; bookedRows: number;
}

/** A ledger sell row we match Schwab sells against (ALL of them — never filtered by broker_order_id). */
interface LedgerSell { brokerOrderId: string | null; qty: number; price: number; createdAtMs: number; }

/** Ledger net position (filled buys − sells) per symbol, and each symbol's filled sells. */
async function loadLedger(pool: AppContext['pool'], sub: string, mode: TradingMode): Promise<{
  net: Map<string, number>; sells: Map<string, LedgerSell[]>;
}> {
  const rows = (await pool.query(
    `SELECT upper(symbol) AS symbol, side, filled_qty, filled_avg_price, broker_order_id, created_at
       FROM oshal_trading_orders WHERE user_sub=$1 AND mode=$2 AND status='filled'`, [sub, mode])).rows;
  const net = new Map<string, number>(); const sells = new Map<string, LedgerSell[]>();
  for (const r of rows) {
    const q = Number(r.filled_qty || 0);
    net.set(r.symbol, (net.get(r.symbol) || 0) + (r.side === 'buy' ? q : -q));
    if (r.side === 'sell') {
      const arr = sells.get(r.symbol) || [];
      arr.push({ brokerOrderId: r.broker_order_id ? String(r.broker_order_id) : null, qty: q, price: Number(r.filled_avg_price || 0), createdAtMs: new Date(r.created_at).getTime() });
      sells.set(r.symbol, arr);
    }
  }
  return { net, sells };
}

/** Is this Schwab sell already booked as a ledger sell? Match by orderId, ELSE qty+price+date proximity
 *  (broker_order_id is documented-unreliable: NULL on dropped Location headers, clobbered by migration-065). */
export function isAlreadyBooked(tx: BrokerTransaction, ledgerSells: LedgerSell[]): boolean {
  const txMs = new Date(tx.tradeDate).getTime();
  return ledgerSells.some((s) =>
    (s.brokerOrderId && tx.orderId && s.brokerOrderId === tx.orderId) ||
    (Math.abs(s.qty - tx.qty) < EPS && Math.abs(s.price - tx.price) <= PRICE_TOL && Math.abs(s.createdAtMs - txMs) <= TIME_TOL_MS));
}

/** FIFO cost basis for a target sell activityId, from a full chronological replay of the venue's TRADE
 *  history. Returns null on lot underflow (incomplete history — a buy outside the window) so the caller
 *  ABORTS the symbol rather than booking a wrong/zero basis. */
export function fifoBasisFor(txns: BrokerTransaction[], targetId: string): number | null {
  const lots: Array<{ qty: number; price: number }> = [];
  const ordered = [...txns].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  for (const t of ordered) {
    if (t.side === 'buy') { lots.push({ qty: t.qty, price: t.price }); continue; }
    let need = t.qty; let cost = 0; const consumed = need;
    while (need > EPS) {
      const lot = lots[0];
      if (!lot) return null; // lot underflow → incomplete history (opening buy outside the window) → abort symbol
      const take = Math.min(lot.qty, need);
      cost += take * lot.price; lot.qty -= take; need -= take;
      if (lot.qty <= EPS) lots.shift();
    }
    if (t.transactionId === targetId) return consumed > 0 ? cost / consumed : null;
  }
  return null; // target not found among sells
}

/** Book one close through the shared recordOrder upsert (idempotent by clientOrderId, back-dated). */
async function bookClose(pool: AppContext['pool'], sub: string, mode: TradingMode, b: ReconcileBooking): Promise<void> {
  // Each reconcile row needs a justifying decision (FK). A deterministic decision id keeps re-runs idempotent.
  const decisionId = crypto.createHash('sha1').update(`reconcile:${mode}:${b.clientOrderId}`).digest('hex').slice(0, 32)
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5');
  await pool.query(
    `INSERT INTO oshal_trading_decisions (decision_id, user_sub, mode, signal_ids, action, symbol, side, qty, confidence, rationale, indicators)
     VALUES ($1,$2,$3,'{}','sell',$4,'sell',$5,1,$6,$7)
     ON CONFLICT (decision_id) DO NOTHING`,
    [decisionId, sub, mode, b.symbol, b.qty, `Ledger reconcile — ${b.source} close booked from the broker's own record. ${b.clientOrderId}`,
     JSON.stringify({ reason: 'ledger-reconcile', source: b.source })]);
  await recordOrder(pool, sub, mode, decisionId, b.clientOrderId, {
    id: null as any, clientOrderId: b.clientOrderId, status: 'filled', symbol: b.symbol, side: 'sell',
    qty: b.qty, type: 'market', filledQty: b.qty, filledAvgPrice: b.price, provider: 'schwab', mode,
    rawStatus: 'RECONCILE',
  } as any, b.costBasis, b.tradeDate);
}

/** Build the auto-detected bookings for one symbol, or a refusal. Pure over the fetched inputs. */
export function planSymbol(symbol: string, ledgerNet: number, schwabQty: number, txns: BrokerTransaction[], ledgerSells: LedgerSell[]): ReconcileSymbol {
  const base: ReconcileSymbol = { symbol, ledgerNet, schwabQty, excess: 0, action: 'already-clean', bookings: [] };
  if (schwabQty < -EPS) return { ...base, action: 'skip-short', reason: `Schwab net short (${schwabQty}) — out of scope for a long-close reconcile.` };
  const excess = ledgerNet - Math.max(0, schwabQty);
  base.excess = excess;
  if (excess <= EPS) return base; // ledger already matches (or under) the venue — nothing to do
  // Candidates = venue TRADE sells NOT already booked in the ledger (matched by orderId OR qty+price+date).
  const candidates = txns.filter((t) => t.side === 'sell' && !isAlreadyBooked(t, ledgerSells));
  const candQty = candidates.reduce((s, t) => s + t.qty, 0);
  // POSITIVE ASSERTION: the unbooked sells must explain the excess EXACTLY. If they don't (SKHYV: a
  // commingled 119-share sale + ticker conversion), REFUSE — never guess which sells map to the excess.
  if (Math.abs(candQty - excess) > EPS) {
    return { ...base, action: 'refuse', reason: `Unbooked venue sells (${candQty}) do not sum to the ledger excess (${excess}). Likely a commingled/transferred/ticker-changed position — needs an explicit manual close.` };
  }
  const bookings: ReconcileBooking[] = [];
  for (const t of candidates) {
    const basis = fifoBasisFor(txns, t.transactionId);
    if (basis == null) return { ...base, action: 'refuse', reason: `FIFO cost basis unresolved for ${t.transactionId} (incomplete venue history in the window) — widen lookback or handle manually.` };
    bookings.push({ symbol, qty: t.qty, price: t.price, costBasis: basis, realizedPnl: (t.price - basis) * t.qty, tradeDate: t.tradeDate, clientOrderId: `reconcile:schwab:${t.transactionId}`, source: 'txn' });
  }
  return { ...base, action: 'book', bookings };
}

/**
 * @description Reconcile the ledger to the broker's transaction history. DRY-RUN by default (apply=false
 * plans but writes nothing). For each symbol whose ledger net EXCEEDS the venue position, auto-detect the
 * unbooked close(s) and book them with FIFO basis; refuse anything ambiguous. Operator-confirmed
 * `manualCloses` book a synthetic close a commingled venue history can't auto-map (e.g. the SKHYV
 * when-issued→regular-way conversion). Only writes ledger rows — never places an order.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param mode - Book (live has a transactions endpoint; paper does not → nothing to do).
 * @param opts - apply (commit vs dry-run), optional symbol allowlist, optional manualCloses.
 * @returns The full per-symbol plan/outcome.
 */
export async function reconcileLedger(
  ctx: AppContext, sub: string, mode: TradingMode,
  opts: { apply: boolean; symbols?: string[]; manualCloses?: ManualClose[] },
): Promise<ReconcileReport> {
  const broker = getBrokerReader(mode, sub);
  if (!broker.configured() || !broker.getTransactions) {
    return { mode, apply: opts.apply, symbols: [], totalRealized: 0, bookedRows: 0 };
  }
  const [{ net, sells }, positions] = await Promise.all([loadLedger(ctx.pool, sub, mode), broker.getPositions().catch(() => [])]);
  const schwabQty = new Map<string, number>();
  for (const p of positions) schwabQty.set(p.symbol.toUpperCase(), (schwabQty.get(p.symbol.toUpperCase()) || 0) + p.qty);
  const manualBySym = new Map<string, ManualClose>();
  for (const m of opts.manualCloses || []) manualBySym.set(m.symbol.toUpperCase(), m);
  const allow = opts.symbols ? new Set(opts.symbols.map((s) => s.toUpperCase())) : null;

  const from = new Date(Date.now() - 120 * 86400000).toISOString();
  const to = new Date().toISOString();
  const out: ReconcileSymbol[] = [];
  // Candidate symbols: ledger net strictly above the venue position, or an explicit manual close.
  const overSymbols = [...net.keys()].filter((s) => (net.get(s) || 0) - Math.max(0, schwabQty.get(s) || 0) > EPS);
  const symbols = new Set<string>([...overSymbols, ...manualBySym.keys()]);
  for (const symbol of symbols) {
    if (allow && !allow.has(symbol)) continue;
    const ledgerNet = net.get(symbol) || 0; const sq = schwabQty.get(symbol) || 0;
    const manual = manualBySym.get(symbol);
    if (manual) {
      // Operator-confirmed synthetic close. Guard: the ledger must still be long exactly what we're closing.
      const excess = ledgerNet - Math.max(0, sq);
      if (Math.abs(excess - manual.qty) > EPS) {
        out.push({ symbol, ledgerNet, schwabQty: sq, excess, action: 'refuse', reason: `Manual close qty ${manual.qty} != current ledger excess ${excess}; refusing (ledger changed since it was authored).`, bookings: [] });
        continue;
      }
      out.push({ symbol, ledgerNet, schwabQty: sq, excess, action: 'manual', reason: manual.reason, bookings: [{ symbol, qty: manual.qty, price: manual.price, costBasis: manual.costBasis, realizedPnl: (manual.price - manual.costBasis) * manual.qty, tradeDate: manual.tradeDate, clientOrderId: `reconcile:manual:${symbol}:${manual.tradeDate.slice(0, 10)}`, source: 'manual' }] });
      continue;
    }
    const txns = await broker.getTransactions(from, to, symbol).catch((err) => { logger.warn({ symbol, err }, 'reconcile getTransactions failed'); return [] as BrokerTransaction[]; });
    out.push(planSymbol(symbol, ledgerNet, sq, txns, sells.get(symbol) || []));
  }

  let totalRealized = 0; let bookedRows = 0;
  for (const s of out) {
    if (s.action !== 'book' && s.action !== 'manual') continue;
    for (const b of s.bookings) {
      totalRealized += b.realizedPnl; bookedRows += 1;
      if (opts.apply) await bookClose(ctx.pool, sub, mode, b);
    }
  }
  logger.info({ sub, mode, apply: opts.apply, symbols: out.length, bookedRows, totalRealized: Math.round(totalRealized * 100) / 100 }, 'ledger reconcile');
  return { mode, apply: opts.apply, symbols: out, totalRealized: Math.round(totalRealized * 100) / 100, bookedRows };
}
