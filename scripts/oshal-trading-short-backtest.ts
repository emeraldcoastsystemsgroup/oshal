/**
 * Short-strategy backtest — walk the LIVE engine's bearish signals over historical daily bars.
 *
 * Answers the operator's question (2026-07-08): "if it's not a buy, is it a short?" Reuses the exact
 * pure decision function the autopilot runs (decideSymbol multi-timeframe ensemble) and mirrors the
 * portfolio money-management to the short side, then walks four candidate short strategies over the
 * SAME window in one pass, against the same benchmarks:
 *
 *   A0 not-a-buy, literal — UNCAPPED equal-weight daily-rebalanced short of EVERY name whose action
 *                     != 'buy'. This is the operator's hypothesis verbatim; no ranking, no caps
 *                     (a capped/ranked version selects only the most-bearish tail and flatters it).
 *   A  not-a-buy, capped — short the most-bearish non-buys within the book caps (what a real capped
 *                     book could actually hold; NOT the literal hypothesis — see A0)
 *   B  engine-sell  — short only decisive sells (score < -threshold, regime-tolerant — the engine's
 *                     own bearish action, the mirror of what it buys)
 *   C  deep-bear    — engine-sell AND regime <= -0.25 (higher timeframes also bearish — the strict
 *                     mirror of the long side's "won't buy into a bearish weekly/quarterly" gate)
 *   D  long-short   — the long strategy (active posture, incl. rotation) PLUS C's shorts at half
 *                     gross (classic hedged book: 100% long / up-to-50% short). Two-leg budget:
 *                     8 long + 8 short entries/day (the single-leg harness allows 8 total).
 *
 * Short-side money management mirrors the long side: per-name cap = maxPerNamePct of equity,
 * stop-loss = price rising stopLossPct ABOVE entry, take-profit = price falling takeProfitPct
 * BELOW entry, trailing exit off the trough (armed at trailArmPct, covers on trailGivebackPct
 * rebound), cover on signal flip to 'buy', max-positions cap, 8 new entries/day.
 *
 * HONEST LIMITS (same as oshal-trading-backtest.ts, plus short-specific): (1) Alpaca free IEX daily
 * history — a recent-window test, not multi-year, and this window had an UP-drifting market, which
 * is the hostile regime for shorts; a strategy that survives it is conservative, one that only works
 * in it is not proven. (2) Daily bars only — no intraday legs. (3) Fills at the close, no
 * slippage/commission. (4) Borrow cost approximated as a flat SHORT_BORROW_PCT/yr (default 1%)
 * daily drag on short market value; no short-proceeds rebate; hard-to-borrow names really cost
 * more. (5) No short-availability model — assumes every name is borrowable. (6) No maintenance-
 * margin model: the gross-exposure cap binds at ENTRY only; adverse drift above 1x (0.5x for D)
 * is uncorrected until per-name stops fire. (7) A same-bar cover→re-short recycle is possible
 * (shared with the long harness's sell→re-buy), inflating trade counts and win rates — returns and
 * drawdowns are unaffected. (8) Short sizing is flat per-name (no confidence/vol scaling, no sector
 * cap, no daily-loss halt) — HARSHER risk discipline than the long side's sizeEntry, which in an
 * up-window biases AGAINST shorts; per-trade win rates and profit factors are sizing-independent.
 * Treat results as a sanity check on whether the bearish signal has ANY harvestable edge, not a
 * promise of returns. Compare against a long-harness run from the SAME DAY (rolling IEX window).
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-short-backtest.ts [posture] [warmupDays]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — four short-strategy variants (not-a-buy / engine-sell / deep-bear / long-short overlay) walked in one pass over the same bars + benchmarks as the long backtest, short-side risk management mirrored from the portfolio policy, borrow-cost drag, SPY and short-SPY benchmarks. Built to answer "is a non-buy a short?" with evidence; the 15k-resolved-prediction hit rate (down calls 48.9%) already argues no — this measures P&L, where magnitude can still pay.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fixes (3-lens verify workflow: look-ahead sound, accounting sound, fairness flawed): (1) A0 added — the operator's hypothesis VERBATIM as an uncapped equal-weight daily-rebalanced short of every non-buy; the capped/ranked A only shorts the most-bearish tail, which the fairness lens showed flatters the hypothesis. (2) Variant D's long leg now runs rotationBenches like the deployed strategy (it silently omitted rotation — "verbatim mechanics" was false). (3) Strict full-history series filter (maxLen-3 tolerance left names whose series end early; an undefined close NaN-poisoned D's whole book — NaN<1 is false so the qty guard never fired). (4) Honest-limits block extended: no maintenance-margin model, same-bar cover→re-short trade-count inflation, flat short sizing (harsher than sizeEntry — biases AGAINST shorts in an up-window), same-day-rerun comparability rule.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CRITICAL fix shared with the long harness: resample() time-reversed the 1Week/3Month views feeding decideSymbol (and slice(-n) then kept the OLDEST samples), corrupting the action/regime stream that defines the not-a-buy/engine-sell/deep-bear variant sets. Book-vs-book comparisons were internally consistent (shared corrupted entries); absolute numbers were not. Live engine unaffected. Re-run required before citing this harness's numbers.
 */
import 'dotenv/config';
import { barsBatch, DEFAULT_UNIVERSE, type Timeframe } from '@/features/trading';
import { decideSymbol, type MtfDecision } from '../src/features/trading/services/multi-timeframe';
import { sizeEntry, exitsToRun, trailingExits, nextPeaks, rotationBenches, RISK_POLICIES, type RiskPosture, type NameStrength } from '../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../src/features/trading/services/broker-adapter';

const POSTURE = (process.argv[2] as RiskPosture) || 'active';
const WARMUP = Number(process.argv[3] || 30);
const START_CASH = 100000;
const MAX_NEW_PER_DAY = 8;
/** Deep-bear regime gate for variant C — the strict mirror of the long regime tolerance. */
const DEEP_BEAR_REGIME = -0.25;
/** Flat annual borrow-cost approximation applied daily to short market value. */
const BORROW_YR = Number(process.env.SHORT_BORROW_PCT || 1.0) / 100;
/** Long-short variant D: gross short exposure cap as a fraction of equity (100/50 book). */
const D_SHORT_GROSS_CAP = 0.5;
const policy = RISK_POLICIES[POSTURE] ?? RISK_POLICIES.active;

/** Resample a daily close series to a coarser timeframe by taking every `n`th close. */
const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);

/** One open short lot: entry price, share qty (positive), and the lowest close seen since entry. */
interface ShortLot { qty: number; entry: number; trough: number; }
/** One open long lot (variant D's long leg). */
interface LongLot { qty: number; entry: number; peak: number; }

/** A variant's running book + stats, tracked independently through the same walk. */
interface Book {
  name: string;
  wantsShort: (d: MtfDecision) => boolean;
  withLongLeg: boolean;
  cash: number;
  shorts: Map<string, ShortLot>;
  longs: Map<string, LongLot>;
  equityCurve: number[];
  peakEquity: number;
  maxDD: number;
  wins: number; losses: number; trades: number;
  grossWin: number; grossLoss: number;
}

const mkBook = (name: string, wantsShort: Book['wantsShort'], withLongLeg = false): Book => ({
  name, wantsShort, withLongLeg, cash: START_CASH, shorts: new Map(), longs: new Map(),
  equityCurve: [], peakEquity: START_CASH, maxDD: 0, wins: 0, losses: 0, trades: 0, grossWin: 0, grossLoss: 0,
});

async function main(): Promise<void> {
  const universe = DEFAULT_UNIVERSE;
  console.log(`Loading daily bars for ${universe.length} names + SPY…`);
  const bars = await barsBatch([...universe, 'SPY'], '1Day', 520);
  const spyRaw = bars.get('SPY') || [];
  const names = [...bars].filter(([s]) => s !== 'SPY');
  const maxLen = Math.max(...names.map(([, c]) => c.length), spyRaw.length);
  const len = Math.min(maxLen, spyRaw.length);
  if (len < WARMUP + 10) { console.error(`Not enough history (${len} bars).`); process.exit(1); }
  // STRICT full-history filter (unlike the long harness's maxLen-3 tolerance): a series even one bar
  // short of `len` makes priceAt(sym, len-1) undefined, and one undefined mark NaN-poisons the whole
  // book's cash/equity from that day on (variant D's first run died exactly this way).
  const series = new Map(names.filter(([, c]) => c.length >= len).map(([s, c]) => [s, c.slice(-len)]));
  const spy = spyRaw.slice(-len);
  console.log(`Backtest window: ${len} trading days (~${Math.round(len / 21)} months), posture=${POSTURE}, warmup=${WARMUP}, borrow=${(BORROW_YR * 100).toFixed(1)}%/yr.\n`);

  const books: Book[] = [
    mkBook('A not-a-buy → short', (d) => d.action !== 'buy'),
    mkBook('B engine-sell → short', (d) => d.action === 'sell'),
    mkBook('C deep-bear → short', (d) => d.action === 'sell' && d.regime <= DEEP_BEAR_REGIME),
    mkBook('D long + C-shorts (100/50)', (d) => d.action === 'sell' && d.regime <= DEEP_BEAR_REGIME, true),
  ];

  const priceAt = (sym: string, t: number): number => series.get(sym)![t];

  // A0 — the hypothesis VERBATIM: an uncapped, equal-weight, daily-rebalanced short of EVERY
  // non-buy name. Chosen at close t, held t→t+1, no ranking and no caps. Tracked as a synthetic
  // portfolio (mean next-day return, negated, minus borrow) because no cash book can hold an
  // uncapped ~90-name short; this is the literal "if it's not a buy, short it".
  let a0Equity = START_CASH; let a0Peak = START_CASH; let a0MaxDD = 0; let a0AvgNames = 0; let a0Days = 0;
  let a0Set: string[] = [];
  const a0Curve: number[] = [];

  for (let t = WARMUP; t < len; t++) {
    // Decisions for every name from data up to and including day t (no look-ahead).
    const decisions = new Map<string, MtfDecision>();
    for (const [sym, closes] of series) {
      const win = closes.slice(0, t + 1);
      const tf = new Map<Timeframe, number[]>([
        ['1Day', win.slice(-220)], ['1Week', resample(win, 5).slice(-60)], ['3Month', resample(win, 63).slice(-40)],
      ]);
      decisions.set(sym, decideSymbol(sym, tf));
    }

    // A0: realize yesterday's set over t-1→t, then choose today's set for tomorrow.
    if (a0Set.length) {
      const dayRet = a0Set.reduce((s, sym) => s + (priceAt(sym, t) / priceAt(sym, t - 1) - 1), 0) / a0Set.length;
      a0Equity *= (1 - dayRet - BORROW_YR / 252);
      a0Curve.push(a0Equity);
      a0Peak = Math.max(a0Peak, a0Equity);
      a0MaxDD = Math.max(a0MaxDD, (a0Peak - a0Equity) / a0Peak);
    }
    a0Set = [...decisions.values()].filter((d) => d.action !== 'buy' && d.price).map((d) => d.symbol);
    a0AvgNames += a0Set.length; a0Days++;

    for (const book of books) {
      /* ── short leg: mark, borrow drag, exits, entries ─────────────────────────────── */
      // Daily borrow drag on the short market value (the flat approximation; see header).
      const shortMv = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
      book.cash -= shortMv * (BORROW_YR / 252);

      // Roll troughs (the short-side high-water mark is a LOW-water mark).
      for (const [sym, lot] of book.shorts) lot.trough = Math.min(lot.trough, priceAt(sym, t));

      const cover = (sym: string) => {
        const lot = book.shorts.get(sym); if (!lot) return;
        const px = priceAt(sym, t);
        const pnl = lot.qty * (lot.entry - px);
        book.cash -= lot.qty * px;
        if (pnl >= 0) { book.wins++; book.grossWin += pnl; } else { book.losses++; book.grossLoss -= pnl; }
        book.trades++;
        book.shorts.delete(sym);
      };

      // Short-side protective exits — the mirror of exitsToRun + trailingExits.
      for (const [sym, lot] of [...book.shorts]) {
        const px = priceAt(sym, t);
        const advPct = ((px - lot.entry) / lot.entry) * 100;        // >0 = moving against the short
        const gainPct = ((lot.entry - px) / lot.entry) * 100;       // >0 = short in profit
        const armed = ((lot.entry - lot.trough) / lot.entry) * 100 >= policy.trailArmPct;
        const rebounded = ((px - lot.trough) / lot.trough) * 100 >= policy.trailGivebackPct;
        if (advPct >= policy.stopLossPct) cover(sym);               // stop: price ran UP on us
        else if (gainPct >= policy.takeProfitPct) cover(sym);       // take-profit: fell far enough
        else if (armed && rebounded) cover(sym);                    // trailing: gave back the move
        else if (decisions.get(sym)?.action === 'buy') cover(sym);  // signal flipped — get out
      }

      /* ── long leg (variant D only): the deployed strategy, verbatim mechanics ─────── */
      if (book.withLongLeg) {
        const positions: Position[] = [...book.longs].map(([sym, lot]) => {
          const px = priceAt(sym, t);
          return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) };
        });
        const peaks = nextPeaks(positions, new Map([...book.longs].map(([s, l]) => [s, l.peak])));
        for (const [s, p] of peaks) { const l = book.longs.get(s); if (l) l.peak = p; }
        const sellLong = (sym: string) => {
          const lot = book.longs.get(sym); if (!lot) return;
          const px = priceAt(sym, t);
          const pnl = lot.qty * (px - lot.entry);
          book.cash += lot.qty * px;
          if (pnl >= 0) { book.wins++; book.grossWin += pnl; } else { book.losses++; book.grossLoss -= pnl; }
          book.trades++;
          book.longs.delete(sym);
        };
        const exiting = new Set<string>();
        for (const e of [...exitsToRun(positions, policy), ...trailingExits(positions, peaks, policy)]) {
          if (!exiting.has(e.symbol)) { exiting.add(e.symbol); sellLong(e.symbol); }
        }
        // Rotation — bench the cold for the hot, exactly like the deployed strategy / long harness.
        const strength = new Map<string, NameStrength>([...decisions].map(([s, d]) => [s, { score: d.score, action: d.action }]));
        const livePos = positions.filter((p) => !exiting.has(p.symbol));
        for (const b of rotationBenches(livePos, strength, policy)) {
          if (!exiting.has(b.symbol)) { exiting.add(b.symbol); sellLong(b.symbol); }
        }
        for (const [sym, d] of decisions) if (d.action === 'sell' && book.longs.has(sym) && !exiting.has(sym)) { exiting.add(sym); sellLong(sym); }

        const remaining: Position[] = [...book.longs].map(([sym, lot]) => {
          const px = priceAt(sym, t);
          return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) };
        });
        const shortLiab = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
        const equityNow = book.cash + remaining.reduce((s, p) => s + p.marketValue, 0) - shortLiab;
        const account: BrokerAccount = { cash: Math.max(0, book.cash - shortLiab), buyingPower: Math.max(0, book.cash - shortLiab), equity: equityNow, currency: 'USD' };
        const buys = [...decisions.values()].filter((d) => d.action === 'buy' && !book.longs.has(d.symbol) && d.price).sort((a, b) => b.confidence - a.confidence);
        let placed = 0;
        for (const d of buys) {
          if (placed >= MAX_NEW_PER_DAY) break;
          const px = priceAt(d.symbol, t);
          const sized = sizeEntry(d.symbol, px, d.confidence, account, remaining, policy);
          if (sized.qty <= 0) continue;
          book.cash -= sized.qty * px;
          book.longs.set(d.symbol, { qty: sized.qty, entry: px, peak: px });
          remaining.push({ symbol: d.symbol, qty: sized.qty, avgEntryPrice: px, currentPrice: px, marketValue: sized.qty * px, unrealizedPl: 0 });
          placed++;
        }
      }

      /* ── short entries: rank by bearish conviction, size within the mirrored caps ──── */
      const longMv = [...book.longs].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
      const shortMvNow = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
      const equity = book.cash + longMv - shortMvNow;
      const grossCap = book.withLongLeg ? equity * D_SHORT_GROSS_CAP : equity; // 1x gross for pure-short books
      const perName = (policy.maxPerNamePct / 100) * equity;
      const candidates = [...decisions.values()]
        .filter((d) => d.price && !book.shorts.has(d.symbol) && !book.longs.has(d.symbol) && book.wantsShort(d))
        .sort((a, b) => a.score - b.score); // most-bearish first
      let placed = 0;
      for (const d of candidates) {
        if (placed >= MAX_NEW_PER_DAY) break;
        if (book.shorts.size >= policy.maxPositions) break;
        const mvNow = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
        if (mvNow >= grossCap) break;
        const px = priceAt(d.symbol, t);
        const qty = Math.floor(Math.min(perName, grossCap - mvNow) / px);
        if (qty < 1) continue;
        book.cash += qty * px; // short-sale proceeds
        book.shorts.set(d.symbol, { qty, entry: px, trough: px });
        placed++;
      }

      /* ── mark the whole book ────────────────────────────────────────────────────────── */
      const lmv = [...book.longs].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
      const smv = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
      const eq = book.cash + lmv - smv;
      book.equityCurve.push(eq);
      book.peakEquity = Math.max(book.peakEquity, eq);
      book.maxDD = Math.max(book.maxDD, (book.peakEquity - eq) / book.peakEquity);
    }
  }

  /* ── close everything at the last bar and report ─────────────────────────────────────── */
  const last = len - 1;
  const spyRet = (spy[last] / spy[WARMUP] - 1) * 100;
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(` Window benchmarks: SPY buy&hold ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(1)}%  |  short-SPY ${(-spyRet) >= 0 ? '+' : ''}${(-spyRet).toFixed(1)}%`);
  console.log('════════════════════════════════════════════════════════════════════');
  {
    const ret = (a0Equity / START_CASH - 1) * 100;
    const rets = a0Curve.slice(1).map((e, i) => e / a0Curve[i] - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
    console.log(`\n A0 not-a-buy → short EVERYTHING (uncapped equal-weight, the hypothesis verbatim)`);
    console.log(`   return ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   vs SPY ${(ret - spyRet) >= 0 ? '+' : ''}${(ret - spyRet).toFixed(1)}pp   maxDD -${(a0MaxDD * 100).toFixed(1)}%   sharpe ${((mean / sd) * Math.sqrt(252)).toFixed(2)}`);
    console.log(`   avg names shorted/day ${(a0AvgNames / (a0Days || 1)).toFixed(0)} of ${series.size}   (daily-rebalanced portfolio — per-trade stats n/a)`);
  }
  for (const book of books) {
    for (const [sym, lot] of book.longs) book.cash += lot.qty * priceAt(sym, last);
    for (const [sym, lot] of book.shorts) book.cash -= lot.qty * priceAt(sym, last);
    const ret = (book.cash / START_CASH - 1) * 100;
    const rets = book.equityCurve.slice(1).map((e, i) => e / book.equityCurve[i] - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
    const sharpe = (mean / sd) * Math.sqrt(252);
    const wr = book.trades ? (book.wins / (book.wins + book.losses)) * 100 : 0;
    const pf = book.grossLoss > 0 ? book.grossWin / book.grossLoss : Infinity;
    console.log(`\n ${book.name}`);
    console.log(`   return ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   vs SPY ${(ret - spyRet) >= 0 ? '+' : ''}${(ret - spyRet).toFixed(1)}pp   maxDD -${(book.maxDD * 100).toFixed(1)}%   sharpe ${sharpe.toFixed(2)}`);
    console.log(`   trades ${book.trades}   win rate ${wr.toFixed(0)}%   profit factor ${Number.isFinite(pf) ? pf.toFixed(2) : '∞'}   final $${book.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  }
  console.log('\n════════════════════════════════════════════════════════════════════');
}
main().then(() => process.exit(0)).catch((e) => { console.error('short backtest failed:', e); process.exit(1); });
