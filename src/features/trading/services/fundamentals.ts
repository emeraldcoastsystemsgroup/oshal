/**
 * Fundamentals — company financials from SEC EDGAR (keyless), folded into the analyst's view.
 *
 * The research brain reasons over price + headlines + social; this adds the company's actual numbers
 * so a decision weighs fundamentals, not just sentiment. Pulls the latest annual (10-K) revenue and
 * net income from EDGAR's XBRL `companyconcept` API, derives YoY revenue growth + net margin, and
 * returns a short text summary the trading-analyst prompt embeds. Best-effort: any failure → null
 * (the analyst simply proceeds without fundamentals).
 *
 * EDGAR is free and unauthenticated but REQUIRES a descriptive User-Agent (it 403s the default), so
 * every call sets one. The ticker→CIK map is fetched once and cached for the process lifetime.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — EDGAR ticker→CIK map (cached) + latest-annual revenue/net-income via companyconcept, YoY growth + net margin, short summary for the analyst prompt. Keyless, User-Agent set, null on any failure.
 *
 * @module fundamentals
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-fundamentals' });
const UA = 'OSHAL-Trading/1.0 (maintainer@emeraldcoastsystemsgroup.com)';
const REVENUE_CONCEPTS = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'];

/** Structured fundamentals for a symbol. */
export interface Fundamentals {
  symbol: string;
  revenue: number | null;
  revenueYoYPct: number | null;
  netIncome: number | null;
  netMarginPct: number | null;
  fiscalYear: number | null;
  summary: string;
}

let cikByTicker: Map<string, string> | null = null;

async function edgar<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

/** Load + cache the SEC ticker→CIK (zero-padded to 10) map. */
async function loadCikMap(): Promise<Map<string, string>> {
  if (cikByTicker) return cikByTicker;
  const data = await edgar<Record<string, { cik_str: number; ticker: string }>>('https://www.sec.gov/files/company_tickers.json');
  const map = new Map<string, string>();
  if (data) for (const row of Object.values(data)) map.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));
  cikByTicker = map;
  return map;
}

/** The latest two annual (FY/10-K) USD values for a concept, newest first. */
function annualSeries(json: { units?: { USD?: Array<{ val: number; fy?: number; fp?: string; form?: string; end?: string }> } } | null): Array<{ val: number; fy: number }> {
  const rows = json?.units?.USD ?? [];
  const annual = rows.filter((r) => r.form === '10-K' && r.fp === 'FY' && typeof r.val === 'number' && typeof r.fy === 'number');
  const byFy = new Map<number, number>();
  for (const r of annual) byFy.set(r.fy as number, r.val);
  return [...byFy.entries()].map(([fy, val]) => ({ fy, val })).sort((a, b) => b.fy - a.fy).slice(0, 2);
}

/** Fetch the first available revenue concept's annual series for a CIK. */
async function revenueSeries(cik: string): Promise<Array<{ val: number; fy: number }>> {
  for (const concept of REVENUE_CONCEPTS) {
    const json = await edgar<Parameters<typeof annualSeries>[0]>(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`);
    const series = annualSeries(json);
    if (series.length) return series;
  }
  return [];
}

/**
 * @description Latest-annual fundamentals for a symbol from EDGAR (revenue YoY + net margin),
 * with a one-line summary for the analyst prompt. Returns null if the symbol/data isn't found.
 * @param symbol - Ticker.
 * @returns Structured fundamentals + summary, or null.
 */
export async function fundamentalsSummary(symbol: string): Promise<Fundamentals | null> {
  try {
    const cik = (await loadCikMap()).get(symbol.toUpperCase());
    if (!cik) return null;
    const [rev, ni] = await Promise.all([
      revenueSeries(cik),
      edgar<Parameters<typeof annualSeries>[0]>(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/NetIncomeLoss.json`).then(annualSeries),
    ]);
    if (!rev.length) return null;
    const revenue = rev[0].val;
    const fiscalYear = rev[0].fy;
    const revenueYoYPct = rev.length > 1 && rev[1].val ? ((revenue - rev[1].val) / Math.abs(rev[1].val)) * 100 : null;
    const netIncome = ni.length ? ni[0].val : null;
    const netMarginPct = netIncome != null && revenue ? (netIncome / revenue) * 100 : null;
    const b = (n: number): string => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);
    const summary = `FY${fiscalYear}: revenue ${b(revenue)}`
      + (revenueYoYPct != null ? ` (${revenueYoYPct >= 0 ? '+' : ''}${revenueYoYPct.toFixed(1)}% YoY)` : '')
      + (netIncome != null ? `, net income ${b(netIncome)}` : '')
      + (netMarginPct != null ? ` (${netMarginPct.toFixed(1)}% margin)` : '') + '.';
    return { symbol: symbol.toUpperCase(), revenue, revenueYoYPct, netIncome, netMarginPct, fiscalYear, summary };
  } catch (e) {
    logger.warn({ err: e, symbol }, 'fundamentals lookup failed');
    return null;
  }
}
