/**
 * Pop-catcher INTRADAY backtest — the first honest test of TRADING_POP_CATCHER (default OFF).
 *
 * The pop-catcher keys off 5-minute decisions the daily-bar harnesses cannot see, so this walks
 * the REAL production entry rule over the actual 5-minute IEX tape:
 *   entry  — not held, overall multi-timeframe score > 0, isShortTermPop (5Min leg: ≥12 bars,
 *            action buy, score ≥ threshold); strongest surges first; tranche % of equity from
 *            cash; max concurrent positions. Fill at the NEXT 5-min bar's open + slippage
 *            (no lookahead — production reacts on the fire after the bar completes).
 *   exits  — the step-1 protection every 5-min step: hard stop / take-profit / trailing
 *            (posture dials) + the isShortTermBreakdown fast exit; fills next-bar open − slippage.
 *            Positions still open at the window's end liquidate at the final close (reported).
 * Timeframes fed to decideSymbol as-of each step: 5Min (real bars), 1Hour (real bars), 1Day
 * (real bars), 1Week/3Month resampled from daily — the harness convention.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only \
 *          scripts/oshal-trading-pop-backtest.ts [tradingDays] [threshold] [tranchePct] [maxPos]
 * Env: POP_BARS_CACHE=<path> caches the fetched bars so a threshold sweep fetches once.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — intraday 5-min walk of the production pop-catcher entry rule + step-1 exits, no-lookahead next-bar fills, bar cache for sweeps, RESULT json.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { DEFAULT_UNIVERSE, type Timeframe } from '@/features/trading';
import { decideSymbol, isShortTermPop, isShortTermBreakdown } from '../src/features/trading/services/multi-timeframe';
import { RISK_POLICIES } from '../src/features/trading/services/portfolio';

const DAYS = Math.max(2, Number(process.argv[2] || 7));
const THRESHOLD = Number(process.argv[3] || 0.34);
const TRANCHE_PCT = Number(process.argv[4] || 1);
const MAX_POS = Number(process.argv[5] || 5);
// Optional FAST-WIN variant dials (defaults = the production posture behavior):
//   argv[6] tpPct, argv[7] stopPct, argv[8] maxHoldMin (0 = no time stop).
const EQUITY = 100000;
const SLIP = 0.001; // 0.1% marketable-limit slippage each side
const base = RISK_POLICIES.active;
const policy = {
  ...base,
  takeProfitPct: Number(process.argv[6]) > 0 ? Number(process.argv[6]) : base.takeProfitPct,
  stopLossPct: Number(process.argv[7]) > 0 ? Number(process.argv[7]) : base.stopLossPct,
};
const MAX_HOLD_MIN = Math.max(0, Number(process.argv[8] || 0));

const DATA_BASE = 'https://data.alpaca.markets/v2';
const envFirst = (...names: string[]): string => { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; };
const KEY = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');

interface Bar { t: number; o: number; c: number; }
type BarMap = Record<string, Bar[]>;

/** Batched, paginated bar fetch for one timeframe over a lookback window. */
async function fetchBars(symbols: string[], timeframe: string, lookbackDays: number): Promise<BarMap> {
  const out: BarMap = Object.fromEntries(symbols.map((s) => [s, []]));
  const start = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    let pageToken = '';
    for (let page = 0; page < 200; page++) {
      const url = `${DATA_BASE}/stocks/bars?symbols=${encodeURIComponent(chunk.join(','))}&timeframe=${timeframe}` +
        `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000&adjustment=all&feed=iex` +
        (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
      const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
      if (!r.ok) throw new Error(`bars ${timeframe} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = (await r.json()) as { bars?: Record<string, Array<{ t: string; o: number; c: number }>>; next_page_token?: string | null };
      for (const [sym, bars] of Object.entries(j.bars || {})) {
        for (const b of bars) out[sym].push({ t: Date.parse(b.t), o: b.o, c: b.c });
      }
      if (!j.next_page_token) break;
      pageToken = j.next_page_token;
    }
  }
  for (const arr of Object.values(out)) arr.sort((a, b) => a.t - b.t);
  return out;
}

const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);
/** RTH filter: bar start within 13:30–19:55 UTC (9:30–15:55 ET during EDT). */
const isRth = (ms: number): boolean => { const m = new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(); return m >= 810 && m < 1200; };

interface PopLot { sym: string; qty: number; entry: number; peak: number; entryT: number; }
interface Trade { sym: string; entry: number; exit: number; qty: number; reason: string; holdMin: number; }

/** @description Walk the production pop-catcher over the last N trading days of 5-minute tape. */
async function main(): Promise<void> {
  if (!KEY || !SEC) { console.error('FAIL: no Alpaca data keys in env'); process.exit(1); }
  const symbols = [...DEFAULT_UNIVERSE, 'SPY'];
  const cachePath = process.env.POP_BARS_CACHE || '';
  let five: BarMap, hour: BarMap, day: BarMap;
  if (cachePath && fs.existsSync(cachePath)) {
    console.log(`Loading bars from cache ${cachePath}…`);
    ({ five, hour, day } = JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  } else {
    console.log(`Fetching 5Min (${DAYS + 7}d) + 1Hour (70d) + 1Day (400d) bars for ${symbols.length} names…`);
    five = await fetchBars(symbols, '5Min', DAYS + 7);
    hour = await fetchBars(symbols, '1Hour', 70);
    day = await fetchBars(symbols, '1Day', 400);
    if (cachePath) fs.writeFileSync(cachePath, JSON.stringify({ five, hour, day }));
  }

  // The step clock: SPY's RTH 5-min bars over the last DAYS trading days.
  const spy5 = (five.SPY || []).filter((b) => isRth(b.t));
  const dayKeys = [...new Set(spy5.map((b) => new Date(b.t).toISOString().slice(0, 10)))].sort();
  const walkDays = dayKeys.slice(-DAYS);
  const steps = spy5.filter((b) => walkDays.includes(new Date(b.t).toISOString().slice(0, 10)));
  if (steps.length < 50) { console.error(`Not enough 5-min steps (${steps.length}).`); process.exit(1); }
  console.log(`Walk: ${walkDays.length} trading days (${walkDays[0]} → ${walkDays[walkDays.length - 1]}), ${steps.length} five-minute steps, threshold ${THRESHOLD}, tranche ${TRANCHE_PCT}%, max ${MAX_POS}.\n`);

  // Per-symbol RTH 5-min series + index-by-time for as-of slicing and next-bar fills.
  const rth5: Record<string, Bar[]> = {};
  for (const s of symbols) rth5[s] = (five[s] || []).filter((b) => isRth(b.t));

  const held = new Map<string, PopLot>();
  const trades: Trade[] = [];
  let signals = 0, skippedFull = 0;
  const tranche = (TRANCHE_PCT / 100) * EQUITY;

  for (let si = 0; si < steps.length - 1; si++) {
    const now = steps[si].t;
    const nextT = steps[si + 1].t;
    // Decisions as-of this step for every symbol (bars completed at/before now).
    const surges: Array<{ sym: string; score: number; d: ReturnType<typeof decideSymbol> }> = [];
    for (const sym of DEFAULT_UNIVERSE) {
      const f5 = rth5[sym]; if (!f5 || !f5.length) continue;
      const asOf5 = f5.filter((b) => b.t <= now).slice(-220).map((b) => b.c);
      if (asOf5.length < 12) continue;
      const asOfH = (hour[sym] || []).filter((b) => b.t <= now).slice(-200).map((b) => b.c);
      const dayAll = (day[sym] || []).filter((b) => b.t < now - 16 * 3600 * 1000).map((b) => b.c);
      const tf = new Map<Timeframe, number[]>([
        ['5Min', asOf5], ['1Hour', asOfH], ['1Day', dayAll.slice(-220)],
        ['1Week', resample(dayAll, 5).slice(-60)], ['3Month', resample(dayAll, 63).slice(-40)],
      ]);
      const d = decideSymbol(sym, tf);
      // Exits for held names use the same decision (breakdown check below).
      const lot = held.get(sym);
      if (lot) {
        const px = asOf5[asOf5.length - 1];
        lot.peak = Math.max(lot.peak, px);
        const stopLvl = lot.entry * (1 - policy.stopLossPct / 100);
        const tpLvl = lot.entry * (1 + policy.takeProfitPct / 100);
        const armed = lot.peak >= lot.entry * (1 + policy.trailArmPct / 100);
        const trailLvl = armed ? lot.peak * (1 - policy.trailGivebackPct / 100) : 0;
        let reason = '';
        if (px <= Math.max(stopLvl, trailLvl)) reason = trailLvl > stopLvl ? 'trail' : 'stop';
        else if (px >= tpLvl) reason = 'take-profit';
        else if (isShortTermBreakdown(d)) reason = 'breakdown';
        else if (MAX_HOLD_MIN > 0 && now - lot.entryT >= MAX_HOLD_MIN * 60000) reason = 'time-stop';
        if (reason) {
          const nb = rth5[sym].find((b) => b.t >= nextT);
          const fill = (nb ? nb.o : px) * (1 - SLIP);
          trades.push({ sym, entry: lot.entry, exit: fill, qty: lot.qty, reason, holdMin: Math.round((now - lot.entryT) / 60000) });
          held.delete(sym);
        }
        continue; // held names are not entry candidates
      }
      if (d.score > 0 && isShortTermPop(d, THRESHOLD)) surges.push({ sym, score: d.score, d });
    }
    // Entries: strongest first, capped.
    surges.sort((a, b) => b.score - a.score);
    for (const s of surges) {
      signals++;
      if (held.size >= MAX_POS) { skippedFull++; continue; }
      const nb = rth5[s.sym].find((b) => b.t >= nextT);
      if (!nb) continue;
      const fill = nb.o * (1 + SLIP);
      const qty = Math.floor(tranche / fill);
      if (qty < 1) continue;
      held.set(s.sym, { sym: s.sym, qty, entry: fill, peak: fill, entryT: nextT });
    }
  }
  // Liquidate whatever is still open at the final close.
  const lastStep = steps[steps.length - 1].t;
  for (const lot of held.values()) {
    const f5 = rth5[lot.sym].filter((b) => b.t <= lastStep);
    const px = (f5.length ? f5[f5.length - 1].c : lot.entry) * (1 - SLIP);
    trades.push({ sym: lot.sym, entry: lot.entry, exit: px, qty: lot.qty, reason: 'window-end', holdMin: Math.round((lastStep - lot.entryT) / 60000) });
  }

  const pnl = trades.reduce((s, t) => s + (t.exit - t.entry) * t.qty, 0);
  const wins = trades.filter((t) => t.exit > t.entry);
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  const spyRet = (steps[steps.length - 1].c / steps[0].o - 1) * 100;
  const avgHold = trades.length ? Math.round(trades.reduce((s, t) => s + t.holdMin, 0) / trades.length) : 0;

  console.log('───────────────────────────────────────────────');
  console.log(` Pop signals       : ${signals}  (${skippedFull} skipped: book full)`);
  console.log(` Trades closed     : ${trades.length}  (win rate ${trades.length ? ((wins.length / trades.length) * 100).toFixed(0) : 0}%)  avg hold ${avgHold} min`);
  console.log(` Exit reasons      : ${JSON.stringify(byReason)}`);
  console.log(` Net P&L           : $${pnl.toFixed(2)}  (${((pnl / EQUITY) * 100).toFixed(3)}% of the $${EQUITY.toLocaleString()} book at ${TRANCHE_PCT}% tranches)`);
  console.log(` SPY same window   : ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(2)}%`);
  console.log('───────────────────────────────────────────────');
  console.log(`RESULT ${JSON.stringify({ days: walkDays.length, threshold: THRESHOLD, tranchePct: TRANCHE_PCT, maxPos: MAX_POS, tpPct: policy.takeProfitPct, stopPct: policy.stopLossPct, maxHoldMin: MAX_HOLD_MIN, signals, skippedFull, trades: trades.length, winRatePct: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(0)) : 0, netPnlUsd: Number(pnl.toFixed(2)), pctOfBook: Number(((pnl / EQUITY) * 100).toFixed(3)), avgHoldMin: avgHold, byReason, spyPct: Number(spyRet.toFixed(2)) })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('backtest failed:', e); process.exit(1); });
