/**
 * Rotation-sleeve backtest — the FIRST backtest of the gravity-ranked rotation that owned the
 * production sleeve from 2026-06-30 (TRADING_SLEEVE_ROTATION) until it was turned off 2026-07-10.
 *
 * Uses the REAL production ranking function (rankUniverse, exported from trading-schedule-dispatch)
 * so gravity/momentum/ensemble/blend rank exactly as the dispatcher ranked. Walk mirrors
 * rotateSleeve: every cadence days rank the universe on closes-to-date, hold the top-N positive
 * scores, sell dropouts, rebalance survivors/new leaders toward their goal weight (conviction =
 * score share of the sleeve budget capped at the posture per-name %; equal = budget/N). Protective
 * exits (stop/take-profit/trailing) run every day at the close, like production's per-fire exits.
 *
 * NOTE the structural cap this exposes: with the active posture (maxPerNamePct 3) and topN 12, the
 * rotation book can never deploy more than ~36% of equity — the scan sleeve it replaced could build
 * up to 32 names (~96%). Deployment drag, not ranking skill, may dominate any comparison.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only \
 *          scripts/oshal-trading-rotation-backtest.ts [rank] [cadenceDays] [topN] [weighting] [posture] [warmup] [tails]
 *   rank = gravity|momentum|ensemble|blend, weighting = conviction|equal, tails = "5,21,63,126"
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — production rankUniverse over daily closes, rotateSleeve-faithful rebalance + daily protective exits, multi-horizon tail segments, RESULT json line.
 */
import 'dotenv/config';
import { DEFAULT_UNIVERSE } from '@/features/trading';
import { rankUniverse } from '../src/app/trading-schedule-dispatch';
import { exitsToRun, trailingExits, nextPeaks, RISK_POLICIES, type RiskPosture } from '../src/features/trading/services/portfolio';
import type { Position } from '../src/features/trading/services/broker-adapter';

const RANK = (process.argv[2] || 'blend').toLowerCase();
const CADENCE = Math.max(1, Number(process.argv[3] || 1));
const TOP_N = Math.max(1, Number(process.argv[4] || 12));
const WEIGHTING = (process.argv[5] || 'conviction').toLowerCase();
const POSTURE = (process.argv[6] as RiskPosture) || 'active';
const WARMUP = Number(process.argv[7] || 80); // rankUniverse needs 60+ closes
const TAIL_LIST = String(process.argv[8] || '').split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
const START_CASH = 100000;
const policy = RISK_POLICIES[POSTURE] ?? RISK_POLICIES.balanced;

const DATA_BASE = 'https://data.alpaca.markets/v2';
const envFirst = (...names: string[]): string => { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; };
const KEY = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');

/** Fetch ~2y of daily closes per symbol (feed=iex, adjustment=all), batched + paginated. */
async function fetchCloses(symbols: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>(symbols.map((s) => [s, []]));
  const start = new Date(Date.now() - 800 * 24 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    let pageToken = '';
    for (let page = 0; page < 60; page++) {
      const url = `${DATA_BASE}/stocks/bars?symbols=${encodeURIComponent(chunk.join(','))}&timeframe=1Day` +
        `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000&adjustment=all&feed=iex` +
        (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
      const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
      if (!r.ok) throw new Error(`bars HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = (await r.json()) as { bars?: Record<string, Array<{ c: number }>>; next_page_token?: string | null };
      for (const [sym, bars] of Object.entries(j.bars || {})) {
        const arr = out.get(sym) || [];
        for (const b of bars) arr.push(b.c);
        out.set(sym, arr);
      }
      if (!j.next_page_token) break;
      pageToken = j.next_page_token;
    }
  }
  return out;
}

interface Lot { qty: number; entry: number; peak: number; }

/** @description Walk the production rotation strategy over daily closes. */
async function main(): Promise<void> {
  if (!KEY || !SEC) { console.error('FAIL: no Alpaca data keys in env'); process.exit(1); }
  console.log(`Loading daily closes for ${DEFAULT_UNIVERSE.length} names + SPY…`);
  const raw = await fetchCloses([...DEFAULT_UNIVERSE, 'SPY']);
  const spyRaw = raw.get('SPY') || [];
  const names = [...raw].filter(([s]) => s !== 'SPY');
  const maxLen = Math.max(...names.map(([, c]) => c.length), spyRaw.length);
  const len = Math.min(maxLen, spyRaw.length);
  if (len < WARMUP + 10) { console.error(`Not enough history (${len} bars).`); process.exit(1); }
  const series = new Map(names.filter(([, c]) => c.length >= len).map(([s, c]) => [s, c.slice(-len)]));
  const spy = spyRaw.slice(-len);
  console.log(`Window: ${len} days, rank=${RANK}, cadence=${CADENCE}d, topN=${TOP_N}, weighting=${WEIGHTING}, posture=${POSTURE}, warmup=${WARMUP}.\n`);

  const book = new Map<string, Lot>();
  let cash = START_CASH, peakEquity = START_CASH, maxDD = 0, wins = 0, losses = 0, trades = 0;
  const equityCurve: number[] = [];
  const px = (sym: string, t: number): number => series.get(sym)![t];
  const emptyCore = new Set<string>();

  for (let t = WARMUP; t < len; t++) {
    const exiting = new Set<string>();
    const sellAt = (sym: string, p: number) => {
      const lot = book.get(sym); if (!lot) return;
      cash += lot.qty * p; (p >= lot.entry ? () => wins++ : () => losses++)(); trades++; book.delete(sym); exiting.add(sym);
    };

    // Daily protective exits at the close (production's per-fire stop/take-profit/trailing).
    const positions: Position[] = [...book].map(([sym, lot]) => {
      const p = px(sym, t);
      return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: p, marketValue: lot.qty * p, unrealizedPl: lot.qty * (p - lot.entry) };
    });
    const peaks = nextPeaks(positions, new Map([...book].map(([s, l]) => [s, l.peak])));
    for (const [s, p] of peaks) { const l = book.get(s); if (l) l.peak = p; }
    for (const e of [...exitsToRun(positions, policy), ...trailingExits(positions, peaks, policy)]) {
      if (!exiting.has(e.symbol)) sellAt(e.symbol, px(e.symbol, t));
    }

    // Rotation rebalance on the cadence — the production rotateSleeve shape.
    if ((t - WARMUP) % CADENCE === 0) {
      const barsToT = new Map([...series].map(([s, c]) => [s, c.slice(0, t + 1)]));
      const ranked = rankUniverse(RANK, barsToT, emptyCore);
      ranked.sort((a, b) => b.score - a.score);
      const target = ranked.filter((r) => r.score > 0).slice(0, TOP_N);
      const targetSet = new Set(target.map((r) => r.sym));
      // Sell every held name that dropped off the leaderboard.
      for (const sym of [...book.keys()]) { if (!targetSet.has(sym) && !exiting.has(sym)) sellAt(sym, px(sym, t)); }
      // Rebalance toward goals: conviction = score share of budget capped at per-name %; equal = budget/N.
      const equityNow = cash + [...book].reduce((s, [sym, lot]) => s + lot.qty * px(sym, t), 0);
      const perName = (policy.maxPerNamePct / 100) * equityNow;
      const scoreSum = target.reduce((s, r) => s + Math.max(0, r.score), 0);
      const dust = equityNow * 0.005;
      for (const r of target) {
        const goal = WEIGHTING === 'conviction' && scoreSum > 0
          ? Math.min(perName, (Math.max(0, r.score) / scoreSum) * equityNow)
          : Math.min(perName, equityNow / Math.max(1, TOP_N));
        const p = px(r.sym, t);
        const cur = book.has(r.sym) ? book.get(r.sym)!.qty * p : 0;
        if (goal - cur > dust) {
          const qty = Math.floor(Math.min(goal - cur, cash) / p);
          if (qty >= 1) {
            const lot = book.get(r.sym);
            if (lot) { lot.entry = (lot.entry * lot.qty + p * qty) / (lot.qty + qty); lot.qty += qty; lot.peak = Math.max(lot.peak, p); }
            else book.set(r.sym, { qty, entry: p, peak: p });
            cash -= qty * p;
          }
        } else if (cur - goal > dust) {
          const lot = book.get(r.sym)!;
          const qty = Math.min(lot.qty, Math.floor((cur - goal) / p));
          if (qty >= 1) { cash += qty * p; lot.qty -= qty; trades++; (p >= lot.entry ? () => wins++ : () => losses++)(); if (lot.qty === 0) book.delete(r.sym); }
        }
      }
    }

    const equity = cash + [...book].reduce((s, [sym, lot]) => s + lot.qty * px(sym, t), 0);
    equityCurve.push(equity);
    peakEquity = Math.max(peakEquity, equity);
    maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
  }

  const last = len - 1;
  for (const [sym, lot] of book) cash += lot.qty * px(sym, last);
  const finalEquity = cash;
  const ret = (finalEquity / START_CASH - 1) * 100;
  const spyRet = (spy[last] / spy[WARMUP] - 1) * 100;
  const rets = equityCurve.slice(1).map((e, i) => e / equityCurve[i] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(252);

  console.log('───────────────────────────────────────────────');
  console.log(` Rotation ${RANK}/${CADENCE}d/top${TOP_N}/${WEIGHTING} (${POSTURE})`);
  console.log(` Strategy return   : ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`);
  console.log(` SPY buy & hold    : ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(1)}%`);
  console.log(` Max drawdown      : -${(maxDD * 100).toFixed(1)}%`);
  console.log(` Sharpe (annualized): ${sharpe.toFixed(2)}`);
  console.log(` Closed trades     : ${trades}  (win rate ${trades ? ((wins / (wins + losses)) * 100).toFixed(0) : 0}%)`);
  const tails: Array<{ days: number; retPct: number; spyPct: number }> = [];
  for (const n of TAIL_LIST) {
    if (equityCurve.length <= n) continue;
    const eq0 = equityCurve[equityCurve.length - 1 - n];
    const tailRet = (equityCurve[equityCurve.length - 1] / eq0 - 1) * 100;
    const tailSpy = (spy[last] / spy[last - n] - 1) * 100;
    tails.push({ days: n, retPct: Number(tailRet.toFixed(2)), spyPct: Number(tailSpy.toFixed(2)) });
    console.log(` Last ${n} days       : ${tailRet >= 0 ? '+' : ''}${tailRet.toFixed(2)}%   (SPY ${tailSpy >= 0 ? '+' : ''}${tailSpy.toFixed(2)}%)`);
  }
  console.log('───────────────────────────────────────────────');
  console.log(`RESULT ${JSON.stringify({ strategy: `rotation-${RANK}`, cadence: CADENCE, topN: TOP_N, weighting: WEIGHTING, posture: POSTURE, warmup: WARMUP, days: len - WARMUP, retPct: Number(ret.toFixed(2)), spyPct: Number(spyRet.toFixed(2)), maxDDPct: Number((maxDD * 100).toFixed(2)), sharpe: Number(sharpe.toFixed(2)), trades, winRatePct: trades ? Number(((wins / (wins + losses)) * 100).toFixed(0)) : 0, tails })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('backtest failed:', e); process.exit(1); });
