/**
 * Alpaca broker adapter — the first concrete trade-execution rail (ADR-052).
 *
 * Implements `BrokerAdapter` over the Alpaca Trading REST API using `fetch` + JSON +
 * the APCA key headers — no `@alpacahq/alpaca-trade-api` SDK dependency, same style as
 * stripe-payment-adapter.ts / finance-plaid.ts.
 *
 * Dual-mode is physical, not a flag: Alpaca exposes two fully separate accounts with
 * DISTINCT base URLs and DISTINCT key pairs —
 *   paper → https://paper-api.alpaca.markets   (ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY)
 *   live  → https://api.alpaca.markets          (ALPACA_LIVE_KEY_ID  / ALPACA_LIVE_SECRET_KEY)
 * This adapter is instantiated per mode; the paper instance and the live instance never
 * share a URL or a credential. The provider factory refuses to hand out a live adapter
 * unless TRADING_LIVE_ENABLED=true (ADR-052 ships paper-only by default).
 *
 * Scope: cash equities, long-only, market/limit, time_in_force=day. Idempotency rides on
 * Alpaca's `client_order_id` so a retry never double-places.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Alpaca v2 account/positions/orders (place/get/cancel), fetch-based, per-mode base URL + key pair, normalized status mapping, client_order_id idempotency.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | listOrders(from,to) over /v2/orders?status=all — the venue-side record used to re-find an order whose stored broker id is missing or belongs to the other book.
 *
 * @module alpaca-broker-adapter
 */

import { createChildLogger } from '@/shared/logger';
import type {
  BrokerAdapter, BrokerAccount, BrokerProviderType, OrderRequest, OrderResult,
  OrderStatus, Position, PortfolioHistory, TradingMode,
} from './broker-adapter';

const logger = createChildLogger({ module: 'alpaca-broker-adapter' });

const PAPER_BASE = 'https://paper-api.alpaca.markets';
const LIVE_BASE = 'https://api.alpaca.markets';

/** First non-empty environment value among the given names (alias resolution). */
function envFirst(...names: string[]): string {
  for (const n of names) { const v = process.env[n]; if (v) return v.trim(); }
  return '';
}

/**
 * @description `fetch` with an AbortController timeout so a hung Alpaca order/account call can't
 * stall the trade path indefinitely. Default 8s, overridable via ALPACA_FETCH_TIMEOUT_MS. The
 * timer is always cleared in `finally`.
 * @param url - Request URL.
 * @param init - Fetch init (method/headers/body); the abort signal is merged in.
 * @param ms - Timeout in milliseconds.
 * @returns The fetch Response.
 */
async function fetchT(url: string, init: RequestInit = {}, ms = Number(process.env.ALPACA_FETCH_TIMEOUT_MS) || 8000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

/** Normalize a base URL override: drop trailing slashes and a trailing `/v2`
 *  (we append `/v2/...` per call, so an endpoint that already includes it would double up). */
function normalizeBase(url: string): string {
  if (!url) return '';
  return url.replace(/\/+$/, '').replace(/\/v2$/i, '');
}

/** Map an Alpaca order status → our normalized OrderStatus. */
function normalizeStatus(alpacaStatus: string): OrderStatus {
  switch (alpacaStatus) {
    case 'filled': return 'filled';
    case 'partially_filled': return 'partially_filled';
    case 'canceled':
    case 'pending_cancel': return 'canceled';
    case 'expired': return 'expired';
    case 'rejected':
    case 'suspended':
    case 'stopped': return 'rejected';
    case 'new':
    case 'accepted':
    case 'replaced':
    case 'done_for_day': return 'accepted';
    case 'pending_new':
    case 'accepted_for_bidding':
    case 'calculated': return 'pending';
    default: return 'pending';
  }
}

/** The bits of an Alpaca order we read. */
interface AlpacaOrder {
  id: string;
  client_order_id: string;
  status: string;
  symbol: string;
  side: string;
  qty: string;
  order_type?: string;
  type?: string;
  limit_price?: string | null;
  stop_price?: string | null;
  trail_price?: string | null;
  trail_percent?: string | null;
  time_in_force?: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
  submitted_at?: string;
  // Some rejects arrive without a dedicated reason field; we surface status verbatim.
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
  current_price?: string;
  change_today?: string;
  unrealized_intraday_pl?: string;
}

interface AlpacaAccount {
  cash: string;
  buying_power: string;
  equity: string;
  last_equity?: string;
  currency?: string;
  status?: string;
}

/** The Alpaca-backed trade-execution rail, bound to one book (paper|live). */
export class AlpacaBrokerAdapter implements BrokerAdapter {
  readonly provider: BrokerProviderType = 'alpaca';
  private readonly _mode: TradingMode;
  private readonly base: string;
  private readonly keyId: string;
  private readonly secretKey: string;

  constructor(mode: TradingMode) {
    this._mode = mode;
    // Canonical per-mode names are primary; common aliases (incl. the single ALPACA_KEY /
    // ALPAKA_KEY pair pointed at one account, and the misspelled ALPAKA_*) resolve too, so
    // an existing .env keeps working. The single-pair aliases map to the PAPER book — the
    // book the operator is testing; live always needs its own distinct key pair.
    if (mode === 'live') {
      this.keyId = envFirst('ALPACA_LIVE_KEY_ID', 'ALPACA_LIVE_KEY', 'ALPAKA_LIVE_KEY');
      this.secretKey = envFirst('ALPACA_LIVE_SECRET_KEY', 'ALPACA_LIVE_SECRET', 'ALPAKA_LIVE_SECRET');
      this.base = normalizeBase(envFirst('ALPACA_LIVE_ENDPOINT', 'ALPAKA_LIVE_ENDPOINT')) || LIVE_BASE;
    } else {
      this.keyId = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
      this.secretKey = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
      this.base = normalizeBase(envFirst('ALPACA_PAPER_ENDPOINT', 'ALPACA_ENDPOINT', 'ALPAKA_ENDPOINT')) || PAPER_BASE;
    }
  }

  mode(): TradingMode { return this._mode; }

  /** True once this mode's key pair is present. */
  configured(): boolean {
    return Boolean(this.keyId && this.secretKey);
  }

  /**
   * @description Low-level Alpaca request. Injects the APCA key headers and throws on a
   * non-2xx with Alpaca's message.
   * @param method - HTTP method.
   * @param pathname - API path (e.g. '/v2/orders').
   * @param body - JSON body (omitted for GET/DELETE).
   * @returns The parsed JSON response (or {} for 204).
   */
  private async request<T>(method: 'GET' | 'POST' | 'DELETE', pathname: string, body?: Record<string, unknown>): Promise<T> {
    const r = await fetchT(`${this.base}${pathname}`, {
      method,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return {} as T;
    const j = (await r.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>;
    if (!r.ok) {
      throw new Error(j.message || `alpaca ${pathname} ${r.status}`);
    }
    return j as T;
  }

  /**
   * @description Place an equity order — any of market/limit/stop/stop_limit/trailing_stop,
   * long or short. Validates the price params each type requires. Idempotent on clientOrderId.
   * @param req - The normalized order request.
   * @returns The placed order, normalized.
   */
  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!(req.qty > 0)) throw new Error('qty must be a positive number of shares');
    // trailing_stop cannot use 'day'-incompatible TIFs the same way; default day, allow gtc.
    const tif = req.timeInForce || 'day';
    const body: Record<string, unknown> = {
      symbol: req.symbol.toUpperCase(),
      qty: String(req.qty),
      side: req.side,
      type: req.type,
      time_in_force: tif,
      client_order_id: req.clientOrderId,
    };
    // Pre/post-market routing — Alpaca only accepts it on a LIMIT day order.
    if (req.extendedHours && req.type === 'limit') body.extended_hours = true;
    switch (req.type) {
      case 'market':
        break;
      case 'limit':
        if (!(Number(req.limitPrice) > 0)) throw new Error('limit orders require a positive limitPrice');
        body.limit_price = String(req.limitPrice);
        break;
      case 'stop':
        if (!(Number(req.stopPrice) > 0)) throw new Error('stop orders require a positive stopPrice');
        body.stop_price = String(req.stopPrice);
        break;
      case 'stop_limit':
        if (!(Number(req.stopPrice) > 0) || !(Number(req.limitPrice) > 0)) throw new Error('stop_limit orders require positive stopPrice and limitPrice');
        body.stop_price = String(req.stopPrice);
        body.limit_price = String(req.limitPrice);
        break;
      case 'trailing_stop':
        if (Number(req.trailPrice) > 0) body.trail_price = String(req.trailPrice);
        else if (Number(req.trailPercent) > 0) body.trail_percent = String(req.trailPercent);
        else throw new Error('trailing_stop orders require trailPrice or trailPercent');
        break;
      default:
        throw new Error(`unsupported order type: ${req.type}`);
    }
    logger.info({ userSub: req.userSub, mode: this._mode, symbol: req.symbol, side: req.side, qty: req.qty, type: req.type, tif }, 'alpaca placeOrder');
    const o = await this.request<AlpacaOrder>('POST', '/v2/orders', body);
    return this.toResult(o);
  }

  /**
   * @description Fetch one order's current state.
   * @param orderId - The Alpaca order id from placeOrder.
   * @returns The order's current normalized state.
   */
  async getOrder(orderId: string): Promise<OrderResult> {
    const o = await this.request<AlpacaOrder>('GET', `/v2/orders/${encodeURIComponent(orderId)}`);
    return this.toResult(o);
  }

  /**
   * @description Cancel a working order. A 404/422 (already terminal) is swallowed.
   * @param orderId - The Alpaca order id.
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * @description Every order Alpaca recorded as submitted inside a window (`status=all` so terminal
   * orders are included — recovery usually looks for one that already filled).
   * @param fromIso - Window start, ISO-8601 (Alpaca `after`, exclusive).
   * @param toIso - Window end, ISO-8601 (Alpaca `until`, exclusive).
   * @returns The orders submitted in that window, normalized.
   */
  async listOrders(fromIso: string, toIso: string): Promise<OrderResult[]> {
    const qs = `status=all&direction=asc&limit=500&after=${encodeURIComponent(fromIso)}&until=${encodeURIComponent(toIso)}`;
    const rows = await this.request<AlpacaOrder[]>('GET', `/v2/orders?${qs}`);
    return (rows || []).map((o) => this.toResult(o));
  }

  /** Current open positions in this book. */
  async getPositions(): Promise<Position[]> {
    const rows = await this.request<AlpacaPosition[]>('GET', '/v2/positions');
    return (rows || []).map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty || 0),
      avgEntryPrice: Number(p.avg_entry_price || 0),
      marketValue: Number(p.market_value || 0),
      unrealizedPl: Number(p.unrealized_pl || 0),
      currentPrice: p.current_price != null ? Number(p.current_price) : undefined,
      changeToday: p.change_today != null ? Number(p.change_today) : undefined,
      unrealizedIntradayPl: p.unrealized_intraday_pl != null ? Number(p.unrealized_intraday_pl) : undefined,
    }));
  }

  /** The account snapshot (cash, buying power, equity) for this book. */
  async getAccount(): Promise<BrokerAccount> {
    const a = await this.request<AlpacaAccount>('GET', '/v2/account');
    return {
      cash: Number(a.cash || 0),
      buyingPower: Number(a.buying_power || 0),
      equity: Number(a.equity || 0),
      lastEquity: a.last_equity != null ? Number(a.last_equity) : undefined,
      currency: a.currency || 'USD',
      status: a.status,
    };
  }

  /**
   * @description Account equity history for the performance/vs-market view (Alpaca portfolio history).
   * @param period - e.g. '1W' | '1M' | '3M' | '1A' (Alpaca period codes).
   * @param timeframe - e.g. '15Min' | '1H' | '1D' (Alpaca resolution).
   * @returns Timestamps + equity + cumulative pl% + base value.
   */
  async portfolioHistory(period: string, timeframe: string): Promise<PortfolioHistory> {
    const j = await this.request<{ timestamp?: number[]; equity?: number[]; profit_loss_pct?: number[]; base_value?: number }>(
      'GET', `/v2/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=true`);
    return { t: j.timestamp || [], equity: j.equity || [], plPct: j.profit_loss_pct || [], baseValue: Number(j.base_value || 0) };
  }

  /** Fold an Alpaca order into the normalized OrderResult. */
  private toResult(o: AlpacaOrder): OrderResult {
    const status = normalizeStatus(o.status);
    const type = (o.order_type || o.type || 'market') as OrderResult['type'];
    return {
      id: o.id,
      clientOrderId: o.client_order_id,
      status,
      symbol: o.symbol,
      side: (o.side as OrderResult['side']),
      qty: Number(o.qty || 0),
      type,
      limitPrice: o.limit_price != null ? Number(o.limit_price) : undefined,
      stopPrice: o.stop_price != null ? Number(o.stop_price) : undefined,
      trailPrice: o.trail_price != null ? Number(o.trail_price) : undefined,
      trailPercent: o.trail_percent != null ? Number(o.trail_percent) : undefined,
      timeInForce: o.time_in_force as OrderResult['timeInForce'],
      filledQty: Number(o.filled_qty || 0),
      filledAvgPrice: o.filled_avg_price != null ? Number(o.filled_avg_price) : undefined,
      provider: this.provider,
      mode: this._mode,
      rawStatus: o.status,
      rejectReason: status === 'rejected' ? `alpaca status: ${o.status}` : undefined,
      submittedAt: o.submitted_at,
    };
  }
}
