/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — federal contract-award signal (USAspending) per universe company into world_metrics. "Trade the names getting free money from the gov." First gov-contracting contributor to World Knowledge.
 */

/**
 * Government contract-award signal (USAspending.gov — free, keyless).
 *
 * Federal award dollars = revenue visibility the market often prices slowly. We total recent contract
 * awards per universe company and write per-ticker metrics (the miner auto-discovers):
 *   gov_award_notional (summed obligated $), gov_award_count.
 *
 * This is the first gov-contracting contributor to the shared World Knowledge layer; the gov-contracting
 * CRM will push its richer capture/pipeline data through the same world-knowledge inbound.
 */

import { createWorldIntelligenceService } from './world-intelligence-service';
import { DEFAULT_UNIVERSE } from '@/features/trading';
import { tickerName } from './ticker-names';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'gov-contracts' });

const USA_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
/** Lookback window (days) over award action dates (default 180). */
const GOV_DAYS = Math.max(30, Number(process.env.WORLD_GOV_DAYS) || 180);

export interface GovContractsResult { tickers: number; totalNotional: number; }

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Total federal contract awards for one recipient name over the window. */
async function awardsFor(name: string, start: string, end: string): Promise<{ notional: number; count: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(USA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        filters: { time_period: [{ start_date: start, end_date: end }], award_type_codes: ['A', 'B', 'C', 'D'], recipient_search_text: [name] },
        fields: ['Award ID', 'Recipient Name', 'Award Amount'], limit: 100, page: 1,
      }),
    });
    if (!res.ok) return { notional: 0, count: 0 };
    const j = await res.json() as { results?: Array<{ 'Award Amount'?: number }> };
    const rows = Array.isArray(j.results) ? j.results : [];
    return { notional: rows.reduce((s, r) => s + (Number(r['Award Amount']) || 0), 0), count: rows.length };
  } catch {
    return { notional: 0, count: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull federal contract awards per universe company and write gov_award_* metrics. One USAspending call
 * per company (bounded, isolated); run on the 6h depth cycle. Companies with no awards are skipped.
 */
export async function collectGovContracts(svcInput?: ReturnType<typeof createWorldIntelligenceService>): Promise<GovContractsResult> {
  const svc = svcInput ?? createWorldIntelligenceService();
  if (!svc) return { tickers: 0, totalNotional: 0 };
  const now = new Date();
  const start = ymd(new Date(now.getTime() - GOV_DAYS * 86_400_000));
  const end = ymd(now);

  let tickers = 0; let totalNotional = 0;
  for (const sym of DEFAULT_UNIVERSE) {
    const name = tickerName(sym);
    const a = await awardsFor(name, start, end);
    if (a.count === 0) continue;
    const entity = `world:ticker:${sym.toLowerCase()}`;
    try {
      await svc.writeMetric(entity, 'gov_award_notional', a.notional, 'usaspending');
      await svc.writeMetric(entity, 'gov_award_count', a.count, 'usaspending');
      tickers += 1; totalNotional += a.notional;
    } catch (err) { logger.warn({ err, sym }, 'gov award metric write failed'); }
  }
  logger.info({ tickers, totalNotional: Math.round(totalNotional) }, 'gov contracts collected');
  return { tickers, totalNotional };
}
