/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the news-READER gate study (sweep-#5 surviving path): stage-1 prefilter + LLM materiality reader (claude CLI headless, strict-JSON batches) replayed over the last ~30 days of the Benzinga wire against the corrected-SIP 5-min surge set. Measures RECALL (material verdict ≤60min before a real surge), PRECISION (verdict followed by a ≥1.5% same-direction move ≤2h), and hypothetical RTH-only bracketed pop CAPTURE with a one-bar latency penalty. Pre-registered PROCEED/MARGINAL/KILL. Study only — arms nothing.
 */

/**
 * News-reader gate study — can an LLM materiality reader sift the wire down to the real insight
 * news (partnerships, supply shocks, macro surprises) accurately enough to catch the pops?
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/oshal-trading-news-reader-gate.ts [days=30] [surgePct=2.5]
 *
 * PRE-REGISTERED DECISION RULE (stated before any number is computed):
 *   PROCEED (build the live 5-min shadow leg) iff, on volume-confirmed surges, recall(material
 *   verdict ≤60 min before) >= 25% AND the bracketed capture averages >= +0.40%/trade gross on
 *   >= 15 deduped trades AND alarms average <= 6/trading day.
 *   MARGINAL (park/refine) iff capture > 0 on >= 15 trades, or recall >= 25% with thin capture.
 *   Otherwise KILL for the pop-capture purpose.
 *
 * Writes docs/evidence/news-reader-gate-<date>.md and prints a RESULT json line.
 *
 * @module scripts/oshal-trading-news-reader-gate
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_UNIVERSE } from '../src/features/trading';
import { buildReaderPrompt, parseReaderVerdicts, prefilterHeadline, type ReaderVerdict } from '../src/features/trading/services/news-materiality';

const DAYS = Math.max(7, Math.min(60, Number(process.argv[2] || 30)));
const SURGE_PCT = Number(process.argv[3] || 2.5);
const BATCH = 40;
const CONF_MIN = 0.6;
const DATA = 'https://data.alpaca.markets';
const LATENCY_BARS = 1;            // entry one full 5-min bar after the verdict's bar — polling+reading latency
const BRACKET_UP = 3.0, BRACKET_DN = 2.0; // +3% take / −2% stop on 5-min closes, else session close (no overnight)

const keys = () => ({
  id: (process.env.ALPACA_LIVE_KEY_ID || process.env.ALPACA_PAPER_KEY_ID || process.env.ALPACA_KEY || '').trim(),
  secret: (process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_SECRET || '').trim(),
});
const H = () => ({ 'APCA-API-KEY-ID': keys().id, 'APCA-API-SECRET-KEY': keys().secret });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRth = (ms: number): boolean => { const d = new Date(ms); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 810 && m < 1200; };
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const et = (ms: number): string => new Date(ms - 4 * 3600e3).toISOString().replace('T', ' ').slice(5, 16) + ' ET';

interface Bar { t: number; o: number; c: number; v: number }
interface WireItem { id: number; headline: string; createdAt: string; tMs: number; symbols: string[] }
interface Surge { sym: string; t: number; movePct: number; volConfirmed: boolean }
interface Alarm { sym: string; tMs: number; cls: string; dir: 'up' | 'down'; conf: number; headline: string }

async function fetchBars(symbols: string[], startIso: string): Promise<Record<string, Bar[]>> {
  const out: Record<string, Bar[]> = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    let pageToken = '';
    do {
      const url = `${DATA}/v2/stocks/bars?symbols=${batch.join(',')}&timeframe=5Min&start=${startIso}`
        + `&end=${encodeURIComponent(new Date(Date.now() - 16 * 60 * 1000).toISOString())}`
        + `&limit=10000&adjustment=raw&feed=sip${pageToken ? `&page_token=${pageToken}` : ''}`;
      const r = await fetch(url, { headers: H() });
      if (r.status === 429) { await sleep(1500); continue; }
      if (!r.ok) { console.error(`  bars ${r.status} batch ${i / 50 + 1}`); break; }
      const j = await r.json() as { bars?: Record<string, Array<{ t: string; o: number; c: number; v: number }>>; next_page_token?: string };
      for (const [sym, bars] of Object.entries(j.bars || {})) (out[sym] ||= []).push(...bars.map((b) => ({ t: Date.parse(b.t), o: b.o, c: b.c, v: b.v })));
      pageToken = j.next_page_token || '';
    } while (pageToken);
  }
  for (const s of Object.keys(out)) out[s].sort((a, b) => a.t - b.t);
  return out;
}

/** Corrected surge finder (same-session contiguous 30-min windows, volume flag) — the recall-test fix. */
function findSurges(bars: Record<string, Bar[]>): Surge[] {
  const out: Surge[] = [];
  for (const [sym, all] of Object.entries(bars)) {
    if (sym === 'SPY' || sym === 'QQQ') continue;
    const rth = all.filter((b) => isRth(b.t));
    if (rth.length < 40) continue;
    const medVol = [...rth].map((b) => b.v).sort((a, b) => a - b)[Math.floor(rth.length / 2)] || 0;
    const sessions = new Map<string, Bar[]>();
    for (const b of rth) { const d = dayOf(b.t); (sessions.get(d) ?? sessions.set(d, []).get(d)!).push(b); }
    for (const [, day] of sessions) {
      if (day.length < 8) continue;
      let best: Surge | null = null;
      for (let i = 6; i < day.length; i++) {
        if ((day[i].t - day[i - 6].t) / 60000 > 35) continue; // contiguity guard
        const move = (day[i].c / day[i - 6].c - 1) * 100;
        if (move < SURGE_PCT) continue;
        const surgeVol = day.slice(i - 6, i + 1).reduce((s, b) => s + b.v, 0) / 7;
        const s: Surge = { sym, t: day[i - 6].t, movePct: +move.toFixed(2), volConfirmed: medVol > 0 && surgeVol > medVol * 2 };
        if (!best || s.movePct > best.movePct) best = s;
      }
      if (best) out.push(best);
    }
  }
  return out.sort((a, b) => b.movePct - a.movePct);
}

async function fetchWire(symbols: string[], startIso: string): Promise<WireItem[]> {
  const out: WireItem[] = [];
  let id = 1;
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50).join(',');
    let pageToken = '';
    do {
      const url = `${DATA}/v1beta1/news?symbols=${encodeURIComponent(batch)}&start=${encodeURIComponent(startIso)}&limit=50&sort=asc&include_content=false${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await fetch(url, { headers: H() });
      if (r.status === 429) { await sleep(2000); continue; }
      if (!r.ok) { console.error(`  news ${r.status}`); break; }
      const j = await r.json() as { news?: Array<{ headline: string; created_at: string; symbols: string[] }>; next_page_token?: string | null };
      for (const n of j.news || []) out.push({ id: id++, headline: n.headline, createdAt: n.created_at, tMs: Date.parse(n.created_at), symbols: n.symbols || [] });
      pageToken = j.next_page_token || '';
      await sleep(60);
    } while (pageToken);
  }
  return out;
}

/** One reader call: prompt via stdin, strict-JSON out, one retry on a parse miss. */
function readBatch(items: WireItem[]): Map<number, ReaderVerdict> {
  const prompt = buildReaderPrompt(items.map((it) => ({ id: it.id, headline: it.headline, symbols: it.symbols })));
  const ids = new Set(items.map((it) => it.id));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = execSync('claude -p "Follow the instructions in the piped input EXACTLY. Output only the fenced json block."',
        { input: prompt, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
      const v = parseReaderVerdicts(raw, ids);
      if (v.size >= Math.max(1, Math.floor(items.length * 0.5))) return v;
      console.error(`  reader parse thin (${v.size}/${items.length}) — ${attempt ? 'giving up' : 'retrying'}`);
      if (v.size) return v;
    } catch (e) {
      console.error(`  reader call failed (${attempt ? 'giving up' : 'retrying'}): ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return new Map();
}

async function main(): Promise<void> {
  if (!keys().id) { console.error('FAIL: no Alpaca keys in env'); process.exit(1); }
  const startIso = new Date(Date.now() - DAYS * 864e5).toISOString();
  console.log(`# News-READER gate study — run ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Universe ${DEFAULT_UNIVERSE.length} (+SPY/QQQ for macro) · ${DAYS}d · surges ≥ +${SURGE_PCT}%/30min RTH (SIP) · reader conf ≥ ${CONF_MIN} · latency ${LATENCY_BARS} bar`);
  console.log(`DECISION RULE (pre-registered): PROCEED iff recall(vol-confirmed, ≤60min) ≥ 25% AND capture ≥ +0.40%/trade on ≥15 trades AND ≤6 alarms/day. MARGINAL: capture > 0 on ≥15. Else KILL.\n`);

  console.log('## Fetching 5-min SIP bars…');
  const symbols = [...DEFAULT_UNIVERSE, 'SPY', 'QQQ'];
  const bars = await fetchBars(symbols, startIso);
  const surges = findSurges(bars);
  const volSurges = surges.filter((s) => s.volConfirmed);
  console.log(`  ${surges.length} surges (${volSurges.length} volume-confirmed)\n`);

  console.log('## Fetching the wire…');
  const items = await fetchWire(symbols, startIso);
  const kept = items.filter((it) => prefilterHeadline(it.headline) && Number.isFinite(it.tMs));
  console.log(`  ${items.length} items → stage-1 kept ${kept.length} (${Math.round((kept.length / Math.max(1, items.length)) * 100)}%)\n`);

  console.log(`## Reading (${Math.ceil(kept.length / BATCH)} batches of ${BATCH})…`);
  const alarms: Alarm[] = [];
  let material = 0;
  for (let i = 0; i < kept.length; i += BATCH) {
    const batch = kept.slice(i, i + BATCH);
    const verdicts = readBatch(batch);
    for (const it of batch) {
      const v = verdicts.get(it.id);
      if (!v || !v.material) continue;
      material++;
      if (v.dir === 'unclear' || v.conf < CONF_MIN) continue;
      const sym = v.sym && bars[v.sym] ? v.sym
        : (v.cls.startsWith('macro') || v.cls === 'geopolitical-supply') ? 'SPY'
        : it.symbols.map((s) => s.toUpperCase()).find((s) => bars[s]) ?? null;
      if (!sym) continue;
      alarms.push({ sym, tMs: it.tMs, cls: v.cls, dir: v.dir, conf: v.conf, headline: it.headline });
    }
    if ((i / BATCH) % 5 === 4) console.log(`  …batch ${i / BATCH + 1}/${Math.ceil(kept.length / BATCH)}: ${material} material, ${alarms.length} clear-dir alarms so far`);
  }
  // Dedupe: one alarm per symbol × day × dir (first wins — the live leg would fire once).
  const seen = new Set<string>();
  const deduped = alarms.filter((a) => { const k = `${a.sym}|${dayOf(a.tMs)}|${a.dir}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const tradingDays = new Set(Object.values(bars).flatMap((bs) => bs.filter((b) => isRth(b.t)).map((b) => dayOf(b.t)))).size;
  console.log(`  ${material} material verdicts → ${alarms.length} clear-dir conf≥${CONF_MIN} → ${deduped.length} deduped alarms over ~${tradingDays} sessions\n`);

  // ── RECALL vs the real surges ──
  const alarmsBySym = new Map<string, Alarm[]>();
  for (const a of deduped) (alarmsBySym.get(a.sym) ?? alarmsBySym.set(a.sym, []).get(a.sym)!).push(a);
  const caught = (s: Surge, windowMin: number): Alarm | undefined =>
    (alarmsBySym.get(s.sym) || []).find((a) => a.dir === 'up' && a.tMs < s.t && s.t - a.tMs <= windowMin * 60e3);
  const recall60 = volSurges.filter((s) => caught(s, 60)).length;
  const recall24h = volSurges.filter((s) => caught(s, 1440)).length;
  console.log('## RECALL (volume-confirmed surges with an UP alarm before the move)');
  console.log(`  ≤60 min: ${recall60}/${volSurges.length} (${volSurges.length ? Math.round((recall60 / volSurges.length) * 100) : 0}%) · ≤24 h: ${recall24h}/${volSurges.length}`);
  for (const s of volSurges.slice(0, 12)) {
    const a = caught(s, 60);
    console.log(`   ${s.sym.padEnd(6)} +${String(s.movePct).padStart(5)}% ${et(s.t)}  ${a ? `CAUGHT ${Math.round((s.t - a.tMs) / 60e3)}min [${a.cls}] ${a.headline.slice(0, 60)}` : 'missed'}`);
  }

  // ── PRECISION + CAPTURE (bracketed, RTH-only, latency-penalized) ──
  let hits = 0, evaluated = 0, sumPct = 0, wins = 0;
  const trades: Array<{ sym: string; pct: number }> = [];
  for (const a of deduped) {
    const bs = (bars[a.sym] || []).filter((b) => isRth(b.t) && dayOf(b.t) === dayOf(Math.max(a.tMs, Date.parse(`${dayOf(a.tMs)}T13:30:00Z`))));
    // entry bar: first RTH bar with t >= alarm time, plus the latency penalty; pre/post-market alarms enter at the open.
    let dayBars = bs;
    if (!dayBars.length) { // after-close alarm → next session
      const nextDays = [...new Set((bars[a.sym] || []).filter((b) => isRth(b.t) && b.t > a.tMs).map((b) => dayOf(b.t)))].sort();
      if (!nextDays.length) continue;
      dayBars = (bars[a.sym] || []).filter((b) => isRth(b.t) && dayOf(b.t) === nextDays[0]);
    }
    const idx0 = dayBars.findIndex((b) => b.t >= a.tMs);
    const entryIdx = (idx0 < 0 ? 0 : idx0) + LATENCY_BARS;
    if (entryIdx >= dayBars.length - 1) continue;
    const entry = dayBars[entryIdx].c;
    evaluated++;
    // precision: did a ≥1.5% same-direction move happen within 2h of entry?
    const twoH = dayBars.filter((b, i) => i > entryIdx && b.t - dayBars[entryIdx].t <= 2 * 3600e3);
    const moved = twoH.some((b) => (a.dir === 'up' ? (b.c / entry - 1) * 100 >= 1.5 : (1 - b.c / entry) * 100 >= 1.5));
    if (moved) hits++;
    // capture: bracket on closes to session end.
    let exitPct: number | null = null;
    for (let i = entryIdx + 1; i < dayBars.length; i++) {
      const chg = (a.dir === 'up' ? dayBars[i].c / entry - 1 : 1 - dayBars[i].c / entry) * 100;
      if (chg >= BRACKET_UP) { exitPct = BRACKET_UP; break; }
      if (chg <= -BRACKET_DN) { exitPct = -BRACKET_DN; break; }
    }
    if (exitPct == null) {
      const last = dayBars[dayBars.length - 1].c;
      exitPct = (a.dir === 'up' ? last / entry - 1 : 1 - last / entry) * 100;
    }
    sumPct += exitPct; if (exitPct > 0) wins++;
    trades.push({ sym: a.sym, pct: +exitPct.toFixed(2) });
  }
  const avg = evaluated ? sumPct / evaluated : 0;
  const perDay = tradingDays ? deduped.length / tradingDays : 0;
  console.log(`\n## PRECISION & CAPTURE (deduped alarms, ${LATENCY_BARS}-bar latency, +${BRACKET_UP}%/−${BRACKET_DN}% brackets, flat by close)`);
  console.log(`  alarms evaluated: ${evaluated} (${perDay.toFixed(1)}/day) · ≥1.5% follow-through ≤2h: ${hits}/${evaluated} (${evaluated ? Math.round((hits / evaluated) * 100) : 0}%)`);
  console.log(`  capture: total ${sumPct.toFixed(1)}% · avg ${avg.toFixed(2)}%/trade · win rate ${evaluated ? Math.round((wins / evaluated) * 100) : 0}%`);

  // ── The pre-registered verdict ──
  const recallPct = volSurges.length ? (recall60 / volSurges.length) * 100 : 0;
  const proceed = recallPct >= 25 && avg >= 0.4 && evaluated >= 15 && perDay <= 6;
  const marginal = !proceed && evaluated >= 15 && (avg > 0 || recallPct >= 25);
  const verdict = proceed ? 'PROCEED' : marginal ? 'MARGINAL' : 'KILL';
  console.log(`\n## VERDICT (pre-registered): ${verdict}`);
  console.log(proceed ? '   → Build the live 5-min shadow leg (recorded verdicts, no orders) judged against the sweep-#4 arming bar.'
    : marginal ? '   → Park/refine: adjust conf threshold / classes / brackets and re-run before any live leg.'
    : '   → No pop pipeline on this reader as configured. Filter + contract + harness remain for iteration.');

  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join('docs', 'evidence', `news-reader-gate-${date}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [
    `# News-reader gate study — ${date}`, '',
    `Stage-1 prefilter + LLM materiality reader over ${DAYS}d of the Benzinga wire (${items.length} items → ${kept.length} kept → ${material} material → ${deduped.length} deduped clear-dir alarms), replayed against ${volSurges.length} volume-confirmed SIP surges (≥+${SURGE_PCT}%/30min RTH).`, '',
    `**Pre-registered rule:** PROCEED iff recall ≥ 25% (≤60min, vol-confirmed) AND capture ≥ +0.40%/trade on ≥15 trades AND ≤6 alarms/day.`, '',
    `- Recall ≤60min: **${recall60}/${volSurges.length}** (${recallPct.toFixed(0)}%) · ≤24h: ${recall24h}/${volSurges.length}`,
    `- Alarms: ${deduped.length} (${perDay.toFixed(1)}/day) · follow-through ≥1.5% ≤2h: ${hits}/${evaluated}`,
    `- Capture: total ${sumPct.toFixed(1)}% · **avg ${avg.toFixed(2)}%/trade** · win ${evaluated ? Math.round((wins / evaluated) * 100) : 0}% · brackets +${BRACKET_UP}/−${BRACKET_DN}, ${LATENCY_BARS}-bar latency, flat by close`,
    '', `## Verdict: **${verdict}**`, '',
    '| sym | trade % |', '|---|---|', ...trades.slice(0, 40).map((t) => `| ${t.sym} | ${t.pct} |`), '',
    'Honest limits: reader is an LLM (non-deterministic run-to-run; verdicts recorded here are the run of record); brackets evaluated on 5-min closes (no intrabar fills); no slippage/commission (~0.2%/round-trip applies); single-run, one month, one regime.', '',
  ].join('\n'));
  console.log(`\nEvidence: ${outPath}`);
  console.log(`RESULT ${JSON.stringify({ verdict, surges: volSurges.length, recall60, alarms: deduped.length, evaluated, avgPct: +avg.toFixed(2), perDay: +perDay.toFixed(1) })}`);
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
