/**
 * Equity strategy backtest — walk the LIVE engine over historical daily bars.
 *
 * Reuses the exact pure functions the autopilot runs (decideSymbol multi-timeframe ensemble +
 * the portfolio money-manager: sizeEntry / exitsToRun / trailingExits / rotationBenches), so this
 * measures the real strategy, not a re-implementation. Walks the universe day by day: mark to close,
 * take protective exits (stop/take-profit/trailing), rotate the cold for the hot, size new entries
 * within the caps, and track the equity curve. Reports total return, max drawdown, win rate, trade
 * count, and a SPY buy-&-hold benchmark over the same window.
 *
 * HONEST LIMITS: (1) Alpaca's free IEX daily history is ~149 bars (~7 months) — a recent-window test,
 * not multi-year. (2) Daily bars only, so the 5Min/1Hour legs (fast breakdown exits, intraday
 * timing) are NOT modeled — this backtests the daily/weekly trend core + the money-management. (3)
 * Fills are at the day's close with no slippage/commission (paper-equivalent). Treat it as a sanity
 * check on the logic + risk controls, not a promise of returns.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-backtest.ts [posture] [warmupDays]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — walk-forward backtest reusing decideSymbol + the portfolio manager over Alpaca daily bars; return/max-drawdown/win-rate vs SPY.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Strict full-history series filter (was maxLen-3): a name whose series ends 1-3 bars early NaN-poisoned the whole book via undefined closes on the final bars — latent since initial, armed by the 07-08 biotech-ETF universe addition (today's run printed all-NaN). Found by the short-backtest verification workflow before it bit here.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CRITICAL fix: resample() returned the weekly/quarterly views TIME-REVERSED (filter is ascending + anchored at the newest bar; the .reverse() flipped it, and .slice(-n) then kept the OLDEST samples). scoreSymbol assumes ascending closes, so the 1Week/3Month legs — ~60% of the combined score and the ENTIRE regime gate — were mirrored: multi-year winners read as downtrends, the sim vetoed exactly the names live would buy. All prior absolute numbers from this harness are suspect; the LIVE engine is unaffected (native weekly/quarterly bars, no resample). Found by the stop-width verification workflow (empirical: resample([1..11],5) === [11,6,1]).
 */
import 'dotenv/config';
import { barsBatch, DEFAULT_UNIVERSE, type Timeframe } from '@/features/trading';
import { decideSymbol } from '../src/features/trading/services/multi-timeframe';
import { sizeEntry, exitsToRun, trailingExits, nextPeaks, rotationBenches, RISK_POLICIES, type RiskPosture, type NameStrength } from '../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../src/features/trading/services/broker-adapter';

const POSTURE = (process.argv[2] as RiskPosture) || 'active';
const WARMUP = Number(process.argv[3] || 30);
const START_CASH = 100000;
const policy = RISK_POLICIES[POSTURE] ?? RISK_POLICIES.balanced;

/** Resample a daily close series to a coarser timeframe by taking every `n`th close. */
const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);

interface Lot { qty: number; entry: number; peak: number; }

async function main(): Promise<void> {
  const universe = DEFAULT_UNIVERSE;
  console.log(`Loading daily bars for ${universe.length} names + SPY…`);
  const bars = await barsBatch([...universe, 'SPY'], '1Day', 520);
  const spyRaw = bars.get('SPY') || [];
  // Keep names with FULL history only, right-aligned to the last `len` bars. The old `maxLen - 3`
  // tolerance admitted series that, after .slice(-len), were shorter than the walk — priceAt(sym,
  // len-1) returned undefined on the final bars and one undefined mark NaN-poisoned the whole
  // book's cash (NaN < 1 is false, so qty guards never fire). Latent since 06-24; armed 2026-07-08
  // when the universe gained the biotech ETFs (one series runs 1-3 bars short) — the whole report
  // printed NaN. A dropped name costs a little coverage; a poisoned book costs the entire run.
  const names = [...bars].filter(([s]) => s !== 'SPY');
  const maxLen = Math.max(...names.map(([, c]) => c.length), spyRaw.length);
  const len = Math.min(maxLen, spyRaw.length);
  if (len < WARMUP + 10) { console.error(`Not enough history (${len} bars).`); process.exit(1); }
  const series = new Map(names.filter(([, c]) => c.length >= len).map(([s, c]) => [s, c.slice(-len)]));
  const spy = spyRaw.slice(-len);
  console.log(`Backtest window: ${len} trading days, posture=${POSTURE}, warmup=${WARMUP}.\n`);

  const book = new Map<string, Lot>();
  let cash = START_CASH;
  let peakEquity = START_CASH;
  let maxDD = 0;
  let wins = 0, losses = 0, trades = 0;
  const equityCurve: number[] = [];

  const priceAt = (sym: string, t: number): number => series.get(sym)![t];

  for (let t = WARMUP; t < len; t++) {
    // Mark the book to today's close, roll trailing peaks.
    const positions: Position[] = [...book].map(([sym, lot]) => {
      const px = priceAt(sym, t);
      return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) };
    });
    const peaks = nextPeaks(positions, new Map([...book].map(([s, l]) => [s, l.peak])));
    for (const [s, p] of peaks) { const l = book.get(s); if (l) l.peak = p; }

    // Decisions for every name from data up to and including day t.
    const decisions = new Map<string, ReturnType<typeof decideSymbol>>();
    for (const [sym, closes] of series) {
      const win = closes.slice(0, t + 1);
      const tf = new Map<Timeframe, number[]>([
        ['1Day', win.slice(-220)], ['1Week', resample(win, 5).slice(-60)], ['3Month', resample(win, 63).slice(-40)],
      ]);
      decisions.set(sym, decideSymbol(sym, tf));
    }

    // Sell side: stop/take-profit + trailing, then rotation benches. Fill at close.
    const sell = (sym: string) => { const lot = book.get(sym); if (!lot) return; const px = priceAt(sym, t); cash += lot.qty * px; (px >= lot.entry ? () => wins++ : () => losses++)(); trades++; book.delete(sym); };
    const exiting = new Set<string>();
    for (const e of [...exitsToRun(positions, policy), ...trailingExits(positions, peaks, policy)]) { if (!exiting.has(e.symbol)) { exiting.add(e.symbol); sell(e.symbol); } }
    const strength = new Map<string, NameStrength>([...decisions].map(([s, d]) => [s, { score: d.score, action: d.action }]));
    const livePos = positions.filter((p) => !exiting.has(p.symbol));
    for (const b of rotationBenches(livePos, strength, policy)) { if (!exiting.has(b.symbol)) { exiting.add(b.symbol); sell(b.symbol); } }
    // Technical sells (weighted action) for names still held.
    for (const [sym, d] of decisions) { if (d.action === 'sell' && book.has(sym) && !exiting.has(sym)) { exiting.add(sym); sell(sym); } }

    // Buy side: rank buys, size within caps against the post-sell book. Fill at close.
    const remaining: Position[] = [...book].map(([sym, lot]) => { const px = priceAt(sym, t); return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) }; });
    const equityNow = cash + remaining.reduce((s, p) => s + p.marketValue, 0);
    const account: BrokerAccount = { cash, buyingPower: cash, equity: equityNow, currency: 'USD' };
    const buys = [...decisions.values()].filter((d) => d.action === 'buy' && !book.has(d.symbol) && d.price).sort((a, b) => b.confidence - a.confidence);
    let placed = 0;
    for (const d of buys) {
      if (placed >= 8) break;
      const px = priceAt(d.symbol, t);
      const sized = sizeEntry(d.symbol, px, d.confidence, account, remaining, policy);
      if (sized.qty <= 0) continue;
      cash -= sized.qty * px;
      book.set(d.symbol, { qty: sized.qty, entry: px, peak: px });
      remaining.push({ symbol: d.symbol, qty: sized.qty, avgEntryPrice: px, currentPrice: px, marketValue: sized.qty * px, unrealizedPl: 0 });
      placed++;
    }

    const equity = cash + [...book].reduce((s, [sym, lot]) => s + lot.qty * priceAt(sym, t), 0);
    equityCurve.push(equity);
    peakEquity = Math.max(peakEquity, equity);
    maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
  }

  // Liquidate at the last close for the final number.
  const last = len - 1;
  for (const [sym, lot] of book) cash += lot.qty * priceAt(sym, last);
  const finalEquity = cash;
  const ret = (finalEquity / START_CASH - 1) * 100;
  const spyRet = (spy[last] / spy[WARMUP] - 1) * 100;
  const rets = equityCurve.slice(1).map((e, i) => e / equityCurve[i] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(252);

  console.log('───────────────────────────────────────────────');
  console.log(` Strategy return   : ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`);
  console.log(` SPY buy & hold    : ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(1)}%   (same window)`);
  console.log(` Max drawdown      : -${(maxDD * 100).toFixed(1)}%`);
  console.log(` Sharpe (annualized): ${sharpe.toFixed(2)}`);
  console.log(` Closed trades     : ${trades}  (win rate ${trades ? ((wins / (wins + losses)) * 100).toFixed(0) : 0}%)`);
  console.log(` Final equity      : $${finalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })} from $${START_CASH.toLocaleString()}`);
  console.log('───────────────────────────────────────────────');
}
main().then(() => process.exit(0)).catch((e) => { console.error('backtest failed:', e); process.exit(1); });
