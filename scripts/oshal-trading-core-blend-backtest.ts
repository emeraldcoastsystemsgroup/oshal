/**
 * Core-blend backtest — the walk-forward engine backtest (oshal-trading-backtest.ts) plus the two
 * levers that script cannot vary: a HELD SPY BETA CORE and a TAKE-PROFIT override.
 *
 * Motivation (2026-07-10 "steadily losing since the hot start" review): the active-posture sleeve
 * is a designed chop-trader that banks +8% winners and cannot ride a trending tape; the code's own
 * answer — the beta core (ensureCore in trading-schedule-dispatch.ts) — has never been backtested,
 * and TRADING_CORE_TARGET_PCT sits at 0 in production. This harness buys corePct% of starting
 * equity in SPY at the first walk day, holds it untouched (exempt from every sleeve sell, exactly
 * like production coreSet), and runs the standard sleeve on the rest. Optional tpPct overrides the
 * posture's takeProfitPct so the "does +8% cash-out cost us the trend?" question is testable.
 *
 * Same honest limits as the baseline harness: ~7 months of free IEX daily bars, daily-close fills,
 * no slippage, 5Min/1Hour legs not modeled. Emits a final machine-readable `RESULT {...json}` line
 * so sweep tooling can parse runs without scraping the human table.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only \
 *          scripts/oshal-trading-core-blend-backtest.ts [posture] [corePct] [tpPct|-] [warmupDays]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — SPY-core blend + take-profit override over the exact live-engine walk (decideSymbol + sizeEntry/exits/trailing/rotationBenches), JSON RESULT line for sweep tooling.
 */
import 'dotenv/config';
import { barsBatch, DEFAULT_UNIVERSE, type Timeframe } from '@/features/trading';
import { decideSymbol } from '../src/features/trading/services/multi-timeframe';
import { sizeEntry, exitsToRun, trailingExits, nextPeaks, rotationBenches, RISK_POLICIES, type RiskPosture, type NameStrength } from '../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../src/features/trading/services/broker-adapter';

const POSTURE = (process.argv[2] as RiskPosture) || 'active';
const CORE_PCT = Math.max(0, Math.min(90, Number(process.argv[3] || 0)));
const TP_ARG = process.argv[4];
const WARMUP = Number(process.argv[5] || 30);
const START_CASH = 100000;
const base = RISK_POLICIES[POSTURE] ?? RISK_POLICIES.balanced;
/** The sleeve policy: posture defaults, with takeProfitPct overridden when the arg is numeric. */
const policy = TP_ARG && TP_ARG !== '-' && Number.isFinite(Number(TP_ARG))
  ? { ...base, takeProfitPct: Number(TP_ARG) }
  : base;

/** Resample a daily close series to a coarser timeframe by taking every `n`th close (ascending-safe). */
const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);

interface Lot { qty: number; entry: number; peak: number; }

/**
 * @description Walk the live engine over the IEX daily window with a held SPY core beside the sleeve.
 * @returns Nothing — prints the human table + the RESULT json line and exits.
 */
async function main(): Promise<void> {
  const universe = DEFAULT_UNIVERSE;
  console.log(`Loading daily bars for ${universe.length} names + SPY…`);
  const bars = await barsBatch([...universe, 'SPY'], '1Day', 520);
  const spyRaw = bars.get('SPY') || [];
  // Strict full-history filter, right-aligned — same NaN-poison guard as the baseline harness.
  const names = [...bars].filter(([s]) => s !== 'SPY');
  const maxLen = Math.max(...names.map(([, c]) => c.length), spyRaw.length);
  const len = Math.min(maxLen, spyRaw.length);
  if (len < WARMUP + 10) { console.error(`Not enough history (${len} bars).`); process.exit(1); }
  const series = new Map(names.filter(([, c]) => c.length >= len).map(([s, c]) => [s, c.slice(-len)]));
  const spy = spyRaw.slice(-len);
  console.log(`Window: ${len} trading days, posture=${POSTURE}, core=${CORE_PCT}% SPY, tp=${policy.takeProfitPct}%, warmup=${WARMUP}.\n`);

  // The core: buy-and-hold SPY with corePct% of starting equity at the first walk close.
  const coreQty = CORE_PCT > 0 ? (START_CASH * CORE_PCT / 100) / spy[WARMUP] : 0;
  const book = new Map<string, Lot>();
  let cash = START_CASH - coreQty * spy[WARMUP];
  let peakEquity = START_CASH;
  let maxDD = 0;
  let wins = 0, losses = 0, trades = 0;
  const equityCurve: number[] = [];

  const priceAt = (sym: string, t: number): number => series.get(sym)![t];
  const corePos = (t: number): Position[] => coreQty > 0
    ? [{ symbol: 'SPY', qty: coreQty, avgEntryPrice: spy[WARMUP], currentPrice: spy[t], marketValue: coreQty * spy[t], unrealizedPl: coreQty * (spy[t] - spy[WARMUP]) }]
    : [];

  for (let t = WARMUP; t < len; t++) {
    // Mark sleeve to close, roll trailing peaks. The core is never a sell candidate (production coreSet).
    const sleevePositions: Position[] = [...book].map(([sym, lot]) => {
      const px = priceAt(sym, t);
      return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) };
    });
    const peaks = nextPeaks(sleevePositions, new Map([...book].map(([s, l]) => [s, l.peak])));
    for (const [s, p] of peaks) { const l = book.get(s); if (l) l.peak = p; }

    const decisions = new Map<string, ReturnType<typeof decideSymbol>>();
    for (const [sym, closes] of series) {
      const win = closes.slice(0, t + 1);
      const tf = new Map<Timeframe, number[]>([
        ['1Day', win.slice(-220)], ['1Week', resample(win, 5).slice(-60)], ['3Month', resample(win, 63).slice(-40)],
      ]);
      decisions.set(sym, decideSymbol(sym, tf));
    }

    // Sell side (sleeve only): protective exits + trailing, rotation benches, technical sells.
    const sell = (sym: string) => { const lot = book.get(sym); if (!lot) return; const px = priceAt(sym, t); cash += lot.qty * px; (px >= lot.entry ? () => wins++ : () => losses++)(); trades++; book.delete(sym); };
    const exiting = new Set<string>();
    for (const e of [...exitsToRun(sleevePositions, policy), ...trailingExits(sleevePositions, peaks, policy)]) { if (!exiting.has(e.symbol)) { exiting.add(e.symbol); sell(e.symbol); } }
    const strength = new Map<string, NameStrength>([...decisions].map(([s, d]) => [s, { score: d.score, action: d.action }]));
    const livePos = sleevePositions.filter((p) => !exiting.has(p.symbol));
    for (const b of rotationBenches(livePos, strength, policy)) { if (!exiting.has(b.symbol)) { exiting.add(b.symbol); sell(b.symbol); } }
    for (const [sym, d] of decisions) { if (d.action === 'sell' && book.has(sym) && !exiting.has(sym)) { exiting.add(sym); sell(sym); } }

    // Buy side: production hands sizeEntry the WHOLE account (core included), so caps see total equity.
    const remaining: Position[] = [...book].map(([sym, lot]) => { const px = priceAt(sym, t); return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) }; });
    const withCore = [...remaining, ...corePos(t)];
    const equityNow = cash + withCore.reduce((s, p) => s + p.marketValue, 0);
    const account: BrokerAccount = { cash, buyingPower: cash, equity: equityNow, currency: 'USD' };
    const buys = [...decisions.values()].filter((d) => d.action === 'buy' && !book.has(d.symbol) && d.price).sort((a, b) => b.confidence - a.confidence);
    let placed = 0;
    for (const d of buys) {
      if (placed >= 8) break;
      const px = priceAt(d.symbol, t);
      const sized = sizeEntry(d.symbol, px, d.confidence, account, withCore, policy);
      if (sized.qty <= 0) continue;
      const cost = sized.qty * px;
      if (cost > cash) continue; // cash-only sleeve — the core is not spendable
      cash -= cost;
      book.set(d.symbol, { qty: sized.qty, entry: px, peak: px });
      remaining.push({ symbol: d.symbol, qty: sized.qty, avgEntryPrice: px, currentPrice: px, marketValue: cost, unrealizedPl: 0 });
      withCore.push(remaining[remaining.length - 1]);
      placed++;
    }

    const equity = cash + [...book].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0) + coreQty * spy[t];
    equityCurve.push(equity);
    peakEquity = Math.max(peakEquity, equity);
    maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
  }

  // Liquidate everything (core included) at the last close for the final number.
  const last = len - 1;
  for (const [sym, lot] of book) cash += lot.qty * priceAt(sym, last);
  const finalEquity = cash + coreQty * spy[last];
  const ret = (finalEquity / START_CASH - 1) * 100;
  const spyRet = (spy[last] / spy[WARMUP] - 1) * 100;
  const rets = equityCurve.slice(1).map((e, i) => e / equityCurve[i] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(252);

  console.log('───────────────────────────────────────────────');
  console.log(` Strategy return   : ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   (core ${CORE_PCT}% SPY, tp ${policy.takeProfitPct}%)`);
  console.log(` SPY buy & hold    : ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(1)}%   (same window)`);
  console.log(` Max drawdown      : -${(maxDD * 100).toFixed(1)}%`);
  console.log(` Sharpe (annualized): ${sharpe.toFixed(2)}`);
  console.log(` Closed trades     : ${trades}  (win rate ${trades ? ((wins / (wins + losses)) * 100).toFixed(0) : 0}%)`);
  console.log(` Final equity      : $${finalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })} from $${START_CASH.toLocaleString()}`);
  console.log('───────────────────────────────────────────────');
  console.log(`RESULT ${JSON.stringify({ posture: POSTURE, corePct: CORE_PCT, tpPct: policy.takeProfitPct, warmup: WARMUP, days: len - WARMUP, retPct: Number(ret.toFixed(2)), spyPct: Number(spyRet.toFixed(2)), maxDDPct: Number((maxDD * 100).toFixed(2)), sharpe: Number(sharpe.toFixed(2)), trades, winRatePct: trades ? Number(((wins / (wins + losses)) * 100).toFixed(0)) : 0 })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('backtest failed:', e); process.exit(1); });
