/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Isolate read-only Futures studies with completed-window evidence fingerprints.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Refuse stale source dates before each market's optimizer and retain per-window sample gate evidence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Exclude the operational review opt-in from market-evidence fingerprints.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Exclude forward operational controls from historical evidence fingerprints.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Reuse exact owned inputs before optimization after source freshness; canonicalize stored report evidence.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Classify missing/empty sources for owner notification without hiding unexpected worker errors.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_OPTIMIZER_STAGES, getFuturesRoot, runStagedOptimizer, walkForwardWindows,
  MockFuturesDataSource, KibotFuturesDataSource, KibotFileDataSource, buildContinuousSeries,
  type BacktestConfig, type OptimizerStage, type StagedOptimizerReport, type Timeframe,
  type FuturesDataSource, type ContinuousSeries,
} from '../features/trading';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import { FuturesSourceError } from './trading-futures-source-error';
import { assertFuturesSourceFreshness, assessFuturesSample, type FuturesResearchQuality } from './trading-futures-research-quality';
import { fingerprintFuturesEvidence } from './trading-futures-prediction-evidence';
import { futuresStudyDefinition, futuresStudyInputFingerprint, reusableFuturesReport, type FuturesStudyComputation, type FuturesStudyReuse } from './trading-futures-research-reuse';

export interface FuturesResearchMarket {
  root: string; bars: number; ltfBars: number; ltfResampledFromMinute: boolean;
  chartAsOf: string; ltfAsOf: string; latestCompleteOosEnd: string; evidenceFingerprint: string;
  outOfSampleTrades: number; outOfSampleNet: number; worstOutOfSampleMaxDD: number;
  report: StagedOptimizerReport;
  quality?: FuturesResearchQuality;
  computation?: FuturesStudyComputation;
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
  if (!pair.src.configured()) throw new FuturesSourceError(`source '${config.source}' is not configured`, { code: 'unconfigured', root });
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
  const hash = createHash('sha256');
  hash.update(fingerprintFuturesEvidence({ root, studyDefinition: futuresStudyDefinition(config), report }));
  for (const [kind, bars] of [['chart', chart.bars], ['ltf', ltf.bars]] as const) {
    hash.update(`\n${kind}\n`);
    for (const bar of bars) if (Date.parse(bar.t) < end) hash.update(`${JSON.stringify(bar)}\n`);
  }
  return hash.digest('hex');
}

function lastBarAt(series: ContinuousSeries): string {
  return series.bars.reduce((latest, bar) => bar.t > latest ? bar.t : latest, '');
}

/** @description Reread and gate sources before computing or reusing owned historical evidence.
 * @param config - Normalized bounded study. @param reuse - Internal process-fenced ledger context.
 * @returns Markets with current source assessment and explicit computation receipts.
 */
export async function executeFuturesStudy(config: FuturesResearchConfig, reuse: FuturesStudyReuse = { generation: randomUUID() }): Promise<FuturesResearchMarket[]> {
  const markets: FuturesResearchMarket[] = [];
  for (const root of config.roots) {
    const { chart, ltf, ltfResampledFromMinute } = await buildSeries(config, root);
    if (!chart.bars.length || !ltf.bars.length) throw new FuturesSourceError(`${root}: chart or higher-timeframe series is empty`, { code: 'empty', root });
    const chartAsOf = lastBarAt(chart), ltfAsOf = lastBarAt(ltf);
    const freshness = assertFuturesSourceFreshness(config.quality, root, config.end, chartAsOf, ltfAsOf);
    const windows = walkForwardWindows(chart.bars, config.split);
    if (!windows.length) throw new Error(`${root}: archive has no complete out-of-sample window`);
    const base = baseConfig(root), stages = stagesFor(config);
    const inputFingerprint = futuresStudyInputFingerprint({ generation: reuse.generation, config, root, base, stages, windows, chart: chart.bars, ltf: ltf.bars, ltfResampledFromMinute });
    const prior = reusableFuturesReport(reuse, root, inputFingerprint, windows);
    const report = prior?.report ?? runStagedOptimizer({ chart: chart.bars, ltf: ltf.bars, daily: config.ltfTimeframe === '1Day' ? ltf.bars : [] }, base, { split: config.split, stages });
    const computation: FuturesStudyComputation = { status: prior ? 'reused' : 'computed', inputFingerprint, reportFingerprint: fingerprintFuturesEvidence(report), ...(prior ? { reusedFromRunId: prior.runId } : {}) };
    markets.push({ root, bars: chart.bars.length, ltfBars: ltf.bars.length, ltfResampledFromMinute,
      chartAsOf, ltfAsOf, computation, quality: assessFuturesSample(config.quality, freshness, report),
      latestCompleteOosEnd: report.windows.at(-1)!.window.oosEnd,
      evidenceFingerprint: evidenceFingerprint(config, root, chart, ltf, report),
      outOfSampleTrades: report.outOfSampleTrades, outOfSampleNet: report.outOfSampleNet, worstOutOfSampleMaxDD: report.worstOutOfSampleMaxDD, report });
  }
  return markets;
}
