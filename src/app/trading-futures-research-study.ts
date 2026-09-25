/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Isolate read-only Futures studies with completed-window evidence fingerprints.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Refuse stale source dates before each market's optimizer and retain per-window sample gate evidence.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_OPTIMIZER_STAGES, getFuturesRoot, runStagedOptimizer,
  MockFuturesDataSource, KibotFuturesDataSource, KibotFileDataSource, buildContinuousSeries,
  type BacktestConfig, type OptimizerStage, type StagedOptimizerReport, type Timeframe,
  type FuturesDataSource, type ContinuousSeries,
} from '../features/trading';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import { assertFuturesSourceFreshness, assessFuturesSample, type FuturesResearchQuality } from './trading-futures-research-quality';

export interface FuturesResearchMarket {
  root: string; bars: number; ltfBars: number; ltfResampledFromMinute: boolean;
  chartAsOf: string; ltfAsOf: string; latestCompleteOosEnd: string; evidenceFingerprint: string;
  outOfSampleTrades: number; outOfSampleNet: number; worstOutOfSampleMaxDD: number;
  report: StagedOptimizerReport;
  quality?: FuturesResearchQuality;
}

interface SourcePair { src: FuturesDataSource; probe?: FuturesDataSource }
function sourceFor(config: FuturesResearchConfig, tf: Timeframe, forceMinute = false): SourcePair {
  if (config.source === 'mock') return { src: new MockFuturesDataSource() };
  if (config.source === 'kibot') return { src: new KibotFuturesDataSource() };
  const daily = join(config.dataDir, 'daily');
  const minute = join(config.dataDir, 'minute');
  const isDaily = (tf === '1Day' || tf === '1Week') && !forceMinute;
  const dir = isDaily && statSync(daily, { throwIfNoEntry: false })?.isDirectory() ? daily : minute;
  return { src: new KibotFileDataSource({ dir, minVolume: config.minVolume }), probe: new KibotFileDataSource({ dir, frontMonthOnly: false, minVolume: 0 }) };
}

async function buildSeries(config: FuturesResearchConfig, root: string): Promise<{ chart: ContinuousSeries; ltf: ContinuousSeries; ltfResampledFromMinute: boolean }> {
  const pair = sourceFor(config, config.timeframe); const ltfPair = sourceFor(config, config.ltfTimeframe);
  if (!pair.src.configured()) throw new Error(`source '${config.source}' is not configured`);
  const start = new Date(config.start); const end = new Date(config.end);
  const chart = await buildContinuousSeries(pair.src, root, config.timeframe, start, end, { adjust: config.adjust, basisProbe: pair.probe });
  let ltf = await buildContinuousSeries(ltfPair.src, root, config.ltfTimeframe, start, end, { adjust: config.adjust, basisProbe: ltfPair.probe });
  let ltfResampledFromMinute = false;
  if (!ltf.bars.length && config.source === 'kibot-file') {
    const fallback = sourceFor(config, config.ltfTimeframe, true);
    ltf = await buildContinuousSeries(fallback.src, root, config.ltfTimeframe, start, end, { adjust: config.adjust, basisProbe: fallback.probe });
    ltfResampledFromMinute = ltf.bars.length > 0;
  }
  return { chart, ltf, ltfResampledFromMinute };
}

function baseConfig(root: string): BacktestConfig {
  const meta = getFuturesRoot(root)!;
  return { instrument: { symbol: root, multiplier: meta.multiplier, tickSize: meta.tickSize }, entry: { generation: 'ensemble', riskPerTradePercent: 2 }, stops: { useStrangleTrail: true }, costs: { slippageTicks: 1, commissionPerContract: 2.5 }, startingEquity: 100_000 };
}

function stagesFor(config: FuturesResearchConfig): OptimizerStage[] {
  return DEFAULT_OPTIMIZER_STAGES.map((stage) => ({ ...stage, grid: config.stageGrids[stage.name] ?? stage.grid }));
}

/** Only bars inside a completed OOS horizon count as new research evidence. */
function evidenceFingerprint(config: FuturesResearchConfig, root: string, chart: ContinuousSeries, ltf: ContinuousSeries, report: StagedOptimizerReport): string {
  const lastWindow = report.windows.at(-1)!;
  const end = Date.parse(lastWindow.window.oosEnd);
  const { end: _end, endMode: _endMode, nightlyCron: _nightlyCron, ...studyDefinition } = config;
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ root, studyDefinition, report }));
  for (const [kind, bars] of [['chart', chart.bars], ['ltf', ltf.bars]] as const) {
    hash.update(`\n${kind}\n`);
    for (const bar of bars) if (Date.parse(bar.t) < end) hash.update(`${JSON.stringify(bar)}\n`);
  }
  return hash.digest('hex');
}

function lastBarAt(series: ContinuousSeries): string {
  return series.bars.reduce((latest, bar) => bar.t > latest ? bar.t : latest, '');
}

export async function executeFuturesStudy(config: FuturesResearchConfig): Promise<FuturesResearchMarket[]> {
  const markets: FuturesResearchMarket[] = [];
  for (const root of config.roots) {
    const { chart, ltf, ltfResampledFromMinute } = await buildSeries(config, root);
    if (!chart.bars.length || !ltf.bars.length) throw new Error(`${root}: chart or higher-timeframe series is empty`);
    const chartAsOf = lastBarAt(chart), ltfAsOf = lastBarAt(ltf);
    const freshness = assertFuturesSourceFreshness(config.quality, root, config.end, chartAsOf, ltfAsOf);
    const report = runStagedOptimizer({ chart: chart.bars, ltf: ltf.bars, daily: config.ltfTimeframe === '1Day' ? ltf.bars : [] }, baseConfig(root), { split: config.split, stages: stagesFor(config) });
    if (!report.windows.length) throw new Error(`${root}: archive has no complete out-of-sample window`);
    markets.push({ root, bars: chart.bars.length, ltfBars: ltf.bars.length, ltfResampledFromMinute,
      chartAsOf, ltfAsOf, quality: assessFuturesSample(config.quality, freshness, report),
      latestCompleteOosEnd: report.windows.at(-1)!.window.oosEnd,
      evidenceFingerprint: evidenceFingerprint(config, root, chart, ltf, report),
      outOfSampleTrades: report.outOfSampleTrades, outOfSampleNet: report.outOfSampleNet, worstOutOfSampleMaxDD: report.worstOutOfSampleMaxDD, report });
  }
  return markets;
}
