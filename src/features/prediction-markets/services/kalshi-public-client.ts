/**
 * Kalshi public-data client — markets, series, candlesticks, trades, exchange status.
 *
 * Every endpoint here is UNAUTHENTICATED on Kalshi's trade-api v2 (market data is public);
 * the authed portfolio/order client lives separately in kalshi-auth.ts. `fetch`-based with an
 * abort timeout and a global throttle so batch studies stay inside the public rate limit.
 * Base URL is env-switchable so the same client drives the demo exchange.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — throttled public client (markets w/ cursor paging, series meta cache, hourly/minute candlesticks, trade tape, exchange status), dollars-string normalization into KalshiMarket.
 *
 * @module prediction-markets/kalshi-public-client
 */

import { createChildLogger } from '@/shared/logger';
import type { KalshiCandle, KalshiMarket, KalshiSeriesMeta } from '../types';

const log = createChildLogger({ module: 'kalshi-public-client' });

/** Production API base; demo exchange = https://demo-api.kalshi.co/trade-api/v2 via env. */
const DEFAULT_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

/** @description Resolve the Kalshi API base URL (KALSHI_API_BASE overrides; demo or prod). @returns Base URL without trailing slash. */
export function kalshiApiBase(): string {
  return (process.env.KALSHI_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

/** Minimum ms between requests — the public tier 429s near 5 rps under sustained load; default ~3 rps. */
const THROTTLE_MS = Number(process.env.KALSHI_THROTTLE_MS) || 350;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + THROTTLE_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function fetchT(url: string, ms = Number(process.env.KALSHI_FETCH_TIMEOUT_MS) || 10000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal }); } finally { clearTimeout(t); }
}

/**
 * @description Throttled GET against the public API with one retry on 429/5xx (honors Retry-After).
 * @param path - Path + query under the API base, e.g. `/markets?limit=100`.
 * @returns Parsed JSON body.
 */
export async function kalshiGet<T>(path: string): Promise<T> {
  await throttle();
  const url = `${kalshiApiBase()}${path}`;
  let res = await fetchT(url);
  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2;
    log.warn({ path, status: res.status, retryAfter }, 'kalshi GET throttled/errored — retrying once');
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    res = await fetchT(url);
  }
  if (!res.ok) throw new Error(`Kalshi GET ${path} failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200)).catch(() => '')}`);
  return (await res.json()) as T;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function date(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @description Normalize one wire market object into KalshiMarket (dollars as numbers, series
 * ticker derived from the event ticker, multivariate/parlay legs flagged for exclusion).
 * @param m - Raw market object from the API.
 * @returns Normalized market.
 */
export function normalizeMarket(m: Record<string, unknown>): KalshiMarket {
  const eventTicker = String(m.event_ticker || '');
  const title = [m.title, m.yes_sub_title || m.subtitle].filter(Boolean).join(' — ');
  return {
    ticker: String(m.ticker || ''),
    eventTicker,
    seriesTicker: eventTicker.split('-')[0] || '',
    title: title || String(m.ticker || ''),
    status: String(m.status || ''),
    result: String(m.result || ''),
    yesBid: num(m.yes_bid_dollars ?? (m.yes_bid as number) / 100),
    yesAsk: num(m.yes_ask_dollars ?? (m.yes_ask as number) / 100),
    noBid: num(m.no_bid_dollars ?? (m.no_bid as number) / 100),
    noAsk: num(m.no_ask_dollars ?? (m.no_ask as number) / 100),
    lastPrice: num(m.last_price_dollars ?? (m.last_price as number) / 100),
    volume: num(m.volume_fp ?? m.volume),
    liquidity: num(m.liquidity_dollars ?? (m.liquidity as number) / 100),
    openInterest: num(m.open_interest_fp ?? m.open_interest),
    openTime: date(m.open_time),
    closeTime: date(m.close_time),
    isMultivariate: Boolean(m.mve_collection_ticker || m.mve_selected_legs),
    strikeType: typeof m.strike_type === 'string' ? m.strike_type : undefined,
    floorStrike: typeof m.floor_strike === 'number' ? m.floor_strike : undefined,
    capStrike: typeof m.cap_strike === 'number' ? m.cap_strike : undefined,
  };
}

/**
 * @description Page through GET /markets with a cursor. Stops at `maxMarkets` or when the
 * exchange runs out of pages.
 * @param params - Filter params: status ('open'|'settled'|...), seriesTicker, minCloseTs/maxCloseTs (epoch s).
 * @param maxMarkets - Hard cap on markets returned.
 * @returns Normalized markets.
 */
export async function listMarkets(
  params: { status?: string; seriesTicker?: string; minCloseTs?: number; maxCloseTs?: number },
  maxMarkets = 1000,
): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor = '';
  while (out.length < maxMarkets) {
    const q = new URLSearchParams({ limit: String(Math.min(1000, maxMarkets - out.length)) });
    if (params.status) q.set('status', params.status);
    if (params.seriesTicker) q.set('series_ticker', params.seriesTicker);
    if (params.minCloseTs) q.set('min_close_ts', String(params.minCloseTs));
    if (params.maxCloseTs) q.set('max_close_ts', String(params.maxCloseTs));
    if (cursor) q.set('cursor', cursor);
    const body = await kalshiGet<{ cursor?: string; markets?: Record<string, unknown>[] }>(`/markets?${q}`);
    const page = (body.markets || []).map(normalizeMarket);
    out.push(...page);
    cursor = body.cursor || '';
    if (!cursor || page.length === 0) break;
  }
  return out;
}

/**
 * @description Page /markets keeping only markets that pass `keep`, until `maxKeep` are held or
 * `maxPaged` raw markets have been walked. The flat feed is >99% auto-generated multivariate
 * parlay legs with empty books — filtering in-stream is the only practical way to reach the
 * real markets without a per-series fan-out.
 * @param params - Same filters as listMarkets.
 * @param keep - Predicate deciding whether a market is retained.
 * @param opts - maxKeep (default 1500 retained) / maxPaged (default 60000 walked).
 * @returns Retained markets + how many raw markets were paged.
 */
export async function listMarketsFiltered(
  params: { status?: string; seriesTicker?: string; minCloseTs?: number; maxCloseTs?: number },
  keep: (m: KalshiMarket) => boolean,
  opts: { maxKeep?: number; maxPaged?: number } = {},
): Promise<{ markets: KalshiMarket[]; paged: number }> {
  const maxKeep = opts.maxKeep ?? 1500;
  const maxPaged = opts.maxPaged ?? 60_000;
  const out: KalshiMarket[] = [];
  let paged = 0;
  let cursor = '';
  while (out.length < maxKeep && paged < maxPaged) {
    const q = new URLSearchParams({ limit: '1000' });
    if (params.status) q.set('status', params.status);
    if (params.seriesTicker) q.set('series_ticker', params.seriesTicker);
    if (params.minCloseTs) q.set('min_close_ts', String(params.minCloseTs));
    if (params.maxCloseTs) q.set('max_close_ts', String(params.maxCloseTs));
    if (cursor) q.set('cursor', cursor);
    const body = await kalshiGet<{ cursor?: string; markets?: Record<string, unknown>[] }>(`/markets?${q}`);
    const page = (body.markets || []).map(normalizeMarket);
    paged += page.length;
    for (const m of page) { if (keep(m) && out.length < maxKeep) out.push(m); }
    cursor = body.cursor || '';
    if (!cursor || page.length === 0) break;
  }
  return { markets: out, paged };
}

const seriesCache = new Map<string, KalshiSeriesMeta>();

/**
 * @description List a category's series (fee model + cadence per series). Primes the series
 * cache so follow-up getSeriesMeta calls are free. Categories with no series return [].
 * @param category - Kalshi category, e.g. 'Economics', 'Climate and Weather'.
 * @returns Series metadata for the category.
 */
export async function listSeries(category: string): Promise<KalshiSeriesMeta[]> {
  const body = await kalshiGet<{ series?: Record<string, unknown>[] }>(`/series?category=${encodeURIComponent(category)}`);
  const out: KalshiSeriesMeta[] = [];
  for (const s of body.series || []) {
    const ticker = String(s.ticker || '');
    if (!ticker) continue;
    const meta: KalshiSeriesMeta = {
      ticker,
      category: String(s.category || category),
      feeType: String(s.fee_type || 'quadratic'),
      feeMultiplier: num(s.fee_multiplier) || 1,
      frequency: String(s.frequency || ''),
    };
    seriesCache.set(ticker, meta);
    out.push(meta);
  }
  return out;
}

/**
 * @description Series metadata (category + fee model), cached per process — the fee math and
 * calibration grouping key. Unknown/failed lookups return a 'quadratic ×1, Unknown' default so
 * one bad series can't sink a batch study.
 * @param seriesTicker - e.g. `KXHIGHNY`.
 * @returns Series metadata.
 */
export async function getSeriesMeta(seriesTicker: string): Promise<KalshiSeriesMeta> {
  const hit = seriesCache.get(seriesTicker);
  if (hit) return hit;
  let meta: KalshiSeriesMeta;
  try {
    const body = await kalshiGet<{ series?: Record<string, unknown> }>(`/series/${encodeURIComponent(seriesTicker)}`);
    const s = body.series || {};
    meta = {
      ticker: seriesTicker,
      category: String(s.category || 'Unknown'),
      feeType: String(s.fee_type || 'quadratic'),
      feeMultiplier: num(s.fee_multiplier) || 1,
      frequency: String(s.frequency || ''),
    };
  } catch (err) {
    log.error({ err, seriesTicker }, 'series lookup failed — defaulting fee model');
    meta = { ticker: seriesTicker, category: 'Unknown', feeType: 'quadratic', feeMultiplier: 1, frequency: '' };
  }
  seriesCache.set(seriesTicker, meta);
  return meta;
}

function candleNum(section: unknown, field: string): number | null {
  if (!section || typeof section !== 'object') return null;
  const v = (section as Record<string, unknown>)[field];
  const n = num(v);
  return v === undefined || v === null ? null : n;
}

/**
 * @description Market candlesticks (YES price + book OHLC). `periodInterval` minutes: 1, 60, or 1440.
 * @param seriesTicker - Series the market belongs to.
 * @param marketTicker - Market ticker.
 * @param startTs - Range start, epoch seconds.
 * @param endTs - Range end, epoch seconds.
 * @param periodInterval - Candle width in minutes.
 * @returns Candles (may be empty when the market didn't exist in the range).
 */
export async function getCandles(
  seriesTicker: string, marketTicker: string, startTs: number, endTs: number, periodInterval: 1 | 60 | 1440,
): Promise<KalshiCandle[]> {
  const path = `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(marketTicker)}` +
    `/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`;
  const body = await kalshiGet<{ candlesticks?: Record<string, unknown>[] }>(path);
  return (body.candlesticks || []).map((c) => ({
    endPeriodTs: num(c.end_period_ts),
    close: candleNum(c.price, 'close_dollars'),
    mean: candleNum(c.price, 'mean_dollars'),
    yesBidClose: candleNum(c.yes_bid, 'close_dollars'),
    yesAskClose: candleNum(c.yes_ask, 'close_dollars'),
    volume: num(c.volume_fp ?? c.volume),
    openInterest: num(c.open_interest_fp ?? c.open_interest),
  }));
}

/**
 * @description Exchange trading status — gate any live scan/execution on `trading_active`.
 * @returns True when the exchange reports trading active.
 */
export async function exchangeTradingActive(): Promise<boolean> {
  const body = await kalshiGet<{ trading_active?: boolean }>('/exchange/status');
  return Boolean(body.trading_active);
}
