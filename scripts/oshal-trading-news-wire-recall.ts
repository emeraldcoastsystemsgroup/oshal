/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | THE GATE for the LLM-news-reader build (BACKLOG "Trading: LLM news reader"). Measures the RECALL CEILING before anyone writes a reader: for each real intraday surge, did a headline about that name exist ON THE WIRE before the move, and how early? Motivated by a measured fact that kills the current design outright — our scraped world_items feed has a MEDIAN detection lag of 5.3 HOURS (84,342 items, 7d: p25 37min / p50 320min / p75 777min / p90 2,941min), while the audited pops moved 2-66 MINUTES after their headline. A perfect reader on that feed reads yesterday's news. This script bypasses world_items entirely and asks Alpaca's Benzinga wire (real publisher timestamps, same keys we already own) whether the signal is even THERE in time. If recall is near zero, the whole event-pop idea dies here for the price of an afternoon instead of a month.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | TWO DATA DEFECTS FOUND AND FIXED — both invalidate the existing pop research, and both are in scripts/oshal-trading-pop-miss-audit.ts too. (1) OVERNIGHT-GAP CONTAMINATION: findSurges filtered to RTH and then compared bars[i] to bars[i-6] by ARRAY INDEX — but the RTH filter deletes the overnight bars, so consecutive slots straddle a session boundary. PROVEN on MU: the reported "+8.27%/30min surge" is an 18-HOUR overnight gap (07-08 15:50 ET $948.59 -> 07-09 09:50 ET $1025.31). That is why every "surge" clustered at 15:35-15:55 ET — those are the last bars of a session. Same bug class as the resample() time-reversal that voided the 2026-07-09 numbers. Fix: the window must be same-session AND contiguous in wall-clock time. (2) THIN TAPE: we were on feed=iex (~2% of consolidated volume) when the PAPER key has full SIP entitlement — on the real tape MU moved +0.03% over the window IEX showed as +0.58%, on 9.0M shares vs IEX's 189K. Fix: feed=sip, fall back to iex only if denied.
 */

/**
 * News-wire recall test — can the wire see the pop coming at all?
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/oshal-trading-news-wire-recall.ts [surgePct] [topN] [days]
 *
 * Output: per-surge lead time (headline → move) and the aggregate recall curve.
 * Judged BEFORE any reader is built. Writes docs/evidence/news-wire-recall-<date>.md.
 *
 * @module scripts/oshal-trading-news-wire-recall
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_UNIVERSE } from '../src/features/trading';

const SURGE_PCT = Number(process.argv[2] || 2.5);   // 30-min (6-bar) rolling gain that counts as a surge
const TOP_N = Number(process.argv[3] || 25);
const DAYS = Number(process.argv[4] || 14);
const DATA = 'https://data.alpaca.markets';
/** SIP = the consolidated tape. IEX is ~2% of volume and its prints diverge wildly from reality
 *  (MU: +0.58% on IEX vs +0.03% on SIP over the same hour, 189K shares vs 9.0M). Verified 2026-07-12:
 *  the PAPER key carries SIP entitlement — so there is no reason to ever hunt surges on IEX. */
const FEED = (process.env.ALPACA_DATA_FEED || 'sip').trim();

/** Lead-time buckets (minutes before the move). The audited pops moved 2-66 min after their headline. */
const BUCKETS = [5, 15, 30, 60, 120, 240, 1440];

interface Bar { t: number; c: number; o: number }
interface Surge { sym: string; t: number; movePct: number; dayPct: number; volConfirmed: boolean }
interface Item { headline: string; source: string; createdAt: string; symbols: string[] }

const keys = () => ({
  id: (process.env.ALPACA_LIVE_KEY_ID || process.env.ALPACA_PAPER_KEY_ID || process.env.ALPACA_KEY || '').trim(),
  secret: (process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_SECRET || '').trim(),
});
const H = () => ({ 'APCA-API-KEY-ID': keys().id, 'APCA-API-SECRET-KEY': keys().secret });
const et = (ms: number): string => new Date(ms - 4 * 3600e3).toISOString().replace('T', ' ').slice(5, 16) + ' ET';
/** RTH only, in UTC minutes (13:30–20:00 UTC = 9:30–16:00 ET). */
const isRth = (ms: number): boolean => {
  const d = new Date(ms); const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 810 && m < 1200;
};

/**
 * @description Fetch 5-minute bars (with volume) for a symbol batch over the window.
 * @returns symbol → chronological bars
 */
async function fetchBars(symbols: string[], startIso: string, feed = FEED): Promise<Record<string, Array<Bar & { v: number }>>> {
  const out: Record<string, Array<Bar & { v: number }>> = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    let pageToken = '';
    do {
      const url = `${DATA}/v2/stocks/bars?symbols=${batch.join(',')}&timeframe=5Min&start=${startIso}`
        + `&limit=10000&adjustment=raw&feed=${feed}${pageToken ? `&page_token=${pageToken}` : ''}`;
      const r = await fetch(url, { headers: H() });
      if (!r.ok) { console.error(`  bars ${r.status} for batch ${i / 50 + 1}`); break; }
      const j = await r.json() as { bars?: Record<string, Array<{ t: string; o: number; c: number; v: number }>>; next_page_token?: string };
      for (const [sym, bars] of Object.entries(j.bars || {})) {
        (out[sym] ||= []).push(...bars.map((b) => ({ t: Date.parse(b.t), o: b.o, c: b.c, v: b.v })));
      }
      pageToken = j.next_page_token || '';
    } while (pageToken);
  }
  for (const s of Object.keys(out)) out[s].sort((a, b) => a.t - b.t);
  return out;
}

/**
 * @description Biggest 30-min RTH surge per symbol per day, with a VOLUME confirmation flag.
 * The volume check exists because the miss audit found several "surges" (LRCX/KLAC +10%/30min on a
 * DOWN day) were IEX thin-print artifacts — a detector without volume confirmation chases ghosts.
 * @returns top-N surges by size
 */
function findSurges(bars: Record<string, Array<Bar & { v: number }>>): Surge[] {
  const out: Surge[] = [];
  for (const [sym, all] of Object.entries(bars)) {
    if (sym === 'SPY') continue;
    const rth = all.filter((b) => isRth(b.t));
    if (rth.length < 20) continue;
    const medVol = [...rth].map((b) => b.v).sort((a, b) => a - b)[Math.floor(rth.length / 2)] || 0;
    // Group by SESSION first. Comparing bars by array index across the RTH-filtered array is the
    // bug that produced the phantom surges: the filter deletes the overnight bars, so bars[i] and
    // bars[i-6] straddle a session boundary and an OVERNIGHT GAP is reported as a 30-min move.
    const sessions = new Map<string, Array<Bar & { v: number }>>();
    for (const b of rth) {
      const day = new Date(b.t).toISOString().slice(0, 10);
      (sessions.get(day) ?? sessions.set(day, []).get(day)!).push(b);
    }
    for (const [, day] of sessions) {
      if (day.length < 8) continue;
      const dayPct = (day[day.length - 1].c / day[0].o - 1) * 100;
      let best: Surge | null = null;
      for (let i = 6; i < day.length; i++) {
        // Contiguity guard: the window must really be ~30 minutes of wall clock, not a gap.
        const spanMin = (day[i].t - day[i - 6].t) / 60000;
        if (spanMin > 35) continue;
        const move = (day[i].c / day[i - 6].c - 1) * 100;
        if (move < SURGE_PCT) continue;
        const surgeVol = day.slice(i - 6, i + 1).reduce((s, b) => s + b.v, 0) / 7;
        const s: Surge = {
          sym, t: day[i - 6].t, movePct: +move.toFixed(2), dayPct: +dayPct.toFixed(2),
          volConfirmed: medVol > 0 && surgeVol > medVol * 2,
        };
        if (!best || s.movePct > best.movePct) best = s;
      }
      if (best) out.push(best);
    }
  }
  return out.sort((a, b) => b.movePct - a.movePct).slice(0, TOP_N);
}

/**
 * @description Headlines ON THE WIRE for a symbol in a window. This is the whole point: publisher
 * timestamps from Benzinga, not an aggregator's re-post time.
 * @returns items, newest first
 */
async function wireNews(sym: string, startIso: string, endIso: string): Promise<Item[]> {
  const url = `${DATA}/v1beta1/news?symbols=${sym}&start=${startIso}&end=${endIso}&limit=50&sort=desc`;
  const r = await fetch(url, { headers: H() });
  if (!r.ok) return [];
  const j = await r.json() as { news?: Array<{ headline: string; source: string; created_at: string; symbols: string[] }> };
  return (j.news || []).map((n) => ({ headline: n.headline, source: n.source, createdAt: n.created_at, symbols: n.symbols || [] }));
}

async function main(): Promise<void> {
  if (!keys().id) { console.error('FAIL: no Alpaca keys in env'); process.exit(1); }
  const start = new Date(Date.now() - DAYS * 864e5).toISOString();
  console.log(`# News-wire recall test — can the wire see the pop coming?\n`);
  console.log(`Universe ${DEFAULT_UNIVERSE.length} · surges >= +${SURGE_PCT}%/30min · top ${TOP_N} · last ${DAYS}d\n`);

  const bars = await fetchBars([...DEFAULT_UNIVERSE], start);
  const surges = findSurges(bars);
  if (!surges.length) { console.log('No surges found in the window.'); return; }

  const rows: string[] = [];
  const leads: Array<number | null> = [];
  let ghosts = 0;

  for (const s of surges) {
    const t0 = new Date(s.t);
    const items = await wireNews(s.sym, new Date(s.t - 24 * 3600e3).toISOString(), t0.toISOString());
    // The newest item strictly BEFORE the move starts is the candidate trigger.
    const pre = items.filter((n) => Date.parse(n.createdAt) < s.t);
    const lead = pre.length ? Math.round((s.t - Date.parse(pre[0].createdAt)) / 60000) : null;
    leads.push(lead);
    if (!s.volConfirmed) ghosts++;

    const leadTxt = lead === null ? 'NO NEWS' : `${lead} min`;
    const flag = s.volConfirmed ? '' : ' [thin-print?]';
    console.log(`  ${s.sym.padEnd(6)} +${String(s.movePct).padStart(5)}%/30m  ${et(s.t)}  day ${String(s.dayPct).padStart(6)}%${flag}`);
    console.log(`         lead: ${leadTxt.padEnd(9)} ${pre[0] ? `[${pre[0].source}] ${pre[0].headline.slice(0, 66)}` : '(nothing on the wire in 24h)'}`);
    rows.push(`| ${s.sym} | +${s.movePct}% | ${et(s.t)} | ${s.dayPct}% | ${s.volConfirmed ? 'yes' : 'NO'} | ${leadTxt} | ${pre[0] ? `${pre[0].source}: ${pre[0].headline.replace(/\|/g, '/').slice(0, 80)}` : '—'} |`);
  }

  // ── The recall curve: the number that decides whether a reader is worth building ──
  console.log(`\n## Recall curve — headline on the wire BEFORE the move\n`);
  const withNews = leads.filter((l): l is number => l !== null);
  const curve = BUCKETS.map((b) => ({ b, n: withNews.filter((l) => l <= b).length }));
  for (const { b, n } of curve) {
    const pct = Math.round((n / surges.length) * 100);
    const bar = '█'.repeat(Math.round(pct / 4));
    console.log(`  within ${String(b).padStart(4)} min:  ${String(n).padStart(2)}/${surges.length}  ${String(pct).padStart(3)}%  ${bar}`);
  }
  console.log(`  no news at all:  ${surges.length - withNews.length}/${surges.length}`);
  console.log(`  thin-print suspects (no volume confirmation): ${ghosts}/${surges.length}`);

  // ── The verdict, stated against a PRE-REGISTERED bar ──
  const actionable = withNews.filter((l) => l <= 60).length;   // a reader needs >= ~1min to read + confirm
  const pct = Math.round((actionable / surges.length) * 100);
  console.log(`\n## VERDICT (pre-registered): a reader is worth building only if a material headline`);
  console.log(`   precedes a decent share of surges by 1-60 min — enough time to read, confirm, and enter.\n`);
  console.log(`   Actionable window (<=60 min lead): ${actionable}/${surges.length} = ${pct}%`);
  console.log(pct >= 30
    ? `   → PROCEED: the signal is on the wire in time. Build the reader (batched, rolling, filtered).`
    : pct >= 15
      ? `   → MARGINAL: signal exists but is thin. A reader may clear the bar only on the biggest events.`
      : `   → STOP: the wire does not see these moves coming. No reader can fix that. Kill the idea here.`);

  const date = new Date().toISOString().slice(0, 10);
  const out = path.join('docs', 'evidence', `news-wire-recall-${date}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [
    `# News-wire recall test — ${date}`, '',
    `Can Alpaca's Benzinga wire see the pop coming? Surges >= +${SURGE_PCT}%/30min, top ${TOP_N}, last ${DAYS}d,`,
    `universe ${DEFAULT_UNIVERSE.length}. **This is the gate for the LLM-news-reader build** — measured BEFORE`,
    `writing a reader, because our scraped feed has a median detection lag of 5.3 HOURS while these moves`,
    `happen 2-66 minutes after the headline.`, '',
    `| Symbol | Move | When | Day | Vol confirmed | Lead time | Newest headline before the move |`,
    `|---|---|---|---|---|---|---|`, ...rows, '',
    `## Recall curve`, '',
    `| Lead <= | Surges with a headline | % |`, `|---|---|---|`,
    ...curve.map(({ b, n }) => `| ${b} min | ${n}/${surges.length} | ${Math.round((n / surges.length) * 100)}% |`),
    `| (no news at all) | ${surges.length - withNews.length}/${surges.length} | ${Math.round(((surges.length - withNews.length) / surges.length) * 100)}% |`, '',
    `Thin-print suspects (no volume confirmation): ${ghosts}/${surges.length}.`, '',
    `## Verdict`, '',
    `Actionable window (1-60 min lead): **${actionable}/${surges.length} = ${pct}%**.`, '',
    pct >= 30 ? `**PROCEED** — the signal is on the wire in time; build the reader.`
      : pct >= 15 ? `**MARGINAL** — signal exists but thin; only the largest events are likely to clear the cost bar.`
        : `**STOP** — the wire does not see these moves coming. No reader quality fixes that.`,
  ].join('\n'));
  console.log(`\nEvidence written: ${out}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
