/**
 * Broker adapter — the provider-agnostic trade-execution contract (ADR-052).
 *
 * Mirrors the PaymentAdapter pattern (payment-adapter.ts): the rest of OSHAL never
 * talks to Alpaca / Schwab / IBKR directly — it depends on this `BrokerAdapter`
 * interface and lets `getBrokerAdapter(mode)` pick the concrete one from
 * `BROKER_PROVIDER`. Adding a broker = a sibling adapter, nothing else changes.
 *
 * The `mode` dimension is first-class, not a flag. A `paper` adapter and a `live`
 * adapter are SEPARATE instances pointed at physically different broker accounts
 * (distinct base URLs + distinct key pairs). A bug on the paper path cannot place a
 * real order, and the live book is a true record — never a simulation. This is what
 * makes ADR-052's "two ledgers, both first-class" real rather than cosmetic.
 *
 * Scope (trading v1, ADR-052 + paper-scope expansion): cash equities, market/limit/stop/
 * stop_limit/trailing_stop orders, long AND short. No crypto, no options. Shorting + the
 * stop/trailing types were widened past the ADR's original long-only/market-limit line for
 * the PAPER book so the test harness can exercise the full trade matrix; live stays gated and
 * re-scoped separately. Every order placed through this layer is required by the route to
 * carry a persisted decision (signal → decision → order provenance) — the adapter itself only
 * executes; justification is enforced upstream.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — provider-agnostic BrokerAdapter contract (placeOrder/getOrder/cancelOrder/getPositions/getAccount/configured/mode) + normalized order/position/account types and status, parallel to the PaymentAdapter pattern. Dual-mode (paper|live) is first-class.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added BrokerTransaction + optional getTransactions(fromIso,toIso,symbol?) — settled trade EXECUTIONS as the venue recorded them (distinct from OrderResult's order lifecycle). The authority for reconciling the ledger against closes that happened OUTSIDE the engine (a manual sell), which listOrders can't do because it only sees orders the engine placed. Read-only; only rails with a transactions endpoint implement it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added listOrders(fromIso, toIso). A row can hold no broker id (Schwab returns it only in a Location header, and placeOrder falls back to a pending result without one) or the WRONG id (the pre-migration-065 cross-book upsert stamped the other book's id onto it). getOrder can never resolve such a row, so it strands non-terminal forever and blocks the symbol's future exits. The venue's own order record is the only authority, which makes enumeration a first-class capability rather than a recovery hack — it is what finally makes placeOrder's "reconcile will find it" true.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Futures extension (ADR-116): add 'tradovate' (the intended live futures rail) and 'paper' (the built-in vendor-neutral paper simulator) to BrokerProviderType so PaperFuturesBrokerAdapter can implement this same contract for the futures asset class. Equities rails and equity-only order semantics are unchanged; the futures adapter carries its own multiplier/short handling.
 *
 * @module broker-adapter
 */

/** The concrete brokers OSHAL can be configured to use. 'paper' = the built-in simulator; 'tradovate' = the (not-yet-wired) live futures rail. */
export type BrokerProviderType = 'alpaca' | 'schwab' | 'snaptrade' | 'ibkr' | 'tradovate' | 'paper';

/** Which book an adapter is bound to. Paper and live are separate accounts, never a flag. */
export type TradingMode = 'paper' | 'live';

/** Order side. buy opens a long / covers a short; sell closes a long / opens a short. */
export type OrderSide = 'buy' | 'sell';

/** Order type — the full Alpaca equity set (ADR-052 paper-scope expansion). */
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';

/** Time-in-force. Defaults to 'day'. */
export type TimeInForce = 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';

/** A request to place an order. Quantity is in whole/fractional shares.
 *  Required price params by type:
 *    limit         → limitPrice
 *    stop          → stopPrice
 *    stop_limit    → stopPrice + limitPrice
 *    trailing_stop → trailPrice OR trailPercent
 *  Shorting is allowed in paper: a sell with no/short position opens/extends a short. */
export interface OrderRequest {
  /** Authenticated caller's OIDC sub — the owner of the account (audit + scoping). */
  userSub: string;
  /** Ticker symbol, e.g. 'AAPL'. */
  symbol: string;
  /** buy or sell. */
  side: OrderSide;
  /** Share quantity (positive). */
  qty: number;
  /** The order type. */
  type: OrderType;
  /** Limit price per share (limit / stop_limit). */
  limitPrice?: number;
  /** Stop trigger price (stop / stop_limit). */
  stopPrice?: number;
  /** Trailing-stop trail amount in dollars (trailing_stop; mutually exclusive with trailPercent). */
  trailPrice?: number;
  /** Trailing-stop trail amount in percent (trailing_stop; mutually exclusive with trailPrice). */
  trailPercent?: number;
  /** Time-in-force; defaults to 'day'. */
  timeInForce?: TimeInForce;
  /** Route in pre/post-market. Alpaca requires a LIMIT order + time_in_force 'day' for this. */
  extendedHours?: boolean;
  /** Idempotency / client order id — the SAME id MUST never place a second order.
   *  Callers derive it deterministically (e.g. `${userSub}:${requestId}`). */
  clientOrderId: string;
}

/** Normalized order lifecycle, broker-independent. */
export type OrderStatus =
  | 'pending'           // accepted by the broker, not yet working/filled
  | 'accepted'          // working at the venue
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired';

/** The result of placing / inspecting an order. */
export interface OrderResult {
  /** Broker-assigned order id (used later with getOrder/cancelOrder). */
  id: string;
  /** The client order id we sent (idempotency key mirror). */
  clientOrderId: string;
  /** Normalized status. */
  status: OrderStatus;
  symbol: string;
  side: OrderSide;
  /** Quantity requested. */
  qty: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  trailPrice?: number;
  trailPercent?: number;
  timeInForce?: TimeInForce;
  /** Shares filled so far. */
  filledQty: number;
  /** Average fill price, when filled/partially filled. */
  filledAvgPrice?: number;
  /** Which broker produced this result. */
  provider: BrokerProviderType;
  /** Which book this order lives in. */
  mode: TradingMode;
  /** Broker-native status string, kept verbatim for debugging/audit. */
  rawStatus?: string;
  /** Rejection reason when status is 'rejected'. */
  rejectReason?: string;
  /** Broker submission timestamp (ISO). */
  submittedAt?: string;
}

/** A single open position. */
export interface Position {
  symbol: string;
  qty: number;
  /** Average entry price. */
  avgEntryPrice: number;
  /** Latest market value of the position. */
  marketValue: number;
  /** Unrealized P&L in account currency. */
  unrealizedPl: number;
  /** Current price per share, if the broker returns it. */
  currentPrice?: number;
  /** Today's fractional price change (e.g. 0.012 = +1.2%), if the broker returns it. */
  changeToday?: number;
  /** Unrealized P&L accrued just today, if the broker returns it. */
  unrealizedIntradayPl?: number;
}

/** Account equity time-series for the performance/vs-market view. */
export interface PortfolioHistory {
  /** Epoch-second timestamps. */
  t: number[];
  /** Account equity at each timestamp. */
  equity: number[];
  /** Cumulative profit/loss percent at each timestamp (0..1-ish, broker-native). */
  plPct: number[];
  /** The base equity the plPct is measured from. */
  baseValue: number;
}

/** A snapshot of the brokerage account (the ledger header). */
export interface BrokerAccount {
  /** The broker account number this snapshot is for (masked/last-4 acceptable), when the rail exposes it. */
  accountNumber?: string;
  /** Cash available. */
  cash: number;
  /** Buying power (may exceed cash on margin accounts; v1 is cash-only). */
  buyingPower: number;
  /** Total account equity (cash + positions). */
  equity: number;
  /** Equity at the prior trading day's close (for day P&L = equity − lastEquity). */
  lastEquity?: number;
  /** ISO 4217 currency. */
  currency: string;
  /** Broker-native account status (e.g. 'ACTIVE'). */
  status?: string;
}

/**
 * A settled trade execution as the venue recorded it — the source of truth for reconciling the ledger
 * against the broker (e.g. a close that happened OUTSIDE the engine, like a manual sell). Distinct from
 * OrderResult (an order's lifecycle): this is a single filled execution with its real price + fees.
 */
export interface BrokerTransaction {
  /** The venue's unique, stable execution id (Schwab `activityId`) — the idempotency/dedup key. */
  transactionId: string;
  /** The originating order id, when the venue links it (Schwab `orderId`); null for manual/journal. */
  orderId: string | null;
  /** Ticker of the security leg. */
  symbol: string;
  /** Direction, derived from the SIGNED security-leg quantity (never from open/close position effect). */
  side: 'buy' | 'sell';
  /** Absolute share quantity of this execution (always positive). */
  qty: number;
  /** Per-share execution price (positive), from the security leg's own price field — fees excluded. */
  price: number;
  /** Total fees/commission on the execution (positive), summed across fee legs. */
  fees: number;
  /** Signed net cash impact of the whole transaction (negative = buy, positive = sell), incl. fees. */
  netAmount: number;
  /** Execution datetime, ISO-8601 (Schwab `tradeDate`, falling back to `time`). */
  tradeDate: string;
}

/**
 * @description The contract every broker implements. Concrete adapters (Alpaca,
 * Schwab, IBKR) live beside this file and are selected by `getBrokerAdapter(mode)`.
 * Keep this interface broker-neutral — no Alpaca/Schwab types leak.
 */
export interface BrokerAdapter {
  /** Which broker this adapter wraps. */
  readonly provider: BrokerProviderType;

  /** Which book this instance is bound to (paper | live). */
  mode(): TradingMode;

  /** True when this mode's credentials are present (else the surface shows a setup note). */
  configured(): boolean;

  /**
   * @description Place an order. MUST be idempotent on `req.clientOrderId`.
   * @param req - The normalized order request.
   * @returns The placed order, normalized (often 'pending'/'accepted' initially).
   */
  placeOrder(req: OrderRequest): Promise<OrderResult>;

  /**
   * @description Fetch the current state of a previously-placed order.
   * @param orderId - The id returned by placeOrder.
   * @returns The order's current normalized state.
   */
  getOrder(orderId: string): Promise<OrderResult>;

  /**
   * @description Cancel a working order.
   * @param orderId - The broker order id.
   */
  cancelOrder(orderId: string): Promise<void>;

  /**
   * @description Every order the venue recorded as entered inside a time window.
   * Why this exists: an order id can be absent (Schwab surfaces it only in a Location header, and
   * placeOrder falls back to a pending result without one) or wrong (the 2026-07-08 cross-book upsert
   * overwrote one with the other book's id). Either way the only authority on what we actually sent is
   * the venue's own record, so recovery must enumerate it rather than guess.
   * @param fromIso - Window start, ISO-8601.
   * @param toIso - Window end, ISO-8601.
   * @returns The orders entered in that window, normalized.
   */
  listOrders(fromIso: string, toIso: string): Promise<OrderResult[]>;

  /** Current open positions in this book. */
  getPositions(): Promise<Position[]>;

  /** The account snapshot (cash, buying power, equity) for this book. */
  getAccount(): Promise<BrokerAccount>;

  /** Account equity over time (for the performance / vs-market view). Optional — not every rail has it. */
  portfolioHistory?(period: string, timeframe: string): Promise<PortfolioHistory>;

  /**
   * @description Settled trade executions the venue recorded in a window — the authority for
   * reconciling the ledger against closes that happened outside the engine (e.g. a manual sell).
   * Optional: only rails with a transactions endpoint implement it. Read-only.
   * @param fromIso - Window start, ISO-8601.
   * @param toIso - Window end, ISO-8601.
   * @param symbol - Optional single-symbol filter.
   * @returns The trade executions in that window, normalized.
   */
  getTransactions?(fromIso: string, toIso: string, symbol?: string): Promise<BrokerTransaction[]>;
}
