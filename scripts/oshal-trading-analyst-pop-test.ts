/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the LAST surviving event-pop hypothesis, isolated: do INTRADAY analyst rating/PT actions produce a tradeable SAME-DAY pop? (The 07-14 wire-ceiling diagnostic showed most pre-surge headlines are REACTIVE coverage the filter rightly drops; analyst actions are the only genuinely-leading machine-readable class.) Deterministic — no LLM. Entry 1 bar after publication, +3%/-2% bracket on 5-min closes, flat by the close (never hold news overnight — sweep-#5 durable finding). Judged against a SAME-SYMBOL RANDOM-TIME control (the null that killed the analyst-drift study), not against zero.
 */

/**
 * Analyst intraday-pop test — the narrow, deterministic close of the event-pop family.
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/oshal-trading-analyst-pop-test.ts [days=60]
 *
 * PRE-REGISTERED DECISION RULE (stated before any number is computed):
 *   PROCEED (build a deterministic shadow pop leg) iff, over RTH-published analyst UP actions:
 *     n >= 30 trades AND avg >= +0.40%/trade gross (the sweep-#4 arming bar)
 *     AND the mean beats the same-symbol random-time control by >= 0.30pp
 *     AND permutation p < 0.05 against that control.
 *   MARGINAL iff avg > 0 and beats the control but misses a bar above.
 *   Otherwise KILL — the event-pop family is closed for this universe/tape.
 *
 * @module scripts/oshal-trading-analyst-pop-test
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_UNIVERSE } from '../src/features/trading';
import { classifyAnalystHeadline } from '../src/features/trading/services/analyst-actions';

const DAYS = Math.max(14, Math.min(120, Number(process.argv[2] || 60)));
const DATA = 'https://data.alpaca.markets';
const LATENCY_BARS = 1;              // enter one full 5-min bar after publication (poll + read + place)
const TP = 3.0, SL = 2.0;            // bracket on 5-min closes; else flat at the session close
const PERM_ITERS = 2000;
const keys = () => ({
  id: (process.env.ALPACA_LIVE_KEY_ID || process.env.ALPACA_PAPER_KEY_ID || process.env.ALPACA_KEY || '').trim(),
  secret: (process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_SECRET || '').trim(),
});
const H = () => ({ 'APCA-API-KEY-ID': keys().id, 'APCA-API-SECRET-KEY': keys().secret });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** RTH minute-of-day in UTC (13:30–20:00 UTC = 9:30–16:00 ET). Entries stop 30 min before the close. */
const rthMin = (ms: number) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const isRth = (ms: number) => rthMin(ms) >= 810 && rthMin(ms) < 1200;
const isEntryWindow = (ms: number) => rthMin(ms) >= 815 && rthMin(ms) <= 1170; // 9:35–15:30 ET

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Bar { t: number; c: number }
type BarsBySym = Record<string, Bar[]>;

async function fetchBars(symbols: string[], startIso: string): Promise<BarsBySym> {
  const out: BarsBySym = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    let pageToken = '';
    do {
      const url = `${DATA}/v2/stocks/bars?symbols=${batch.join(',')}&timeframe=5Min&start=${startIso}`
        + `&end=${encodeURIComponent(new Date(Date.now() - 16 * 60 * 1000).toISOString())}`
        + `&limit=10000&adjustment=raw&feed=sip${pageToken ? `&page_token=${pageToken}` : ''}`;
      const r = await fetch(url, { headers: H() });
      if (r.status === 429) { await sleep(1500); continue; }
      if (!r.ok) { console.error(`  bars ${r.status}`); break; }
      const j = await r.json() as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string };
      for (const [sym, bars] of Object.entries(j.bars || {})) (out[sym] ||= []).push(...bars.map((b) => ({ t: Date.parse(b.t), c: b.c })));
      pageToken = j.next_page_token || '';
    } while (pageToken);
  }
  for (const s of Object.keys(out)) out[s].sort((a, b) => a.t - b.t);
  return out;
}

interface Ev { sym: string; tMs: number; cls: string; headline: string }

async function fetchEvents(symbols: string[], startIso: string): Promise<Ev[]> {
  const uni = new Set(symbols.map((s) => s.toUpperCase()));
  const out: Ev[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50).join(',');
    let pageToken = '';
    do {
      const url = `${DATA}/v1beta1/news?symbols=${encodeURIComponent(batch)}&start=${encodeURIComponent(startIso)}&limit=50&sort=asc&include_content=false${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await fetch(url, { headers: H() });
      if (r.status === 429) { await sleep(2000); continue; }
      if (!r.ok) break;
      const j = await r.json() as { news?: Array<{ headline: string; created_at: string; symbols: string[] }>; next_page_token?: string | null };
      for (const n of j.news || []) {
        const a = classifyAnalystHeadline(n.headline);
        if (!a || a.dir !== 'up') continue;                    // UP actions only (upgrade / pt-raise / bull initiation)
        const tMs = Date.parse(n.created_at);
        if (!Number.isFinite(tMs) || !isEntryWindow(tMs)) continue;  // RTH-published, room to enter AND exit
        for (const sRaw of n.symbols) {
          const sym = sRaw.toUpperCase();
          if (!uni.has(sym)) continue;
          const k = `${sym}|${dayOf(tMs)}`;                     // one trade per symbol per day (first wins)
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ sym, tMs, cls: a.cls, headline: n.headline });
        }
      }
      pageToken = j.next_page_token || '';
      await sleep(60);
    } while (pageToken);
  }
  return out;
}

/** Bracketed long from the bar AFTER `atMs` (latency), flat by session close. Null if unplayable. */
function playLong(bars: Bar[], atMs: number): number | null {
  const day = bars.filter((b) => isRth(b.t) && dayOf(b.t) === dayOf(atMs));
  if (day.length < 6) return null;
  const i0 = day.findIndex((b) => b.t >= atMs);
  const entryIdx = (i0 < 0 ? day.length : i0) + LATENCY_BARS;
  if (entryIdx >= day.length - 1) return null;
  const entry = day[entryIdx].c;
  if (!(entry > 0)) return null;
  for (let i = entryIdx + 1; i < day.length; i++) {
    const chg = (day[i].c / entry - 1) * 100;
    if (chg >= TP) return TP;
    if (chg <= -SL) return -SL;
  }
  return (day[day.length - 1].c / entry - 1) * 100;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

async function main(): Promise<void> {
  if (!keys().id) { console.error('FAIL: no Alpaca keys'); process.exit(1); }
  const startIso = new Date(Date.now() - DAYS * 864e5).toISOString();
  console.log(`# Analyst intraday-POP test — run ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Universe ${DEFAULT_UNIVERSE.length} · ${DAYS}d · UP analyst actions published 9:35–15:30 ET · entry +${LATENCY_BARS} bar · bracket +${TP}/−${SL} · flat by close`);
  console.log(`RULE (pre-registered): PROCEED iff n>=30 AND avg>=+0.40%/trade AND beats the same-symbol random-time control by >=0.30pp AND perm p<0.05. MARGINAL if positive and beats control. Else KILL.\n`);

  const bars = await fetchBars([...DEFAULT_UNIVERSE], startIso);
  console.log(`bars: ${Object.keys(bars).length} symbols`);
  const events = await fetchEvents([...DEFAULT_UNIVERSE], startIso);
  console.log(`events: ${events.length} RTH-published UP analyst actions (deduped per symbol-day)\n`);

  const trades: Array<{ sym: string; pct: number; cls: string; headline: string; tMs: number }> = [];
  for (const e of events) {
    const pct = playLong(bars[e.sym] || [], e.tMs);
    if (pct == null) continue;
    trades.push({ sym: e.sym, pct: +pct.toFixed(2), cls: e.cls, headline: e.headline, tMs: e.tMs });
  }
  const obs = trades.map((t) => t.pct);
  const avg = mean(obs);
  const wins = obs.filter((x) => x > 0).length;
  const tp = obs.filter((x) => x >= TP - 1e-9).length;
  const sl = obs.filter((x) => x <= -SL + 1e-9).length;

  console.log(`## Observed (n=${obs.length})`);
  console.log(`  avg ${avg.toFixed(3)}%/trade · win ${obs.length ? Math.round((wins / obs.length) * 100) : 0}% · +${TP}% hits ${tp} · −${SL}% stops ${sl} · total ${obs.reduce((s, x) => s + x, 0).toFixed(1)}%`);
  const byCls = new Map<string, number[]>();
  for (const t of trades) (byCls.get(t.cls) ?? byCls.set(t.cls, []).get(t.cls)!).push(t.pct);
  for (const [c, xs] of byCls) console.log(`   ${c.padEnd(16)} n=${String(xs.length).padStart(4)}  avg ${mean(xs).toFixed(3)}%`);

  // ── SAME-SYMBOL RANDOM-TIME CONTROL (the null that killed the drift study) ──
  const rand = mulberry32(97_2026);
  const validEntries = new Map<string, number[]>(); // sym → playable RTH entry timestamps
  for (const t of trades) {
    if (validEntries.has(t.sym)) continue;
    const ts = (bars[t.sym] || []).filter((b) => isEntryWindow(b.t)).map((b) => b.t);
    validEntries.set(t.sym, ts);
  }
  const controlMeans: number[] = [];
  for (let it = 0; it < PERM_ITERS; it++) {
    const xs: number[] = [];
    for (const t of trades) {
      const pool = validEntries.get(t.sym) || [];
      if (!pool.length) continue;
      const pct = playLong(bars[t.sym] || [], pool[Math.floor(rand() * pool.length)]);
      if (pct != null) xs.push(pct);
    }
    if (xs.length) controlMeans.push(mean(xs));
  }
  const controlAvg = mean(controlMeans);
  const pVal = controlMeans.length ? controlMeans.filter((m) => m >= avg).length / controlMeans.length : 1;
  const edge = avg - controlAvg;
  console.log(`\n## Same-symbol random-time control (${PERM_ITERS} draws — "what does buying these names at RANDOM RTH moments pay?")`);
  console.log(`  control avg ${controlAvg.toFixed(3)}%/trade · observed ${avg.toFixed(3)}% · EDGE ${edge >= 0 ? '+' : ''}${edge.toFixed(3)}pp · perm p=${pVal.toFixed(4)}`);

  const proceed = obs.length >= 30 && avg >= 0.4 && edge >= 0.3 && pVal < 0.05;
  const marginal = !proceed && obs.length >= 15 && avg > 0 && edge > 0;
  const verdict = proceed ? 'PROCEED' : marginal ? 'MARGINAL' : 'KILL';
  console.log(`\n## VERDICT (pre-registered): ${verdict}`);
  console.log(proceed ? '   → Build the deterministic shadow pop leg (no LLM needed) and judge it live against the sweep-#4 bar.'
    : marginal ? '   → Positive but under the bar: park; do NOT commit capital on this sample.'
    : '   → The event-POP family is CLOSED for this universe/tape. Intraday analyst actions do not pay after latency.');

  const top = [...trades].sort((a, b) => b.pct - a.pct).slice(0, 10);
  console.log('\n## Best 10 (what the winners actually were)');
  for (const t of top) console.log(`  ${t.sym.padEnd(6)} ${String(t.pct).padStart(6)}%  ${t.headline.slice(0, 72)}`);

  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join('docs', 'evidence', `analyst-pop-test-${date}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [
    `# Analyst intraday-pop test — ${date}`, '',
    `The last surviving event-pop hypothesis, isolated and tested deterministically (no LLM).`,
    `${DAYS}d · universe ${DEFAULT_UNIVERSE.length} · UP analyst actions (upgrade / PT-raise / bull initiation)`,
    `published 9:35–15:30 ET · entry ${LATENCY_BARS} bar after publication · +${TP}%/−${SL}% bracket on 5-min closes ·`,
    `flat by the session close (never hold news overnight — sweep-#5 durable finding).`, '',
    `**Pre-registered rule:** PROCEED iff n≥30, avg ≥ +0.40%/trade, edge over the same-symbol random-time`,
    `control ≥ 0.30pp, perm p < 0.05. MARGINAL if positive and beats control. Else KILL.`, '',
    `| metric | value |`, `|---|---|`,
    `| trades | ${obs.length} |`,
    `| avg %/trade | **${avg.toFixed(3)}** |`,
    `| win rate | ${obs.length ? Math.round((wins / obs.length) * 100) : 0}% |`,
    `| +${TP}% target hits | ${tp} |`,
    `| −${SL}% stops | ${sl} |`,
    `| same-symbol random-time control | ${controlAvg.toFixed(3)}%/trade |`,
    `| **edge over control** | **${edge >= 0 ? '+' : ''}${edge.toFixed(3)}pp** |`,
    `| permutation p | ${pVal.toFixed(4)} |`, '',
    `## Verdict: **${verdict}**`, '',
    'Honest limits: 5-min closes (no intrabar fills), no slippage/commission (~0.2%/round-trip bar applies),',
    'single tape/regime, Benzinga publisher timestamps (the wire is the ceiling — the 07-14 diagnostic showed',
    'most pre-surge headlines are REACTIVE coverage of the move, not information).', '',
  ].join('\n'));
  console.log(`\nEvidence: ${outPath}`);
  console.log(`RESULT ${JSON.stringify({ verdict, n: obs.length, avgPct: +avg.toFixed(3), controlPct: +controlAvg.toFixed(3), edgePp: +edge.toFixed(3), p: +pVal.toFixed(4) })}`);
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
