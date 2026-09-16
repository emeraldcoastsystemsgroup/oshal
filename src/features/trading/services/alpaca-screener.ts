/**
 * Alpaca REST screener (ADR-143 D5) — the WHOLE US-equity movers board from the owned paper key.
 *
 * Two read-only endpoints on the v1beta1 base: `screener/stocks/movers` (gainers + losers, each row
 * carrying the vendor's price and percent change) and `screener/stocks/most-actives` (symbol +
 * volume + trade count, no price). A 30-symbol daily-bar board cannot rank the market; these can,
 * over the same key the rest of the feature already uses — no purchase, no websocket.
 *
 * FAIL-SOFT BY CONTRACT: every failure shape — no key configured, a non-200, a body that is not the
 * documented shape, a timeout or a thrown fetch — returns `null`, never a throw and never a partial
 * board. `null` is the caller's signal to fall back to its own bounded report, so a screener outage
 * degrades the surface instead of blanking it.
 *
 * NEVER FABRICATES: a field the vendor did not send stays null (most-actives rows carry no price, so
 * their `price`/`changePct` are null — they are not back-filled from another source and presented as
 * the screener's). `lastUpdated` is the vendor's own `last_updated` verbatim; nothing here claims a
 * freshness the vendor did not state.
 *
 * The raw board is dominated by sub-$1 warrants and shells, so two stated filters apply: a minimum
 * price (TRADING_MOVERS_MIN_PRICE, default DEFAULT_MOVERS_MIN_PRICE) against the vendor's own price
 * where it sent one, and the active tradable asset directory. The directory filter is SKIPPED when
 * the directory is unavailable — an empty directory must never empty the board.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (ADR-143 D5) — screenerMovers(gainers|losers) and screenerMostActives(volume|trades) over the owned key's REST screener: the vendor's last_updated carried verbatim, rows normalized to the movers row shape with absent fields left null, the minimum-price + asset-directory filters applied and reported, per-endpoint `top` clamps, and a single fail-soft null on every unconfigured/non-200/unusable-body/thrown path so the caller can fall back to its bounded board.
 *
 * @module alpaca-screener
 */

import { createChildLogger } from '@/shared/logger';
import { alpacaAuthHeaders, alpacaFetch, assetDirectory } from './market-data';

const logger = createChildLogger({ module: 'alpaca-screener' });

/** The vendor's own label for this source — printed verbatim on the surface (ADR-143 D5). */
export const SCREENER_LABEL = 'Alpaca screener';
/** Default floor under which a row is warrant/shell noise rather than a tradable mover. */
export const DEFAULT_MOVERS_MIN_PRICE = 5;
/** `top` ceilings the vendor documents per endpoint. */
const MOVERS_TOP_MAX = 50;
const ACTIVES_TOP_MAX = 100;

/** Which screener board was asked for. */
export type ScreenerSide = 'gainers' | 'losers';
/** How most-actives ranks. */
export type ActivesBy = 'volume' | 'trades';

/** One screener row, normalized to the movers row shape. A field the vendor omitted stays null. */
export interface ScreenerRow {
  symbol: string;
  price: number | null;
  changePct: number | null;
  dayVolume: number | null;
  tradeCount: number | null;
}

/** What actually filtered the raw board — stated on the surface, never implied. */
export interface ScreenerFilter {
  /** The price floor applied to rows the vendor priced. */
  minPrice: number;
  /** True when the active tradable asset directory was available and applied. */
  assetDirectory: boolean;
}

/** One screener board: the vendor's rows, its own freshness stamp, and the filters that ran. */
export interface ScreenerBoard {
  rows: ScreenerRow[];
  /** The vendor's `last_updated`, verbatim — null when it sent none. */
  lastUpdated: string | null;
  filter: ScreenerFilter;
}

/**
 * @description The screener base URL. Overridable the way SCHWAB_MARKETDATA_BASE_URL already is, so a
 * guard can drive the real HTTP path against a local stand-in vendor.
 * @returns The base URL with any trailing slashes removed.
 */
function screenerBase(): string {
  return (process.env.ALPACA_SCREENER_BASE_URL || 'https://data.alpaca.markets/v1beta1/screener').replace(/\/+$/, '');
}

/**
 * @description The minimum price a screener row must carry to survive the filter.
 * @returns TRADING_MOVERS_MIN_PRICE when it is a finite number at or above 0, else DEFAULT_MOVERS_MIN_PRICE.
 */
export function moversMinPrice(): number {
  const raw = Number(process.env.TRADING_MOVERS_MIN_PRICE);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MOVERS_MIN_PRICE;
}

/**
 * @description One screener GET — fail-soft on EVERY shape. Unconfigured, non-200, unusable body,
 * timeout and thrown fetch all answer null; nothing here throws at its caller.
 * @param path - The path under the screener base (leading slash included).
 * @returns The parsed object, or null.
 */
async function screenerGet(path: string): Promise<Record<string, unknown> | null> {
  const headers = alpacaAuthHeaders();
  if (!headers) { logger.info({ path }, 'screener skipped — no Alpaca key configured'); return null; }
  try {
    const r = await alpacaFetch(`${screenerBase()}${path}`, { headers });
    if (!r.ok) { logger.warn({ path, status: r.status }, 'screener answered non-200 — falling back to the bounded board'); return null; }
    const body = await r.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) { logger.warn({ path }, 'screener body unusable — falling back to the bounded board'); return null; }
    return body as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, path }, 'screener fetch threw — falling back to the bounded board');
    return null;
  }
}

/** A finite number, or null — never a coerced zero standing in for "the vendor said nothing". */
function num(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * @description Normalize one raw vendor row. A row without a usable symbol is dropped by the caller.
 * @param raw - The vendor row.
 * @returns The normalized row, or null when it carries no symbol.
 */
function rowOf(raw: Record<string, unknown>): ScreenerRow | null {
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  if (!symbol) return null;
  return {
    symbol,
    price: num(raw.price),
    changePct: num(raw.percent_change),
    dayVolume: num(raw.volume),
    tradeCount: num(raw.trade_count),
  };
}

/**
 * @description Apply the two stated filters. A row the vendor did not price survives the price floor
 * (most-actives carries no price); the directory filter is skipped entirely when the directory is
 * unavailable, because an empty directory must never empty the board.
 * @param rows - Normalized rows.
 * @returns The surviving rows and the filter that actually ran.
 */
async function applyFilters(rows: ScreenerRow[]): Promise<{ rows: ScreenerRow[]; filter: ScreenerFilter }> {
  const minPrice = moversMinPrice();
  const directory = await assetDirectory();
  const known = directory.length ? new Set(directory.map((a) => a.symbol)) : null;
  const kept = rows.filter((r) => (r.price === null || r.price >= minPrice) && (!known || known.has(r.symbol)));
  return { rows: kept, filter: { minPrice, assetDirectory: Boolean(known) } };
}

/**
 * @description Build one board from a vendor payload's named array.
 * @param body - The vendor payload.
 * @param key - Which array to read ('gainers', 'losers' or 'most_actives').
 * @returns The board, or null when the payload carries no array under that key.
 */
async function boardFrom(body: Record<string, unknown>, key: string): Promise<ScreenerBoard | null> {
  const raw = body[key];
  if (!Array.isArray(raw)) { logger.warn({ key }, 'screener payload has no rows under the documented key'); return null; }
  const rows = raw.map((x) => (x && typeof x === 'object' ? rowOf(x as Record<string, unknown>) : null))
    .filter((r): r is ScreenerRow => r !== null);
  const { rows: kept, filter } = await applyFilters(rows);
  const lastUpdated = typeof body.last_updated === 'string' && body.last_updated ? body.last_updated : null;
  return { rows: kept, lastUpdated, filter };
}

/**
 * @description Clamp a requested row count into the vendor's documented range.
 * @param top - The requested count.
 * @param max - The endpoint's documented ceiling.
 * @returns The clamped count (at least 1).
 */
function clampTop(top: number, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(Number(top) || 1)));
}

/**
 * @description The whole-market gainers or losers board from the owned key's REST screener.
 * @param side - 'gainers' or 'losers'.
 * @param top - How many rows to ask the vendor for (clamped 1..50, before filtering).
 * @returns The board, or null on any failure — the caller's signal to use its bounded report.
 */
export async function screenerMovers(side: ScreenerSide, top: number): Promise<ScreenerBoard | null> {
  const body = await screenerGet(`/stocks/movers?top=${clampTop(top, MOVERS_TOP_MAX)}`);
  return body ? boardFrom(body, side) : null;
}

/**
 * @description The whole-market most-actives board from the owned key's REST screener. These rows
 * carry no price, so `price`/`changePct` stay null rather than being sourced from somewhere else.
 * @param by - 'volume' or 'trades'.
 * @param top - How many rows to ask the vendor for (clamped 1..100, before filtering).
 * @returns The board, or null on any failure — the caller's signal to use its bounded report.
 */
export async function screenerMostActives(by: ActivesBy, top: number): Promise<ScreenerBoard | null> {
  const body = await screenerGet(`/stocks/most-actives?by=${encodeURIComponent(by)}&top=${clampTop(top, ACTIVES_TOP_MAX)}`);
  return body ? boardFrom(body, 'most_actives') : null;
}
