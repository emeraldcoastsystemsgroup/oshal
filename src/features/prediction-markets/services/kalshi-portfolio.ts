/**
 * Kalshi portfolio + orders — the Phase 2 execution layer (ADR-094).
 *
 * Reads (balance/positions/resting orders/fills) and confirm-gated LIMIT order placement against
 * whichever exchange the caller's key belongs to (per-key env auto-detection in kalshi-auth).
 * The guardrails are pure functions so they're unit-testable without a network: an order must be
 * explicitly confirmed, limit-only (market orders are a footgun on thin books), size- and
 * cost-capped, and — the big one — LIVE keys are refused outright unless KALSHI_LIVE_ENABLED=true.
 * Demo-first is the point: fake money absorbs the mistakes while the calibration re-study runs.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — portfolio snapshot (balance/positions/resting orders), validateOrderRequest guards (confirm, limit-only, count/cost caps, price bounds), placeKalshiOrder (client_order_id idempotency), cancelKalshiOrder.
 *
 * @module prediction-markets/kalshi-portfolio
 */

import { createChildLogger } from '@/shared/logger';
import type { KalshiCreds } from './kalshi-auth';
import { kalshiAuthedGet, kalshiAuthedRequest, kalshiKeyEnv } from './kalshi-auth';

const log = createChildLogger({ module: 'kalshi-portfolio' });

/** Max contracts per order (env-tunable). */
const MAX_CONTRACTS = Number(process.env.KALSHI_MAX_CONTRACTS) || 100;
/** Max order cost in dollars (count × price), before fees (env-tunable). */
const MAX_ORDER_COST_DOLLARS = Number(process.env.KALSHI_MAX_ORDER_COST_DOLLARS) || 50;

/** A position in one market, normalized (dollars, signed yes-contracts). */
export interface KalshiPosition {
  ticker: string;
  /** Signed contracts: positive = YES exposure, negative = NO. */
  position: number;
  /** Cost basis of the open exposure, dollars. */
  marketExposure: number;
  realizedPnl: number;
  totalTraded: number;
  restingOrders: number;
  feesPaid: number;
}

/** One resting/settled order, normalized. */
export interface KalshiOrder {
  orderId: string;
  clientOrderId: string;
  ticker: string;
  side: string;
  action: string;
  status: string;
  count: number;
  remainingCount: number;
  priceDollars: number;
  createdTime: string | null;
}

/** The caller's full account snapshot for the surface. */
export interface KalshiPortfolioSnapshot {
  env: 'demo' | 'live';
  balanceDollars: number;
  positions: KalshiPosition[];
  restingOrders: KalshiOrder[];
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function centsToDollars(cents: unknown, dollars: unknown): number {
  if (dollars !== undefined && dollars !== null) return num(dollars);
  return num(cents) / 100;
}

function normalizeOrder(o: Record<string, unknown>): KalshiOrder {
  const side = String(o.side || '');
  const priceCents = side === 'no' ? o.no_price : o.yes_price;
  const priceDollars = side === 'no' ? o.no_price_dollars : o.yes_price_dollars;
  return {
    orderId: String(o.order_id || ''),
    clientOrderId: String(o.client_order_id || ''),
    ticker: String(o.ticker || ''),
    side,
    action: String(o.action || ''),
    status: String(o.status || ''),
    count: num(o.initial_count ?? o.count),
    remainingCount: num(o.remaining_count ?? o.count),
    priceDollars: centsToDollars(priceCents, priceDollars),
    createdTime: typeof o.created_time === 'string' ? o.created_time : null,
  };
}

/**
 * @description The caller's account snapshot: balance, open positions, resting orders, and which
 * exchange the key belongs to. One authed round-trip per section.
 * @param creds - Key id + PEM.
 * @returns Snapshot for the surface.
 */
export async function getKalshiPortfolio(creds: KalshiCreds): Promise<KalshiPortfolioSnapshot> {
  const bal = await kalshiAuthedGet<{ balance?: number; balance_dollars?: string }>(creds, '/portfolio/balance');
  // No count_filter: the API 400s on the comma-separated form, and we filter to non-empty
  // positions below anyway (live-verified 2026-07-13 — a malformed filter took the whole
  // portfolio call down, which correctly blocked orders rather than proceeding blind).
  const pos = await kalshiAuthedGet<{ market_positions?: Record<string, unknown>[] }>(creds, '/portfolio/positions?limit=200');
  const ord = await kalshiAuthedGet<{ orders?: Record<string, unknown>[] }>(creds, '/portfolio/orders?status=resting&limit=200');
  const positions: KalshiPosition[] = (pos.market_positions || [])
    .map((p) => ({
      ticker: String(p.ticker || ''),
      position: num(p.position_fp ?? p.position),
      marketExposure: centsToDollars(p.market_exposure, p.market_exposure_dollars),
      realizedPnl: centsToDollars(p.realized_pnl, p.realized_pnl_dollars),
      totalTraded: centsToDollars(p.total_traded, p.total_traded_dollars),
      restingOrders: num(p.resting_orders_count),
      feesPaid: centsToDollars(p.fees_paid, p.fees_paid_dollars),
    }))
    .filter((p) => p.position !== 0 || p.restingOrders > 0);
  return {
    env: kalshiKeyEnv(creds.keyId) || 'live',
    balanceDollars: centsToDollars(bal.balance, bal.balance_dollars),
    positions,
    restingOrders: (ord.orders || []).map(normalizeOrder),
  };
}

/** An order request as it arrives from the surface. */
export interface KalshiOrderRequest {
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  /** Limit price in CENTS (1..99) for the chosen side. */
  priceCents: number;
  /** Must be literally true — the confirm dialog's assertion, not a default. */
  confirm: boolean;
}

/**
 * @description Pure guardrail check for an order request. Returns the reason it must be refused,
 * or null when it may proceed to the exchange. Deliberately strict: limit-only, explicit confirm,
 * bounded size and cost — the exchange enforces balance/position, we enforce intent.
 * @param req - The order request.
 * @returns A human-readable refusal reason, or null when valid.
 */
export function validateOrderRequest(req: Partial<KalshiOrderRequest>): string | null {
  if (req.confirm !== true) return 'order not confirmed — the confirm flag must be exactly true';
  if (!req.ticker || typeof req.ticker !== 'string') return 'missing ticker';
  if (req.side !== 'yes' && req.side !== 'no') return 'side must be yes or no';
  if (req.action !== 'buy' && req.action !== 'sell') return 'action must be buy or sell';
  if (!Number.isInteger(req.count) || (req.count as number) < 1) return 'count must be a positive integer';
  if ((req.count as number) > MAX_CONTRACTS) return `count exceeds the ${MAX_CONTRACTS}-contract cap (KALSHI_MAX_CONTRACTS)`;
  if (!Number.isInteger(req.priceCents) || (req.priceCents as number) < 1 || (req.priceCents as number) > 99) {
    return 'priceCents must be an integer 1..99 (limit orders only)';
  }
  const costDollars = ((req.count as number) * (req.priceCents as number)) / 100;
  if (costDollars > MAX_ORDER_COST_DOLLARS) {
    return `order cost $${costDollars.toFixed(2)} exceeds the $${MAX_ORDER_COST_DOLLARS} cap (KALSHI_MAX_ORDER_COST_DOLLARS)`;
  }
  return null;
}

/**
 * @description True when live-exchange orders are enabled for this process. Default OFF — the
 * demo exchange is the only order target until the operator flips KALSHI_LIVE_ENABLED=true
 * (and the calibration re-study justifies it).
 * @returns Whether live orders are permitted.
 */
export function kalshiLiveOrdersEnabled(): boolean {
  return process.env.KALSHI_LIVE_ENABLED === 'true';
}

/**
 * @description Place a validated LIMIT order. Callers must have already passed
 * validateOrderRequest and the live-gate; this does the wire call only.
 * @param creds - Key id + PEM.
 * @param req - The validated order.
 * @param clientOrderId - Idempotency key (UUID) — Kalshi dedupes on it.
 * @returns Kalshi's order record, normalized.
 */
export async function placeKalshiOrder(creds: KalshiCreds, req: KalshiOrderRequest, clientOrderId: string): Promise<KalshiOrder> {
  const body: Record<string, unknown> = {
    ticker: req.ticker, side: req.side, action: req.action, count: req.count,
    type: 'limit', client_order_id: clientOrderId,
  };
  if (req.side === 'yes') body.yes_price = req.priceCents; else body.no_price = req.priceCents;
  const out = await kalshiAuthedRequest<{ order?: Record<string, unknown> }>(creds, 'POST', '/portfolio/orders', body);
  const order = normalizeOrder(out.order || {});
  log.info({ ticker: req.ticker, side: req.side, action: req.action, count: req.count, priceCents: req.priceCents, orderId: order.orderId, status: order.status }, 'kalshi order placed');
  return order;
}

/**
 * @description Cancel a resting order.
 * @param creds - Key id + PEM.
 * @param orderId - Kalshi order id.
 * @returns The order record after cancellation.
 */
export async function cancelKalshiOrder(creds: KalshiCreds, orderId: string): Promise<KalshiOrder> {
  const out = await kalshiAuthedRequest<{ order?: Record<string, unknown> }>(creds, 'DELETE', `/portfolio/orders/${encodeURIComponent(orderId)}`);
  const order = normalizeOrder(out.order || {});
  log.info({ orderId, status: order.status }, 'kalshi order cancelled');
  return order;
}
