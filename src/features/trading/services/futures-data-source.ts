/**
 * Futures data sources — the connector that replaces the friend's Kibot-desktop-app + FlaUI download
 * automation (ADR-116).
 *
 * A `FuturesDataSource` fetches OHLCV bars for a dated contract. Two implementations ship:
 *
 *  - `MockFuturesDataSource` — deterministic synthetic bars over continuous weekday sessions. Lets the
 *    whole pipeline — ingest → completeness → store → paper order — run end-to-end with NO credentials
 *    and NO vendor. A `dropRate` deliberately punches holes so the completeness validator can be
 *    exercised. (The real ~23h-session-with-maintenance-break shape is deferred to the exchange session
 *    calendar — BACKLOG — so mock + expected-count stay internally consistent for now.)
 *
 *  - `KibotFuturesDataSource` — a REAL HTTP client against Kibot's data API (login → history → CSV),
 *    reusing the data entitlement the friend already pays for while deleting the desktop downloader and
 *    its interrupted-download failure mode (bytes are integrity-checked on read). Credential-gated:
 *    without KIBOT_USER/KIBOT_PASSWORD it reports `configured() === false` and refuses to fetch. The
 *    exact endpoint/param spelling must be confirmed against Kibot's API doc before live use — see
 *    BACKLOG "Kibot futures data API credentialing + endpoint verification".
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — FuturesDataSource contract; deterministic MockFuturesDataSource (seeded random walk, weekday sessions, dropRate holes); credential-gated KibotFuturesDataSource (login→history→CSV, timeout-guarded fetch, integrity check on read).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | parseKibotCsv infers the row shape per line (comma/semicolon, slash/compact dates, embedded HHMMSS) instead of trusting the caller's timeframe — the old daily branch column-shifted minute rows into NaN-open fabricated bars when a minute file was fetched at 1Day. File source now refuses (loudly, zero bars) to serve a daily file at an intraday timeframe and always resamples by data granularity.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review hardening: exact column counts with trailing-delimiter tolerance (a stray 7th field could flip a daily row into the intraday map, making volume the close), blank OHLC fields rejected (Number('') is 0 — a fabricated $0 price), calendar-rollover dates rejected, BOM/whitespace tolerated, malformed-row drop counter; file source classifies granularity on the WHOLE file (not the fetch window) and applies the volume floor to AGGREGATED bars after resampling (pre-filtering could shift a bucket's true open/low).
 *
 * @module futures-data-source
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '@/shared/logger';
import type { Timeframe } from './market-data';
import { barMinutes, type FuturesBar, type FuturesContract } from './futures-contract';

const logger = createChildLogger({ module: 'futures-data-source' });

/** A range clamp for a fetch; both bounds optional (default = the contract's active window). */
export interface FetchWindow {
  start?: Date;
  end?: Date;
}

/** The connector contract: fetch OHLCV bars for one dated contract at one timeframe. */
export interface FuturesDataSource {
  /** Short source name for logs/reports, e.g. 'mock' / 'kibot'. */
  readonly name: string;
  /** True when this source can actually fetch (credentials present). */
  configured(): boolean;
  /**
   * @description Fetch bars for a contract.
   * @param contract - The dated contract to fetch.
   * @param timeframe - Bar size.
   * @param window - Optional clamp; defaults to the contract's active window.
   * @returns Bars in ascending time order (may be empty).
   */
  fetchBars(contract: FuturesContract, timeframe: Timeframe, window?: FetchWindow): Promise<FuturesBar[]>;
}

/** FNV-1a hash → 32-bit unsigned seed, so a symbol maps to a stable synthetic price path. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic uniform [0,1) from a 32-bit seed (no Math.random; reproducible). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tuning knobs for the mock source. */
export interface MockSourceOptions {
  /** Starting price (default derived from the symbol seed, ~4000–6000). */
  startPrice?: number;
  /** Per-bar volatility as a fraction (default 0.0015). */
  volatility?: number;
  /** Fraction of session buckets to randomly DROP, simulating an incomplete download (default 0). */
  dropRate?: number;
}

/**
 * Deterministic synthetic bar generator — same inputs always yield the same bars. Weekday sessions
 * only, one maintenance-break hour skipped per day.
 */
export class MockFuturesDataSource implements FuturesDataSource {
  readonly name = 'mock';
  private readonly opts: Required<MockSourceOptions>;

  /**
   * @description Construct a mock source.
   * @param opts - Optional start price / volatility / dropRate.
   */
  constructor(opts: MockSourceOptions = {}) {
    this.opts = {
      startPrice: opts.startPrice ?? 0,
      volatility: opts.volatility ?? 0.0015,
      dropRate: Math.max(0, Math.min(1, opts.dropRate ?? 0)),
    };
  }

  /** Always available — synthetic data needs no credentials. */
  configured(): boolean { return true; }

  /** @inheritdoc */
  async fetchBars(contract: FuturesContract, timeframe: Timeframe, window?: FetchWindow): Promise<FuturesBar[]> {
    const barMs = barMinutes(timeframe) * 60_000;
    const start = Math.max((window?.start ?? contract.activeStart).getTime(), contract.activeStart.getTime());
    const end = Math.min((window?.end ?? contract.activeEnd).getTime(), contract.activeEnd.getTime());
    const rng = mulberry32(hashSeed(contract.symbol + timeframe));
    let price = this.opts.startPrice || 4000 + (hashSeed(contract.root) % 2000);
    const bars: FuturesBar[] = [];
    for (let t = Math.floor(start / barMs) * barMs; t < end; t += barMs) {
      const d = new Date(t);
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const ret = (rng() - 0.5) * 2 * this.opts.volatility;
      const open = price;
      price = Math.max(1, price * (1 + ret));
      if (this.opts.dropRate > 0 && rng() < this.opts.dropRate) continue; // simulate a missing bucket
      bars.push(synthBar(t, open, price, rng));
    }
    logger.debug({ symbol: contract.symbol, timeframe, bars: bars.length }, 'mock bars generated');
    return bars;
  }
}

/** Build one OHLCV bar from an open→close move, with high/low padded by the PRNG. */
function synthBar(t: number, open: number, close: number, rng: () => number): FuturesBar {
  const hi = Math.max(open, close) * (1 + rng() * 0.001);
  const lo = Math.min(open, close) * (1 - rng() * 0.001);
  return {
    t: new Date(t).toISOString(),
    o: round2(open), h: round2(hi), l: round2(lo), c: round2(close),
    v: 100 + Math.floor(rng() * 5000),
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Real Kibot data-API client — login → history → CSV. Credential-gated; drops the desktop downloader.
 */
export class KibotFuturesDataSource implements FuturesDataSource {
  readonly name = 'kibot';
  private readonly base: string;
  private readonly user: string;
  private readonly password: string;

  /**
   * @description Construct the Kibot source from env credentials.
   * KIBOT_USER / KIBOT_PASSWORD, optional KIBOT_API_BASE (default http://api.kibot.com).
   */
  constructor() {
    this.base = (process.env.KIBOT_API_BASE || 'http://api.kibot.com').replace(/\/+$/, '');
    this.user = (process.env.KIBOT_USER || '').trim();
    this.password = (process.env.KIBOT_PASSWORD || '').trim();
  }

  /** True only when both credentials are present. */
  configured(): boolean { return this.user.length > 0 && this.password.length > 0; }

  /** @inheritdoc */
  async fetchBars(contract: FuturesContract, timeframe: Timeframe, window?: FetchWindow): Promise<FuturesBar[]> {
    if (!this.configured()) {
      throw new Error('Kibot source not configured — set KIBOT_USER and KIBOT_PASSWORD (BACKLOG: credentialing).');
    }
    await this.login();
    const start = window?.start ?? contract.activeStart;
    const end = window?.end ?? contract.activeEnd;
    const url = `${this.base}/?${new URLSearchParams({
      action: 'history', symbol: contract.symbol, interval: kibotInterval(timeframe),
      type: 'futures', regularsession: '0',
      startdate: ymd(start), enddate: ymd(end),
    })}`;
    const res = await fetchT(url);
    if (!res.ok) throw new Error(`Kibot history HTTP ${res.status} for ${contract.symbol}`);
    const body = await res.text();
    assertBodyIntegrity(res, body, contract.symbol);
    const bars = parseKibotCsv(body);
    logger.info({ symbol: contract.symbol, timeframe, bars: bars.length }, 'kibot bars fetched');
    return bars;
  }

  /** Establish the Kibot session (the API is login-then-query). Throws on auth failure. */
  private async login(): Promise<void> {
    const url = `${this.base}/?${new URLSearchParams({ action: 'login', user: this.user, password: this.password })}`;
    const res = await fetchT(url);
    const body = (await res.text()).trim();
    if (!res.ok || /error|invalid|denied/i.test(body)) {
      throw new Error(`Kibot login failed (HTTP ${res.status})`);
    }
  }
}

/** Map a timeframe to Kibot's `interval` param. */
function kibotInterval(tf: Timeframe): string {
  switch (tf) {
    case '5Min': return '5';
    case '1Hour': return '60';
    case '1Day': return 'daily';
    default: return 'daily';
  }
}

/** Kibot date param format YYYYMMDD (UTC). */
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Reject a truncated body: if Content-Length was sent, the payload must match it (the interrupted-download guard). */
function assertBodyIntegrity(res: Response, body: string, symbol: string): void {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > 0 && Buffer.byteLength(body, 'utf8') < declared) {
    throw new Error(`Kibot ${symbol}: truncated download (${Buffer.byteLength(body)} of ${declared} bytes)`);
  }
}

/**
 * @description Parse Kibot CSV into bars. The row SHAPE is inferred per line, never assumed from the
 * requested timeframe — Kibot ships at least three formats side by side in one entitlement:
 *   - comma intraday:      `MM/DD/YYYY,HH:MM,O,H,L,C,V`        (ES minute bulk, HTTP API intraday)
 *   - semicolon daily:     `YYYYMMDD;O;H;L;C;V`                (ES/CL daily bulk)
 *   - semicolon intraday:  `YYYYMMDD HHMMSS;O;H;L;C;V`         (CL minute bulk)
 *   - comma daily:         `MM/DD/YYYY,O,H,L,C,V`              (HTTP API daily)
 * Trusting the caller's timeframe to pick the shape is how a minute file requested as `1Day` once
 * column-shifted every row (open ← the time string → NaN, close ← the low, volume ← the close) and
 * fed a whole backtest a fabricated higher-timeframe series. Rows whose OHLC does not parse to
 * finite numbers are dropped, never emitted.
 * @param csv - The CSV body.
 * @returns Ascending bars; unparseable rows are skipped.
 */
export function parseKibotCsv(csv: string): FuturesBar[] {
  const out: FuturesBar[] = [];
  let malformed = 0;
  for (const rawLine of csv.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\d/.test(line)) continue;
    const cols = line.split(line.includes(';') ? ';' : ',');
    // Tolerate trailing delimiters (they add empty tail fields), then demand an EXACT column
    // count. A `>=` here once let a daily row with a stray 7th field flip into the intraday
    // column map — volume became the closing price. Exact-or-reject; never guess.
    while (cols.length > 0 && cols[cols.length - 1].trim() === '') cols.pop();
    let iso = '';
    let base = 0; // index of the Open column
    if (cols.length === 7 && /^\d{1,2}:\d{2}/.test(cols[1].trim())) { iso = kibotIso(cols[0], cols[1]); base = 2; }
    else if (cols.length === 6) { iso = kibotIso(cols[0], ''); base = 1; }
    else { malformed++; continue; }
    if (!iso) { malformed++; continue; }
    const o = strictNumber(cols[base]); const h = strictNumber(cols[base + 1]);
    const l = strictNumber(cols[base + 2]); const c = strictNumber(cols[base + 3]);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) { malformed++; continue; }
    out.push({ t: iso, o, h, l, c, v: Number(cols[base + 4]) || 0 });
  }
  if (malformed > 0) {
    logger.warn({ malformed, parsed: out.length }, 'parseKibotCsv: dropped malformed data rows — check the source file if this is more than noise');
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/** Number() that rejects blank fields: `Number('')` is 0, and a fabricated $0 price must never parse. */
function strictNumber(s: string): number {
  const t = s.trim();
  return t === '' ? Number.NaN : Number(t);
}

/**
 * Convert a Kibot date field (+ optional separate time field) to an ISO string; '' if invalid.
 * Accepts `MM/DD/YYYY` (time from the second field, or midnight when absent), `YYYYMMDD HHMMSS`
 * (compact datetime in ONE field), and bare `YYYYMMDD`. Kibot stamps are exchange-local wall time;
 * they are carried in the UTC fields verbatim (see the timestamp-convention note in
 * docs/apps/trading/futures-backtester.md).
 */
function kibotIso(date: string, time: string): string {
  let y = 0; let mo = 0; let d = 0; let hh = 0; let mm = 0;
  const slash = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const compact = date.match(/^(\d{4})(\d{2})(\d{2})(?:\s+(\d{2})(\d{2})(\d{2}))?$/);
  if (slash) {
    const tm = time ? time.match(/^(\d{1,2}):(\d{2})/) : null;
    if (time && !tm) return '';
    y = +slash[3]; mo = +slash[1]; d = +slash[2];
    if (tm) { hh = +tm[1]; mm = +tm[2]; }
  } else if (compact) {
    y = +compact[1]; mo = +compact[2]; d = +compact[3];
    hh = compact[4] ? +compact[4] : 0; mm = compact[5] ? +compact[5] : 0;
  } else {
    return '';
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mm));
  // Date.UTC silently rolls impossible calendar dates (Feb 30 → Mar 2) into plausible-but-wrong
  // stamps; a corrupted date field must drop the row, not relocate it.
  if (dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) return '';
  return dt.toISOString();
}

/** `fetch` with an AbortController timeout (default 15s; KIBOT_FETCH_TIMEOUT_MS overrides). */
async function fetchT(url: string, ms = Number(process.env.KIBOT_FETCH_TIMEOUT_MS) || 15000): Promise<Response> {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal }); } finally { clearTimeout(timer); }
}

/**
 * @description Aggregates fine-grained bars into a coarser timeframe by bucketing on wall-clock
 * boundaries (open = first bar's open, high/low = extremes, close = last bar's close, volume =
 * sum). Kibot ships minute files, so every intraday backtest above 1-minute needs this. Buckets
 * are aligned to the epoch, matching how NT stamps its own bar boundaries.
 * @param bars - Ascending bars finer than or equal to the target timeframe.
 * @param target - Desired timeframe.
 * @returns Aggregated ascending bars (input returned as-is when it is already coarse enough).
 */
export function resampleBars(bars: FuturesBar[], target: Timeframe): FuturesBar[] {
  const ms = barMinutes(target) * 60_000;
  if (!bars.length || ms <= 0) return bars;
  const out: FuturesBar[] = [];
  let cur: FuturesBar | null = null;
  let bucket = Number.NaN;
  for (const b of bars) {
    const k = Math.floor(Date.parse(b.t) / ms);
    if (k !== bucket) {
      if (cur) out.push(cur);
      bucket = k;
      cur = { t: new Date(k * ms).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else if (cur) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Options for {@link KibotFileDataSource}. */
export interface KibotFileOptions {
  /** Directory holding per-contract files named `<SYMBOL>.txt` (e.g. `ESZ25.txt`). */
  dir: string;
  /**
   * Restrict every contract's bars to its FRONT-MONTH window (default true, and you want it).
   * Kibot per-contract files span the contract's whole listed life, most of which it spent as an
   * illiquid back month — ESZ25 averages 1–3 contracts per bar before September 2025 and 600–1200
   * after. Reading a file whole splices that noise into the series and any result computed from it
   * is meaningless; this clamp is what makes a stitched series honest.
   */
  frontMonthOnly?: boolean;
  /** Drop bars whose volume is below this (a second liquidity guard). Default 0 = keep all. */
  minVolume?: number;
}

/**
 * A {@link FuturesDataSource} backed by a local directory of Kibot per-contract text files —
 * the shape their bulk downloads arrive in (`ESZ25.txt`, `CLF19.txt`, …).
 *
 * This is the offline sibling of {@link KibotFuturesDataSource}: same parser, no credentials, no
 * network, and it clamps each contract to its front-month window by default (see
 * {@link KibotFileOptions.frontMonthOnly} for why that is not optional in practice).
 */
export class KibotFileDataSource implements FuturesDataSource {
  readonly name = 'kibot-file';
  private readonly opts: Required<KibotFileOptions>;

  /**
   * @description Construct a file-backed Kibot source.
   * @param opts - Directory plus the front-month and volume guards.
   */
  constructor(opts: KibotFileOptions) {
    this.opts = {
      dir: opts.dir,
      frontMonthOnly: opts.frontMonthOnly ?? true,
      minVolume: Math.max(0, opts.minVolume ?? 0),
    };
  }

  /**
   * @description Whether the configured directory exists and is readable.
   * @returns True when bars can be served.
   */
  configured(): boolean {
    try {
      return statSync(this.opts.dir).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * @description Read one contract's bars from disk, clamped and resampled.
   * @param contract - The dated contract; its symbol names the file and its active window clamps it.
   * @param timeframe - Target bar size; minute files are aggregated up to it.
   * @param window - Optional additional clamp intersected with the contract's own window.
   * @returns Ascending bars, empty when the file is absent.
   */
  async fetchBars(contract: FuturesContract, timeframe: Timeframe, window?: FetchWindow): Promise<FuturesBar[]> {
    const file = join(this.opts.dir, `${contract.symbol}.txt`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      logger.debug({ symbol: contract.symbol, file }, 'kibot-file: no file for contract');
      return [];
    }
    const from = Math.max(
      window?.start?.getTime() ?? -Infinity,
      this.opts.frontMonthOnly ? contract.activeStart.getTime() : -Infinity,
    );
    const to = Math.min(
      window?.end?.getTime() ?? Infinity,
      this.opts.frontMonthOnly ? contract.activeEnd.getTime() : Infinity,
    );
    const all = parseKibotCsv(raw);
    // The file's granularity comes from the data, not the request — and it is classified on the
    // WHOLE file, not the fetch window: a legitimate intraday bar stamped exactly 00:00 that
    // happens to be alone in a narrow window must not reclassify the file as daily. A daily file
    // asked for intraday bars CANNOT be upsampled — refuse loudly with zero bars rather than
    // serving daily rows dressed as intraday ones. Everything else (minute → 5Min/1Hour/1Day/…)
    // aggregates up; resampling a daily file to 1Day is the identity.
    const wantIntraday = timeframe !== '1Day' && timeframe !== '1Week';
    if (wantIntraday && all.length && all.every((b) => b.t.endsWith('T00:00:00.000Z'))) {
      logger.warn({ symbol: contract.symbol, timeframe, file }, 'kibot-file: daily file cannot serve an intraday timeframe — returning no bars');
      return [];
    }
    const windowed = all.filter((b) => { const t = Date.parse(b.t); return t >= from && t < to; });
    // The volume floor applies to the AGGREGATED bar, after resampling: filtering raw minute rows
    // first lets a zero-volume quote print at a bucket boundary vanish and silently shift the
    // bucket's true Open/Low. Zero-volume prints keep shaping OHLC; only a bucket whose total
    // volume is below the floor is dropped.
    const bars = resampleBars(windowed, timeframe).filter((b) => b.v >= this.opts.minVolume);
    logger.debug({ symbol: contract.symbol, timeframe, bars: bars.length }, 'kibot-file: served');
    return bars;
  }
}
