/** Isolated, read-only ADR-116 market study. No schedule, database or order access lives here. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_OPTIMIZER_STAGES, getFuturesRoot, runStagedOptimizer,
  MockFuturesDataSource, KibotFuturesDataSource, KibotFileDataSource, buildContinuousSeries,
  type BacktestConfig, type OptimizerStage, type StagedOptimizerReport, type Timeframe,
  type FuturesDataSource, type ContinuousSeries,
} from '../features/trading';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';

export interface FuturesResearchMarket {
  root: string; bars: number; ltfBars: number; ltfResampledFromMinute: boolean;
  outOfSampleTrades: number; outOfSampleNet: number; worstOutOfSampleMaxDD: number;
  report: StagedOptimizerReport;
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

export async function executeFuturesStudy(config: FuturesResearchConfig): Promise<FuturesResearchMarket[]> {
  const markets: FuturesResearchMarket[] = [];
  for (const root of config.roots) {
    const { chart, ltf, ltfResampledFromMinute } = await buildSeries(config, root);
    if (!chart.bars.length || !ltf.bars.length) throw new Error(`${root}: chart or higher-timeframe series is empty`);
    const report = runStagedOptimizer({ chart: chart.bars, ltf: ltf.bars, daily: config.ltfTimeframe === '1Day' ? ltf.bars : [] }, baseConfig(root), { split: config.split, stages: stagesFor(config) });
    if (!report.windows.length) throw new Error(`${root}: archive has no complete out-of-sample window`);
    markets.push({ root, bars: chart.bars.length, ltfBars: ltf.bars.length, ltfResampledFromMinute, outOfSampleTrades: report.outOfSampleTrades, outOfSampleNet: report.outOfSampleNet, worstOutOfSampleMaxDD: report.worstOutOfSampleMaxDD, report });
  }
  return markets;
}
