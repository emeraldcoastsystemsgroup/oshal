/**
 * Broker provider factory — selects the active trade-execution rail, per mode (ADR-052).
 *
 * Parallels getPaymentAdapter() / HARNESS_FACTORIES: a single registry maps each
 * `BrokerProviderType` to a per-mode constructor, and `getBrokerAdapter(mode, userSub?)`
 * returns the one selected for that book. Adding a broker = register a sibling adapter here;
 * callers (trading-routes) never branch on the provider.
 *
 * PER-MODE SELECTION: the paper and live books can run DIFFERENT rails.
 *   paper → BROKER_PROVIDER_PAPER || BROKER_PROVIDER || 'alpaca'
 *   live  → BROKER_PROVIDER_LIVE  || BROKER_PROVIDER || 'alpaca'
 * This is what lets Alpaca stay the paper + autopilot rail while Schwab is the LIVE manual-orders
 * rail (BROKER_PROVIDER_LIVE=schwab) — Schwab has no paper account, so it can only be the live book.
 *
 * LIVE GATING (ADR-052): trading ships PAPER-ONLY by default. A request for a `live` adapter throws
 * unless `TRADING_LIVE_ENABLED === 'true'` — the code-level guard behind "this ADR does not authorize
 * live trading". Flipping it on is a deliberate, separately-reviewed operator action.
 *
 * PER-USER CREDENTIALS: Alpaca is a shared env key pair (userSub ignored). Schwab is a PER-USER OAuth
 * token — the caller connects their own Schwab account via the 'schwab' connector. Because this feature
 * slice must not import the app-layer connector store (FSD), the app registers a token resolver via
 * `registerSchwabTokenResolver`; the factory binds it to the caller's sub and hands the Schwab adapter
 * a `() => Promise<token>` closure.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — BROKER_PROVIDER-selected, per-mode factory; alpaca wired, schwab/snaptrade/ibkr declared not-yet-implemented; live mode gated behind TRADING_LIVE_ENABLED.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wire the Schwab LIVE rail: per-mode provider selection (BROKER_PROVIDER_PAPER/_LIVE over BROKER_PROVIDER), Schwab factory bound to a per-user token resolver (registerSchwabTokenResolver), getBrokerAdapter(mode, userSub?). Schwab is live-only — the factory refuses a paper Schwab so a "paper" order can never hit a real account. snaptrade/ibkr remain not-implemented.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Split reads from the live gate: getBrokerReader(mode, sub) constructs the adapter WITHOUT the TRADING_LIVE_ENABLED check (shared constructAdapter helper), so a connected live account is readable (balances/positions/order status) without arming live trading. Order placement keeps getBrokerAdapter (gated) + placeDecisionOrder's explicit confirm — ungated reads can never place an order.
 *
 * @module broker-provider
 */

import { createChildLogger } from '@/shared/logger';
import type { BrokerAdapter, BrokerProviderType, TradingMode } from './broker-adapter';
import { AlpacaBrokerAdapter } from './alpaca-broker-adapter';
import { SchwabBrokerAdapter, type SchwabTokenResolver } from './schwab-broker-adapter';

const logger = createChildLogger({ module: 'broker-provider' });

/** Brokers not yet implemented — registered so an explicit selection fails clearly. */
const NOT_IMPLEMENTED: Record<string, string> = {
  snaptrade: 'SnapTrade rail is not implemented yet — set the broker to alpaca or schwab.',
  ibkr: 'Interactive Brokers rail is not implemented yet — set the broker to alpaca or schwab.',
};

/** Resolves a valid Schwab access token for a given user (refreshing as needed). Null = not connected. */
export type BrokerTokenResolver = (mode: TradingMode, userSub: string) => Promise<string | null>;

/** App-layer-injected Schwab token resolver (wraps getValidAccessToken); null until registered. */
let schwabTokenResolver: BrokerTokenResolver | null = null;

/**
 * @description Register the resolver the Schwab adapter uses to fetch a per-user access token.
 * Called once at app boot (createTradingRoutes) so the trading feature never imports the
 * app-layer connector store directly (keeps the FSD layering top-down).
 * @param fn - `(mode, userSub) => Promise<accessToken | null>`.
 */
export function registerSchwabTokenResolver(fn: BrokerTokenResolver): void {
  schwabTokenResolver = fn;
}

/**
 * @description Resolve a Schwab access token via the registered resolver — shared by the Schwab
 * market-data source so it authenticates the SAME per-user connection as the broker adapter.
 * @param mode - The book (Schwab is live-only).
 * @param userSub - The caller's OIDC sub.
 * @returns The access token, or null if no resolver/sub or the user isn't connected.
 */
export async function resolveSchwabToken(mode: TradingMode, userSub?: string): Promise<string | null> {
  if (!schwabTokenResolver || !userSub) return null;
  return schwabTokenResolver(mode, userSub);
}

/** True when live trading has been deliberately enabled by the operator (ADR-052 gate). */
export function liveTradingEnabled(): boolean {
  return process.env.TRADING_LIVE_ENABLED === 'true';
}

/** The rail selected for a given book (per-mode override over the global default). */
function providerFor(mode: TradingMode): BrokerProviderType {
  const perMode = mode === 'live' ? process.env.BROKER_PROVIDER_LIVE : process.env.BROKER_PROVIDER_PAPER;
  return (perMode || process.env.BROKER_PROVIDER || 'alpaca').trim() as BrokerProviderType;
}

/** The rail selected for a book — exposed so the market-data source picks the SAME per-mode vendor. */
export function brokerProviderFor(mode: TradingMode): BrokerProviderType {
  return providerFor(mode);
}

/**
 * @description Resolve the configured broker rail, bound to the requested book (and caller, for
 * per-user rails like Schwab).
 * @param mode - 'paper' (default-safe) or 'live'.
 * @param userSub - The caller's OIDC sub. Required for per-user rails (Schwab); ignored by Alpaca.
 * @returns The active `BrokerAdapter` for that mode.
 * @throws If the selected rail is unimplemented/unknown, if `mode === 'live'` while live trading is
 *   off, or if a paper book is pointed at Schwab (which has no paper account).
 */
export function getBrokerAdapter(mode: TradingMode, userSub?: string): BrokerAdapter {
  if (mode === 'live' && !liveTradingEnabled()) {
    logger.warn('live broker adapter requested while TRADING_LIVE_ENABLED is not true');
    throw new Error('Live trading is disabled. Set TRADING_LIVE_ENABLED=true (after the ADR-052 live review) to enable it.');
  }
  return constructAdapter(mode, userSub);
}

/**
 * @description READ-ONLY adapter accessor — for account/positions/order-status reads. Unlike
 * getBrokerAdapter it does NOT apply the TRADING_LIVE_ENABLED gate, so a connected LIVE account is
 * READABLE (balances, positions, order status) without arming live trading. Order PLACEMENT never
 * uses this — placeDecisionOrder keeps the live gate + explicit confirm — so ungated reads can never
 * place an order. This is what makes the live surface usable (see your account) before you flip live on.
 * @param mode - The book.
 * @param userSub - The caller's OIDC sub (required for per-user rails like Schwab).
 * @returns A `BrokerAdapter` for reads.
 */
export function getBrokerReader(mode: TradingMode, userSub?: string): BrokerAdapter {
  return constructAdapter(mode, userSub);
}

/** Construct the adapter for a book (no live gate) — shared by getBrokerAdapter + getBrokerReader. */
function constructAdapter(mode: TradingMode, userSub?: string): BrokerAdapter {
  const name = providerFor(mode);
  if (name === 'alpaca') return new AlpacaBrokerAdapter(mode);
  if (name === 'schwab') return buildSchwabAdapter(mode, userSub);
  const known = NOT_IMPLEMENTED[name];
  logger.error({ provider: name, mode }, 'unavailable broker provider requested');
  throw new Error(known || `Unknown broker provider '${name}'. Supported: alpaca, schwab.`);
}

/** Construct the Schwab adapter, bound to the caller's token. Live-only; paper is refused. */
function buildSchwabAdapter(mode: TradingMode, userSub?: string): BrokerAdapter {
  if (mode !== 'live') {
    // Schwab has no paper/sandbox trading account. Refuse a paper Schwab so a "paper" order can
    // never reach a real account — keep Alpaca (BROKER_PROVIDER_PAPER=alpaca) for the paper book.
    throw new Error('Schwab has no paper account — the paper book must use alpaca. Schwab is the live rail only.');
  }
  const resolver = schwabTokenResolver;
  const sub = userSub;
  const resolveToken: SchwabTokenResolver = async () => {
    if (!resolver || !sub) return null; // no resolver registered or no caller context → treated as "not connected"
    return resolver(mode, sub);
  };
  return new SchwabBrokerAdapter(mode, resolveToken, sub);
}
