/**
 * Stop-width backtest — the stop-loss dial drawn as a curve, plus volatility-scaled stops.
 *
 * Two operator questions from the 2026-07-09 pre-open review, answered with one walk:
 *  1. "Why -5 and not -3 (or -1)?" → walk the SAME long engine with flat stops at 3/4/5/6/8/10%
 *     and show return vs drawdown vs churn at each setting — choose a point on a visible curve.
 *  2. "Holding a volatile stock — that needs to be a factor." → per-name stops scaled to each
 *     name's OWN volatility. Two pre-registered variants:
 *       V1: stop_i = clamp(2.5 × σ20_i, 3%, 10%) set AT ENTRY (σ20 = stddev of the prior 20 daily
 *           returns) — take-profit stays +8% (isolates the stop variable).
 *       V2: same stop_i, take-profit = 1.6 × stop_i (preserves the current 8:5 reward:risk shape).
 *     2.5σ and the 3-10 clamp are classic values declared BEFORE running — not fitted. If V1/V2
 *     don't beat flat-5 on risk-adjusted terms, the honest answer is "the factor doesn't pay here",
 *     not a search for a k that makes it pay.
 *
 * Mechanics: date-aligned multi-year walk (the short-strategy harness pattern) with the LONG
 * engine's logic — decideSymbol entries (8/day, confidence-ranked), sizeEntry sizing, trailing
 * exits (arm 5% / giveback 3%, same for all books), technical sells on signal flip, rotation
 * benches — identical across books; ONLY the hard-stop/TP rule differs per book. Sizing stays on
 * the active policy for every book so the comparison isolates the exit rule. Fills at close,
 * no slippage/commission. Books diverge in holdings over time (different exits → different books)
 * — inherent to comparing full simulations, not a bug.
 *
 * HONEST LIMITS: same as the sibling harnesses — IEX free history (floor ~2020-07-27), survivors-
 * only universe, same-close fills, single window (n≈2 bear episodes), and this is decision support
 * for a RISK PREFERENCE (which point on the curve), not alpha mining. Whatever wins here still
 * goes through paper before live (live==paper parity rule).
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-stop-width-backtest.ts
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — 8 books (flat stops 3/4/5/6/8/10 + vol-scaled V1/V2) over the full free-IEX window, identical entries/sizing/trailing/rotation, per-book return/maxDD/sharpe/trades/stop-outs/win-rate. Built overnight on the operator's "volatility needs to be a factor" — evidence before any live change.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Verification-workflow fixes: (1) CRITICAL — resample() time-reversal (see the long harness entry; one token: drop .reverse()); (2) trailing arm now matches the live engine (arms on CURRENT gain >= trailArmPct like portfolio.ts trailingExits, not on peak — the inline version was tighter and inflated churn); (3) scratch exits (pnl==0) now count as wins matching every sibling harness's convention. Book-vs-book ranking was unbiased (shared inputs); absolute numbers change — re-run.
 */
import 'dotenv/config';
import { barsBatchSince, DEFAULT_UNIVERSE, type DatedClose } from '@/features/trading';
import { decideSymbol, type MtfDecision } from '../src/features/trading/services/multi-timeframe';
import { sizeEntry, rotationBenches, RISK_POLICIES, type NameStrength } from '../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../src/features/trading/services/broker-adapter';

const START_ISO = '2020-07-01';
const REPORT_FROM = '2021-06-01';
const START_CASH = 100_000;
const MAX_NEW_PER_DAY = 8;
const policy = RISK_POLICIES.active; // sizing/caps/trailing — identical for every book
const TRAIL_ARM = policy.trailArmPct;          // 5
const TRAIL_GIVEBACK = policy.trailGivebackPct; // 3
/** Vol-scaled stop constants — declared before running, classic values, no fitting. */
const VOL_K = 2.5;
const VOL_MIN = 3, VOL_MAX = 10;
const TP_FLAT = 8;
const V2_TP_RATIO = 1.6; // preserves the current 8:5 reward:risk

const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);

/** σ of the last n daily returns (percent). Null when the window is short. */
function sigmaPct(closes: number[], n = 20): number | null {
  if (closes.length < n + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) rets.push((closes[i] / closes[i - 1] - 1) * 100);
  const m = rets.reduce((s, r) => s + r, 0) / n;
  return Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / n);
}

interface Lot { qty: number; entry: number; peak: number; stopPct: number; tpPct: number; }
interface Book {
  name: string;
  /** Stop/TP assigner at entry: returns {stopPct, tpPct} given the name's window at entry. */
  exitRule: (win: number[]) => { stopPct: number; tpPct: number };
  cash: number; lots: Map<string, Lot>;
  curve: number[]; peak: number; maxDD: number;
  wins: number; losses: number; trades: number; stopOuts: number;
}
const mkFlat = (stop: number): Book => ({
  name: `flat ${stop}% stop / ${TP_FLAT}% TP${stop === 5 ? '  ← current live' : ''}`,
  exitRule: () => ({ stopPct: stop, tpPct: TP_FLAT }),
  cash: START_CASH, lots: new Map(), curve: [], peak: START_CASH, maxDD: 0, wins: 0, losses: 0, trades: 0, stopOuts: 0,
});
const volStop = (win: number[]): number => {
  const s = sigmaPct(win);
  return s == null ? 5 : Math.min(VOL_MAX, Math.max(VOL_MIN, VOL_K * s));
};

async function main(): Promise<void> {
  console.log(`Loading daily bars since ${START_ISO} for ${DEFAULT_UNIVERSE.length} names + SPY…`);
  const bars = await barsBatchSince([...DEFAULT_UNIVERSE, 'SPY'], START_ISO);
  const spySeries = bars.get('SPY') || [];
  const calendar = spySeries.map((b) => b.d);
  const t0 = calendar.findIndex((d) => d >= REPORT_FROM);
  if (t0 < 200) { console.error(`Insufficient warmup (${t0} sessions before ${REPORT_FROM}).`); process.exit(1); }
  const nameSeries = new Map<string, DatedClose[]>();
  const nameIdxByDate = new Map<string, Map<string, number>>();
  for (const [sym, arr] of bars) {
    if (sym === 'SPY' || arr.length < 260) continue;
    nameSeries.set(sym, arr);
    nameIdxByDate.set(sym, new Map(arr.map((b, i) => [b.d, i])));
  }
  const spy = spySeries.map((b) => b.c);
  console.log(`Window: ${calendar[t0]} → ${calendar[calendar.length - 1]} (${calendar.length - t0} sessions), ${nameSeries.size} names.\n`);

  const books: Book[] = [
    mkFlat(3), mkFlat(4), mkFlat(5), mkFlat(6), mkFlat(8), mkFlat(10),
    { name: `V1 vol-scaled stop (2.5σ20, clamp ${VOL_MIN}-${VOL_MAX}%) / ${TP_FLAT}% TP`,
      exitRule: (win) => ({ stopPct: volStop(win), tpPct: TP_FLAT }),
      cash: START_CASH, lots: new Map(), curve: [], peak: START_CASH, maxDD: 0, wins: 0, losses: 0, trades: 0, stopOuts: 0 },
    { name: `V2 vol-scaled stop + TP = ${V2_TP_RATIO}× stop (keeps 8:5 shape)`,
      exitRule: (win) => { const s = volStop(win); return { stopPct: s, tpPct: V2_TP_RATIO * s }; },
      cash: START_CASH, lots: new Map(), curve: [], peak: START_CASH, maxDD: 0, wins: 0, losses: 0, trades: 0, stopOuts: 0 },
  ];

  const lastClose = new Map<string, number>();

  for (let t = 0; t < calendar.length; t++) {
    const date = calendar[t];
    // Windows + decisions once per day, shared by every book (books differ only in exits).
    const windows = new Map<string, number[]>();
    for (const [sym, idx] of nameIdxByDate) {
      const i = idx.get(date);
      if (i == null) continue;
      const arr = nameSeries.get(sym)!;
      lastClose.set(sym, arr[i].c);
      windows.set(sym, arr.slice(0, i + 1).map((b) => b.c));
    }
    if (t < t0) continue;
    const decisions = new Map<string, MtfDecision>();
    for (const [sym, win] of windows) {
      const tf = new Map([['1Day', win.slice(-220)], ['1Week', resample(win, 5).slice(-60)], ['3Month', resample(win, 63).slice(-40)]] as [import('@/features/trading').Timeframe, number[]][]);
      decisions.set(sym, decideSymbol(sym, tf));
    }
    const strength = new Map<string, NameStrength>([...decisions].map(([s, d]) => [s, { score: d.score, action: d.action }]));

    for (const book of books) {
      const px = (sym: string): number | undefined => windows.get(sym)?.slice(-1)[0];
      const mark = (sym: string): number => px(sym) ?? lastClose.get(sym) ?? 0;
      const sell = (sym: string, p: number, stopped = false) => {
        const lot = book.lots.get(sym); if (!lot) return;
        const pnl = lot.qty * (p - lot.entry);
        book.cash += lot.qty * p;
        if (pnl >= 0) book.wins++; else book.losses++; // scratch = win, matching every sibling harness
        if (stopped) book.stopOuts++;
        book.trades++;
        book.lots.delete(sym);
      };

      // Exits — per-lot stop/TP (assigned at entry), then trailing, then signal sells, then rotation.
      for (const [sym, lot] of [...book.lots]) {
        const p = px(sym); if (p == null) continue; // not trading today
        lot.peak = Math.max(lot.peak, p);
        const plPct = ((p - lot.entry) / lot.entry) * 100;
        // Arm on CURRENT gain — the live engine's trailingExits semantics (portfolio.ts), not
        // peak-based arming: the price must still be +trailArm% when the giveback fires.
        const armed = plPct >= TRAIL_ARM;
        const gaveBack = ((lot.peak - p) / lot.peak) * 100 >= TRAIL_GIVEBACK;
        if (plPct <= -lot.stopPct) sell(sym, p, true);
        else if (plPct >= lot.tpPct) sell(sym, p);
        else if (armed && gaveBack) sell(sym, p);
        else if (decisions.get(sym)?.action === 'sell') sell(sym, p);
      }
      const positions: Position[] = [...book.lots].map(([sym, lot]) => {
        const p = mark(sym);
        return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: p, marketValue: lot.qty * p, unrealizedPl: lot.qty * (p - lot.entry) };
      });
      for (const b of rotationBenches(positions, strength, policy)) {
        const p = px(b.symbol); if (p != null) sell(b.symbol, p);
      }

      // Entries — identical candidate ranking for all books; stop/TP assigned by the book's rule.
      const remaining: Position[] = [...book.lots].map(([sym, lot]) => {
        const p = mark(sym);
        return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: p, marketValue: lot.qty * p, unrealizedPl: lot.qty * (p - lot.entry) };
      });
      const equityNow = book.cash + remaining.reduce((s, p) => s + p.marketValue, 0);
      const account: BrokerAccount = { cash: book.cash, buyingPower: book.cash, equity: equityNow, currency: 'USD' };
      const buys = [...decisions.values()]
        .filter((d) => d.action === 'buy' && !book.lots.has(d.symbol) && d.price)
        .sort((a, b) => b.confidence - a.confidence);
      let placed = 0;
      for (const d of buys) {
        if (placed >= MAX_NEW_PER_DAY) break;
        const p = px(d.symbol); const win = windows.get(d.symbol);
        if (p == null || !(p > 0) || !win) continue;
        const sized = sizeEntry(d.symbol, p, d.confidence, account, remaining, policy);
        if (sized.qty <= 0) continue;
        const rule = book.exitRule(win);
        book.cash -= sized.qty * p;
        book.lots.set(d.symbol, { qty: sized.qty, entry: p, peak: p, stopPct: rule.stopPct, tpPct: rule.tpPct });
        remaining.push({ symbol: d.symbol, qty: sized.qty, avgEntryPrice: p, currentPrice: p, marketValue: sized.qty * p, unrealizedPl: 0 });
        placed++;
      }

      const eq = book.cash + [...book.lots].reduce((s, [sym, lot]) => s + lot.qty * mark(sym), 0);
      book.curve.push(eq);
      book.peak = Math.max(book.peak, eq);
      book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak);
    }
  }

  const last = calendar.length - 1;
  const spyRet = (spy[last] / spy[t0] - 1) * 100;
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(` SPY buy & hold same window: ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(1)}%`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  for (const book of books) {
    for (const [sym, lot] of book.lots) book.cash += lot.qty * (lastClose.get(sym) ?? lot.entry);
    const ret = (book.cash / START_CASH - 1) * 100;
    const rets = book.curve.slice(1).map((e, i) => e / book.curve[i] - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
    const wr = book.trades ? (book.wins / (book.wins + book.losses)) * 100 : 0;
    console.log(`\n ${book.name}`);
    console.log(`   return ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   maxDD -${(book.maxDD * 100).toFixed(1)}%   sharpe ${((mean / sd) * Math.sqrt(252)).toFixed(2)}   trades ${book.trades}   stop-outs ${book.stopOuts}   wr ${wr.toFixed(0)}%`);
  }
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
}
main().then(() => process.exit(0)).catch((e) => { console.error('stop-width backtest failed:', e); process.exit(1); });
