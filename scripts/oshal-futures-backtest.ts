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
 * Evidence flags (ADR-116 Phase 1): `--config <json>` deep-merges a partial BacktestConfig over
 * the literal below, `--out <json>` writes the run machine-readable so no downstream tool has to
 * re-parse stdout, and `--walk-forward` swaps the single whole-archive run for rolling
 * in-sample/out-of-sample windows at FROZEN constants — the only shape in which a futures number
 * here is quotable as evidence about the strategy rather than about the archive.
 *
 * Exit codes: 0 = ok · 2 = could not run.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — multi-root backtest runner over mock/Kibot bars with stage-1 timed-exit mode, the trader's fitness scoring, per-market summaries, and the overlaid multi-market equity curve.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Real-data wiring: --source kibot-file over the local bulk downloads (--data-dir, minute/ + daily/ layout), continuous series via buildContinuousSeries with panama back-adjustment on by default (--adjust none to inspect raw seams), explicit --start/--end windows, --min-volume floor, and per-seam reporting with measurement method.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-116 Phase 1 evidence rail: --config (deep-merged partial config, null refused, undefined never becoming NaN), --out (machine-readable per-market JSON), --walk-forward with --is-months/--oos-months/--step-months at frozen constants, and the regime gate's dailyBars argument finally passed when the LTF series IS the daily series — before this the gate blocked every bar whenever it was enabled.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  getFuturesRoot, runFuturesBacktest, overlayEquityCurves, maxDrawdownOf,
  maxAvgMfeMinAvgMae, entryLogicFitness, trailingStopFitness, positionSizingFitness,
  mergeBacktestConfig, walkForward,
  type Timeframe, type BacktestResult, type BacktestConfig,
  type ContinuousSeries, type ConfigPatch, type WalkForwardReport,
} from '@/features/trading';
import { sourceFor, buildMarketSeries, type SeriesRequest } from './lib/futures-series';

interface Args {
  roots: string[]; tf: Timeframe; ltfTf: Timeframe; months: number;
  source: 'mock' | 'kibot' | 'kibot-file'; dataDir: string; adjust: 'panama' | 'none';
  start: Date | null; end: Date | null; minVolume: number;
  stage1: number; slippageTicks: number; commission: number; equity: number; riskPct: number;
  configPath: string; outPath: string;
  walkForward: boolean; isMonths: number; oosMonths: number; stepMonths: number;
}

const KNOWN_FLAGS = new Set([
  '--roots', '--tf', '--ltf', '--months', '--source', '--data-dir', '--adjust', '--start', '--end',
  '--min-volume', '--stage1', '--slippage-ticks', '--commission', '--equity', '--risk-pct',
  '--config', '--out', '--walk-forward', '--is-months', '--oos-months', '--step-months',
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
    configPath: get('--config', ''),
    outPath: get('--out', ''),
    // A boolean flag must not be read through `get` — that helper treats a following flag as a
    // missing value and would report a phantom default.
    walkForward: argv.includes('--walk-forward'),
    isMonths: num('--is-months', '24'),
    oosMonths: num('--oos-months', '6'),
    stepMonths: num('--step-months', '6'),
  };
}

/**
 * Read a partial BacktestConfig from a JSON file. A malformed or non-object file aborts: a run that
 * silently ignored its own config file would publish numbers attributed to constants it never used.
 */
function loadConfigPatch(path: string): ConfigPatch {
  if (!path) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[backtest] --config ${path} could not be read: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[backtest] --config ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`[backtest] --config ${path} must contain a JSON object.`);
    process.exit(2);
  }
  return parsed as ConfigPatch;
}

/** The frozen literal every run starts from; `--config` is deep-merged over this, never under it. */
function baseConfig(args: Args, root: string, multiplier: number, tickSize: number): BacktestConfig {
  return {
    instrument: { symbol: root, multiplier, tickSize },
    entry: { generation: 'dynstops', riskPerTradePercent: args.riskPct },
    stops: { useStrangleTrail: true },
    costs: { slippageTicks: args.slippageTicks, commissionPerContract: args.commission },
    startingEquity: args.equity,
    timedBarsToExit: args.stage1,
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

/** Currency, whole dollars, sign kept — the only money formatting this runner does. */
function fmtUsd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(0)}`;
}

/** One market's walk-forward evidence, kept together for the --out artifact. */
interface MarketWalkForward { symbol: string; report: WalkForwardReport }

/**
 * Print one market's walk-forward evidence: every window's two halves side by side, then the
 * aggregate. In-sample and out-of-sample are never merged into one number on purpose — the whole
 * point of this mode is that the reader can see which column a figure came from.
 */
function printWalkForward(root: string, r: WalkForwardReport): void {
  const s = r.split;
  console.log(`
=== ${root} WALK-FORWARD (${s.inSampleMonths}m IS / ${s.oosMonths}m OOS / ${s.stepMonths}m step) ===`);
  if (!r.windows.length) {
    console.log('  no complete window fits this data range — widen --start/--end or shorten the split.');
    return;
  }
  const mo = (iso: string): string => iso.slice(0, 7);
  console.log('  win |   in-sample period   trades       net |  out-of-sample period  trades       net     maxDD');
  for (const w of r.windows) {
    console.log(
      `  ${String(w.window.index).padStart(3)} | ${mo(w.window.isStart)}→${mo(w.window.isEnd)}`
      + ` ${String(w.isTrades).padStart(8)} ${fmtUsd(w.isNet).padStart(9)}`
      + ` | ${mo(w.window.oosStart)}→${mo(w.window.oosEnd)}`
      + ` ${String(w.oosTrades).padStart(8)} ${fmtUsd(w.oosNet).padStart(9)} ${fmtUsd(w.oosMaxDD).padStart(9)}`,
    );
  }
  console.log(`  TOTAL  IS ${r.isTrades} trades ${fmtUsd(r.isNet)}   OOS ${r.oosTrades} trades ${fmtUsd(r.oosNet)}   worst-window OOS maxDD ${fmtUsd(r.oosMaxDD)}`);
  const deg = r.degradation === null ? 'n/a — the in-sample half did not make money' : r.degradation.toFixed(3);
  console.log(`  degradation (OOS $/month ÷ IS $/month): ${deg}`);
  console.log('  OOS periods are bars the frozen constants never saw. Each window is an independent account — do not add the drawdowns.');
}

/**
 * Write the machine-readable run artifact. Deliberately carries NO timestamp: two runs of the same
 * command over the same archive must produce byte-identical files, which is what makes "re-run it
 * and diff" a usable harness self-check instead of an eyeball comparison of stdout.
 */
function writeOut(path: string, args: Args, results: BacktestResult[], wf: MarketWalkForward[]): void {
  const doc = {
    argv: process.argv.slice(2),
    source: args.source, roots: args.roots, tf: args.tf, ltf: args.ltfTf, adjust: args.adjust,
    costs: { slippageTicks: args.slippageTicks, commissionPerContract: args.commission },
    startingEquity: args.equity, riskPct: args.riskPct, timedBarsToExit: args.stage1,
    markets: results.map((r) => ({
      symbol: r.symbol, trades: r.trades.length, winRate: r.winRate, netProfit: r.netProfit,
      maxDrawdown: r.maxDrawdown, barsProcessed: r.barsProcessed, skippedZeroQty: r.skippedZeroQty,
      marginModeled: r.marginModeled, peakLeverage: r.peakLeverage,
      regimeBlockedSignals: r.regimeBlockedSignals, regimeBlockedBars: r.regimeBlockedBars,
      warnings: r.warnings,
      exits: r.trades.reduce<Record<string, number>>((acc, t) => {
        acc[t.exitName] = (acc[t.exitName] ?? 0) + 1;
        return acc;
      }, {}),
    })),
    walkForward: wf,
  };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}
`, 'utf8');
  console.log(`[backtest] wrote ${path}`);
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
  const end = args.end ?? new Date();
  const start = args.start ?? (() => { const d = new Date(end); d.setMonth(d.getMonth() - args.months); return d; })();
  const req: SeriesRequest = {
    source: args.source, dataDir: args.dataDir, adjust: args.adjust, minVolume: args.minVolume,
    tf: args.tf, ltfTf: args.ltfTf, start, end,
  };
  const chartSrc = sourceFor(req, args.tf);
  const ltfSrc = sourceFor(req, args.ltfTf);
  if (!chartSrc.src.configured()) {
    console.error(`[backtest] source '${chartSrc.src.name}' is not configured (missing credentials or data dir) — aborting.`);
    process.exit(2);
  }
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

  const patch = loadConfigPatch(args.configPath);
  if (args.configPath) console.log(`[backtest] config overlay: ${args.configPath}`);
  if (args.walkForward) {
    console.log(`[backtest] WALK-FORWARD: ${args.isMonths}m in-sample / ${args.oosMonths}m out-of-sample / ${args.stepMonths}m step, constants FROZEN across every window.`);
  }
  const results: BacktestResult[] = [];
  const walkForwardReports: MarketWalkForward[] = [];
  for (const root of args.roots) {
    const meta = getFuturesRoot(root);
    if (!meta) { console.error(`[backtest] unknown root '${root}' — skipping.`); continue; }
    console.log(`\n--- ${root} ---`);
    const { chart, ltf, ltfResampledFromMinute } = await buildMarketSeries(req, root, chartSrc, ltfSrc);
    if (ltfResampledFromMinute) console.log(`  LTF: daily/ had no ${root} files — resampled from minute/ instead.`);
    printSeries(root, `chart ${args.tf}`, chart, meta.tickSize);
    printSeries(root, `LTF ${args.ltfTf}`, ltf, meta.tickSize);
    if (chart.bars.length < 100) { console.error(`[backtest] ${root}: only ${chart.bars.length} bars — skipping.`); continue; }
    if (!ltf.bars.length) { console.error(`[backtest] ${root}: LTF series is empty — skipping (the evaluator would gate every entry).`); continue; }
    let cfg: BacktestConfig;
    try {
      cfg = mergeBacktestConfig(baseConfig(args, root, meta.multiplier, meta.tickSize), patch);
    } catch (err) {
      console.error(`[backtest] --config rejected: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
    // The R10 regime gate reads DAILY bars. Feed it the LTF series only when that series IS the
    // daily series: an hourly LTF handed to a daily gate is a different indicator, not a stand-in.
    // Before this the gate was never given bars at all, so enabling it blocked every bar.
    const daily = args.ltfTf === '1Day' ? ltf.bars : [];
    if (args.walkForward) {
      const report = walkForward({ chart: chart.bars, ltf: ltf.bars, daily }, cfg, {
        split: { inSampleMonths: args.isMonths, oosMonths: args.oosMonths, stepMonths: args.stepMonths },
      });
      walkForwardReports.push({ symbol: root, report });
      printWalkForward(root, report);
      continue;
    }
    const r = runFuturesBacktest(chart.bars, ltf.bars, cfg, daily);
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
  if (!results.length && !walkForwardReports.length) {
    console.error('[backtest] no markets produced a run.');
    process.exit(2);
  }
  if (args.outPath) writeOut(args.outPath, args, results, walkForwardReports);
  console.log('');
}

main().catch((err) => {
  console.error('[backtest] failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
