/**
 * Market-data source — the provider-agnostic price-data contract, per mode (ADR-052).
 *
 * The trade engine's inputs (latest price, close series, batched bars) come from a vendor that,
 * like the BrokerAdapter, is selected PER BOOK: the paper book reads Alpaca's IEX feed (the
 * existing market-data.ts free functions), the live book reads Schwab's Market Data API on the
 * caller's own connection. `getMarketData(mode, userSub)` picks the vendor using the SAME per-mode
 * selection as getBrokerAdapter, so data and execution ride one broker for the live book.
 *
 * This is additive: the paper/autopilot path keeps calling the market-data.ts free functions
 * directly (Alpaca), so nothing there changes. Only the LIVE reads are routed through the source.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — MarketDataSource interface, AlpacaMarketData wrapper over the existing free functions, getMarketData(mode, userSub) per-mode factory selecting Schwab (per-user Market Data API) for the live book.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added latestTrade(): the price WITH its exchange timestamp, so the order-pricing path can refuse a stale off-hours print instead of pinning a limit to an hours-old trade (the extended-hours cancel/re-place loop). Both vendors implement it; latestPrice stays freshness-blind for the algo path.
 *
 * @module market-data-source
 */

import type { Timeframe, TradeTick } from './market-data';
import { marketDataConfigured, latestPrice, latestTrade, dailyCloses, closesForTimeframe, barsBatch } from './market-data';
import { brokerProviderFor, resolveSchwabToken } from './broker-provider';
import { SchwabMarketData } from './schwab-market-data';
import type { TradingMode } from './broker-adapter';

/** The price-data surface the algorithms/signals consume, independent of the vendor behind it. */
export interface MarketDataSource {
  /** Which vendor backs this source. */
  readonly kind: 'alpaca' | 'schwab';
  /** True when the vendor's credentials/connection plumbing is present. */
  configured(): boolean;
  /** Latest trade price for a symbol, or null. Freshness-blind — never price an order off this. */
  latestPrice(symbol: string): Promise<number | null>;
  /** Latest trade price WITH its exchange timestamp — the only price safe to set a limit from. */
  latestTrade(symbol: string): Promise<TradeTick | null>;
  /** Daily close series (most recent `n` sessions), ascending. */
  dailyCloses(symbol: string, n?: number): Promise<number[]>;
  /** Close series at one timeframe (most recent `n` bars), ascending. */
  closesForTimeframe(symbol: string, timeframe: Timeframe, n?: number): Promise<number[]>;
  /** One timeframe across many symbols → map of UPPERCASE symbol → ascending closes. */
  barsBatch(symbols: string[], timeframe: Timeframe, n?: number): Promise<Map<string, number[]>>;
}

/** Alpaca-backed source — a thin adapter over the market-data.ts free functions (the paper stream). */
class AlpacaMarketData implements MarketDataSource {
  readonly kind = 'alpaca' as const;
  configured(): boolean { return marketDataConfigured(); }
  latestPrice(symbol: string): Promise<number | null> { return latestPrice(symbol); }
  latestTrade(symbol: string): Promise<TradeTick | null> { return latestTrade(symbol); }
  dailyCloses(symbol: string, n = 60): Promise<number[]> { return dailyCloses(symbol, n); }
  closesForTimeframe(symbol: string, timeframe: Timeframe, n = 60): Promise<number[]> { return closesForTimeframe(symbol, timeframe, n); }
  barsBatch(symbols: string[], timeframe: Timeframe, n = 60): Promise<Map<string, number[]>> { return barsBatch(symbols, timeframe, n); }
}

/** Singleton — the Alpaca source is stateless (keys read from env per call). */
const alpacaSource = new AlpacaMarketData();

/**
 * @description Resolve the market-data source for a book (and caller, for the per-user Schwab feed).
 * @param mode - 'paper' (Alpaca) or 'live' (whatever BROKER_PROVIDER_LIVE selects; schwab = per-user).
 * @param userSub - The caller's OIDC sub — required for the Schwab feed; ignored by Alpaca.
 * @returns The `MarketDataSource` for that book.
 */
export function getMarketData(mode: TradingMode, userSub?: string): MarketDataSource {
  if (brokerProviderFor(mode) === 'schwab') {
    return new SchwabMarketData(async () => resolveSchwabToken(mode, userSub));
  }
  return alpacaSource;
}
