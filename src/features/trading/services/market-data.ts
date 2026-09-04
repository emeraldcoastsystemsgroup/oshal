/**
 * Market data — Alpaca daily bars + latest trade (the algorithms' deterministic inputs).
 *
 * `fetch`-based against the Alpaca Data API (free IEX feed), reusing the same key resolution as the
 * broker adapter (ALPACA_PAPER_* with ALPACA_KEY/SECRET + ALPAKA_* aliases). Daily bars REQUIRE a
 * `start` param or the API returns `bars: null` — always pass one. No SDK, no keys in code.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — dailyCloses + latestPrice over the Alpaca Data API (IEX), shared key resolution, start-param bug avoided.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added multi-timeframe support: Timeframe union, closesForTimeframe (single), barsBatch (one call for many symbols/one timeframe — the autopilot's rate-safe fetch), and isMarketOpen (Alpaca clock). dailyCloses now delegates to closesForTimeframe.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | latestTrade(): return the trade's exchange timestamp alongside its price. latestPrice discarded `trade.t`, so an IEX print from HOURS ago read as "the current price". Extended-hours marketable limits were priced off that frozen print, never became marketable, and were cancel/re-placed every 5-min fire forever (MRNA: 97 orders at one price across 17.3h while the stock fell 6.6% away). Callers that price an order MUST use latestTrade and reject a stale tick; latestPrice stays for the signal/algo path, where a last-known close is legitimate.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | barsBatchSince(): deep-history daily bars from an explicit start, with per-bar session dates. The "~7 months of history" every backtest assumed was LOOKBACK_DAYS' 220-day live-trading economy, not an API limit — IEX serves 2021+ (probed against the 2021-01 and 2022-10 tapes). Unlocks bear-regime validation (2022, 2025 corrections) for the short-strategy work; existing barsBatch callers untouched.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | barsBatchSince(): optional `feed` param ('iex' default, unchanged for existing callers; 'sip' = consolidated-tape historical, free on the paper key). The Strategy Lab (ADR-092) backtests on SIP dailies with IEX fallback; SIP requests cap `end` 16 min back because the free plan denies the most recent 15 minutes.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | barsBatchOhlcv (ADR-096 shadow indicators): barsBatch's exact fetch preserving open/high/low/volume — the ATR/ADX/stochastic/volume-z indicators need more than closes. Additive; every existing caller untouched.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | FAIL CLOSED **LOUDLY**, and split the collapsed stand-down cause. The 2026-07-16 outage hid behind `catch { return 'closed' }`: a pinned-DNS/Tailscale break made the Alpaca clock unreachable, that read as a closed market, and the live desk placed no entries AND ran NO PROTECTIVE EXITS for 28 min — silently, because the watchdog counts "market closed" as a healthy heartbeat. Changes: (1) resolveSession() returns `{session, blind}` — every failure path (clock !ok / unusable body / unparseable timestamp / calendar !ok or non-array) now logs ERROR "venue clock unreachable" and marks blind, instead of four separate silent 'closed' returns; (2) the calendar NEVER caches a failure (a transient 502 used to write {open:-1} and poison the whole day, since calCache is keyed on date and never retried); (3) new tradableSessionDetailed() returns the CAUSE — 'halt' | 'closed' | 'ext-disabled' — because a bare null collapsed three unrelated states into one log line, so an engaged TRADING_HALT (which also kills protective exits) was indistinguishable from a real closed market to both operators and the watchdog. NOT done deliberately: guessing 'regular' from a local clock when blind. An adversarial review priced it as worse than the outage — 'regular' is the highest-permission session (arms the live book, bypasses isTickStale, sends MARKET orders, zeroes the gap guard), so on an unknown holiday it would queue ~78 stale-priced market orders into the next opening auction. Standing down is right; being silent was the bug.
 *
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | barsBatchSinceOhlcv(): deep-history daily bars from an explicit start that KEEP open/high/low/volume. barsBatchSince drops them, and the true-range family (ATR, ADX/+DI/−DI) cannot be reconstructed from closes — which blocked the trend-exhaustion study (ADX≥40 + RSI extreme) from running on a multi-year window. Additive; barsBatchSince and all its callers untouched.
 *
 * @module market-data
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'market-data' });

const DATA_BASE = 'https://data.alpaca.markets/v2';
/** Alpaca paper trading API base — used only for the market clock (not order placement). */
const TRADING_PAPER_BASE = 'https://paper-api.alpaca.markets';

/** The bar timeframes the multi-timeframe engine reads (5-min → quarterly). */
export type Timeframe = '5Min' | '1Hour' | '1Day' | '1Week' | '3Month';

/** A last-trade print with the exchange timestamp that produced it — price plus its freshness. */
export interface TradeTick {
  /** Last trade price. */
  price: number;
  /** Exchange timestamp of that trade. */
  asOf: Date;
}

/** Default seconds a trade print may age before an order must not be priced off it. */
const DEFAULT_MAX_TICK_AGE_SEC = 120;

/**
 * @description How stale a trade print may be before it can no longer set an order's limit price.
 * Off-hours the venue may not have printed for hours; pricing into that is how a "protective" sell
 * lands 6% above the market and never fills. Tunable via TRADING_EXT_QUOTE_MAX_AGE_SEC.
 * @returns Max acceptable tick age in seconds.
 */
export function maxTickAgeSec(): number {
  const raw = Number(process.env.TRADING_EXT_QUOTE_MAX_AGE_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_TICK_AGE_SEC;
}

/**
 * @description True when a trade print is too old to price an order against.
 * @param tick - The trade tick, or null when the vendor returned nothing.
 * @param nowMs - Current epoch ms (injectable for tests).
 * @returns True when the tick is missing or older than `maxTickAgeSec()`.
 */
export function isTickStale(tick: TradeTick | null, nowMs: number = Date.now()): boolean {
  if (!tick) return true;
  return (nowMs - tick.asOf.getTime()) / 1000 > maxTickAgeSec();
}

/** Calendar-day lookback per timeframe — enough history for SMA20/RSI14/donchian20 to fire. */
const LOOKBACK_DAYS: Record<Timeframe, number> = {
  '5Min': 7, '1Hour': 45, '1Day': 220, '1Week': 1200, '3Month': 4000,
};

/**
 * @description `fetch` with an AbortController timeout so a hung Alpaca endpoint can't stall a run
 * indefinitely (the autopilot/clock/news legs all share it). Default 8s, overridable via
 * ALPACA_FETCH_TIMEOUT_MS. The timer is always cleared in `finally`.
 * @param url - Request URL.
 * @param init - Fetch init (headers/method/body); the abort signal is merged in.
 * @param ms - Timeout in milliseconds.
 * @returns The fetch Response.
 */
async function fetchT(url: string, init: RequestInit = {}, ms = Number(process.env.ALPACA_FETCH_TIMEOUT_MS) || 8000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

function envFirst(...names: string[]): string { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; }
function keys(): { id: string; secret: string } {
  return {
    id: envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY'),
    secret: envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET'),
  };
}

/** True when Alpaca data credentials are present. */
export function marketDataConfigured(): boolean { const k = keys(); return Boolean(k.id && k.secret); }

async function adata<T>(pathname: string): Promise<T> {
  const k = keys();
  const r = await fetchT(`${DATA_BASE}${pathname}`, { headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret } });
  const j = (await r.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>;
  if (!r.ok) throw new Error(j.message || `alpaca-data ${pathname} ${r.status}`);
  return j as T;
}

/** ISO date (YYYY-MM-DD) `days` before now — the Alpaca `start` param every bars call needs. */
function startFor(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

/**
 * @description Close series for a symbol at one timeframe (most recent `n` bars).
 * @param symbol - Ticker.
 * @param timeframe - Bar size (5Min | 1Hour | 1Day | 1Week | 3Month).
 * @param n - Max bars to return.
 * @returns Ascending-time array of closes.
 */
export async function closesForTimeframe(symbol: string, timeframe: Timeframe, n = 60): Promise<number[]> {
  const start = startFor(LOOKBACK_DAYS[timeframe] ?? 220);
  // Alpaca returns bars ASCENDING from `start` and `limit` caps from the start, so `limit=n` with a
  // far-back lookback hands back the OLDEST n bars (months stale), not the recent ones. Over-fetch the
  // whole window and keep the most recent n (the approach barsBatch already uses). Without this,
  // dailyCloses() gave callers a stale baseline — e.g. the vs-S&P benchmark anchored SPY to ~7 months
  // ago, making the index look up ~12% and inverting the comparison.
  const j = await adata<{ bars: Array<{ c: number }> | null }>(
    `/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&start=${start}&limit=10000&adjustment=all&feed=iex`);
  return (j.bars || []).map((b) => Number(b.c)).slice(-n);
}

/**
 * @description Daily close series for a symbol (most recent `n` sessions).
 * @param symbol - Ticker.
 * @param n - Max sessions to return.
 * @returns Ascending-date array of closes.
 */
export async function dailyCloses(symbol: string, n = 60): Promise<number[]> {
  return closesForTimeframe(symbol, '1Day', n);
}

/**
 * @description Batched bars: ONE timeframe across MANY symbols in a single (paginated) call.
 * This is how the autopilot scans ~100 names cheaply — 1 request per timeframe instead of 1
 * per symbol — so a full multi-timeframe run stays well inside Alpaca's rate limit.
 * @param symbols - Tickers to fetch.
 * @param timeframe - Bar size.
 * @param n - Max bars per symbol.
 * @returns Map of UPPERCASE symbol → ascending-time closes (symbols with no bars are absent).
 */
export async function barsBatch(symbols: string[], timeframe: Timeframe, n = 60): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!symbols.length) return out;
  const start = startFor(LOOKBACK_DAYS[timeframe] ?? 220);
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].join(',');
  let pageToken = '';
  for (let page = 0; page < 8; page++) {
    const tokenParam = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '';
    const j = await adata<{ bars: Record<string, Array<{ c: number }>> | null; next_page_token?: string | null }>(
      `/stocks/bars?symbols=${encodeURIComponent(syms)}&timeframe=${timeframe}&start=${start}&limit=10000&adjustment=all&feed=iex${tokenParam}`);
    for (const [sym, arr] of Object.entries(j.bars || {})) {
      const prev = out.get(sym) || [];
      out.set(sym, prev.concat((arr || []).map((b) => Number(b.c))));
    }
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
  }
  // Keep only the most recent `n` per symbol (pagination can over-fetch on long lookbacks).
  for (const [sym, closes] of out) if (closes.length > n) out.set(sym, closes.slice(-n));
  return out;
}

/** One full OHLCV bar (ascending time) — what the shadow indicators (ATR/ADX/stochastic/volume)
 *  need beyond closes. Alpaca returns these fields on every bars call; the close-only fetches
 *  simply drop them. */
export interface OhlcvBar { o: number; h: number; l: number; c: number; v: number }

/**
 * @description Batched OHLCV bars: barsBatch's exact fetch shape (one paginated multi-symbol call,
 * adjustment=all, most-recent-n kept) but preserving open/high/low/volume — additive, no existing
 * caller changes. Daily-timeframe use only per the 2026-07-12 feed ruling. IMPORTANT: IEX bar
 * VOLUME is venue-only (~2% of the consolidated tape — the thin-tape trap the strategy log
 * documents); volume-sensitive consumers (volsurge) should pass feed='sip' (historical
 * consolidated tape, free on the paper key, end capped 16 min back like barsBatchSince).
 * @param symbols - Tickers to fetch.
 * @param timeframe - Bar size.
 * @param n - Max bars per symbol.
 * @param feed - 'iex' (default) or 'sip' (consolidated historical; true volume).
 * @returns Map of UPPERCASE symbol → ascending-time OHLCV bars (symbols with no bars absent).
 */
export async function barsBatchOhlcv(symbols: string[], timeframe: Timeframe, n = 60, feed: 'iex' | 'sip' = 'iex'): Promise<Map<string, OhlcvBar[]>> {
  const out = new Map<string, OhlcvBar[]>();
  if (!symbols.length) return out;
  const start = startFor(LOOKBACK_DAYS[timeframe] ?? 220);
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].join(',');
  const endParam = feed === 'sip' ? `&end=${encodeURIComponent(new Date(Date.now() - 16 * 60 * 1000).toISOString())}` : '';
  let pageToken = '';
  for (let page = 0; page < 8; page++) {
    const tokenParam = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '';
    const j = await adata<{ bars: Record<string, Array<{ o: number; h: number; l: number; c: number; v: number }>> | null; next_page_token?: string | null }>(
      `/stocks/bars?symbols=${encodeURIComponent(syms)}&timeframe=${timeframe}&start=${start}${endParam}&limit=10000&adjustment=all&feed=${feed}${tokenParam}`);
    for (const [sym, arr] of Object.entries(j.bars || {})) {
      const prev = out.get(sym) || [];
      out.set(sym, prev.concat((arr || []).map((b) => ({ o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) }))));
    }
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
  }
  for (const [sym, bars] of out) if (bars.length > n) out.set(sym, bars.slice(-n));
  return out;
}

/** Dated close — a daily close carrying its session date, for regime-split analysis. */
export interface DatedClose {
  /** Session date, YYYY-MM-DD. */
  d: string;
  /** Close price. */
  c: number;
}

/**
 * @description Batched DEEP-HISTORY daily bars from an explicit start date, with session dates.
 * `barsBatch` is capped by LOOKBACK_DAYS (220 calendar days for '1Day') — a live-trading economy,
 * NOT an API limit: Alpaca's IEX feed serves daily history back to at least 2021 (verified
 * 2026-07-08 against the 2021-01 and 2022-10 tapes). Multi-year backtests — the bear-regime
 * validation a short strategy requires — need that depth plus the DATE of each bar so results can
 * be split by calendar regime. 105 symbols × ~5.5y ≈ 145k bars → up to 20 pages of 10k.
 * @param symbols - Tickers to fetch.
 * @param startIso - Inclusive start (ISO date or datetime).
 * @param feed - Data feed: 'iex' (default, unchanged for existing callers) or 'sip' — the
 * consolidated-tape HISTORICAL feed, included with the paper key (2026-07-12 feed ruling:
 * daily-on-IEX diverges ≤0.16%, but SIP is the strictly better tape when the caller can take a
 * 16-minute end lag — the free plan denies the most recent 15 minutes of SIP data).
 * @returns Map of UPPERCASE symbol → ascending-time dated closes (symbols with no bars absent).
 */
export async function barsBatchSince(symbols: string[], startIso: string, feed: 'iex' | 'sip' = 'iex'): Promise<Map<string, DatedClose[]>> {
  const out = new Map<string, DatedClose[]>();
  if (!symbols.length) return out;
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].join(',');
  // SIP on the free plan rejects requests touching the last 15 minutes — cap `end` behind that.
  const endParam = feed === 'sip' ? `&end=${encodeURIComponent(new Date(Date.now() - 16 * 60 * 1000).toISOString())}` : '';
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const tokenParam = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '';
    const j = await adata<{ bars: Record<string, Array<{ c: number; t: string }>> | null; next_page_token?: string | null }>(
      `/stocks/bars?symbols=${encodeURIComponent(syms)}&timeframe=1Day&start=${encodeURIComponent(startIso)}${endParam}&limit=10000&adjustment=all&feed=${feed}${tokenParam}`);
    for (const [sym, arr] of Object.entries(j.bars || {})) {
      const prev = out.get(sym) || [];
      out.set(sym, prev.concat((arr || []).map((b) => ({ d: String(b.t).slice(0, 10), c: Number(b.c) }))));
    }
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
  }
  return out;
}

/** A dated OHLCV bar — `DatedClose` plus the high/low/open/volume the Wilder-family indicators
 *  (ATR, ADX/DMI, stochastic) require. The close-only deep-history fetch simply drops them. */
export interface DatedOhlcvBar extends OhlcvBar { /** Session date, YYYY-MM-DD. */ d: string }

/**
 * @description Batched DEEP-HISTORY daily OHLCV bars from an explicit start date. This is
 * `barsBatchSince`'s fetch (same pagination, adjustment=all, same feed semantics) preserving
 * open/high/low/volume, because the true-range family — ATR, and the ADX/+DI/−DI trio a trend-
 * exhaustion study needs — cannot be computed from closes alone. Additive: `barsBatchSince` and
 * every existing caller are untouched.
 * @param symbols - Tickers to fetch.
 * @param startIso - Inclusive start (ISO date or datetime).
 * @param feed - 'iex' (default) or 'sip' (consolidated historical; true volume, end capped 16 min
 * back because the free plan denies the most recent 15 minutes).
 * @param endIso - Optional exclusive-ish end (ISO date or datetime). REQUIRED for windowed
 * back-history over many symbols: without it the fetch runs start→now, and a multi-year window over
 * ~140 names overruns the 20-page (200k-bar) budget, starving whichever symbols paginate last. When
 * omitted, behaviour is unchanged (fetch to now; SIP still capped 16 min back).
 * @returns Map of UPPERCASE symbol → ascending-time dated OHLCV bars (symbols with no bars absent).
 */
export async function barsBatchSinceOhlcv(symbols: string[], startIso: string, feed: 'iex' | 'sip' = 'iex', endIso = ''): Promise<Map<string, DatedOhlcvBar[]>> {
  const out = new Map<string, DatedOhlcvBar[]>();
  if (!symbols.length) return out;
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].join(',');
  // Explicit end wins; else SIP needs the 16-min cap; else no end (fetch to now).
  const sipCap = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  const endVal = endIso || (feed === 'sip' ? sipCap : '');
  const endParam = endVal ? `&end=${encodeURIComponent(endVal)}` : '';
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const tokenParam = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '';
    const j = await adata<{ bars: Record<string, Array<{ o: number; h: number; l: number; c: number; v: number; t: string }>> | null; next_page_token?: string | null }>(
      `/stocks/bars?symbols=${encodeURIComponent(syms)}&timeframe=1Day&start=${encodeURIComponent(startIso)}${endParam}&limit=10000&adjustment=all&feed=${feed}${tokenParam}`);
    for (const [sym, arr] of Object.entries(j.bars || {})) {
      const prev = out.get(sym) || [];
      out.set(sym, prev.concat((arr || []).map((b) => ({ d: String(b.t).slice(0, 10), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) }))));
    }
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
  }
  return out;
}

/** A market news item (Alpaca news API). */
export interface NewsItem { id: number; symbols: string[]; headline: string; summary: string; source: string; url: string; createdAt: string; }

/**
 * @description Recent market news for the given symbols (Alpaca news API, same keys), newest first.
 * @param symbols - Tickers to fetch news for (batched into the query).
 * @param sinceMinutes - Only items created within this many minutes (freshness window).
 * @param limit - Max items.
 * @returns News items (empty on any failure).
 */
export async function recentNews(symbols: string[], sinceMinutes = 30, limit = 50): Promise<NewsItem[]> {
  if (!symbols.length) return [];
  const k = keys();
  if (!k.id || !k.secret) return [];
  const start = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, 50).join(',');
  try {
    // News lives on the v1beta1 base, not /v2 — full URL, same key headers.
    const r = await fetchT(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(syms)}&start=${encodeURIComponent(start)}&limit=${limit}&sort=desc`,
      { headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret } });
    const j = (await r.json().catch(() => ({}))) as { news?: Array<{ id: number; symbols: string[]; headline: string; summary: string; source: string; url: string; created_at: string }> };
    if (!r.ok) return [];
    return (j.news || []).map((n) => ({ id: n.id, symbols: n.symbols || [], headline: n.headline, summary: n.summary || '', source: n.source || '', url: n.url || '', createdAt: n.created_at }));
  } catch { return []; }
}

/**
 * @description True when the US equity market is currently open (Alpaca clock). Best-effort:
 * any error (no keys, network) returns false so the autopilot simply skips the run.
 * @returns Whether regular-hours trading is open right now.
 */
export async function isMarketOpen(): Promise<boolean> {
  const k = keys();
  if (!k.id || !k.secret) return false;
  try {
    const r = await fetchT(`${TRADING_PAPER_BASE}/v2/clock`, {
      headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret },
    });
    const j = (await r.json().catch(() => ({}))) as { is_open?: boolean };
    return Boolean(j.is_open);
  } catch { return false; }
}

/** Which session we're in: closed | pre-market | regular hours | post-market. */
export type Session = 'closed' | 'pre' | 'regular' | 'post';

/** Pre-market opens 04:00 ET; post-market closes 20:00 ET. */
const PRE_OPEN_ET_MIN = 4 * 60;
const POST_CLOSE_ET_MIN = 20 * 60;
let calCache: { date: string; open: number; close: number } | null = null;

function authHeaders(): Record<string, string> { const k = keys(); return { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret }; }
function etMinutesOf(iso: string): number | null { const m = iso.match(/T(\d{2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function hhmmToMin(s: string): number { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); }

/**
 * @description The current trading session. Uses the Alpaca clock (regular) + the calendar for the
 * day (so weekends/holidays are 'closed', not falsely pre/post). Pre = 04:00 ET→open; post = close→20:00 ET.
 * @returns The session, or 'closed' on any error / non-trading day.
 */
async function resolveSession(): Promise<{ session: Session; blind: boolean }> {
  const k = keys();
  if (!k.id || !k.secret) return { session: 'closed', blind: false }; // genuinely unconfigured — a fact, not a guess
  try {
    const r = await fetchT(`${TRADING_PAPER_BASE}/v2/clock`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`clock HTTP ${r.status}`);
    const c = (await r.json()) as { is_open?: boolean; timestamp?: string };
    // A `.json().catch(() => ({}))` here used to swallow a garbage body into a silent 'closed'.
    if (typeof c.is_open !== 'boolean' || !c.timestamp) throw new Error('clock response unusable');
    if (c.is_open) return { session: 'regular', blind: false };
    const ts = String(c.timestamp);
    const nowMin = etMinutesOf(ts);
    const date = ts.slice(0, 10);
    if (nowMin == null || !date) throw new Error('clock timestamp unparseable');
    if (!calCache || calCache.date !== date) {
      const cr = await fetchT(`${TRADING_PAPER_BASE}/v2/calendar?start=${date}&end=${date}`, { headers: authHeaders() });
      // NEVER cache a failure: a transient 502 used to write {open:-1} and poison the WHOLE day
      // (calCache is keyed on date and never retried) — every later fire then read "not a trading day".
      if (!cr.ok) throw new Error(`calendar HTTP ${cr.status}`);
      const cal = (await cr.json()) as Array<{ open: string; close: string }>;
      if (!Array.isArray(cal)) throw new Error('calendar response unusable');
      calCache = cal.length ? { date, open: hhmmToMin(cal[0].open), close: hhmmToMin(cal[0].close) } : { date, open: -1, close: -1 };
    }
    if (calCache.open < 0) return { session: 'closed', blind: false }; // authoritative: not a trading day
    if (nowMin >= PRE_OPEN_ET_MIN && nowMin < calCache.open) return { session: 'pre', blind: false };
    if (nowMin >= calCache.close && nowMin < POST_CLOSE_ET_MIN) return { session: 'post', blind: false };
    return { session: 'closed', blind: false };
  } catch (err) {
    // FAIL CLOSED, BUT LOUD. `blind: true` says "we could not determine the session" — 'closed' here is
    // a stand-down, NOT a fact. The 2026-07-16 incident hid exactly here behind a bare `catch { return
    // 'closed' }`: a DNS outage read as a closed market and the desk went dark for 28 min, silently.
    //
    // We deliberately do NOT guess 'regular' from a local clock. An adversarial review priced that idea
    // and it is worse than the outage: 'regular' is the HIGHEST-permission session — it arms the live
    // book, bypasses the stale-print guard (isTickStale only runs on the pre/post path), sends MARKET
    // orders instead of marketable limits, and zeroes the gap-down guard (a frozen print vs itself = 0%).
    // On an unknown holiday that fires ~78 market orders off a stale print, which Schwab QUEUES into the
    // next session's opening auction. Standing down is correct; being SILENT about it was the bug.
    logger.error({ err }, 'venue clock unreachable - session UNKNOWN, standing down (assuming closed). No entries AND no protective exits until this clears.');
    return { session: 'closed', blind: true };
  }
}

/**
 * @description The current trading session. Uses the Alpaca clock (regular) + the calendar for the
 * day (so weekends/holidays are 'closed', not falsely pre/post). Pre = 04:00 ET→open; post = close→20:00 ET.
 * @returns The session; 'closed' on a non-trading day OR when the venue clock is unreachable (see
 *   tradableSessionDetailed().blind to tell those apart).
 */
export async function tradingSession(): Promise<Session> {
  return (await resolveSession()).session;
}

/**
 * @description The session if trading is allowed right now, else null. Regular always trades;
 * pre/post trade only when TRADING_EXTENDED_HOURS is not 'false' (default on).
 * @returns The tradable session, or null when nothing should trade.
 */
/** Why the engine is standing down. Without this, THREE unrelated causes collapse into one log line. */
export type SessionBlockReason = 'halt' | 'closed' | 'ext-disabled';

/** A tradable-session decision plus WHY — so a caller can log (and a watchdog can judge) the cause. */
export interface TradableSessionResult {
  /** The tradable session, or null when the engine must stand down. */
  session: Session | null;
  /** 'ok' when session is set; otherwise the specific cause. */
  reason: 'ok' | SessionBlockReason;
  /** True when the venue clock was UNREACHABLE — so a 'closed' here is a stand-down, not a fact. */
  blind: boolean;
}

/**
 * @description tradableSession() with the CAUSE attached. This exists because a bare null collapsed
 * three completely different states into the single log line "autopilot skipped — market closed":
 *   (1) TRADING_HALT engaged, (2) a genuinely closed market, (3) extended hours disabled.
 * That ambiguity is load-bearing for safety: the watchdog treats "market closed" as a HEALTHY
 * heartbeat, so both a blind engine (2026-07-16) and an engaged kill-switch during RTH — each of
 * which leaves a funded live book with NO protective exits — read as healthy and never alarmed.
 * Splitting the cause is what makes "market closed" mean only "market closed".
 * @returns The session (or null) plus the reason and whether the clock read was blind.
 */
export async function tradableSessionDetailed(): Promise<TradableSessionResult> {
  // Global kill-switch — TRADING_HALT=true stops ALL trade legs immediately (the panic button).
  // NOTE: this also stops protective EXITS, which is why it must be logged distinctly and loudly.
  if (String(process.env.TRADING_HALT ?? 'false').toLowerCase() === 'true') {
    return { session: null, reason: 'halt', blind: false };
  }
  const { session, blind } = await resolveSession();
  if (session === 'regular') return { session, reason: 'ok', blind };
  if (session === 'pre' || session === 'post') {
    if (String(process.env.TRADING_EXTENDED_HOURS ?? 'true').toLowerCase() !== 'false') return { session, reason: 'ok', blind };
    return { session: null, reason: 'ext-disabled', blind };
  }
  return { session: null, reason: 'closed', blind };
}

/**
 * @description The session if trading is allowed right now, else null. Regular always trades;
 * pre/post trade only when TRADING_EXTENDED_HOURS is not 'false'. Thin wrapper over
 * tradableSessionDetailed — prefer that one where the CAUSE matters (dispatchers, alerting).
 * @returns The tradable session, or null when nothing should trade.
 */
export async function tradableSession(): Promise<Session | null> {
  return (await tradableSessionDetailed()).session;
}

/**
 * @description Latest trade for a symbol (IEX feed) WITH the exchange timestamp that produced it.
 * Why the timestamp matters: IEX carries almost no extended-hours volume, so `trades/latest` keeps
 * returning the last print — which off-hours can be many hours old — with no indication it is stale.
 * Anything that prices an order off this MUST check `asOf` before trusting `price`.
 * @param symbol - Ticker.
 * @returns The last trade price and its exchange timestamp, or null when absent/unparseable.
 */
export async function latestTrade(symbol: string): Promise<TradeTick | null> {
  const j = await adata<{ trade?: { p: number; t: string } }>(`/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`);
  const price = Number(j.trade?.p);
  if (!j.trade || !Number.isFinite(price) || price <= 0) return null;
  const asOf = new Date(String(j.trade.t));
  if (Number.isNaN(asOf.getTime())) return null;
  return { price, asOf };
}

/**
 * @description Latest trade price for a symbol (IEX feed), or null if none. Freshness-blind — see
 * `latestTrade` when the price will set an order's limit.
 * @param symbol - Ticker.
 * @returns The last trade price, or null.
 */
export async function latestPrice(symbol: string): Promise<number | null> {
  return (await latestTrade(symbol))?.price ?? null;
}

/** One tradable instrument from the Alpaca asset directory. */
export interface AssetHit { symbol: string; name: string; exchange: string; kind: 'stock' | 'etf' }
/** Cached asset directory (Alpaca lists ~all active US equities/ETFs; the list changes slowly). */
let assetCache: { at: number; assets: AssetHit[] } | null = null;
const ASSET_TTL_MS = 24 * 3600 * 1000;

/**
 * @description Load (and cache 24h) the Alpaca active, tradable US-equity asset directory: symbol,
 * company/fund name, exchange, and whether it is an ETF. Empty on any failure (never throws).
 * @returns The asset directory (empty when unconfigured / the fetch fails).
 */
export async function assetDirectory(): Promise<AssetHit[]> {
  if (assetCache && Date.now() - assetCache.at < ASSET_TTL_MS) return assetCache.assets;
  const k = keys();
  if (!k.id || !k.secret) return [];
  try {
    const r = await fetchT(`${TRADING_PAPER_BASE}/v2/assets?status=active&asset_class=us_equity`, { headers: authHeaders() }, 15000);
    if (!r.ok) { logger.warn({ status: r.status }, 'asset directory fetch failed'); return assetCache?.assets ?? []; }
    const raw = (await r.json().catch(() => [])) as Array<{ symbol?: string; name?: string; exchange?: string; tradable?: boolean; attributes?: string[] }>;
    const assets = raw.filter((a) => a.symbol && a.tradable !== false).map((a) => ({
      symbol: String(a.symbol).toUpperCase(), name: String(a.name || ''), exchange: String(a.exchange || ''),
      kind: (a.attributes || []).includes('etp') || /\bETF\b|\bFUND\b|\bTRUST\b/i.test(String(a.name || '')) ? 'etf' as const : 'stock' as const,
    }));
    assetCache = { at: Date.now(), assets };
    logger.info({ count: assets.length }, 'asset directory cached');
    return assets;
  } catch (err) { logger.warn({ err }, 'asset directory fetch threw'); return assetCache?.assets ?? []; }
}

/**
 * @description Type-ahead symbol search over the Alpaca asset directory. Exact symbol first, then
 * symbol-prefix, then symbol-substring, then name-substring; shorter symbols rank higher within a tier.
 * @param query - The user's text (ticker fragment or company/fund name).
 * @param limit - Max results (default 20).
 * @returns Ranked matches (empty when the directory is unavailable or the query is too short).
 */
export async function searchSymbols(query: string, limit = 20): Promise<AssetHit[]> {
  const q = String(query || '').trim().toUpperCase();
  if (q.length < 1) return [];
  const all = await assetDirectory();
  const tier = (a: AssetHit): number => {
    if (a.symbol === q) return 0;
    if (a.symbol.startsWith(q)) return 1;
    if (a.symbol.includes(q)) return 2;
    if (a.name.toUpperCase().includes(q)) return 3;
    return 9;
  };
  return all.map((a) => ({ a, t: tier(a) })).filter((x) => x.t < 9)
    .sort((x, y) => x.t - y.t || x.a.symbol.length - y.a.symbol.length || x.a.symbol.localeCompare(y.a.symbol))
    .slice(0, Math.max(1, Math.min(50, limit))).map((x) => x.a);
}
