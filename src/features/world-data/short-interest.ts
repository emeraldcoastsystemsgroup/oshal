/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — FINRA daily short-volume signal (RegSHO) per universe ticker into world_metrics. Crowding / short-pressure feature for the squeeze case.
 */

/**
 * Short-volume signal (FINRA RegSHO daily short-sale volume).
 *
 * FINRA publishes a free daily file of consolidated short-sale volume per symbol. The short-volume ratio
 * (ShortVolume / TotalVolume) is a crowding / short-pressure feature — high + falling price = pressure;
 * high + rising = potential squeeze fuel. Filtered to the trading universe (the file is ~8k symbols; only
 * the tradeable names are actionable). Written to world_metrics: short_vol_ratio, short_volume.
 */

import { createWorldIntelligenceService } from './world-intelligence-service';
import { DEFAULT_UNIVERSE } from '@/features/trading';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'short-interest' });

const FINRA_UA = process.env.WORLD_SHORT_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface ShortInterestResult { day: string | null; tickers: number; }

const ymd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');

/** Fetch the most recent available RegSHO daily file (walk back up to 6 days for weekends/holidays). */
async function fetchLatestRegSho(now: Date): Promise<{ day: string; text: string } | null> {
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const day = ymd(d);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${day}.txt`, { headers: { 'User-Agent': FINRA_UA }, signal: ctrl.signal });
      } finally { clearTimeout(timer); }
      if (res.ok) { const text = await res.text(); if (text.includes('|')) return { day, text }; }
    } catch { /* try the previous day */ }
  }
  return null;
}

/**
 * Pull the latest FINRA RegSHO daily short volume, compute the short-volume ratio per UNIVERSE ticker, and
 * write short_vol_ratio + short_volume to world_metrics. Run on the 6h depth cycle.
 */
export async function collectShortInterest(svcInput?: ReturnType<typeof createWorldIntelligenceService>): Promise<ShortInterestResult> {
  const svc = svcInput ?? createWorldIntelligenceService();
  if (!svc) return { day: null, tickers: 0 };
  const file = await fetchLatestRegSho(new Date());
  if (!file) { logger.warn('no RegSHO file available'); return { day: null, tickers: 0 }; }

  const universe = new Set(DEFAULT_UNIVERSE.map((s) => s.toUpperCase()));
  let tickers = 0;
  for (const line of file.text.split('\n')) {
    // Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
    const c = line.split('|');
    if (c.length < 5) continue;
    const sym = c[1]?.trim().toUpperCase();
    if (!sym || !universe.has(sym)) continue;
    const shortVol = Number(c[2]);
    const totalVol = Number(c[4]);
    if (!Number.isFinite(shortVol) || !Number.isFinite(totalVol) || totalVol <= 0) continue;
    const entity = `world:ticker:${sym.toLowerCase()}`;
    try {
      await svc.writeMetric(entity, 'short_vol_ratio', Number((shortVol / totalVol).toFixed(4)), 'finra-regsho');
      await svc.writeMetric(entity, 'short_volume', shortVol, 'finra-regsho');
      tickers += 1;
    } catch (err) { logger.warn({ err, sym }, 'short metric write failed'); }
  }

  logger.info({ day: file.day, tickers }, 'short interest collected');
  return { day: file.day, tickers };
}
