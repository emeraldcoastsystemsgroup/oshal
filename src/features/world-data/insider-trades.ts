/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — corporate insider (SEC Form 4) trade signal via openinsider, aggregated per ticker into world_metrics. The strongest informed-money tell: officers/directors trading their OWN company.
 */

/**
 * Insider (SEC Form 4) trade signal.
 *
 * Officers/directors must disclose trades in their OWN company within ~2 business days — the timeliest,
 * strongest free "informed money" tell (insiders rarely BUY except when confident). Quiver's insider
 * endpoint needs a key; SEC's getcurrent atom is sparse + directionless. openinsider.com aggregates the
 * directional data (free), so we read its purchase + sale pages and classify each row by its trade-type
 * marker. Aggregated per ticker into world_metrics (the miner auto-discovers):
 *   insider_buys / insider_sells (counts), insider_net (buys−sells),
 *   insider_sentiment ((buys−sells)/total, [-1,1]).
 */

import { createWorldIntelligenceService } from './world-intelligence-service';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'insider-trades' });

const INSIDER_UA = process.env.WORLD_INSIDER_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/** openinsider pages to read (purchases + sales, ≥$25k). Override via WORLD_INSIDER_URLS (comma-sep). */
const INSIDER_URLS = (process.env.WORLD_INSIDER_URLS
  || 'http://openinsider.com/latest-insider-purchases-25k,http://openinsider.com/latest-insider-sales-25k')
  .split(',').map((s) => s.trim()).filter(Boolean);

export interface InsiderTradesResult { tickers: number; trades: number; }

/** Parse an openinsider HTML table: per data row (has a `- Purchase`/`- Sale` marker), the first /TICKER link. */
function parseRows(html: string, agg: Map<string, { buys: number; sells: number }>): number {
  let n = 0;
  for (const row of html.split(/<tr[\s>]/i)) {
    const isBuy = /-\s*Purchase/i.test(row);
    const isSell = /-\s*Sale/i.test(row);
    if (!isBuy && !isSell) continue;
    const m = row.match(/href="\/([A-Z]{1,6})"/);
    if (!m) continue;
    const sym = m[1];
    const e = agg.get(sym) || { buys: 0, sells: 0 };
    if (isBuy) e.buys += 1; else e.sells += 1;
    agg.set(sym, e);
    n += 1;
  }
  return n;
}

/**
 * Fetch openinsider purchase + sale pages, aggregate per ticker, write insider_* metrics. Network/parse
 * failures are swallowed (returns what it got). Run on the 6h depth cycle; each page isolated.
 */
export async function collectInsiderTrades(svcInput?: ReturnType<typeof createWorldIntelligenceService>): Promise<InsiderTradesResult> {
  const svc = svcInput ?? createWorldIntelligenceService();
  if (!svc) return { tickers: 0, trades: 0 };
  const agg = new Map<string, { buys: number; sells: number }>();
  let trades = 0;

  for (const url of INSIDER_URLS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let html: string;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': INSIDER_UA }, signal: ctrl.signal });
        if (!res.ok) { logger.warn({ url, status: res.status }, 'insider page fetch failed'); continue; }
        html = await res.text();
      } finally { clearTimeout(timer); }
      trades += parseRows(html, agg);
    } catch (e) { logger.warn({ err: e, url }, 'insider page error'); }
  }

  for (const [sym, e] of agg) {
    const entity = `world:ticker:${sym.toLowerCase()}`;
    const total = e.buys + e.sells;
    try {
      await svc.writeMetric(entity, 'insider_buys', e.buys, 'openinsider');
      await svc.writeMetric(entity, 'insider_sells', e.sells, 'openinsider');
      await svc.writeMetric(entity, 'insider_net', e.buys - e.sells, 'openinsider');
      if (total) await svc.writeMetric(entity, 'insider_sentiment', Number(((e.buys - e.sells) / total).toFixed(3)), 'openinsider');
    } catch (err) { logger.warn({ err, sym }, 'insider metric write failed'); }
  }

  logger.info({ tickers: agg.size, trades }, 'insider trades collected');
  return { tickers: agg.size, trades };
}
