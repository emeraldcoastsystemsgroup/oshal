/**
 * Gap-stop backtest — the core-blend walk-forward with EXIT-EXECUTION modeled honestly on OHLC bars.
 *
 * The daily-close harnesses (oshal-trading-backtest.ts / oshal-trading-core-blend-backtest.ts) fill
 * every exit at the day's CLOSE — which silently assumes protection can act intraday and pre-market.
 * Production cannot: soft stops poll every 5 minutes in regular hours only, so overnight gap-downs
 * ride to the open unprotected and blow through the 5% stop (2026-07-07 AMD/MU; the 07-09/07-10
 * VRTX/MRNA/SHOP watchdog alerts). This harness fetches daily OHLC and runs the SAME walk under two
 * exit-execution modes so the difference is exactly the execution layer, not the strategy:
 *   close — status quo sim: stop/take-profit/trailing evaluated and filled at the close.
 *   venue — venue-resident orders: a GTC stop at entry*(1-stop%), a GTC limit at entry*(1+tp%), and
 *           a trailing stop tracking daily highs once armed. Triggered by the day's HIGH/LOW, filled
 *           at the order level — or at the OPEN when the day gaps through it (fill-at-open is the
 *           deliberate proxy for pre/post-market protection: the exit lands at the earliest
 *           tradeable print instead of the close; the true ext-hours fill may be modestly better or
 *           worse than the open). Both-sides-hit days resolve to the STOP (conservative).
 * Entries, sizing, rotation benches, and technical sells stay close-based in both modes — they are
 * decisions, not resting orders. IEX daily OHLC is RTH-aggregated, so the OPEN is the 9:30 print.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only \
 *          scripts/oshal-trading-gap-stop-backtest.ts [mode:close|venue] [posture] [corePct] [tpPct|-] [warmupDays]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — OHLC exit-execution modes (close vs venue-resident stops with gap-fill-at-open) over the core-blend walk; quantifies what venue stops + ext-hours protection would change.
 */
import 'dotenv/config';
import { DEFAULT_UNIVERSE, type Timeframe } from '@/features/trading';
import { decideSymbol } from '../src/features/trading/services/multi-timeframe';
import { sizeEntry, exitsToRun, trailingExits, nextPeaks, rotationBenches, RISK_POLICIES, type RiskPosture, type NameStrength } from '../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../src/features/trading/services/broker-adapter';

const MODE = (process.argv[2] || 'close').toLowerCase();
const POSTURE = (process.argv[3] as RiskPosture) || 'active';
const CORE_PCT = Math.max(0, Math.min(90, Number(process.argv[4] || 0)));
const TP_ARG = process.argv[5];
const WARMUP = Number(process.argv[6] || 30);
/** Optional: also report the LAST N walk days as their own segments (comma list, e.g. "5,21,63,126"). */
const TAIL_LIST = String(process.argv[7] || '').split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
const START_CASH = 100000;
const base = RISK_POLICIES[POSTURE] ?? RISK_POLICIES.balanced;
const policy = TP_ARG && TP_ARG !== '-' && Number.isFinite(Number(TP_ARG))
  ? { ...base, takeProfitPct: Number(TP_ARG) }
  : base;
if (MODE !== 'close' && MODE !== 'venue') { console.error(`Unknown mode "${MODE}" (close|venue)`); process.exit(1); }

const DATA_BASE = 'https://data.alpaca.markets/v2';
const envFirst = (...names: string[]): string => { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; };
const KEY = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');

/** One daily OHLC bar. */
interface Ohlc { o: number; h: number; l: number; c: number; }

/** Fetch ~520 daily OHLC bars per symbol (feed=iex, adjustment=all), batched + paginated. */
async function fetchOhlc(symbols: string[]): Promise<Map<string, Ohlc[]>> {
  const out = new Map<string, Ohlc[]>(symbols.map((s) => [s, []]));
  const start = new Date(Date.now() - 800 * 24 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // free tier: end must trail now
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    let pageToken = '';
    for (let page = 0; page < 60; page++) {
      const url = `${DATA_BASE}/stocks/bars?symbols=${encodeURIComponent(chunk.join(','))}&timeframe=1Day` +
        `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000&adjustment=all&feed=iex` +
        (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
      const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
      if (!r.ok) throw new Error(`bars HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = (await r.json()) as { bars?: Record<string, Array<{ o: number; h: number; l: number; c: number }>>; next_page_token?: string | null };
      for (const [sym, bars] of Object.entries(j.bars || {})) {
        const arr = out.get(sym) || [];
        for (const b of bars) arr.push({ o: b.o, h: b.h, l: b.l, c: b.c });
        out.set(sym, arr);
      }
      if (!j.next_page_token) break;
      pageToken = j.next_page_token;
    }
  }
  return out;
}

const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);

interface Lot { qty: number; entry: number; peak: number; }

/** Venue-mode fill for one held lot on day t, or null if no resting order triggered.
 *  Order of evaluation is conservative: gap-at-open first, then stop, then take-profit. */
function venueFill(lot: Lot, bar: Ohlc, pol: typeof policy): { px: number; reason: string } | null {
  const stopLvl = lot.entry * (1 - pol.stopLossPct / 100);
  const tpLvl = lot.entry * (1 + pol.takeProfitPct / 100);
  const armed = lot.peak >= lot.entry * (1 + pol.trailArmPct / 100);
  const trailLvl = armed ? lot.peak * (1 - pol.trailGivebackPct / 100) : 0;
  const protLvl = Math.max(stopLvl, trailLvl); // the tighter of hard stop vs armed trail
  if (bar.o <= protLvl) return { px: bar.o, reason: 'gap-open' };      // gapped through → earliest print
  if (bar.l <= protLvl) return { px: protLvl, reason: trailLvl > stopLvl ? 'trail' : 'stop' };
  if (bar.o >= tpLvl) return { px: bar.o, reason: 'tp-gap' };
  if (bar.h >= tpLvl) return { px: tpLvl, reason: 'tp' };
  return null;
}

/** @description Walk the engine over OHLC dailies under the chosen exit-execution mode. */
async function main(): Promise<void> {
  if (!KEY || !SEC) { console.error('FAIL: no Alpaca data keys in env'); process.exit(1); }
  const universe = DEFAULT_UNIVERSE;
  console.log(`Loading daily OHLC for ${universe.length} names + SPY…`);
  const raw = await fetchOhlc([...universe, 'SPY']);
  const spyRaw = raw.get('SPY') || [];
  const names = [...raw].filter(([s]) => s !== 'SPY');
  const maxLen = Math.max(...names.map(([, b]) => b.length), spyRaw.length);
  const len = Math.min(maxLen, spyRaw.length);
  if (len < WARMUP + 10) { console.error(`Not enough history (${len} bars).`); process.exit(1); }
  const series = new Map(names.filter(([, b]) => b.length >= len).map(([s, b]) => [s, b.slice(-len)]));
  const spy = spyRaw.slice(-len);
  console.log(`Window: ${len} days, mode=${MODE}, posture=${POSTURE}, core=${CORE_PCT}%, tp=${policy.takeProfitPct}%, warmup=${WARMUP}.\n`);

  const coreQty = CORE_PCT > 0 ? (START_CASH * CORE_PCT / 100) / spy[WARMUP].c : 0;
  const book = new Map<string, Lot>();
  let cash = START_CASH - coreQty * spy[WARMUP].c;
  let peakEquity = START_CASH, maxDD = 0, wins = 0, losses = 0, trades = 0, gapExits = 0;
  const equityCurve: number[] = [];
  const barAt = (sym: string, t: number): Ohlc => series.get(sym)![t];

  for (let t = WARMUP; t < len; t++) {
    const exiting = new Set<string>();
    const sellAt = (sym: string, px: number) => {
      const lot = book.get(sym); if (!lot) return;
      cash += lot.qty * px; (px >= lot.entry ? () => wins++ : () => losses++)(); trades++; book.delete(sym); exiting.add(sym);
    };

    // VENUE mode: resting orders execute FIRST, off the day's range (this is the whole experiment).
    if (MODE === 'venue') {
      for (const [sym, lot] of [...book]) {
        const f = venueFill(lot, barAt(sym, t), policy);
        if (f) { if (f.reason === 'gap-open') gapExits++; sellAt(sym, f.px); }
      }
    }

    // Mark survivors to the close; roll peaks (venue mode tracks intraday highs — resting trails see them).
    const positions: Position[] = [...book].map(([sym, lot]) => {
      const px = barAt(sym, t).c;
      return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) };
    });
    const peakSrc = new Map([...book].map(([s, l]) => [s, Math.max(l.peak, MODE === 'venue' ? barAt(s, t).h : 0)]));
    const peaks = nextPeaks(positions, peakSrc);
    for (const [s, p] of peaks) { const l = book.get(s); if (l) l.peak = p; }

    const decisions = new Map<string, ReturnType<typeof decideSymbol>>();
    for (const [sym, bars] of series) {
      const win = bars.slice(0, t + 1).map((b) => b.c);
      const tf = new Map<Timeframe, number[]>([
        ['1Day', win.slice(-220)], ['1Week', resample(win, 5).slice(-60)], ['3Month', resample(win, 63).slice(-40)],
      ]);
      decisions.set(sym, decideSymbol(sym, tf));
    }

    // CLOSE mode keeps the status-quo protective exits at the close; venue mode already ran them.
    if (MODE === 'close') {
      for (const e of [...exitsToRun(positions, policy), ...trailingExits(positions, peaks, policy)]) {
        if (!exiting.has(e.symbol)) sellAt(e.symbol, barAt(e.symbol, t).c);
      }
    }
    // Decision-driven sells (both modes, at the close — these are scans, not resting orders).
    const strength = new Map<string, NameStrength>([...decisions].map(([s, d]) => [s, { score: d.score, action: d.action }]));
    const livePos = positions.filter((p) => !exiting.has(p.symbol));
    for (const b of rotationBenches(livePos, strength, policy)) { if (!exiting.has(b.symbol)) sellAt(b.symbol, barAt(b.symbol, t).c); }
    for (const [sym, d] of decisions) { if (d.action === 'sell' && book.has(sym) && !exiting.has(sym)) sellAt(sym, barAt(sym, t).c); }

    // Buy side at the close — identical in both modes.
    const remaining: Position[] = [...book].map(([sym, lot]) => { const px = barAt(sym, t).c; return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) }; });
    const withCore = coreQty > 0
      ? [...remaining, { symbol: 'SPY', qty: coreQty, avgEntryPrice: spy[WARMUP].c, currentPrice: spy[t].c, marketValue: coreQty * spy[t].c, unrealizedPl: coreQty * (spy[t].c - spy[WARMUP].c) }]
      : remaining;
    const equityNow = cash + withCore.reduce((s, p) => s + p.marketValue, 0);
    const account: BrokerAccount = { cash, buyingPower: cash, equity: equityNow, currency: 'USD' };
    const buys = [...decisions.values()].filter((d) => d.action === 'buy' && !book.has(d.symbol) && d.price).sort((a, b) => b.confidence - a.confidence);
    let placed = 0;
    for (const d of buys) {
      if (placed >= 8) break;
      const px = barAt(d.symbol, t).c;
      const sized = sizeEntry(d.symbol, px, d.confidence, account, withCore, policy);
      if (sized.qty <= 0) continue;
      const cost = sized.qty * px;
      if (cost > cash) continue;
      cash -= cost;
      book.set(d.symbol, { qty: sized.qty, entry: px, peak: px });
      withCore.push({ symbol: d.symbol, qty: sized.qty, avgEntryPrice: px, currentPrice: px, marketValue: cost, unrealizedPl: 0 });
      placed++;
    }

    const equity = cash + [...book].reduce((s, [sym, lot]) => s + lot.qty * barAt(sym, t).c, 0) + coreQty * spy[t].c;
    equityCurve.push(equity);
    peakEquity = Math.max(peakEquity, equity);
    maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
  }

  const last = len - 1;
  for (const [sym, lot] of book) cash += lot.qty * barAt(sym, last).c;
  const finalEquity = cash + coreQty * spy[last].c;
  const ret = (finalEquity / START_CASH - 1) * 100;
  const spyRet = (spy[last].c / spy[WARMUP].c - 1) * 100;
  // Overnight-vs-intraday decomposition (operator question 2026-07-12: "sell at end of day, get
  // back in at the open — do we dodge the overnight kills?"). Compounds SPY's close→open moves
  // (what a flat-overnight holder FORFEITS) against its open→close moves (what they keep), plus
  // the keep-side after a 0.2% daily round-trip cost. Strategy-independent market structure.
  let spyOvernight = 1, spyIntraday = 1, spyIntradayCosted = 1;
  for (let t = WARMUP + 1; t <= last; t++) {
    spyOvernight *= spy[t].o / spy[t - 1].c;
    spyIntraday *= spy[t].c / spy[t].o;
    spyIntradayCosted *= (spy[t].c / spy[t].o) * (1 - 0.002);
  }
  const rets = equityCurve.slice(1).map((e, i) => e / equityCurve[i] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(252);

  console.log('───────────────────────────────────────────────');
  console.log(` Mode              : ${MODE}${MODE === 'venue' ? `  (${gapExits} gap-open exits)` : ''}`);
  console.log(` Strategy return   : ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   (core ${CORE_PCT}%, tp ${policy.takeProfitPct}%)`);
  console.log(` SPY buy & hold    : ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(1)}%`);
  console.log(` Max drawdown      : -${(maxDD * 100).toFixed(1)}%`);
  console.log(` Sharpe (annualized): ${sharpe.toFixed(2)}`);
  console.log(` Closed trades     : ${trades}  (win rate ${trades ? ((wins / (wins + losses)) * 100).toFixed(0) : 0}%)`);
  console.log(` SPY split         : overnight ${((spyOvernight - 1) * 100).toFixed(1)}% vs intraday ${((spyIntraday - 1) * 100).toFixed(1)}%  (intraday after 0.2%/day costs: ${((spyIntradayCosted - 1) * 100).toFixed(1)}%)`);
  console.log('───────────────────────────────────────────────');
  // Tail segments: the strategy's last N days with a WARM book (not a cold start), vs SPY same days.
  const tails: Array<{ days: number; retPct: number; spyPct: number }> = [];
  for (const n of TAIL_LIST) {
    if (equityCurve.length <= n) continue;
    const eq0 = equityCurve[equityCurve.length - 1 - n];
    const tailRet = (equityCurve[equityCurve.length - 1] / eq0 - 1) * 100;
    const tailSpy = (spy[last].c / spy[last - n].c - 1) * 100;
    tails.push({ days: n, retPct: Number(tailRet.toFixed(2)), spyPct: Number(tailSpy.toFixed(2)) });
    console.log(` Last ${n} days       : ${tailRet >= 0 ? '+' : ''}${tailRet.toFixed(2)}%   (SPY ${tailSpy >= 0 ? '+' : ''}${tailSpy.toFixed(2)}%)`);
  }
  const tail = tails.length ? tails[0] : null; // back-compat field
  console.log(`RESULT ${JSON.stringify({ mode: MODE, posture: POSTURE, corePct: CORE_PCT, tpPct: policy.takeProfitPct, warmup: WARMUP, days: len - WARMUP, retPct: Number(ret.toFixed(2)), spyPct: Number(spyRet.toFixed(2)), maxDDPct: Number((maxDD * 100).toFixed(2)), sharpe: Number(sharpe.toFixed(2)), trades, winRatePct: trades ? Number(((wins / (wins + losses)) * 100).toFixed(0)) : 0, gapExits, tail, tails })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('backtest failed:', e); process.exit(1); });
