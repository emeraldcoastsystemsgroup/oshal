/**
 * News-MATERIALITY backtest — BLIND-FORWARD walk of the tier-3 event-pop design over the real
 * news archive (world_items) and the real 5-minute tape.
 *
 * Discipline: at simulated time t the strategy sees ONLY headlines with pub_date < t and bars
 * that opened at/before t. A headline scoring ≥ threshold becomes a signal at pub_date; the
 * entry fills at the OPEN of the first RTH 5-min bar starting ≥ pub_date + 5 min (processing
 * latency), or the next session's first bar for off-hours headlines (tracked as the 'overnight'
 * cohort — the gap usually eats that edge; reported separately). Scoring is DETERMINISTIC
 * (event-class regexes, dollar magnitude, direct-subject check, outlet reliability) so nothing
 * about it can leak hindsight. Honest caveat: the event-class list was designed after eyeballing
 * the 07-01→07-10 miss audit, so the final week is partially in-sample; June 16 → July 3 is the
 * cleaner stretch. True out-of-sample = the Monday-forward shadow run.
 *
 * Sizing (operator rule): tranche = 1% × min(3, 1 + 2×materiality) when sizing=scaled — the
 * size of the story takes the strong position. Exits: tp/stop/session-end (sweep-#4 best shape).
 *
 * Usage: TSDB_HOST_URL=… NEWS_BARS_CACHE=<path> npx ts-node -r tsconfig-paths/register \
 *          --transpile-only scripts/oshal-trading-news-materiality-backtest.ts \
 *          [days] [threshold] [sizing:scaled|flat] [tpPct] [stopPct]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — blind-forward headline-materiality walk (deterministic scorer, pub_date-ordered stream, next-bar entries, materiality-scaled sizing, RTH/overnight cohorts, RESULT json).
 */
import 'dotenv/config';
import * as fs from 'fs';
import { Pool } from 'pg';
import { DEFAULT_UNIVERSE } from '@/features/trading';
import { tickerName } from '../src/features/world-data/ticker-names';

const DAYS = Math.max(3, Number(process.argv[2] || 18));
const THRESHOLD = Number(process.argv[3] || 0.5);
const SIZING = (process.argv[4] || 'scaled').toLowerCase();
const TP_PCT = Number(process.argv[5] || 3);
const STOP_PCT = Number(process.argv[6] || 2);
/** rthOnly=1: only act on headlines PUBLISHED during regular hours — the overnight cohort's gap
 *  already contains the move by the next open (first run: 90 OVN trades took 75% of the loss). */
const RTH_ONLY = String(process.argv[7] || '0') === '1';
/** Optional hard end-cutoff (ISO date): ignore all headlines/bars at/after it. Exists for the
 *  CLEAN-PERIOD rerun — scorer-v2 keywords were tuned on the 07-01..07-10 audit, so numbers that
 *  include that week are upper bounds; the pre-07-01 stretch is the honest test. */
const CUTOFF_MS = process.argv[8] ? Date.parse(process.argv[8]) : Number.MAX_SAFE_INTEGER;
const EQUITY = 100000;
const SLIP = 0.001;
const MAX_POS = 5;
const LATENCY_MS = 5 * 60 * 1000;
const TSDB = process.env.TSDB_HOST_URL || 'postgresql://oshal:oshal@127.0.0.1:55434/oshal_ts';

interface Bar { t: number; o: number; c: number; }
type BarMap = Record<string, Bar[]>;
const isRth = (ms: number): boolean => { const m = new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(); return m >= 810 && m < 1200; };
const et = (ms: number): string => new Date(ms - 4 * 3600 * 1000).toISOString().replace('T', ' ').slice(5, 16) + 'ET';

const DATA_BASE = 'https://data.alpaca.markets/v2';
const envFirst = (...names: string[]): string => { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; };
const KEY = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');

/** Batched, paginated 5-min bar fetch over the window. */
async function fetchFive(symbols: string[], lookbackDays: number): Promise<BarMap> {
  const out: BarMap = Object.fromEntries(symbols.map((s) => [s, []]));
  const start = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  for (let i = 0; i < symbols.length; i += 40) {
    const chunk = symbols.slice(i, i + 40);
    let pageToken = '';
    for (let page = 0; page < 400; page++) {
      const url = `${DATA_BASE}/stocks/bars?symbols=${encodeURIComponent(chunk.join(','))}&timeframe=5Min` +
        `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000&adjustment=all&feed=iex` +
        (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
      const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
      if (!r.ok) throw new Error(`bars HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = (await r.json()) as { bars?: Record<string, Array<{ t: string; o: number; c: number }>>; next_page_token?: string | null };
      for (const [sym, bars] of Object.entries(j.bars || {})) for (const b of bars) out[sym].push({ t: Date.parse(b.t), o: b.o, c: b.c });
      if (!j.next_page_token) break;
      pageToken = j.next_page_token;
    }
  }
  for (const arr of Object.values(out)) arr.sort((a, b) => a.t - b.t);
  return out;
}

/** Deterministic materiality score for one headline. 0 = ignore.
 *  v2 after the first 18-day run's top-10 exposed four defects: listicle "to buy" false-M&A,
 *  "seeks approval" scored as approval, acquirer-side M&A bought (acquirers drop), and the
 *  overnight cohort (handled by the rthOnly arg, not here). */
export function scoreHeadline(title: string, sym: string, reliability: number | null): { score: number; cls: string } {
  const t = ` ${String(title || '').toLowerCase()} `;
  // Opinion/listicle junk is never material, whatever else it matches.
  if (/(is it a buy|should you|better buy|why is|what to know|prediction|price target|is now|vs\.|top \d|best stock|could |might |here's|motley fool|stocks? to (buy|watch)|to buy in \d{4}|too soon to buy|most profitable|reasons? to|bull case|is one of)/.test(t)) return { score: 0, cls: 'opinion' };
  const name = tickerName(sym).toLowerCase();
  let cls = ''; let base = 0;
  // Approval: require a GRANTING verb; seeking/filing is a different (weak) event.
  if (/(seeks?|files?|submits?|applies|awaits|to seek).{0,30}(approval|authorization|clearance)/.test(t)) { cls = 'filing'; base = 0.3; }
  else if (/(fda|ema|regulator|panel).{0,40}(approv|backs|clears|authoriz|recommends|greenlights)/.test(t) || /(wins|receives|granted|gets).{0,20}(approval|clearance|authorization)/.test(t)) { cls = 'approval'; base = 0.9; }
  else if (/(awarded|wins|secures|lands).{0,40}(contract|order|deal)/.test(t) || /contract.{0,30}(award|worth|valued)/.test(t)) { cls = 'contract'; base = 0.8; }
  else if (/(acquir|merger|merges|buyout|takeover|\bto buy [a-z])/.test(t)) {
    // Direction: the TARGET pops; the ACQUIRER pays the premium and usually drops. If our company
    // is named BEFORE the deal verb it is the acquirer — skip. Named after → target → strong.
    const verbIdx = t.search(/(acquir|merger|merges|buyout|takeover|\bto buy [a-z])/);
    const nameIdx = t.indexOf(name);
    if (nameIdx >= 0 && nameIdx < verbIdx) return { score: 0, cls: 'm&a-acquirer' };
    cls = 'm&a'; base = 0.85;
  }
  else if (/(raises|boosts|hikes).{0,30}(guidance|outlook|forecast)/.test(t) || /beats.{0,30}(estimate|expectation)/.test(t)) { cls = 'guidance'; base = 0.7; }
  else if (/(partnership|partners with|launches|unveils|expands into)/.test(t)) { cls = 'launch'; base = 0.4; }
  const dollar = t.match(/\$\s?(\d+(?:\.\d+)?)\s?(billion|bn\b|b\b)/);
  if (dollar && cls !== 'm&a-acquirer' && cls !== 'filing') { base = Math.max(base, 0.5) + Math.min(0.3, Number(dollar[1]) / 20); cls = cls || 'big-dollar'; }
  if (!base) return { score: 0, cls: 'none' };
  const direct = t.includes(name) ? 1.0 : 0.35;   // sector-sweep articles are tagged too
  const rel = reliability == null ? 0.6 : reliability;
  const score = Math.min(1, base * direct * (0.7 + 0.5 * rel));
  return { score: Number(score.toFixed(3)), cls };
}

interface Lot { sym: string; qty: number; entry: number; entryT: number; score: number; cls: string; title: string; overnight: boolean; }
interface Done extends Lot { exit: number; reason: string; }

/** @description Blind-forward walk: pub_date-ordered headlines → scored signals → next-bar entries → tp/stop/EOD exits. */
async function main(): Promise<void> {
  if (!KEY || !SEC) { console.error('FAIL: no Alpaca data keys'); process.exit(1); }
  const symbols = [...DEFAULT_UNIVERSE];
  const cachePath = process.env.NEWS_BARS_CACHE || '';
  let five: BarMap;
  if (cachePath && fs.existsSync(cachePath)) { console.log('Loading tape cache…'); five = JSON.parse(fs.readFileSync(cachePath, 'utf8')); }
  else { console.log(`Fetching 5Min tape (${DAYS + 10}d) for ${symbols.length} names…`); five = await fetchFive(symbols, DAYS + 10); if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(five)); }
  const rth5: Record<string, Bar[]> = {};
  for (const s of symbols) rth5[s] = (five[s] || []).filter((b) => isRth(b.t));

  const startMs = Date.now() - DAYS * 1.55 * 24 * 3600 * 1000; // calendar padding for trading days
  console.log(`Loading headlines since ${new Date(startMs).toISOString().slice(0, 10)} (blind-forward stream)…`);
  const pool = new Pool({ connectionString: TSDB, max: 2 });
  const res = await pool.query(
    `SELECT entity_id, title, reliability, pub_date FROM world_items
      WHERE entity_id LIKE 'world:ticker:%' AND pub_date >= $1 AND pub_date < now()
      ORDER BY pub_date ASC`, [new Date(startMs).toISOString()]);
  await pool.end();
  console.log(`${res.rows.length} headlines in stream.\n`);

  const held = new Map<string, Lot>();
  const done: Done[] = [];
  const recentTitle = new Map<string, Map<string, number>>();  // sym → normTitle → lastMs (48h syndication dedup)
  const lastSignal = new Map<string, number>();                // sym → lastEntry ms (4h re-signal suppression)
  let signals = 0, skippedFull = 0, skippedDup = 0;

  const exitLot = (lot: Lot, exit: number, reason: string) => { done.push({ ...lot, exit, reason }); held.delete(lot.sym); };
  /** Run exits for all held lots up to time tMax (bars strictly after entry, at/before tMax). */
  const runExits = (tMax: number) => {
    for (const lot of [...held.values()]) {
      const bars = rth5[lot.sym].filter((b) => b.t > lot.entryT && b.t <= tMax);
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const sessionEnd = i === bars.length - 1 ? false : new Date(bars[i + 1].t).toISOString().slice(0, 10) !== new Date(b.t).toISOString().slice(0, 10);
        const lastOfDay = new Date(b.t).getUTCHours() * 60 + new Date(b.t).getUTCMinutes() >= 1195; // 19:55Z bar
        let reason = '';
        if (b.c <= lot.entry * (1 - STOP_PCT / 100)) reason = 'stop';
        else if (b.c >= lot.entry * (1 + TP_PCT / 100)) reason = 'take-profit';
        else if (lastOfDay || sessionEnd) reason = 'session-end';
        if (reason) {
          const nb = bars[i + 1] || b;
          exitLot(lot, (reason === 'session-end' ? b.c : nb.o) * (1 - SLIP), reason);
          break;
        }
      }
    }
  };

  for (const row of res.rows) {
    const sym = String(row.entity_id).slice('world:ticker:'.length).toUpperCase();
    if (!rth5[sym] || !rth5[sym].length) continue;
    const pub = new Date(row.pub_date).getTime();
    if (pub >= CUTOFF_MS) break; // clean-period cutoff — the stream is pub_date-ordered
    runExits(pub); // bring the book up to this headline's moment first — strict forward order
    const norm = String(row.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 80);
    const seen = recentTitle.get(sym) || new Map();
    if ((seen.get(norm) || 0) > pub - 48 * 3600 * 1000) { skippedDup++; continue; }
    seen.set(norm, pub); recentTitle.set(sym, seen);
    const { score, cls } = scoreHeadline(String(row.title), sym, row.reliability == null ? null : Number(row.reliability));
    if (score < THRESHOLD) continue;
    signals++;
    if ((lastSignal.get(sym) || 0) > pub - 4 * 3600 * 1000) { skippedDup++; continue; }
    if (held.has(sym)) continue;
    if (held.size >= MAX_POS) { skippedFull++; continue; }
    if (RTH_ONLY && !isRth(pub)) continue;
    const entryBar = rth5[sym].find((b) => b.t >= pub + LATENCY_MS);
    if (!entryBar) continue;
    const overnight = !isRth(pub) || new Date(entryBar.t).toISOString().slice(0, 10) !== new Date(pub).toISOString().slice(0, 10);
    if (RTH_ONLY && overnight) continue;
    const tranchePct = SIZING === 'scaled' ? Math.min(3, 1 + 2 * score) : 1;
    const fill = entryBar.o * (1 + SLIP);
    const qty = Math.floor((tranchePct / 100) * EQUITY / fill);
    if (qty < 1) continue;
    lastSignal.set(sym, pub);
    held.set(sym, { sym, qty, entry: fill, entryT: entryBar.t, score, cls, title: String(row.title).slice(0, 80), overnight });
  }
  runExits(Math.min(Date.now(), CUTOFF_MS));
  for (const lot of [...held.values()]) {
    const bars = rth5[lot.sym].filter((b) => b.t <= CUTOFF_MS);
    exitLot(lot, (bars.length ? bars[bars.length - 1].c : lot.entry) * (1 - SLIP), 'window-end');
  }

  const pnl = (t: Done): number => (t.exit - t.entry) * t.qty;
  const total = done.reduce((s, t) => s + pnl(t), 0);
  const rth = done.filter((t) => !t.overnight); const ovn = done.filter((t) => t.overnight);
  const sub = (arr: Done[]): string => `${arr.length} trades, win ${arr.length ? Math.round((arr.filter((t) => t.exit > t.entry).length / arr.length) * 100) : 0}%, net $${arr.reduce((s, t) => s + pnl(t), 0).toFixed(0)}`;
  const byCls: Record<string, { n: number; pnl: number }> = {};
  for (const t of done) { const c = byCls[t.cls] || { n: 0, pnl: 0 }; c.n++; c.pnl += pnl(t); byCls[t.cls] = c; }

  console.log('─── ten biggest absolute outcomes ───');
  for (const t of [...done].sort((a, b) => Math.abs(pnl(b)) - Math.abs(pnl(a))).slice(0, 10)) {
    console.log(` ${t.sym.padEnd(5)} ${et(t.entryT)} ${(((t.exit - t.entry) / t.entry) * 100).toFixed(2).padStart(6)}% $${pnl(t).toFixed(0).padStart(5)} [${t.cls}/${t.score}] ${t.reason}${t.overnight ? ' OVN' : ''} "${t.title}"`);
  }
  console.log('───────────────────────────────────────────────');
  console.log(` Headlines streamed : ${res.rows.length}  → signals ≥${THRESHOLD}: ${signals} (${skippedDup} dup-suppressed, ${skippedFull} book-full)`);
  console.log(` All trades         : ${sub(done)}  (${((total / EQUITY) * 100).toFixed(3)}% of book)`);
  console.log(` RTH cohort         : ${sub(rth)}`);
  console.log(` Overnight cohort   : ${sub(ovn)}`);
  console.log(` By event class     : ${JSON.stringify(Object.fromEntries(Object.entries(byCls).map(([k, v]) => [k, `${v.n}/$${v.pnl.toFixed(0)}`])))}`);
  console.log(`RESULT ${JSON.stringify({ days: DAYS, threshold: THRESHOLD, sizing: SIZING, tpPct: TP_PCT, stopPct: STOP_PCT, rthOnly: RTH_ONLY, headlines: res.rows.length, signals, skippedDup, skippedFull, trades: done.length, winRatePct: done.length ? Number(((done.filter((t) => t.exit > t.entry).length / done.length) * 100).toFixed(0)) : 0, netPnlUsd: Number(total.toFixed(2)), pctOfBook: Number(((total / EQUITY) * 100).toFixed(3)), rthTrades: rth.length, rthNet: Number(rth.reduce((s, t) => s + pnl(t), 0).toFixed(2)), ovnTrades: ovn.length, ovnNet: Number(ovn.reduce((s, t) => s + pnl(t), 0).toFixed(2)), byCls: Object.fromEntries(Object.entries(byCls).map(([k, v]) => [k, { n: v.n, pnl: Number(v.pnl.toFixed(0)) }])) })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('backtest failed:', e); process.exit(1); });
