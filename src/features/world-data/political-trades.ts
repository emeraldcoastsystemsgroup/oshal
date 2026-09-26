/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — congressional ("political") trade signal: STOCK Act disclosures aggregated per ticker into world_metrics. "Trade the things getting free money from the gov." Gov-contracting award data is a future sibling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve transaction dates by aggregating per ticker/day and writing dated metric points, so downstream watchlists can show the feed-backed disclosure date instead of the collector's observation time.
 */

/**
 * Political (congressional) trade signal.
 *
 * STOCK Act disclosures: members of Congress must report their stock trades. It's an "informed money"
 * signal — distinctive, free, and (per the operator) a tell for names benefiting from government money.
 * Caveat: ~45-day disclosure lag, so it's a slow POSITIONING signal, not a fast catalyst.
 *
 * Source: Quiver Quantitative's live congress-trading endpoint (keyless, browser UA). We aggregate recent
 * trades per ticker into world_metrics (the miner auto-discovers them):
 *   congress_buys / congress_sells (counts), congress_net (buys−sells),
 *   congress_sentiment ((buys−sells)/total, [-1,1]), congress_notional (summed lower-bound $).
 *
 * Future sibling (operator): wire gov-contracting award data (USAspending/SAM.gov) for "who's getting
 * federal contracts" — the same idea from the spending side.
 */

import { createWorldIntelligenceService } from './world-intelligence-service';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'political-trades' });

const CONGRESS_URL = process.env.WORLD_POLITICAL_URL || 'https://api.quiverquant.com/beta/live/congresstrading';
/** Quiver serves this to a browser UA. Override via WORLD_POLITICAL_UA. */
const POLITICAL_UA = process.env.WORLD_POLITICAL_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/** Lookback window (days) over the disclosed TransactionDate (default 90 — covers the ~45d lag + a tail). */
const POLITICAL_DAYS = Math.max(7, Number(process.env.WORLD_POLITICAL_DAYS) || 90);

export interface CongressTrade { Ticker?: string; Transaction?: string; ReportDate?: string; TransactionDate?: string; Amount?: string | number; }

export interface PoliticalTradeObservation {
  ticker: string;
  transactionDate: string;
  buys: number;
  sells: number;
  notional: number;
}

export interface PoliticalTradesResult { tickers: number; trades: number; }

/**
 * @description Normalize the feed into dated ticker observations before any persistence. The
 * transaction date is deliberately reduced to a UTC calendar day: the feed's timestamp may carry
 * a timezone, but the watchlist needs the disclosure day that a human can verify from the source.
 * @param raw - Untrusted feed rows.
 * @param now - Clock used for deterministic lookback/future filtering.
 * @param lookbackDays - Inclusive lookback window in days.
 * @returns Sorted per-ticker/per-day aggregates and the number of accepted trades.
 */
export function aggregatePoliticalTrades(
  raw: CongressTrade[], now = new Date(), lookbackDays = POLITICAL_DAYS,
): { observations: PoliticalTradeObservation[]; trades: number } {
  const cutoff = new Date(now.getTime() - Math.max(1, lookbackDays) * 86_400_000);
  const agg = new Map<string, PoliticalTradeObservation>();
  let trades = 0;
  for (const t of raw) {
    const sym = String(t?.Ticker || '').toUpperCase().trim();
    if (!sym || !/^[A-Z][A-Z.]{0,5}$/.test(sym)) continue;
    const dateStr = t?.TransactionDate || t?.ReportDate;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime()) || d < cutoff || d > now) continue;
    const tx = String(t?.Transaction || '').toLowerCase();
    const isBuy = tx.includes('purchase');
    const isSell = tx.includes('sale') || tx.includes('sold');
    if (!isBuy && !isSell) continue;
    const sourceDate = /^\d{4}-\d{2}-\d{2}/.exec(String(dateStr))?.[0] || d.toISOString().slice(0, 10);
    const transactionDate = `${sourceDate}T00:00:00.000Z`;
    const key = `${sym}\0${transactionDate}`;
    const e = agg.get(key) || { ticker: sym, transactionDate, buys: 0, sells: 0, notional: 0 };
    if (isBuy) e.buys += 1; else e.sells += 1;
    e.notional += Number(String(t?.Amount ?? '').replace(/[,$]/g, '')) || 0;
    agg.set(key, e);
    trades += 1;
  }
  return { observations: [...agg.values()].sort((a, b) => a.ticker.localeCompare(b.ticker) || a.transactionDate.localeCompare(b.transactionDate)), trades };
}

/**
 * Fetch + aggregate recent congressional trades per ticker into world_metrics. Network/parse failures are
 * swallowed (returns zeros) so it never breaks the refresh. Run on the 6h depth cycle.
 * @param svcInput - Existing world service or null to build one (skips quietly when world is disabled).
 */
export async function collectPoliticalTrades(svcInput?: ReturnType<typeof createWorldIntelligenceService>): Promise<PoliticalTradesResult> {
  const svc = svcInput ?? createWorldIntelligenceService();
  if (!svc) return { tickers: 0, trades: 0 };
  const now = new Date();

  let raw: CongressTrade[];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(CONGRESS_URL, { headers: { 'User-Agent': POLITICAL_UA, Accept: 'application/json' }, signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) { logger.warn({ status: res.status }, 'congress trades fetch failed'); return { tickers: 0, trades: 0 }; }
    raw = await res.json() as CongressTrade[];
  } catch (e) { logger.warn({ err: e }, 'congress trades fetch error'); return { tickers: 0, trades: 0 }; }
  if (!Array.isArray(raw)) return { tickers: 0, trades: 0 };

  const { observations, trades } = aggregatePoliticalTrades(raw, now);

  for (const e of observations) {
    const entity = `world:ticker:${e.ticker.toLowerCase()}`;
    const total = e.buys + e.sells;
    try {
      await svc.writeMetric(entity, 'congress_buys', e.buys, 'quiver-congress', e.transactionDate);
      await svc.writeMetric(entity, 'congress_sells', e.sells, 'quiver-congress', e.transactionDate);
      await svc.writeMetric(entity, 'congress_net', e.buys - e.sells, 'quiver-congress', e.transactionDate);
      if (total) await svc.writeMetric(entity, 'congress_sentiment', Number(((e.buys - e.sells) / total).toFixed(3)), 'quiver-congress', e.transactionDate);
      await svc.writeMetric(entity, 'congress_notional', e.notional, 'quiver-congress', e.transactionDate);
    } catch (err) { logger.warn({ err, sym: e.ticker, transactionDate: e.transactionDate }, 'congress metric write failed'); }
  }

  logger.info({ tickers: new Set(observations.map((e) => e.ticker)).size, trades, observations: observations.length }, 'political trades collected');
  return { tickers: new Set(observations.map((e) => e.ticker)).size, trades };
}
