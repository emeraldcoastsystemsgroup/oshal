/**
 * Schwab broker adapter — the LIVE trade-execution rail (ADR-052).
 *
 * Implements `BrokerAdapter` over the Charles Schwab Trader API using `fetch` + JSON + a
 * per-user OAuth bearer token — same style as alpaca-broker-adapter.ts, but the credential
 * model is different: Alpaca is a shared env key pair; Schwab is a PER-USER OAuth token the
 * caller connected via the 'schwab' connector (oshal_connections). The token is resolved
 * lazily through an injected resolver (`getBrokerAdapter(mode, userSub)` binds it) so this
 * feature never imports the app-layer connector store (FSD layering stays intact).
 *
 * LIVE-ONLY: Schwab has no paper/sandbox trading account — the developer sandbox exercises
 * auth/connection only. So this adapter is the LIVE book; Alpaca stays the paper + autopilot
 * rail. The provider factory refuses to hand out a Schwab adapter for the paper book (a "paper"
 * order must never reach a real Schwab account) and refuses live at all unless
 * TRADING_LIVE_ENABLED=true.
 *
 * Scope (v1 manual-orders rail): cash equities, LONG side (buy/sell), market/limit/stop/
 * stop_limit/trailing_stop, day/gtc/fok/ioc. Shorting (SELL_SHORT/BUY_TO_COVER) is NOT wired —
 * a plain SELL that would open a short is left to Schwab to reject, which is the safe default for
 * a long-only manual rail. Schwab has no client-order-id / idempotency key, so a network retry
 * that succeeds twice could double-place; the adapter never auto-retries a POST, and the OSHAL
 * order store's UNIQUE (user_sub, client_order_id) blocks a duplicate RECORD.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Schwab Trader API account/positions/orders (place/get/cancel), fetch-based, per-user bearer via injected resolver, account-hash resolution + selection (SCHWAB_ACCOUNT_NUMBER), normalized status mapping, 201-Location order-id parse. Live-only (no paper); no portfolioHistory (Schwab has no equity-curve endpoint).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | listOrders(from,to) over /accounts/{hash}/orders?fromEnteredTime — Schwab surfaces a new order's id ONLY in the Location header, so enumeration is the only way to recover an id we never captured (or one a cross-book upsert overwrote).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | getPositions() now derives unrealizedIntradayPl + changeToday from the prior-session close (fillIntradayChange) instead of Schwab's currentDayProfitLoss, which double-counted same-day realized P&L on round-tripped symbols and inflated the live desk's "Today $" column to bogus five-figure sums. Display-only fields (no trade/exit logic reads them); mirrors Alpaca's unrealized_intraday_pl/change_today semantics.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | getTransactions(fromIso,toIso,symbol?) — settled TRADE executions for reconciling closes done outside the engine (a manual sell). GET /accounts/{hash}/transactions?types=TRADE&startDate&endDate; Schwab needs the exact ISO+millis+Z form (= toISOString()) and caps the window ~60d, so we chunk at 55d, tolerate a per-chunk failure (log+skip, never abort), and dedup by activityId. normalizeTransaction picks the single non-fee non-cash security leg and infers side from the SIGNED amount CROSS-CHECKED against the cost sign (spec documents no sign → disagreement trusts cost; multi-leg/ambiguous → null/skip). Read-only; per the ADR-052 rail pattern.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Class-share symbology at the wire boundary: orders go out via toSchwabSymbol (BRK.B → BRK/B — Schwab rejects the engine's dot form as an invalid symbol), positions/orders/transactions come back via fromSchwabSymbol so the engine's exemption sets, exits, and ledger all match on ONE notation. Found by the read-only quote probe for the 2026-07-26 BRK.B core proposal; guard: tests/unit/schwab-symbology.spec.ts.
 *
 * @module schwab-broker-adapter
 */

import { createChildLogger } from '@/shared/logger';
import type {
  BrokerAdapter, BrokerAccount, BrokerProviderType, BrokerTransaction, OrderRequest, OrderResult,
  OrderStatus, Position, TradingMode,
} from './broker-adapter';
import { SchwabMarketData, toSchwabSymbol, fromSchwabSymbol } from './schwab-market-data';

// CHANGE LOG addendum (ADR-134 PR1): constructor takes an optional boundAccountNumber — when set,
// accountHash() is an EXACT enumeration match that fails closed (never first-account fallback), and
// the hash cache keys per (sub, bound account) so one user's second account can never read a stale
// hash minted by the first. Unbound behavior (env pin / first) is byte-unchanged.
const logger = createChildLogger({ module: 'schwab-broker-adapter' });

/** Cross-order account-hash cache (keyed by userSub, short TTL). Each live order builds a FRESH
 *  adapter, so without this every order re-fetches /accounts/accountNumbers — a redundant Schwab call
 *  per order that hammers the rate limit at the open. Short TTL so a re-linked account is still picked
 *  up; cleared on process restart. */
const ACCOUNT_HASH_CACHE = new Map<string, { hash: string; exp: number }>();
const ACCOUNT_HASH_TTL_MS = Number(process.env.SCHWAB_ACCOUNT_HASH_TTL_MS) || 10 * 60_000;

/** Resolves a valid Schwab access token for the bound user (refreshing if needed). Null = not connected. */
export type SchwabTokenResolver = () => Promise<string | null>;

/** Trader API base — env-overridable so the developer sandbox base can be swapped in. */
function traderBase(): string {
  return (process.env.SCHWAB_TRADER_BASE_URL || 'https://api.schwabapi.com/trader/v1').replace(/\/+$/, '');
}

/**
 * @description `fetch` with an AbortController timeout so a hung Schwab order/account call can't
 * stall the trade path. Default 8s, overridable via SCHWAB_FETCH_TIMEOUT_MS. Timer always cleared.
 * @param url - Request URL.
 * @param init - Fetch init (method/headers/body); the abort signal is merged in.
 * @param ms - Timeout in milliseconds.
 * @returns The fetch Response.
 */
async function fetchT(url: string, init: RequestInit = {}, ms = Number(process.env.SCHWAB_FETCH_TIMEOUT_MS) || 8000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

/** Map a Schwab order status → our normalized OrderStatus. Partial fills are inferred by caller. */
function normalizeStatus(schwabStatus: string): OrderStatus {
  switch (String(schwabStatus || '').toUpperCase()) {
    case 'FILLED': return 'filled';
    case 'CANCELED':
    case 'PENDING_CANCEL':
    case 'CANCELLED': return 'canceled';
    case 'REJECTED': return 'rejected';
    case 'EXPIRED': return 'expired';
    case 'WORKING':
    case 'ACCEPTED':
    case 'NEW':
    case 'REPLACED':
    case 'PENDING_REPLACE':
    case 'AWAITING_RELEASE_TIME': return 'accepted';
    case 'PENDING_ACTIVATION':
    case 'QUEUED':
    case 'AWAITING_PARENT_ORDER':
    case 'AWAITING_CONDITION':
    case 'AWAITING_MANUAL_REVIEW':
    case 'AWAITING_STOP_CONDITION':
    case 'PENDING_ACKNOWLEDGEMENT':
    case 'PENDING_RECALL': return 'pending';
    default: return 'pending';
  }
}

/** Map our OrderType → Schwab orderType enum. */
function schwabOrderType(t: OrderRequest['type']): string {
  switch (t) {
    case 'market': return 'MARKET';
    case 'limit': return 'LIMIT';
    case 'stop': return 'STOP';
    case 'stop_limit': return 'STOP_LIMIT';
    case 'trailing_stop': return 'TRAILING_STOP';
    default: return 'MARKET';
  }
}

/** Map a Schwab orderType enum back to our OrderType. */
function fromSchwabOrderType(t?: string): OrderResult['type'] {
  switch (String(t || '').toUpperCase()) {
    case 'LIMIT': return 'limit';
    case 'STOP': return 'stop';
    case 'STOP_LIMIT': return 'stop_limit';
    case 'TRAILING_STOP': return 'trailing_stop';
    default: return 'market';
  }
}

/** Map our TimeInForce → Schwab duration enum. */
function schwabDuration(tif?: OrderRequest['timeInForce']): string {
  switch (tif) {
    case 'gtc': return 'GOOD_TILL_CANCEL';
    case 'fok': return 'FILL_OR_KILL';
    case 'ioc': return 'IMMEDIATE_OR_CANCEL';
    default: return 'DAY';
  }
}

/** The bits of a Schwab order we read back. */
interface SchwabOrder {
  orderId?: number | string;
  status?: string;
  quantity?: number;
  filledQuantity?: number;
  orderType?: string;
  price?: number;
  stopPrice?: number;
  enteredTime?: string;
  orderLegCollection?: Array<{ instruction?: string; quantity?: number; instrument?: { symbol?: string } }>;
  orderActivityCollection?: Array<{ executionLegs?: Array<{ price?: number; quantity?: number }> }>;
  statusDescription?: string;
}

interface SchwabPosition {
  shortQuantity?: number;
  longQuantity?: number;
  averagePrice?: number;
  marketValue?: number;
  longOpenProfitLoss?: number;
  shortOpenProfitLoss?: number;
  currentDayProfitLoss?: number;
  instrument?: { symbol?: string };
}

interface SchwabAccountDetail {
  securitiesAccount?: {
    accountNumber?: string;
    type?: string;
    currentBalances?: {
      cashBalance?: number;
      liquidationValue?: number;
      buyingPower?: number;
      availableFunds?: number;
      cashAvailableForTrading?: number;
    };
    positions?: SchwabPosition[];
  };
}

/** One leg of a Schwab transaction (the security leg, or a fee/cash leg). */
interface SchwabTransferItem {
  instrument?: { symbol?: string; assetType?: string };
  /** SIGNED share quantity on the security leg (>0 received/buy, <0 delivered/sell). */
  amount?: number;
  /** Per-share execution price (positive magnitude) on the security leg. */
  price?: number;
  /** SIGNED net cash for this leg (<0 buy, >0 sell). */
  cost?: number;
  /** Present ONLY on fee legs (COMMISSION, SEC_FEE, …) — its presence marks a leg as a fee, not security. */
  feeType?: string;
}

/** A Schwab Trader API transaction (the settled-execution record). */
interface SchwabTransaction {
  activityId?: number;
  orderId?: number;
  type?: string;
  /** Execution datetime (ISO). `time` is the activity stamp; both are present on trades. */
  tradeDate?: string;
  time?: string;
  /** Signed total account cash impact, net of fees (<0 buy, >0 sell). */
  netAmount?: number;
  transferItems?: SchwabTransferItem[];
}

/** Schwab's required transaction-date format is exactly ISO with millis + Z — which is toISOString(). */
function schwabIso(ms: number): string { return new Date(ms).toISOString(); }

/**
 * @description Fold one Schwab TRADE transaction into the normalized BrokerTransaction, or null when
 * it isn't a plain single-security equity execution we can safely reconcile. Parsing follows the
 * researched rules: the SECURITY leg is the non-fee, non-cash leg; direction is inferred from the
 * SIGNED security-leg amount and CROSS-CHECKED against the cost sign (spec documents no sign, so a
 * disagreement trusts cost — cash-in⇒sell, cash-out⇒buy — and is logged); per-share price is the
 * leg's own `price` (fees are separate legs). Anything multi-leg/ambiguous returns null (skipped).
 */
function normalizeTransaction(t: SchwabTransaction): BrokerTransaction | null {
  if (String(t.type || '').toUpperCase() !== 'TRADE' || !Array.isArray(t.transferItems)) return null;
  if (t.activityId == null) return null; // no stable id → can't dedup/idempotency-key it safely
  const isCash = (a?: string) => a === 'CURRENCY' || a === 'CASH_EQUIVALENT';
  const securityLegs = t.transferItems.filter((i) => i.instrument && i.instrument.assetType && !isCash(i.instrument.assetType) && !i.feeType);
  if (securityLegs.length !== 1) return null; // 0 = not an equity trade; >1 = multi-leg/corp-action → out of scope
  const leg = securityLegs[0];
  const symbol = fromSchwabSymbol(String(leg.instrument?.symbol || ''));
  const amt = Number(leg.amount || 0);
  const cost = Number(leg.cost || 0);
  if (!symbol || (amt === 0 && cost === 0)) return null;
  // Direction: amount sign, cross-checked with cost sign; on disagreement trust cost (unambiguous cash).
  let side: 'buy' | 'sell' = amt < 0 || cost > 0 ? 'sell' : 'buy';
  if (amt !== 0 && cost !== 0 && (amt < 0) !== (cost > 0)) {
    logger.warn({ symbol, amount: amt, cost, activityId: t.activityId }, 'schwab txn amount/cost sign disagree — trusting cost sign');
    side = cost > 0 ? 'sell' : 'buy';
  }
  const qty = Math.abs(amt) || (leg.price && leg.price > 0 ? Math.abs(cost) / leg.price : 0);
  const price = leg.price && leg.price > 0 ? leg.price : (qty > 0 ? Math.abs(cost) / qty : 0);
  if (!(qty > 0) || !(price > 0)) return null;
  const fees = t.transferItems.filter((i) => i.feeType).reduce((s, i) => s + Math.abs(Number(i.cost || 0)), 0);
  const tradeDate = String(t.tradeDate || t.time || '');
  if (!tradeDate) return null;
  return {
    transactionId: String(t.activityId ?? ''), orderId: t.orderId != null ? String(t.orderId) : null,
    symbol, side, qty, price, fees, netAmount: Number(t.netAmount || 0), tradeDate,
  };
}

/** The Schwab-backed trade-execution rail. Live-only; per-user token via the injected resolver. */
export class SchwabBrokerAdapter implements BrokerAdapter {
  readonly provider: BrokerProviderType = 'schwab';
  private readonly _mode: TradingMode;
  private readonly resolveToken: SchwabTokenResolver;
  private readonly clientConfigured: boolean;
  /** Owner sub — keys the cross-order account-hash cache (ACCOUNT_HASH_CACHE). */
  private readonly userSub?: string;

  /** ADR-134: exact account this adapter is bound to; null = legacy selection (env pin / first). */
  private readonly boundAccountNumber: string | null;

  /**
   * @param mode - The book. Schwab is live-only; the factory forbids paper, so this is 'live'.
   * @param resolveToken - Resolves a fresh access token for the bound user (null = not connected).
   * @param userSub - Owner sub, keying the cross-order account-hash cache (avoids re-fetching
   *   /accounts/accountNumbers on every order — a rate-limit saver at the open).
   * @param boundAccountNumber - ADR-134 book binding: when set, account resolution is an EXACT
   *   match against the enumeration and fails closed — never first-account fallback.
   */
  constructor(mode: TradingMode, resolveToken: SchwabTokenResolver, userSub?: string, boundAccountNumber: string | null = null) {
    this._mode = mode;
    this.resolveToken = resolveToken;
    this.userSub = userSub;
    this.boundAccountNumber = boundAccountNumber;
    // "configured" = the Schwab OAuth app is wired (approved production App Key + Secret present).
    // Whether THIS user has connected their account is discovered lazily (a call throws a clear
    // "connect your Schwab account" error) since the interface's configured() is synchronous.
    this.clientConfigured = Boolean(
      (process.env.SCHWAB_CLIENT_ID_PRD || process.env.SCHWAB_CLIENT_ID || process.env.SCHWAB_APP_KEY)
      && (process.env.SCHWAB_CLIENT_SECRET_PRD || process.env.SCHWAB_CLIENT_SECRET || process.env.SCHWAB_APP_SECRET),
    );
  }

  mode(): TradingMode { return this._mode; }

  /** True once the Schwab OAuth app is wired. Per-user connection is checked lazily on first call. */
  configured(): boolean { return this.clientConfigured; }

  /** Resolve a bearer token or throw a clear, user-actionable error. */
  private async bearer(): Promise<string> {
    const tok = await this.resolveToken();
    if (!tok) throw new Error('Schwab account not connected — connect it under Settings → Connections → Charles Schwab, then retry.');
    return tok;
  }

  /**
   * @description Low-level Trader API request. Injects the bearer + Accept, throws on non-2xx.
   * @param method - HTTP method.
   * @param pathname - API path under the Trader base (e.g. '/accounts/{hash}').
   * @param body - JSON body (POST only).
   * @returns Parsed JSON (or {} for empty/204).
   */
  private async api<T>(method: 'GET' | 'POST' | 'DELETE', pathname: string, body?: Record<string, unknown>): Promise<T> {
    const bearer = await this.bearer();
    const r = await fetchT(`${traderBase()}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return {} as T;
    const text = await r.text();
    if (!r.ok) throw new Error(`schwab ${pathname} ${r.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * @description Resolve (and cache) the encrypted account hash Schwab keys account-scoped calls by.
   * Picks SCHWAB_ACCOUNT_NUMBER when set (to disambiguate multiple accounts), else the first.
   * @returns The account hashValue.
   */
  private async accountHash(): Promise<string> {
    // ADR-134: the cache is keyed per (sub, bound account) — a userSub-only key would hand one
    // user's SECOND account a stale hash from the first (the connector-map migration hazard).
    const key = `${this.userSub || 'default'}:${this.boundAccountNumber ?? 'legacy'}`;
    const cached = ACCOUNT_HASH_CACHE.get(key);
    if (cached && cached.exp > Date.now()) return cached.hash;
    const rows = await this.api<Array<{ accountNumber?: string; hashValue?: string }>>('GET', '/accounts/accountNumbers');
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) throw new Error('Schwab returned no accounts for this connection.');
    let chosen: { accountNumber?: string; hashValue?: string } | undefined;
    if (this.boundAccountNumber) {
      // Bound book: EXACT match, fail-closed. Falling through to first-account would trade the
      // WRONG real account on a partial/foreign enumeration — the fire skips instead.
      chosen = list.find((a) => a.accountNumber === this.boundAccountNumber);
      if (!chosen) throw new Error(`Schwab bound account …${this.boundAccountNumber.slice(-4)} is not in this connection's enumeration (${list.length} accounts) — refusing to fall back to another account.`);
    } else {
      const want = (process.env.SCHWAB_ACCOUNT_NUMBER || '').trim();
      chosen = (want && list.find((a) => a.accountNumber === want)) || list[0];
    }
    if (!chosen?.hashValue) throw new Error('Schwab account has no hashValue (cannot address account-scoped calls).');
    logger.info({ mode: this._mode, account: `…${String(chosen.accountNumber || '').slice(-4)}`, accounts: list.length, bound: Boolean(this.boundAccountNumber) }, 'schwab account resolved');
    ACCOUNT_HASH_CACHE.set(key, { hash: chosen.hashValue, exp: Date.now() + ACCOUNT_HASH_TTL_MS });
    return chosen.hashValue;
  }

  /**
   * @description Place an equity order (market/limit/stop/stop_limit/trailing_stop, long side).
   * Schwab returns 201 with the new order id in the Location header (no body); we parse it and
   * read the order back so the caller gets a normalized result. NOT idempotent (Schwab has no
   * client-order-id) and never auto-retried.
   * @param req - The normalized order request.
   * @returns The placed order, normalized (often 'pending'/'accepted' initially).
   */
  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!(req.qty > 0)) throw new Error('qty must be a positive number of shares');
    const hash = await this.accountHash();
    const body = buildOrderBody(req);
    logger.info({ userSub: req.userSub, mode: this._mode, symbol: req.symbol, side: req.side, qty: req.qty, type: req.type }, 'schwab placeOrder');
    const bearer = await this.bearer();
    const r = await fetchT(`${traderBase()}/accounts/${encodeURIComponent(hash)}/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`schwab place order ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const location = r.headers.get('location') || '';
    const orderId = location.split('/').filter(Boolean).pop() || '';
    if (!orderId) return this.pendingResult(req, ''); // accepted but id not surfaced — reconcile will find it
    // Read the order back for its live status. Schwab doesn't return the client-order-id, so stamp the
    // request's own back onto the result (the standalone getOrder refresh legitimately can't know it).
    try { return { ...(await this.getOrder(orderId)), clientOrderId: req.clientOrderId }; }
    catch { return this.pendingResult(req, orderId); }
  }

  /**
   * @description Fetch one order's current state.
   * @param orderId - The Schwab order id from placeOrder.
   * @returns The order's current normalized state.
   */
  async getOrder(orderId: string): Promise<OrderResult> {
    const hash = await this.accountHash();
    const o = await this.api<SchwabOrder>('GET', `/accounts/${encodeURIComponent(hash)}/orders/${encodeURIComponent(orderId)}`);
    return this.toResult(o);
  }

  /**
   * @description Cancel a working order. A terminal order (already filled/canceled) 400/404s — swallowed.
   * @param orderId - The Schwab order id.
   */
  async cancelOrder(orderId: string): Promise<void> {
    const hash = await this.accountHash();
    try { await this.api<unknown>('DELETE', `/accounts/${encodeURIComponent(hash)}/orders/${encodeURIComponent(orderId)}`); }
    catch (err) { logger.warn({ err, orderId }, 'schwab cancel (order may already be terminal)'); }
  }

  /**
   * @description Every order Schwab recorded as entered inside a window. This is the only way to
   * re-find an order whose id we never captured: Schwab returns the id in a `Location` header on
   * placement and nowhere in the response body, so a missing header loses the id until we ask.
   * @param fromIso - Window start, ISO-8601.
   * @param toIso - Window end, ISO-8601.
   * @returns The orders entered in that window, normalized.
   */
  async listOrders(fromIso: string, toIso: string): Promise<OrderResult[]> {
    const hash = await this.accountHash();
    const qs = `maxResults=500&fromEnteredTime=${encodeURIComponent(fromIso)}&toEnteredTime=${encodeURIComponent(toIso)}`;
    const rows = await this.api<SchwabOrder[]>('GET', `/accounts/${encodeURIComponent(hash)}/orders?${qs}`);
    return (rows || []).map((o) => this.toResult(o));
  }

  /** Current open positions in the account. */
  async getPositions(): Promise<Position[]> {
    const hash = await this.accountHash();
    const a = await this.api<SchwabAccountDetail>('GET', `/accounts/${encodeURIComponent(hash)}?fields=positions`);
    const rows = a.securitiesAccount?.positions || [];
    const positions = rows.map((p) => toPosition(p)).filter((p) => p.qty !== 0);
    await this.fillIntradayChange(positions);
    return positions;
  }

  /**
   * @description Populate each position's TRUE `unrealizedIntradayPl` + `changeToday` from the
   * prior-session close: `(currentPrice − priorClose) × qty`. Schwab's position-level
   * `currentDayProfitLoss` double-counts same-day realized P&L on round-tripped symbols, which
   * inflated the live desk's "Today $" column to meaningless five-figure sums (root-caused
   * 2026-07-09: USB showed +$686 on a flat 25-share position). This mirrors how Alpaca's own
   * `unrealized_intraday_pl`/`change_today` are defined. A market-data hiccup leaves the fields
   * undefined — the desk renders "—", which is the honest fallback over showing the polluted value.
   * @param positions - Normalized positions, mutated in place.
   */
  private async fillIntradayChange(positions: Position[]): Promise<void> {
    if (!positions.length) return;
    try {
      const md = new SchwabMarketData(this.resolveToken);
      const closes = await md.priorCloses(positions.map((p) => p.symbol));
      for (const p of positions) {
        const prior = closes.get(p.symbol.toUpperCase());
        const now = p.currentPrice;
        if (prior != null && prior > 0 && now != null && Number.isFinite(now)) {
          p.unrealizedIntradayPl = (now - prior) * p.qty;
          p.changeToday = now / prior - 1;
        }
      }
    } catch (err) {
      logger.warn({ err, userSub: this.userSub }, 'Schwab intraday-change enrichment failed — leaving Today $/% blank rather than showing the polluted currentDayProfitLoss');
    }
  }

  /** The account snapshot (cash, buying power, equity). */
  async getAccount(): Promise<BrokerAccount> {
    const hash = await this.accountHash();
    const a = await this.api<SchwabAccountDetail>('GET', `/accounts/${encodeURIComponent(hash)}`);
    const b = a.securitiesAccount?.currentBalances || {};
    const cash = Number(b.cashBalance || 0);
    const num = a.securitiesAccount?.accountNumber;
    return {
      accountNumber: num ? `…${String(num).slice(-4)}` : undefined,
      cash,
      buyingPower: Number(b.buyingPower ?? b.cashAvailableForTrading ?? b.availableFunds ?? cash),
      equity: Number(b.liquidationValue ?? cash),
      currency: 'USD',
      status: a.securitiesAccount?.type,
    };
  }

  /**
   * @description Settled TRADE executions in a window (read-only), normalized. Schwab requires the
   * exact ISO form `yyyy-MM-ddTHH:mm:ss.SSSZ` for start/end (bare dates 400) and a SINGLE `types`
   * enum per call. It has a ~60-day window cap, so we CHUNK the range into ≤60-day pieces, tolerate a
   * per-chunk failure (log + skip, never abort the whole pull), and dedup by activityId across chunks.
   * @param fromIso - Window start, ISO-8601.
   * @param toIso - Window end, ISO-8601.
   * @param symbol - Optional single-symbol filter (server-side).
   * @returns Normalized trade executions, ascending by tradeDate.
   */
  async getTransactions(fromIso: string, toIso: string, symbol?: string): Promise<BrokerTransaction[]> {
    const hash = await this.accountHash();
    const CHUNK_MS = 55 * 24 * 60 * 60 * 1000; // < 60d, safe under the undocumented cap
    const start = new Date(fromIso).getTime();
    const end = new Date(toIso).getTime();
    if (!(start > 0) || !(end > start)) throw new Error('getTransactions: invalid window');
    const byId = new Map<string, BrokerTransaction>();
    for (let s = start; s < end; s += CHUNK_MS) {
      const e = Math.min(s + CHUNK_MS, end);
      const qs = new URLSearchParams({ types: 'TRADE', startDate: schwabIso(s), endDate: schwabIso(e) });
      if (symbol) qs.set('symbol', symbol.toUpperCase());
      try {
        const rows = await this.api<SchwabTransaction[]>('GET', `/accounts/${encodeURIComponent(hash)}/transactions?${qs.toString()}`);
        for (const t of Array.isArray(rows) ? rows : []) {
          const norm = normalizeTransaction(t);
          if (norm) byId.set(norm.transactionId, norm); // dedup by activityId across overlapping chunks
        }
      } catch (err) {
        logger.warn({ mode: this._mode, from: schwabIso(s), to: schwabIso(e), err }, 'schwab getTransactions chunk failed — skipping chunk');
      }
    }
    return [...byId.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  }

  /** A minimal 'pending' result for an accepted order we couldn't immediately read back. */
  private pendingResult(req: OrderRequest, orderId: string): OrderResult {
    return {
      id: orderId, clientOrderId: req.clientOrderId, status: 'pending', symbol: req.symbol.toUpperCase(),
      side: req.side, qty: req.qty, type: req.type, limitPrice: req.limitPrice, stopPrice: req.stopPrice,
      trailPrice: req.trailPrice, trailPercent: req.trailPercent, timeInForce: req.timeInForce,
      filledQty: 0, provider: this.provider, mode: this._mode, rawStatus: 'ACCEPTED',
    };
  }

  /** Fold a Schwab order into the normalized OrderResult. */
  private toResult(o: SchwabOrder): OrderResult {
    const leg = (o.orderLegCollection || [])[0] || {};
    const instr = String(leg.instruction || '').toUpperCase();
    const side = (instr === 'SELL' || instr === 'SELL_SHORT') ? 'sell' : 'buy';
    const filledQty = Number(o.filledQuantity || 0);
    const qty = Number(o.quantity || leg.quantity || 0);
    let status = normalizeStatus(String(o.status || ''));
    if (status === 'accepted' && filledQty > 0 && filledQty < qty) status = 'partially_filled';
    return {
      id: String(o.orderId ?? ''),
      clientOrderId: '',
      status,
      symbol: fromSchwabSymbol(String(leg.instrument?.symbol || '')),
      side,
      qty,
      type: fromSchwabOrderType(o.orderType),
      limitPrice: o.price != null ? Number(o.price) : undefined,
      stopPrice: o.stopPrice != null ? Number(o.stopPrice) : undefined,
      filledQty,
      filledAvgPrice: avgFillPrice(o),
      provider: this.provider,
      mode: this._mode,
      rawStatus: o.status,
      rejectReason: status === 'rejected' ? (o.statusDescription || `schwab status: ${o.status}`) : undefined,
      submittedAt: o.enteredTime,
    };
  }
}

/** Build the Schwab order JSON for a single-leg equity order from our normalized request. */
function buildOrderBody(req: OrderRequest): Record<string, unknown> {
  const instruction = req.side === 'sell' ? 'SELL' : 'BUY';
  const body: Record<string, unknown> = {
    orderType: schwabOrderType(req.type),
    session: req.extendedHours ? 'SEAMLESS' : 'NORMAL',
    duration: schwabDuration(req.timeInForce),
    orderStrategyType: 'SINGLE',
    orderLegCollection: [{
      instruction, quantity: req.qty,
      // Schwab wire notation (BRK/B) — the engine's dot form is rejected as an invalid symbol.
      instrument: { symbol: toSchwabSymbol(req.symbol), assetType: 'EQUITY' },
    }],
  };
  switch (req.type) {
    case 'market': break;
    case 'limit':
      if (!(Number(req.limitPrice) > 0)) throw new Error('limit orders require a positive limitPrice');
      body.price = String(req.limitPrice); break;
    case 'stop':
      if (!(Number(req.stopPrice) > 0)) throw new Error('stop orders require a positive stopPrice');
      body.stopPrice = String(req.stopPrice); break;
    case 'stop_limit':
      if (!(Number(req.stopPrice) > 0) || !(Number(req.limitPrice) > 0)) throw new Error('stop_limit orders require positive stopPrice and limitPrice');
      body.stopPrice = String(req.stopPrice); body.price = String(req.limitPrice); break;
    case 'trailing_stop':
      applyTrailingStop(body, req); break;
    default:
      throw new Error(`unsupported order type: ${req.type}`);
  }
  return body;
}

/** Fill in Schwab's trailing-stop link fields from trailPercent (PERCENT) or trailPrice (VALUE). */
function applyTrailingStop(body: Record<string, unknown>, req: OrderRequest): void {
  body.stopPriceLinkBasis = 'LAST';
  if (Number(req.trailPercent) > 0) {
    body.stopPriceLinkType = 'PERCENT';
    body.stopPriceOffset = Number(req.trailPercent);
  } else if (Number(req.trailPrice) > 0) {
    body.stopPriceLinkType = 'VALUE';
    body.stopPriceOffset = Number(req.trailPrice);
  } else {
    throw new Error('trailing_stop orders require trailPrice or trailPercent');
  }
}

/** Weighted average fill price across a Schwab order's execution legs (undefined if none). */
function avgFillPrice(o: SchwabOrder): number | undefined {
  let shares = 0, notional = 0;
  for (const act of o.orderActivityCollection || []) {
    for (const leg of act.executionLegs || []) {
      const q = Number(leg.quantity || 0), p = Number(leg.price || 0);
      if (q > 0 && p > 0) { shares += q; notional += q * p; }
    }
  }
  return shares > 0 ? notional / shares : undefined;
}

/** Fold a Schwab position into the normalized Position (net qty; short = negative). */
function toPosition(p: SchwabPosition): Position {
  const qty = Number(p.longQuantity || 0) - Number(p.shortQuantity || 0);
  const marketValue = Number(p.marketValue || 0);
  return {
    symbol: fromSchwabSymbol(String(p.instrument?.symbol || '')),
    qty,
    avgEntryPrice: Number(p.averagePrice || 0),
    marketValue,
    unrealizedPl: Number(p.longOpenProfitLoss ?? p.shortOpenProfitLoss ?? 0),
    currentPrice: qty !== 0 ? Math.abs(marketValue / qty) : undefined,
    // NB: Schwab's `currentDayProfitLoss` is deliberately NOT mapped to unrealizedIntradayPl — it
    // double-counts same-day realized P&L on round-tripped symbols (inflated the desk's "Today $"
    // to five-figure nonsense, 2026-07-09). getPositions() fills the true day move from prior close.
  };
}
