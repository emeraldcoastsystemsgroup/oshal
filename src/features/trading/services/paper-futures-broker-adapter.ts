/**
 * Paper futures broker — a built-in, vendor-neutral execution simulator for the futures extension
 * (ADR-116).
 *
 * The two wired equities rails (Alpaca, Schwab) hardcode `assetType:'EQUITY'`, long-only, and delegate
 * all state to the vendor. Futures need shorting, a contract multiplier, and — since there is no free
 * futures paper venue equivalent to Alpaca-paper — a self-contained simulator. This adapter IS that
 * simulator: it implements the same `BrokerAdapter` contract so every consumer of that interface works
 * unchanged, fills market/limit orders against an injected mark-price resolver, and keeps a proper
 * futures P&L book (signed position, weighted-average entry, realized on close, unrealized at mark,
 * all scaled by the instrument multiplier from futures-contract.ts).
 *
 * Honest scope for v1: the book is IN-MEMORY (per process — resets on restart) and stop / stop_limit /
 * trailing_stop orders are ACCEPTED as working but not auto-triggered (no intrabar simulation yet).
 * Durable persistence and stop-trigger simulation are tracked in BACKLOG. This is a real simulator,
 * not a stub — market and limit fills, shorting, and mark-to-market P&L all execute for real.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — PaperFuturesBrokerAdapter implementing BrokerAdapter: idempotent placeOrder (market fills at injected mark, limit at limit price, stop family accepted-working), signed-position book with multiplier-scaled realized/unrealized P&L, positions/account/order reads, in-memory. createPaperFuturesBroker factory + FuturesPriceResolver.
 *
 * @module paper-futures-broker-adapter
 */

import { createChildLogger } from '@/shared/logger';
import type {
  BrokerAccount, BrokerAdapter, OrderRequest, OrderResult, OrderStatus, Position, TradingMode,
} from './broker-adapter';
import { getFuturesRoot, parseFuturesSymbol } from './futures-contract';

const logger = createChildLogger({ module: 'paper-futures-broker' });

/** Resolves the current mark price for a futures symbol (for market fills + mark-to-market). Null = unknown. */
export type FuturesPriceResolver = (symbol: string) => Promise<number | null>;

/** Construction options for the paper futures broker. */
export interface PaperFuturesOptions {
  /** Opening account cash (default $100,000). */
  startingCash?: number;
  /** Mark-price resolver — required for market fills and position marks. */
  priceResolver: FuturesPriceResolver;
}

/** A signed paper position: qty>0 long, qty<0 short. */
interface PaperPosition { qty: number; avgEntryPrice: number }

/**
 * In-memory futures paper book. Instantiate via `createPaperFuturesBroker`.
 */
export class PaperFuturesBrokerAdapter implements BrokerAdapter {
  readonly provider = 'paper' as const;
  private readonly startingCash: number;
  private readonly resolvePrice: FuturesPriceResolver;
  private readonly book = new Map<string, PaperPosition>();
  private readonly orders = new Map<string, OrderResult>();
  private readonly clientToId = new Map<string, string>();
  private realizedPnl = 0;
  private seq = 0;

  /**
   * @description Construct the simulator.
   * @param opts - Starting cash + the mark-price resolver.
   */
  constructor(opts: PaperFuturesOptions) {
    this.startingCash = opts.startingCash ?? 100_000;
    this.resolvePrice = opts.priceResolver;
  }

  /** Simulator is always the paper book. */
  mode(): TradingMode { return 'paper'; }

  /** Always available — no credentials needed. */
  configured(): boolean { return true; }

  /** @inheritdoc — idempotent on clientOrderId; market fills at mark, limit at limit price. */
  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const existingId = this.clientToId.get(req.clientOrderId);
    if (existingId) return this.orders.get(existingId)!; // idempotent replay
    const root = parseFuturesSymbol(req.symbol);
    if (!root) return this.reject(req, `not a known futures contract: ${req.symbol}`);
    const multiplier = getFuturesRoot(root.root.root)?.multiplier ?? root.root.multiplier;
    const fillPrice = await this.fillPriceFor(req);
    const id = `paper-${++this.seq}`;
    this.clientToId.set(req.clientOrderId, id);
    if (fillPrice == null) return this.working(req, id); // stop family / unmarketable → working
    this.applyFill(req.symbol, req.side, req.qty, fillPrice, multiplier);
    const result = this.result(req, id, 'filled', { filledQty: req.qty, filledAvgPrice: fillPrice });
    this.orders.set(id, result);
    logger.info({ symbol: req.symbol, side: req.side, qty: req.qty, fillPrice }, 'paper futures fill');
    return result;
  }

  /** Decide the fill price: market → mark, limit → limit price, stop family → null (working). */
  private async fillPriceFor(req: OrderRequest): Promise<number | null> {
    if (req.type === 'market') return this.resolvePrice(req.symbol);
    if (req.type === 'limit') return req.limitPrice ?? null;
    return null; // stop / stop_limit / trailing_stop: accepted working, trigger sim is BACKLOG
  }

  /** Mutate the signed book + realized P&L for a fill; weighted-avg on adds, realize on closes. */
  private applyFill(symbol: string, side: 'buy' | 'sell', qty: number, price: number, multiplier: number): void {
    const delta = side === 'buy' ? qty : -qty;
    const cur = this.book.get(symbol) ?? { qty: 0, avgEntryPrice: 0 };
    const closing = cur.qty !== 0 && Math.sign(delta) === -Math.sign(cur.qty);
    if (closing) {
      const closeQty = Math.min(Math.abs(cur.qty), Math.abs(delta));
      this.realizedPnl += (price - cur.avgEntryPrice) * closeQty * Math.sign(cur.qty) * multiplier;
      const newQty = cur.qty + delta;
      const avg = newQty === 0 ? 0 : (Math.sign(newQty) === Math.sign(cur.qty) ? cur.avgEntryPrice : price);
      this.setPosition(symbol, newQty, avg);
    } else {
      const newQty = cur.qty + delta;
      const avg = (cur.avgEntryPrice * Math.abs(cur.qty) + price * qty) / (Math.abs(cur.qty) + qty);
      this.setPosition(symbol, newQty, avg);
    }
  }

  private setPosition(symbol: string, qty: number, avgEntryPrice: number): void {
    if (qty === 0) this.book.delete(symbol);
    else this.book.set(symbol, { qty, avgEntryPrice });
  }

  /** @inheritdoc */
  async getOrder(orderId: string): Promise<OrderResult> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`paper futures: unknown order ${orderId}`);
    return o;
  }

  /** @inheritdoc — cancels a working order; a filled/terminal order is returned unchanged. */
  async cancelOrder(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o && (o.status === 'accepted' || o.status === 'pending')) {
      this.orders.set(orderId, { ...o, status: 'canceled' });
    }
  }

  /** @inheritdoc */
  async listOrders(fromIso: string, toIso: string): Promise<OrderResult[]> {
    const from = Date.parse(fromIso), to = Date.parse(toIso);
    return [...this.orders.values()].filter((o) => {
      const t = o.submittedAt ? Date.parse(o.submittedAt) : NaN;
      return Number.isNaN(t) || (t >= from && t <= to);
    });
  }

  /** @inheritdoc — marks each position at the resolver's price. */
  async getPositions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const [symbol, pos] of this.book) {
      const mark = (await this.resolvePrice(symbol)) ?? pos.avgEntryPrice;
      const multiplier = getFuturesRoot(parseFuturesSymbol(symbol)?.root.root ?? '')?.multiplier ?? 1;
      out.push({
        symbol, qty: pos.qty, avgEntryPrice: pos.avgEntryPrice,
        marketValue: mark * pos.qty * multiplier,
        unrealizedPl: (mark - pos.avgEntryPrice) * pos.qty * multiplier,
        currentPrice: mark,
      });
    }
    return out;
  }

  /** @inheritdoc — cash = starting + realized; equity = cash + unrealized. */
  async getAccount(): Promise<BrokerAccount> {
    const positions = await this.getPositions();
    const unrealized = positions.reduce((s, p) => s + p.unrealizedPl, 0);
    const cash = this.startingCash + this.realizedPnl;
    return { cash, buyingPower: cash, equity: cash + unrealized, currency: 'USD', status: 'ACTIVE' };
  }

  /** Build a rejected result. */
  private reject(req: OrderRequest, reason: string): OrderResult {
    const id = `paper-rej-${++this.seq}`;
    const r = this.result(req, id, 'rejected', { rejectReason: reason });
    this.orders.set(id, r);
    logger.warn({ symbol: req.symbol, reason }, 'paper futures order rejected');
    return r;
  }

  /** Build + record an accepted (working) result. */
  private working(req: OrderRequest, id: string): OrderResult {
    const r = this.result(req, id, 'accepted', {});
    this.orders.set(id, r);
    return r;
  }

  /** Assemble a normalized OrderResult for this order. */
  private result(req: OrderRequest, id: string, status: OrderStatus, extra: Partial<OrderResult>): OrderResult {
    return {
      id, clientOrderId: req.clientOrderId, status, symbol: req.symbol, side: req.side, qty: req.qty,
      type: req.type, limitPrice: req.limitPrice, stopPrice: req.stopPrice,
      filledQty: 0, provider: 'paper', mode: 'paper', submittedAt: new Date().toISOString(), ...extra,
    };
  }
}

/**
 * @description Construct a paper futures broker.
 * @param opts - Starting cash + a mark-price resolver (wire it to the bar store's latest close or a live feed).
 * @returns A `BrokerAdapter` backed by the in-memory futures simulator.
 */
export function createPaperFuturesBroker(opts: PaperFuturesOptions): BrokerAdapter {
  return new PaperFuturesBrokerAdapter(opts);
}
