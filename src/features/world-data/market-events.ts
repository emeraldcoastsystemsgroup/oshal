/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — FORWARD market-events calendar (vs the reactive event_* news tags): scheduled earnings (Nasdaq), FOMC meetings, jobs report. So the trading gate knows what's COMING (don't hold into earnings; expect FOMC/jobs volatility), not just what already broke.
 */

/**
 * Forward market-events collector.
 *
 * The `event_*` classifier tags news AFTER it breaks. This is the other half: the CALENDAR of what's
 * COMING — who reports earnings when, when the FOMC decides, when the jobs number drops. Stored in
 * `world_events` (the dated calendar) plus convenience `days_to_*` metrics in `world_metrics` so the
 * trading gate can read "AAPL earnings in 1 day → stand aside" and the miner can test event-proximity.
 *
 * Sources (free/keyless):
 *  - Earnings: Nasdaq earnings calendar API (per date), filtered to the trading universe. Needs a browser
 *    UA (it 000s the feeds UA) → WORLD_EARNINGS_UA.
 *  - FOMC: the fixed published meeting schedule (WORLD_FOMC_DATES, default = the 2026 decision days).
 *  - Jobs (Employment Situation / NFP): first Friday of the month, 08:30 ET — computed, no source needed.
 */

import { createWorldIntelligenceService } from './world-intelligence-service';
import { DEFAULT_UNIVERSE } from '@/features/trading';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'market-events' });

/** Nasdaq blocks the feeds UA; it serves the calendar JSON to a browser UA. Overridable. */
const NASDAQ_UA = process.env.WORLD_EARNINGS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
/** How many days ahead to scan the earnings calendar (default 14). */
const EARNINGS_LOOKAHEAD = Math.max(1, Number(process.env.WORLD_EARNINGS_DAYS) || 14);
/** FOMC decision dates (2nd meeting day). Default = published 2026 schedule; override via WORLD_FOMC_DATES. */
const FOMC_DATES = (process.env.WORLD_FOMC_DATES
  || '2026-01-28,2026-03-18,2026-04-29,2026-06-17,2026-07-29,2026-09-16,2026-10-28,2026-12-09')
  .split(',').map((s) => s.trim()).filter(Boolean);

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const daysUntil = (dateStr: string, now: Date): number => Math.max(0, Math.ceil((new Date(dateStr).getTime() - now.getTime()) / 86_400_000));

/** The next `n` weekday dates (YYYY-MM-DD), starting today (earnings happen Mon-Fri). */
function nextWeekdays(n: number, now: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** First Friday of (year, month0). */
function firstFriday(year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0, 1));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}

/** The next `count` jobs-report dates (first Friday of this month onward, future only). */
function nextFirstFridays(count: number, now: Date): string[] {
  const out: string[] = [];
  let y = now.getUTCFullYear(); let m = now.getUTCMonth();
  const today = ymd(now);
  for (let k = 0; k < count + 2 && out.length < count; k += 1) {
    const f = firstFriday(y, m);
    if (f >= today) out.push(f);
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

/** Fetch the set of symbols reporting earnings on `date` from the Nasdaq calendar API (browser UA). */
async function fetchNasdaqEarnings(date: string): Promise<Set<string>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {
      headers: { 'User-Agent': NASDAQ_UA, Accept: 'application/json' }, signal: ctrl.signal,
    });
    if (!res.ok) return new Set();
    const j = await res.json() as { data?: { rows?: Array<{ symbol?: string }> | null } };
    const rows = j?.data?.rows;
    if (!Array.isArray(rows)) return new Set();
    return new Set(rows.map((r) => String(r.symbol || '').toUpperCase().trim()).filter(Boolean));
  } catch {
    return new Set();
  } finally {
    clearTimeout(timer);
  }
}

export interface MarketEventsResult { earnings: number; fomc: number; jobs: number; }

/**
 * Collect the forward calendar into world_events + days_to_* metrics. Earnings scanned per weekday over the
 * lookahead window (filtered to the universe); FOMC + jobs from the schedule. Run daily-ish (folded into the
 * 6h depth refresh) — a calendar doesn't change intraday. Each source is isolated (failures don't cascade).
 * @param svcInput - An existing world service, or null to build one (skips quietly if world is disabled).
 */
export async function collectMarketEvents(svcInput?: ReturnType<typeof createWorldIntelligenceService>): Promise<MarketEventsResult> {
  const svc = svcInput ?? createWorldIntelligenceService();
  if (!svc) return { earnings: 0, fomc: 0, jobs: 0 };
  const now = new Date();
  const out: MarketEventsResult = { earnings: 0, fomc: 0, jobs: 0 };

  // 1) EARNINGS — scan each upcoming weekday, keep the EARLIEST date per universe ticker.
  try {
    const universe = new Set(DEFAULT_UNIVERSE.map((s) => s.toUpperCase()));
    const earliest = new Map<string, string>();
    for (const date of nextWeekdays(EARNINGS_LOOKAHEAD, now)) {
      const syms = await fetchNasdaqEarnings(date);
      for (const sym of syms) if (universe.has(sym) && !earliest.has(sym)) earliest.set(sym, date);
    }
    for (const [sym, date] of earliest) {
      const entity = `world:ticker:${sym.toLowerCase()}`;
      await svc.upsertEvent({ entityId: entity, eventType: 'earnings', scheduledAt: `${date}T12:00:00Z`, title: `${sym} earnings`, source: 'nasdaq-calendar' });
      await svc.writeMetric(entity, 'days_to_earnings', daysUntil(date, now), 'market-events');
      out.earnings += 1;
    }
  } catch (e) { logger.warn({ err: e }, 'earnings calendar collect failed'); }

  // 2) FOMC — published decision dates (future only) + days_to_fomc on the macro node.
  try {
    const future = FOMC_DATES.filter((d) => new Date(`${d}T23:59:59Z`).getTime() >= now.getTime()).sort();
    for (const d of future) {
      await svc.upsertEvent({ entityId: 'world:macro:fomc', eventType: 'fomc', scheduledAt: `${d}T18:00:00Z`, title: 'FOMC rate decision', source: 'fomc-schedule' });
      out.fomc += 1;
    }
    if (future[0]) await svc.writeMetric('world:macro:fomc', 'days_to_fomc', daysUntil(future[0], now), 'market-events');
  } catch (e) { logger.warn({ err: e }, 'FOMC calendar collect failed'); }

  // 3) JOBS — Employment Situation, first Friday 08:30 ET (~13:30 UTC).
  try {
    const fridays = nextFirstFridays(3, now);
    for (const d of fridays) {
      await svc.upsertEvent({ entityId: 'world:macro:jobs', eventType: 'jobs', scheduledAt: `${d}T13:30:00Z`, title: 'Employment Situation (jobs report)', source: 'bls-schedule' });
      out.jobs += 1;
    }
    if (fridays[0]) await svc.writeMetric('world:macro:jobs', 'days_to_jobs', daysUntil(fridays[0], now), 'market-events');
  } catch (e) { logger.warn({ err: e }, 'jobs calendar collect failed'); }

  logger.info(out, 'market events collected');
  return out;
}
