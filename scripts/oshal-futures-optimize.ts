/**
 * ADR-116 Phase 2 — run the staged locked-winner optimizer on real Kibot archives.
 *
 * The command intentionally defaults to the local ES/CL daily archives and writes a deterministic
 * JSON report. It is an evidence runner, not a live trading path: the optimizer only reads bars and
 * invokes the in-process backtester.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add the real-bar Phase 2 evidence command with explicit source/data/window arguments and machine-readable per-market OOS output.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_OPTIMIZER_STAGES,
  getFuturesRoot,
  mergeBacktestConfig,
  runStagedOptimizer,
  type BacktestConfig,
  type ConfigPatch,
  type Timeframe,
} from '@/features/trading';
import { buildMarketSeries, sourceFor, type SeriesRequest } from './lib/futures-series';

function arg(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(`${name} requires a value`);
  return value ?? fallback;
}

function dateArg(argv: string[], name: string, fallback: string): Date {
  const value = new Date(arg(argv, name, fallback));
  if (Number.isNaN(value.getTime())) throw new Error(`${name} must be an ISO date`);
  return value;
}

function baseConfig(root: string, multiplier: number, tickSize: number): BacktestConfig {
  return {
    instrument: { symbol: root, multiplier, tickSize },
    // The Entry stage sweeps ensembleEntryThresholdPct; keep that axis live rather than
    // silently running an older generation that ignores the threshold.
    entry: { generation: 'ensemble', riskPerTradePercent: 2 },
    stops: { useStrangleTrail: true },
    costs: { slippageTicks: 1, commissionPerContract: 2.5 },
    startingEquity: 100_000,
  };
}

function readPatch(path: string): ConfigPatch {
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--config must contain an object');
  return parsed as ConfigPatch;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const roots = arg(argv, '--roots', 'ES,CL').split(',').map((root) => root.trim().toUpperCase()).filter(Boolean);
  const tf = arg(argv, '--tf', '1Day') as Timeframe;
  const ltfTf = arg(argv, '--ltf', '1Day') as Timeframe;
  const dataDir = arg(argv, '--data-dir', process.env.KIBOT_DATA_DIR || 'C:\\MarketData\\kibot');
  const source = arg(argv, '--source', 'kibot-file') as 'kibot-file' | 'mock';
  const start = dateArg(argv, '--start', '2021-01-01T00:00:00Z');
  const end = dateArg(argv, '--end', '2025-12-31T23:59:59Z');
  const outPath = arg(argv, '--out', 'docs/apps/trading/futures-phase2-oos-2026-09-24.json');
  const configPatch = readPatch(arg(argv, '--config', ''));
  const split = {
    inSampleMonths: Number(arg(argv, '--is-months', '24')),
    oosMonths: Number(arg(argv, '--oos-months', '6')),
    stepMonths: Number(arg(argv, '--step-months', '6')),
  };
  if (Object.values(split).some((value) => !Number.isInteger(value) || value <= 0)) throw new Error('split months must be positive integers');

  const request: SeriesRequest = { source, dataDir, adjust: 'panama', minVolume: 1, tf, ltfTf, start, end };
  const chartSource = sourceFor(request, tf);
  const ltfSource = sourceFor(request, ltfTf);
  if (!chartSource.src.configured()) throw new Error(`source '${chartSource.src.name}' is not configured`);
  const markets: Array<Record<string, unknown>> = [];
  for (const root of roots) {
    const meta = getFuturesRoot(root);
    if (!meta) throw new Error(`unknown futures root '${root}'`);
    const { chart, ltf } = await buildMarketSeries(request, root, chartSource, ltfSource);
    const config = mergeBacktestConfig(baseConfig(root, meta.multiplier, meta.tickSize), configPatch);
    const report = runStagedOptimizer(
      { chart: chart.bars, ltf: ltf.bars, daily: ltfTf === '1Day' ? ltf.bars : [] },
      config,
      { split, stages: [...DEFAULT_OPTIMIZER_STAGES] },
    );
    markets.push({ root, bars: chart.bars.length, ltfBars: ltf.bars.length, report });
    console.log(`${root}: ${report.windows.length} windows, OOS ${report.outOfSampleTrades} trades, net ${report.outOfSampleNet.toFixed(2)}, worst OOS DD ${report.worstOutOfSampleMaxDD.toFixed(2)}`);
  }
  writeFileSync(outPath, `${JSON.stringify({ source, roots, tf, ltf: ltfTf, start: start.toISOString(), end: end.toISOString(), split, markets }, null, 2)}\n`, 'utf8');
  console.log(`wrote ${outPath}`);
}

main().catch((error) => { console.error(`futures-optimize: ${error instanceof Error ? error.message : String(error)}`); process.exit(2); });
