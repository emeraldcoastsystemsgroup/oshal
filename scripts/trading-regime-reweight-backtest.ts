/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regime-reweight evidence harness: lab-sim A/B/C over a ~2-week walked window (incumbent 140-universe vs the 159 regime universe at core 60 and core 54) + a direct dated-close comparison of the proposed core basket (SPY/BRK.B/NANC/XLE/XLB) vs the incumbent SPY:60 core. Read-only market data; no orders, no DB writes.
 */

/**
 * Regime-change reweight backtest (operator request 2026-07-26).
 *
 * Two questions, answered with the SAME machinery the platform already trusts:
 *  1. Does the 19-name universe expansion change what the armed gravity rotation would have
 *     done over the last ~2 weeks? (lab sim runBacktest, pinned universes, short walk)
 *  2. Would the proposed core basket (SPY:20 BRK.B:12 NANC:8 XLE:8 XLB:6) have beaten the
 *     incumbent SPY:60 core over the same window? (direct dated-close weighted returns)
 *
 * HONEST LIMITS: a ~10-session walk is a regime probe, not a validation — the lab's nightly
 * forward walks remain the real A/B. The sim's core is single-symbol (SPY), so the basket
 * effect is measured separately in part 2, not inside the sim.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/trading-regime-reweight-backtest.ts
 */
import 'dotenv/config';
import { DEFAULT_UNIVERSE } from '@/features/trading';
import { runBacktest, normalizeConfig } from '../src/app/trading-strategy-lab-sim';
import { barsBatchSince } from '../src/features/trading/services/market-data';

/** The 19 names the 2026-07-26 reweight added — subtracting them recovers the incumbent 140. */
const ADDED = new Set([
  'FCX', 'NEM', 'LIN', 'APD', 'SCCO', 'NUE', 'STLD', 'ALB', 'MP',
  'STX', 'WDC', 'SNDK', 'PSTG', 'NTAP',
  'MCO', 'VRSN', 'KHC',
  'TEM', 'AB',
]);

/** Calendar-day fetch window sized so the walk after the 80-session warmup is ~2 weeks. */
const WINDOW_DAYS = 135;

/** Proposed core basket: symbol -> target % of book equity (54 total, vs incumbent SPY 60). */
const BASKET: ReadonlyArray<{ sym: string; pct: number }> = [
  { sym: 'SPY', pct: 20 }, { sym: 'BRK.B', pct: 12 }, { sym: 'NANC', pct: 8 },
  { sym: 'XLE', pct: 8 }, { sym: 'XLB', pct: 6 },
];

const fmt = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(2);

async function simPart(): Promise<void> {
  const expanded = [...DEFAULT_UNIVERSE];
  const incumbent = expanded.filter((s) => !ADDED.has(s));
  const base = {
    kind: 'rotation', rank: 'gravity', topN: 12, posture: 'active', weighting: 'conviction',
    coreSymbol: 'SPY', warmupDays: 80, windowDays: WINDOW_DAYS, cadenceDays: 1, takeProfitPct: null,
  };
  const variants = [
    { label: 'A incumbent  (140 names, SPY core 60%)', cfg: { ...base, universe: incumbent, corePct: 60 } },
    { label: 'B expanded   (159 names, SPY core 60%)', cfg: { ...base, universe: expanded, corePct: 60 } },
    { label: 'C expanded   (159 names, SPY core 54%)', cfg: { ...base, universe: expanded, corePct: 54 } },
  ];
  console.log(`\n── Lab sim: armed gravity rotation, ~2-week walk (fetch ${WINDOW_DAYS}d, warmup 80 sessions) ──`);
  for (const v of variants) {
    const sim = await runBacktest(normalizeConfig(v.cfg), { windowDays: WINDOW_DAYS });
    const m = sim.metrics;
    console.log(
      `${v.label}  walk ${sim.windowStart}..${sim.windowEnd} (${sim.bars} sessions, ${sim.feed})\n` +
      `   return ${fmt(m.totalReturnPct)}%  vs SPY ${fmt(m.spyReturnPct)}%  alpha ${fmt(m.alphaVsSpyPct)}pts  ` +
      `maxDD ${m.maxDrawdownPct}%  trades ${m.trades}  win ${m.winRatePct}%`,
    );
  }
}

async function basketPart(): Promise<void> {
  const startIso = new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const symbols = [...new Set([...BASKET.map((b) => b.sym), 'SPY'])];
  const bars = await barsBatchSince(symbols, startIso, 'sip');
  const spy = bars.get('SPY') || [];
  if (spy.length < 12) throw new Error(`not enough SPY sessions (${spy.length})`);
  const dates = spy.slice(-11).map((b) => b.d); // 11 closes = 10 return-days ≈ 2 trading weeks
  console.log(`\n── Core basket vs incumbent SPY core, ${dates[0]} .. ${dates[dates.length - 1]} ──`);
  const retOf = (sym: string): number => {
    const s = (bars.get(sym) || []).filter((b) => b.d >= dates[0] && b.d <= dates[dates.length - 1]);
    if (s.length < 2) throw new Error(`no aligned closes for ${sym} (${s.length})`);
    return (s[s.length - 1].c / s[0].c - 1) * 100;
  };
  const spyRet = retOf('SPY');
  let basketRet = 0; // basket return, weighted within the 54-pt core
  for (const { sym, pct } of BASKET) {
    const r = retOf(sym);
    basketRet += (pct / 54) * r;
    console.log(`   ${sym.padEnd(6)} ${String(pct).padStart(2)}% of book  2wk ${fmt(r)}%`);
  }
  console.log(`   basket (54% of book, weighted)  ${fmt(basketRet)}%  vs SPY ${fmt(spyRet)}%  edge ${fmt(basketRet - spyRet)}pts`);
  // Book-level core contribution: what the parked slice adds to total book return.
  console.log(`   book-level core contribution: incumbent 60%×SPY = ${fmt(0.60 * spyRet)}pts  proposed = ${fmt(0.54 * basketRet)}pts`);
}

(async () => {
  await simPart();
  await basketPart();
})().catch((err) => { console.error('BACKTEST FAILED:', (err as Error).message); process.exit(1); });
