/**
 * Pop MISS AUDIT — "what are we missing": every big intraday surge in the recent tape, joined
 * against what the world-intelligence layer knew BEFORE the move.
 *
 * Operator directive 2026-07-10: the price-only pop-catcher was rejected (no discrimination);
 * The operator spots pops from the NEWS. This audit inverts the question — instead of testing a
 * signal, it finds the moves a good detector SHOULD have caught (30-min surges ≥ SURGE_PCT in
 * the 5-min tape) and asks, for each: was there a news burst before it (item count vs the name's
 * own baseline), how early was the closest headline, and would the price-only pop rule have
 * fired? Output = the miss table + the news-led catch rate, i.e. the evidence base for the
 * EVENT-pop detector design (BACKLOG) and its news-magnitude/proximity sizing.
 *
 * Inputs: POP_BARS_CACHE (the 5-min tape cache from oshal-trading-pop-backtest.ts) and the
 * world TSDB (world_items). TSDB_HOST_URL overrides the default local port-map.
 *
 * Usage: POP_BARS_CACHE=<path> npx ts-node -r tsconfig-paths/register --transpile-only \
 *          scripts/oshal-trading-pop-miss-audit.ts [surgePct] [topN]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — surge extraction from the 5-min cache, world_items news join (pre-move burst ratio, closest-headline lag), price-only pop check at event time, news-led catch-rate summary + RESULT json.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { Pool } from 'pg';
import { type Timeframe } from '@/features/trading';
import { decideSymbol, isShortTermPop } from '../src/features/trading/services/multi-timeframe';

const SURGE_PCT = Number(process.argv[2] || 2.5);   // 30-min (6-bar) rolling gain that counts as a surge
const TOP_N = Number(process.argv[3] || 25);
const TSDB = process.env.TSDB_HOST_URL || 'postgresql://oshal:oshal@127.0.0.1:55434/oshal_ts';

interface Bar { t: number; o: number; c: number; }
type BarMap = Record<string, Bar[]>;
const isRth = (ms: number): boolean => { const m = new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(); return m >= 810 && m < 1200; };
const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);
const et = (ms: number): string => new Date(ms - 4 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' ET';

interface Surge { sym: string; t: number; movePct: number; dayPct: number; }

/**
 * Find the biggest 30-min surges (one per symbol per day — the largest).
 *
 * ⚠️ FIXED 2026-07-12 — this function was the source of a data defect that invalidates the
 * conclusions of the 2026-07-10 pop-miss audit. It filtered to RTH and then compared bars by
 * ARRAY INDEX (`bars[i]` vs `bars[i-6]`). The RTH filter deletes the overnight bars, so adjacent
 * array slots straddle a session boundary and an OVERNIGHT GAP is reported as a 30-minute intraday
 * surge. Proven on MU: the "+8.27%/30min surge" was an 18-hour gap (07-08 15:50 ET $948.59 →
 * 07-09 09:50 ET $1025.31). It is why every audited "surge" clustered at 15:35-15:55 ET — those are
 * the last bars of a session. Same bug class as the resample() time-reversal (cad41dc5).
 *
 * Now: group by SESSION first, and require the window to be contiguous in wall-clock time.
 */
function findSurges(five: BarMap, symbols: string[]): Surge[] {
  const out: Surge[] = [];
  for (const sym of symbols) {
    const rth = (five[sym] || []).filter((b) => isRth(b.t));
    const sessions = new Map<string, Bar[]>();
    for (const b of rth) {
      const day = new Date(b.t).toISOString().slice(0, 10);
      (sessions.get(day) ?? sessions.set(day, []).get(day)!).push(b);
    }
    for (const [, day] of sessions) {
      if (day.length < 8) continue;
      const dayPct = (day[day.length - 1].c / day[0].o - 1) * 100;
      let best: Surge | null = null;
      for (let i = 6; i < day.length; i++) {
        if ((day[i].t - day[i - 6].t) / 60000 > 35) continue;   // contiguity guard — no gaps
        const move = (day[i].c / day[i - 6].c - 1) * 100;
        if (move < SURGE_PCT) continue;
        if (!best || move > best.movePct) {
          best = { sym, t: day[i - 6].t, movePct: Number(move.toFixed(2)), dayPct: Number(dayPct.toFixed(2)) };
        }
      }
      if (best) out.push(best);
    }
  }
  return out.sort((a, b) => b.movePct - a.movePct).slice(0, TOP_N);
}

/** @description Join each surge against the pre-move news record and the price-only pop rule. */
async function main(): Promise<void> {
  const cachePath = process.env.POP_BARS_CACHE || '';
  if (!cachePath || !fs.existsSync(cachePath)) { console.error('FAIL: POP_BARS_CACHE not set/found'); process.exit(1); }
  const { five, hour, day } = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { five: BarMap; hour: BarMap; day: BarMap };
  const symbols = Object.keys(five).filter((s) => s !== 'SPY');
  const surges = findSurges(five, symbols);
  console.log(`Surges ≥ +${SURGE_PCT}%/30min: auditing top ${surges.length}.\n`);

  const pool = new Pool({ connectionString: TSDB, max: 2 });
  const rows: Array<Record<string, unknown>> = [];
  let newsLed = 0, popCaught34 = 0, popCaught80 = 0, noWarning = 0;

  for (const s of surges) {
    const entity = `world:ticker:${s.sym.toLowerCase()}`;
    const t0 = new Date(s.t);
    // News burst: items in the 24h before the move vs the name's average 24h volume over the prior 5 days.
    const q = await pool.query(
      `SELECT
         count(*) FILTER (WHERE pub_date >= $2::timestamptz - interval '24 hours' AND pub_date < $2) AS pre24,
         count(*) FILTER (WHERE pub_date >= $2::timestamptz - interval '6 days' AND pub_date < $2::timestamptz - interval '24 hours') / 5.0 AS base24,
         avg(sentiment) FILTER (WHERE pub_date >= $2::timestamptz - interval '24 hours' AND pub_date < $2) AS preSent
       FROM world_items WHERE entity_id = $1`, [entity, t0.toISOString()]);
    const pre24 = Number(q.rows[0].pre24) || 0;
    const base24 = Math.max(0.2, Number(q.rows[0].base24) || 0);
    const ratio = Number((pre24 / base24).toFixed(2));
    const h = await pool.query(
      `SELECT title, outlet, pub_date FROM world_items
        WHERE entity_id = $1 AND pub_date < $2 AND pub_date >= $2::timestamptz - interval '24 hours'
        ORDER BY pub_date DESC LIMIT 1`, [entity, t0.toISOString()]);
    const headline = h.rows[0] ? String(h.rows[0].title).slice(0, 90) : null;
    const lagMin = h.rows[0] ? Math.round((s.t - new Date(h.rows[0].pub_date).getTime()) / 60000) : null;

    // Price-only pop rule at the event start (as-of series, both thresholds).
    const asOf5 = (five[s.sym] || []).filter((b) => isRth(b.t) && b.t <= s.t).slice(-220).map((b) => b.c);
    const asOfH = (hour[s.sym] || []).filter((b) => b.t <= s.t).slice(-200).map((b) => b.c);
    const dayAll = (day[s.sym] || []).filter((b) => b.t < s.t - 16 * 3600 * 1000).map((b) => b.c);
    const tf = new Map<Timeframe, number[]>([
      ['5Min', asOf5], ['1Hour', asOfH], ['1Day', dayAll.slice(-220)],
      ['1Week', resample(dayAll, 5).slice(-60)], ['3Month', resample(dayAll, 63).slice(-40)],
    ]);
    const d = decideSymbol(s.sym, tf);
    const pop34 = d.score > 0 && isShortTermPop(d, 0.34);
    const pop80 = d.score > 0 && isShortTermPop(d, 0.8);

    const newsBurst = ratio >= 2 && pre24 >= 3;
    if (newsBurst) newsLed++;
    if (pop34) popCaught34++;
    if (pop80) popCaught80++;
    if (!newsBurst && !pop34) noWarning++;
    rows.push({ sym: s.sym, at: et(s.t), movePct: s.movePct, dayPct: s.dayPct, newsPre24: pre24, newsBase24: Number(base24.toFixed(1)), newsRatio: ratio, newsBurst, headline, headlineLagMin: lagMin, pop34, pop80 });
  }
  await pool.end();

  for (const r of rows) {
    console.log(`${String(r.sym).padEnd(6)} ${r.at}  +${r.movePct}%/30m (day ${r.dayPct}%)  news24h ${r.newsPre24} (x${r.newsRatio} base)${r.newsBurst ? ' BURST' : ''}  pop@.34:${r.pop34 ? 'Y' : 'n'} @.8:${r.pop80 ? 'Y' : 'n'}`);
    if (r.headline) console.log(`       ↳ ${r.headlineLagMin}min before: "${r.headline}"`);
  }
  console.log('───────────────────────────────────────────────');
  console.log(` Surges audited      : ${rows.length}`);
  console.log(` News-burst led      : ${newsLed}  (${Math.round((newsLed / rows.length) * 100)}% — the news gate would have admitted these)`);
  console.log(` Price pop@0.34 fired: ${popCaught34}   @0.8: ${popCaught80}`);
  console.log(` NO warning at all   : ${noWarning}`);
  console.log(`RESULT ${JSON.stringify({ surgePct: SURGE_PCT, audited: rows.length, newsLed, popCaught34, popCaught80, noWarning, rows })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('audit failed:', e); process.exit(1); });
