/**
 * Schwab market data — the LIVE data stream (ADR-052), mirroring the Alpaca paper stream.
 *
 * `fetch`-based against the Schwab Market Data API using the SAME per-user OAuth bearer the
 * SchwabBrokerAdapter uses (resolved lazily via the injected resolver), so the live book's data
 * and execution ride one connection. Implements the `MarketDataSource` surface the algorithms/
 * signals consume (latestPrice / dailyCloses / closesForTimeframe) — the Schwab twin of the
 * Alpaca functions in market-data.ts, so the exact same engine reasons over Schwab live quotes
 * and candles instead of Alpaca's IEX feed.
 *
 * Schwab has no news API in the market-data set — news stays an Alpaca-sourced signal (a data
 * vendor independent of the execution broker), so `recentNews` is not part of this source.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Schwab Market Data API quotes (latestPrice) + pricehistory candles (closesForTimeframe/dailyCloses/barsBatch), per-user bearer via the shared resolver, timeframe→Schwab frequency mapping. The live twin of the Alpaca paper data stream.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added latestTrade(): lastPrice paired with Schwab's tradeTime/quoteTime epoch-ms stamp, so the order-pricing path can tell a live tick from an hours-old off-hours print. Deliberately does NOT fall back to mark/closePrice the way latestPrice does — a settlement mark has no trade timestamp and must never set a limit.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added priorCloses(): batched prior-session closes so the live desk can derive a TRUE "today's move" per position instead of Schwab's polluted currentDayProfitLoss (which double-counted same-day realized P&L on round-tripped symbols → bogus five-figure "Today $" totals).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Class-share symbology translation (toSchwabSymbol/fromSchwabSymbol): live probe for the BRK.B core proposal showed Schwab rejects engine dot notation ("invalidSymbols":["BRK.B"]) and requires BRK/B. All quote/pricehistory requests now translate outbound and re-key inbound by the caller's engine symbol; the broker adapter applies the same pair on orders/positions/transactions. Without this the live book silently diverges from paper on any class-share name.
 *
 * @module schwab-market-data
 */

import { createChildLogger } from '@/shared/logger';
import type { SchwabTokenResolver } from './schwab-broker-adapter';
import type { MarketDataSource } from './market-data-source';
import type { Timeframe, TradeTick } from './market-data';

const logger = createChildLogger({ module: 'schwab-market-data' });

/** Market Data API base — env-overridable (mirrors the Trader base override for the sandbox). */
function mdBase(): string {
  return (process.env.SCHWAB_MARKETDATA_BASE_URL || 'https://api.schwabapi.com/marketdata/v1').replace(/\/+$/, '');
}

/* Class-share symbology split (found live 2026-07-26 probing the BRK.B core proposal): the engine —
 * universe, core config, Alpaca paper venue — speaks dot notation (`BRK.B`); Schwab's Trader +
 * Market Data APIs reject it ("invalidSymbols") and require slash (`BRK/B`). Translate at THIS wire
 * boundary only, both directions, so every layer above stays single-notation. Single trailing class
 * letter only — deliberately conservative (preferred-share forms are out of scope until needed). */

/** @description Engine notation (`BRK.B`) → Schwab wire notation (`BRK/B`). Non-class symbols pass through. */
export function toSchwabSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase().replace(/^([A-Z]+)\.([A-Z])$/, '$1/$2');
}

/** @description Schwab wire notation (`BRK/B`) → engine notation (`BRK.B`). Non-class symbols pass through. */
export function fromSchwabSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase().replace(/^([A-Z]+)\/([A-Z])$/, '$1.$2');
}

/** Calendar-day lookback per timeframe — enough history for SMA20/RSI14/donchian20 to fire (matches market-data.ts). */
const LOOKBACK_DAYS: Record<Timeframe, number> = {
  '5Min': 7, '1Hour': 45, '1Day': 220, '1Week': 1200, '3Month': 4000,
};

/** Our Timeframe → Schwab pricehistory frequency params. Schwab minute set is {1,5,10,15,30} (no 60),
 *  so 1Hour is approximated with 30-min candles; weekly/monthly/daily map exactly. */
const FREQ: Record<Timeframe, { periodType: string; frequencyType: string; frequency: number }> = {
  '5Min': { periodType: 'day', frequencyType: 'minute', frequency: 5 },
  '1Hour': { periodType: 'day', frequencyType: 'minute', frequency: 30 },
  '1Day': { periodType: 'year', frequencyType: 'daily', frequency: 1 },
  '1Week': { periodType: 'year', frequencyType: 'weekly', frequency: 1 },
  '3Month': { periodType: 'year', frequencyType: 'monthly', frequency: 1 },
};

/**
 * @description `fetch` with an AbortController timeout so a hung Schwab endpoint can't stall a run.
 * Default 8s, overridable via SCHWAB_FETCH_TIMEOUT_MS. Timer always cleared.
 */
async function fetchT(url: string, init: RequestInit = {}, ms = Number(process.env.SCHWAB_FETCH_TIMEOUT_MS) || 8000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

/** True when the Schwab OAuth app is wired (App Key + Secret present). */
function schwabClientConfigured(): boolean {
  return Boolean(
    (process.env.SCHWAB_CLIENT_ID_PRD || process.env.SCHWAB_CLIENT_ID || process.env.SCHWAB_APP_KEY)
    && (process.env.SCHWAB_CLIENT_SECRET_PRD || process.env.SCHWAB_CLIENT_SECRET || process.env.SCHWAB_APP_SECRET),
  );
}

/** The Schwab-backed market-data source (per-user token). The live twin of the Alpaca free functions. */
export class SchwabMarketData implements MarketDataSource {
  readonly kind = 'schwab' as const;
  private readonly resolveToken: SchwabTokenResolver;

  /** @param resolveToken - Resolves a fresh access token for the bound user (null = not connected). */
  constructor(resolveToken: SchwabTokenResolver) {
    this.resolveToken = resolveToken;
  }

  /** True once the Schwab OAuth app is wired. Per-user connection is checked lazily on the first call. */
  configured(): boolean { return schwabClientConfigured(); }

  /** Resolve a bearer or throw a clear, user-actionable error. */
  private async bearer(): Promise<string> {
    const tok = await this.resolveToken();
    if (!tok) throw new Error('Schwab account not connected — connect it under Settings → Connections → Charles Schwab, then retry.');
    return tok;
  }

  /** Low-level Market Data GET (bearer + Accept). Throws on non-2xx. */
  private async get<T>(pathname: string): Promise<T> {
    const bearer = await this.bearer();
    const r = await fetchT(`${mdBase()}${pathname}`, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) throw new Error(`schwab-md ${pathname.split('?')[0]} ${r.status}: ${text.slice(0, 160)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * @description Latest trade price for a symbol via /quotes. Prefers lastPrice, then mark/regular
   * close (after-hours). Returns null if the quote is missing.
   * @param symbol - Ticker.
   * @returns The last price, or null.
   */
  async latestPrice(symbol: string): Promise<number | null> {
    const sym = toSchwabSymbol(symbol);
    const j = await this.get<Record<string, { quote?: { lastPrice?: number; mark?: number; closePrice?: number } }>>(
      `/quotes?symbols=${encodeURIComponent(sym)}&fields=quote&indicative=false`);
    const q = j?.[sym]?.quote || {};
    const px = q.lastPrice ?? q.mark ?? q.closePrice;
    return px != null && Number.isFinite(Number(px)) ? Number(px) : null;
  }

  /**
   * @description Last TRADE price plus the timestamp of that trade, for the order-pricing path.
   * Unlike `latestPrice` this never falls back to `mark`/`closePrice`: those are derived marks with
   * no trade behind them, so their freshness is unknowable and they must not set a limit price.
   * Returns null when Schwab omits either the last price or its timestamp — the caller treats a
   * null as stale and declines to price the order, which is the safe direction.
   * @param symbol - Ticker.
   * @returns The last trade tick, or null when price/timestamp are missing.
   */
  async latestTrade(symbol: string): Promise<TradeTick | null> {
    const sym = toSchwabSymbol(symbol);
    const j = await this.get<Record<string, { quote?: { lastPrice?: number; tradeTime?: number; quoteTime?: number } }>>(
      `/quotes?symbols=${encodeURIComponent(sym)}&fields=quote&indicative=false`);
    const q = j?.[sym]?.quote || {};
    const price = Number(q.lastPrice);
    // Schwab stamps these as epoch MILLISECONDS. tradeTime is the print; quoteTime is the book update.
    const stampMs = Number(q.tradeTime ?? q.quoteTime);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stampMs) || stampMs <= 0) return null;
    return { price, asOf: new Date(stampMs) };
  }

  /**
   * @description Prior-session CLOSE for many symbols in ONE /quotes call — the anchor for a
   * correct "today's move" ((currentPrice − priorClose) × qty). The live desk uses this instead of
   * Schwab's position-level `currentDayProfitLoss`, which double-counts same-day realized P&L on
   * round-tripped symbols and inflated the desk's "Today $" column into five-figure nonsense
   * (2026-07-09). Symbols Schwab omits (or returns a non-positive close for) are simply absent.
   * @param symbols - Tickers (deduped + upper-cased internally).
   * @returns Map of UPPERCASE symbol → prior-session close price.
   */
  async priorCloses(symbols: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(Boolean);
    if (!uniq.length) return out;
    // Request in Schwab wire notation; key the result by the ENGINE symbol the caller passed.
    const j = await this.get<Record<string, { quote?: { closePrice?: number } }>>(
      `/quotes?symbols=${encodeURIComponent(uniq.map(toSchwabSymbol).join(','))}&fields=quote&indicative=false`);
    for (const sym of uniq) {
      const c = Number(j?.[toSchwabSymbol(sym)]?.quote?.closePrice);
      if (Number.isFinite(c) && c > 0) out.set(sym, c);
    }
    return out;
  }

  /**
   * @description Close series for a symbol at one timeframe (most recent `n` candles) via /pricehistory.
   * @param symbol - Ticker.
   * @param timeframe - Bar size (5Min | 1Hour | 1Day | 1Week | 3Month).
   * @param n - Max closes to return.
   * @returns Ascending-time array of closes.
   */
  async closesForTimeframe(symbol: string, timeframe: Timeframe, n = 60): Promise<number[]> {
    const f = FREQ[timeframe] || FREQ['1Day'];
    const startDate = Date.now() - (LOOKBACK_DAYS[timeframe] ?? 220) * 864e5;
    const qs = new URLSearchParams({
      symbol: toSchwabSymbol(symbol),
      periodType: f.periodType,
      frequencyType: f.frequencyType,
      frequency: String(f.frequency),
      startDate: String(Math.floor(startDate)),
      endDate: String(Date.now()),
      needExtendedHoursData: 'false',
    });
    const j = await this.get<{ candles?: Array<{ close?: number }>; empty?: boolean }>(`/pricehistory?${qs.toString()}`);
    return (j.candles || []).map((c) => Number(c.close)).filter((c) => Number.isFinite(c)).slice(-n);
  }

  /** Daily close series (most recent `n` sessions). */
  async dailyCloses(symbol: string, n = 60): Promise<number[]> {
    return this.closesForTimeframe(symbol, '1Day', n);
  }

  /**
   * @description Batched bars: ONE timeframe across many symbols. Schwab pricehistory is per-symbol,
   * so this fans out (bounded concurrency) — fine for the manual live rail's small watchlists, not the
   * ~100-name autopilot scan (which stays on the Alpaca batched endpoint by design).
   * @param symbols - Tickers.
   * @param timeframe - Bar size.
   * @param n - Max bars per symbol.
   * @returns Map of UPPERCASE symbol → ascending closes (symbols with no data are absent).
   */
  async barsBatch(symbols: string[], timeframe: Timeframe, n = 60): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
    for (const sym of uniq) {
      try { const closes = await this.closesForTimeframe(sym, timeframe, n); if (closes.length) out.set(sym, closes); }
      catch (err) { logger.warn({ err, sym, timeframe }, 'schwab barsBatch symbol failed'); }
    }
    return out;
  }
}
