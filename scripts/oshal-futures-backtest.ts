/**
 * Futures backtest runner — drives the ADR-116 strategy port over real or mock intraday bars.
 *
 * This is the harness that turns the ported strategy into numbers: it builds a continuous
 * front-month series for one or more roots (panama back-adjusted by default), runs the entry
 * evaluator + stop engine through the bar-walk simulator, scores the result with the trader's own
 * optimization fitnesses, and prints a per-market blotter plus the OVERLAID multi-market equity
 * curve — the portfolio view NinjaTrader does not draw.
 *
 * Two modes matter:
 *   --stage1 N   the trader's entry-optimization harness: hold every trade exactly N bars, no
 *                stops, score with AvgMFE/AvgMAE. His runs used 25.
 *   (default)    full stop-managed trading: initial stop → breakeven-gated chandelier trail →
 *                the ADX-gated Strangle tight stop.
 *
 * Data: `--source mock` (default) generates deterministic synthetic bars — enough to prove the
 * machinery and shake out wiring, NOT to draw conclusions about the strategy. `--source kibot-file`
 * reads the local Kibot bulk downloads (per-contract text files under --data-dir, `minute/` and
 * `daily/` subdirectories). `--source kibot` uses the credentialed Kibot HTTP source. Any
 * conclusion about edge needs real bars; the runner prints a banner saying so on mock data.
 *
 * Exit codes: 0 = ok · 2 = could not run.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — multi-root backtest runner over mock/Kibot bars with stage-1 timed-exit mode, the trader's fitness scoring, per-market summaries, and the overlaid multi-market equity curve.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Real-data wiring: --source kibot-file over the local bulk downloads (--data-dir, minute/ + daily/ layout), continuous series via buildContinuousSeries with panama back-adjustment on by default (--adjust none to inspect raw seams), explicit --start/--end windows, --min-volume floor, and per-seam reporting with measurement method.
 */
import 'dotenv/config';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MockFuturesDataSource, KibotFuturesDataSource, KibotFileDataSource, getFuturesRoot,
  buildContinuousSeries, runFuturesBacktest, overlayEquityCurves, maxDrawdownOf,
  maxAvgMfeMinAvgMae, entryLogicFitness, trailingStopFitness, positionSizingFitness,
  type Timeframe, type BacktestResult, type FuturesDataSource, type ContinuousSeries,
} from '@/features/trading';

interface Args {
  roots: string[]; tf: Timeframe; ltfTf: Timeframe; months: number;
  source: 'mock' | 'kibot' | 'kibot-file'; dataDir: string; adjust: 'panama' | 'none';
  start: Date | null; end: Date | null; minVolume: number;
  stage1: number; slippageTicks: number; commission: number; equity: number; riskPct: number;
}

const KNOWN_FLAGS = new Set([
  '--roots', '--tf', '--ltf', '--months', '--source', '--data-dir', '--adjust', '--start', '--end',
  '--min-volume', '--stage1', '--slippage-ticks', '--commission', '--equity', '--risk-pct',
]);

/** Parse CLI flags with defaults tuned to the trader's own workflow. */
function parseArgs(argv: string[]): Args {
  // A typo'd flag must not silently become "use the default" — on a real-data run that is a
  // silently wrong experiment. Unknown flags abort.
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    console.error(`[backtest] unknown flag(s): ${unknown.join(' ')} — aborting. Known: ${[...KNOWN_FLAGS].join(' ')}`);
    process.exit(2);
  }
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : undefined;
    // A flag written without a value must not swallow the NEXT flag as its argument — that turns
    // `--stage1 --roots ES` into stage1='--roots', NaN, and a silently wrong run.
    if (i >= 0 && (v === undefined || v.startsWith('--'))) {
      console.error(`[backtest] flag ${flag} has no value — using default '${def}'.`);
      return def;
    }
    return v ?? def;
  };
  const num = (flag: string, def: string): number => {
    const n = Number(get(flag, def));
    if (!Number.isFinite(n)) {
      console.error(`[backtest] ${flag} must be a number — aborting.`);
      process.exit(2);
    }
    return n;
  };
  const date = (flag: string): Date | null => {
    const v = get(flag, '');
    if (!v) return null;
    const d = new Date(v.includes('T') ? v : `${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      console.error(`[backtest] ${flag} must be an ISO date (YYYY-MM-DD) — aborting.`);
      process.exit(2);
    }
    return d;
  };
  return {
    roots: get('--roots', 'ES').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean),
    tf: get('--tf', '1Hour') as Timeframe,
    ltfTf: get('--ltf', '1Day') as Timeframe,
    months: num('--months', '12'),
    source: get('--source', 'mock') as Args['source'],
    dataDir: get('--data-dir', process.env.KIBOT_DATA_DIR || 'C:\\MarketData\\kibot'),
    adjust: get('--adjust', 'panama') === 'none' ? 'none' : 'panama',
    start: date('--start'),
    end: date('--end'),
    minVolume: num('--min-volume', '1'),
    stage1: num('--stage1', '0'),
    slippageTicks: num('--slippage-ticks', '1'),
    commission: num('--commission', '2.5'),
    equity: num('--equity', '100000'),
    riskPct: num('--risk-pct', '2'),
  };
}

/** Per-timeframe bar source + the unclamped probe used for overlap seam measurement. */
interface SourcePair { src: FuturesDataSource; probe?: FuturesDataSource; }

/**
 * Build the source (and seam probe) for one timeframe. kibot-file picks `minute/` for intraday and
 * `daily/` for 1Day/1Week (falling back to minute, which resamples, when no daily dir exists). The
 * probe is the same directory WITHOUT the front-month clamp or volume floor — the incoming
 * contract's pre-roll bars are back-month bars, which is exactly what seam measurement needs.
 */
function sourceFor(args: Args, tf: Timeframe, forceMinute = false): SourcePair {
  if (args.source === 'mock') return { src: new MockFuturesDataSource() };
  // NOTE: the live HTTP source gets no basis probe — every seam it feeds falls back to the noisier
  // 'adjacent' measurement. Acceptable while that path is credential-gated and unverified; wire a
  // probe when it goes live.
  if (args.source === 'kibot') return { src: new KibotFuturesDataSource() };
  const wantDaily = (tf === '1Day' || tf === '1Week') && !forceMinute;
  const dailyDir = join(args.dataDir, 'daily');
  const minuteDir = join(args.dataDir, 'minute');
  const dirExists = (d: string): boolean => { try { return statSync(d).isDirectory(); } catch { return false; } };
  const dir = wantDaily && dirExists(dailyDir) ? dailyDir : minuteDir;
  return {
    src: new KibotFileDataSource({ dir, minVolume: args.minVolume }),
    probe: new KibotFileDataSource({ dir, frontMonthOnly: false, minVolume: 0 }),
  };
}

/** Print one market's result block. */
function printResult(r: BacktestResult, stage1: number): void {
  const wins = r.trades.filter((t) => t.profit > 0).length;
  console.log(`\n=== ${r.symbol} ===`);
  console.log(`  bars ${r.barsProcessed}  trades ${r.trades.length}  win% ${(r.winRate * 100).toFixed(1)}  (${wins}W/${r.trades.length - wins}L)`);
  console.log(`  net $${r.netProfit.toFixed(0)}   maxDD $${r.maxDrawdown.toFixed(0)}   zero-qty skips ${r.skippedZeroQty}`);
  if (!r.trades.length) return;
  const ft = r.trades.map((t) => ({
    profit: t.profit, mfe: t.mfe, mae: t.mae, mfePct: t.mfePct, maePct: t.maePct, exitName: t.exitName,
  }));
  const agg = { maxDrawdown: r.maxDrawdown };
  if (stage1 > 0) {
    console.log(`  STAGE-1 fitness AvgMFE/AvgMAE = ${maxAvgMfeMinAvgMae(ft, agg).toFixed(4)}   (entry-logic ${entryLogicFitness(ft, agg).toFixed(2)})`);
  } else {
    console.log(`  fitness: entry ${entryLogicFitness(ft, agg).toFixed(2)}  trail ${trailingStopFitness(ft, agg).toFixed(2)}  sizing ${positionSizingFitness(ft, agg).toFixed(4)}`);
  }
  const byExit = new Map<string, number>();
  for (const t of r.trades) byExit.set(t.exitName, (byExit.get(t.exitName) ?? 0) + 1);
  console.log(`  exits: ${[...byExit.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

/** Print a continuous series' provenance: contracts used, seams, and adjustment state. */
function printSeries(root: string, label: string, s: ContinuousSeries, tickSize: number): void {
  console.log(`  ${label}: ${s.bars.length} bars from ${s.contracts.length} contracts (${s.contracts.slice(0, 4).map((c) => c.symbol).join(' ')}${s.contracts.length > 4 ? ` … +${s.contracts.length - 4}` : ''})`);
  if (!s.seams.length) return;
  // Coverage gaps are never adjusted (the jump is market drift, not roll basis) — say so loudly
  // regardless of the adjustment mode.
  const gaps = s.seams.filter((x) => x.method === 'gap');
  for (const g of gaps) {
    console.log(`\n  !! ${root} ${label}: COVERAGE GAP ${g.fromSymbol} → ${g.toSymbol} (level moved ${g.jump.toFixed(2)} pts across missing contracts).`);
    console.log('     This discontinuity is NOT adjustable; trades spanning it carry phantom P&L.');
  }
  const rolls = s.seams.filter((x) => x.method !== 'gap');
  if (!rolls.length) return;
  const overlap = rolls.filter((x) => x.method === 'overlap').length;
  if (s.adjusted) {
    console.log(`  ${label}: ${rolls.length} roll seam(s) back-adjusted (panama; ${overlap}/${rolls.length} overlap-measured)`);
    return;
  }
  const material = s.seams.filter((x) => Math.abs(x.jump) > tickSize * 8);
  if (material.length) {
    const worst = material.reduce((a, b) => (Math.abs(b.jump) > Math.abs(a.jump) ? b : a));
    console.log(`\n  !! ${root} ${label}: ${material.length} UN-adjusted roll seam(s), worst ${worst.jump.toFixed(2)} pts at ${worst.at}.`);
    console.log('     Trades spanning a seam carry phantom P&L — this run is for seam inspection, not results.');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chartSrc = sourceFor(args, args.tf);
  const ltfSrc = sourceFor(args, args.ltfTf);
  if (!chartSrc.src.configured()) {
    console.error(`[backtest] source '${chartSrc.src.name}' is not configured (missing credentials or data dir) — aborting.`);
    process.exit(2);
  }
  const end = args.end ?? new Date();
  const start = args.start ?? (() => { const d = new Date(end); d.setMonth(d.getMonth() - args.months); return d; })();
  if (start.getTime() >= end.getTime()) {
    console.error('[backtest] --start must be before --end — aborting.');
    process.exit(2);
  }

  if (args.source === 'mock') {
    console.log('\n*** MOCK DATA — this run proves the machinery, NOT the strategy. ***');
    console.log('*** Any statement about edge requires real bars (--source kibot-file). ***');
  }
  console.log(`\n[backtest] ${args.roots.join(',')} ${args.tf} (LTF ${args.ltfTf}) — ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}, source=${chartSrc.src.name}, adjust=${args.adjust}`);
  console.log(`[backtest] costs: ${args.slippageTicks} tick slippage/side, $${args.commission}/contract/side; equity $${args.equity}, risk ${args.riskPct}%`);
  if (args.stage1 > 0) console.log(`[backtest] STAGE-1 MODE: fixed ${args.stage1}-bar exit, stops suppressed (entry optimization)`);

  const results: BacktestResult[] = [];
  for (const root of args.roots) {
    const meta = getFuturesRoot(root);
    if (!meta) { console.error(`[backtest] unknown root '${root}' — skipping.`); continue; }
    console.log(`\n--- ${root} ---`);
    const chart = await buildContinuousSeries(chartSrc.src, root, args.tf, start, end, { adjust: args.adjust, basisProbe: chartSrc.probe });
    let ltf = await buildContinuousSeries(ltfSrc.src, root, args.ltfTf, start, end, { adjust: args.adjust, basisProbe: ltfSrc.probe });
    if (!ltf.bars.length && args.source === 'kibot-file') {
      // daily/ existing is not the same as daily/ covering THIS root — fall back to resampling
      // the minute files before declaring the LTF empty.
      const alt = sourceFor(args, args.ltfTf, /* forceMinute */ true);
      ltf = await buildContinuousSeries(alt.src, root, args.ltfTf, start, end, { adjust: args.adjust, basisProbe: alt.probe });
      if (ltf.bars.length) console.log(`  LTF: daily/ had no ${root} files — resampled from minute/ instead.`);
    }
    printSeries(root, `chart ${args.tf}`, chart, meta.tickSize);
    printSeries(root, `LTF ${args.ltfTf}`, ltf, meta.tickSize);
    if (chart.bars.length < 100) { console.error(`[backtest] ${root}: only ${chart.bars.length} bars — skipping.`); continue; }
    if (!ltf.bars.length) { console.error(`[backtest] ${root}: LTF series is empty — skipping (the evaluator would gate every entry).`); continue; }
    const r = runFuturesBacktest(chart.bars, ltf.bars, {
      instrument: { symbol: root, multiplier: meta.multiplier, tickSize: meta.tickSize },
      entry: { generation: 'dynstops', riskPerTradePercent: args.riskPct },
      stops: { useStrangleTrail: true },
      costs: { slippageTicks: args.slippageTicks, commissionPerContract: args.commission },
      startingEquity: args.equity,
      timedBarsToExit: args.stage1,
    });
    results.push(r);
    printResult(r, args.stage1);
  }

  if (results.length > 1) {
    const overlay = overlayEquityCurves(results, args.equity);
    const combined = overlay.length ? overlay[overlay.length - 1].equity : 0;
    const base = args.equity * results.length;
    console.log('\n=== OVERLAID PORTFOLIO (all markets, independent accounts) ===');
    console.log(`  markets ${results.length}   combined equity $${combined.toFixed(0)}  (from $${base.toFixed(0)}, net $${(combined - base).toFixed(0)})`);
    console.log(`  overlay maxDD $${maxDrawdownOf(overlay.map((p) => ({ time: p.time, equity: p.equity, tradeIndex: 0 }))).toFixed(0)}`);
    console.log(`  total trades ${results.reduce((a, r) => a + r.trades.length, 0)}`);
  }
  if (!results.length) { console.error('[backtest] no markets produced a run.'); process.exit(2); }
  console.log('');
}

main().catch((err) => {
  console.error('[backtest] failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
