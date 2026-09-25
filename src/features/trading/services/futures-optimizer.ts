/**
 * ADR-116 Phase 2 — staged locked-winner futures optimizer.
 *
 * A parameter sweep over the full archive is only a hypothesis. This module puts the trader's
 * six-stage protocol inside the Phase 1 walk-forward: each window ranks candidates on its
 * in-sample bars, locks that winner, advances to the next stage, and runs the final locked config
 * once on the unseen out-of-sample bars. No stage can reopen an earlier decision.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add the ADR-116 six-stage locked-winner optimizer, with per-window OOS evidence, minimum-trade sentinel preservation, deterministic ties, and injected runners for boundary tests.
 */

import type { FuturesBar } from './futures-contract';
import { runFuturesBacktest, type BacktestConfig, type BacktestResult } from './futures-backtester';
import { FITNESS_FUNCTIONS, type FitnessFunction } from './futures-fitness';
import {
  expandGrid,
  mergeBacktestConfig,
  walkForwardWindows,
  type BacktestRunner,
  type WalkForwardSeries,
  type WalkForwardSplit,
  type WalkForwardWindow,
} from './futures-walk-forward';

export type OptimizerStageName = 'Entry' | 'StopLoss' | 'Trail' | 'Targets' | 'EmergencyExit' | 'Sizing';

export interface OptimizerStage {
  name: OptimizerStageName;
  /** A registered NT8-compatible objective name, or an injected objective for a test harness. */
  fitness?: string | FitnessFunction;
  /** Dotted BacktestConfig paths. A stage with no axes is still a locked no-op stage. */
  grid: Record<string, unknown[]>;
}

export interface LockedStageEvidence {
  name: OptimizerStageName;
  fitness: string;
  candidateCount: number;
  baseConfig: BacktestConfig;
  winnerPatch: Record<string, unknown>;
  winnerConfig: BacktestConfig;
  inSampleScore: number;
  inSampleTrades: number;
  inSampleNet: number;
}

export interface StagedWindowEvidence {
  window: WalkForwardWindow;
  stages: LockedStageEvidence[];
  finalConfig: BacktestConfig;
  outOfSampleTrades: number;
  outOfSampleNet: number;
  outOfSampleMaxDD: number;
}

export interface StagedOptimizerReport {
  split: WalkForwardSplit;
  windows: StagedWindowEvidence[];
  outOfSampleTrades: number;
  outOfSampleNet: number;
  worstOutOfSampleMaxDD: number;
}

export interface StagedOptimizerOptions {
  split: WalkForwardSplit;
  stages: OptimizerStage[];
  runner?: BacktestRunner;
}

function sliceBars(bars: FuturesBar[], from: string, to: string): FuturesBar[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return bars.filter((bar) => {
    const time = Date.parse(bar.t);
    return time >= start && time < end;
  });
}

function finiteScore(score: number): number {
  // NaN is the empty-trade sentinel for one of the trader's objectives. It must never win a
  // stage; the -1e10 minimum-trade gate remains finite and therefore stays visible in evidence.
  return Number.isNaN(score) ? Number.NEGATIVE_INFINITY : score;
}

function defaultFitnessName(stage: OptimizerStageName): string {
  return {
    Entry: 'entry-logic',
    StopLoss: 'stop-loss-mae',
    Trail: 'trailing-stop',
    Targets: 'target-order',
    EmergencyExit: 'emergency-exit',
    Sizing: 'position-sizing',
  }[stage];
}

function fitnessFor(stage: OptimizerStage): { name: string; score: FitnessFunction } {
  if (typeof stage.fitness === 'function') return { name: 'injected', score: stage.fitness };
  const name = stage.fitness ?? defaultFitnessName(stage.name);
  const score = FITNESS_FUNCTIONS[name];
  if (!score) throw new RangeError(`futures optimizer: unknown fitness '${name}'`);
  return { name, score };
}

function stagePatches(grid: Record<string, unknown[]>): Record<string, unknown>[] {
  return Object.keys(grid).length ? expandGrid(grid) : [{}];
}

function scoreResult(result: BacktestResult, fitness: FitnessFunction): number {
  return fitness(result.trades.map((trade) => ({
    profit: trade.profit, mfe: trade.mfe, mae: trade.mae,
    mfePct: trade.mfePct, maePct: trade.maePct, exitName: trade.exitName,
  })), { maxDrawdown: result.maxDrawdown, netProfit: result.netProfit });
}

function chooseWinner(
  base: BacktestConfig,
  patches: Record<string, unknown>[],
  fitness: FitnessFunction,
  run: (config: BacktestConfig) => BacktestResult,
): { patch: Record<string, unknown>; config: BacktestConfig; result: BacktestResult; score: number } {
  let chosen: ReturnType<typeof chooseWinner> | null = null;
  for (const patch of patches) {
    const config = mergeBacktestConfig(base, patch);
    const result = run(config);
    const candidateScore = scoreResult(result, fitness);
    // Strict > makes ties deterministic: the first grid value wins, and JSON axis order is part
    // of the reproducible experiment artifact. A gated sentinel is intentionally preserved.
    if (!chosen || finiteScore(candidateScore) > finiteScore(chosen.score)) {
      chosen = { patch, config, result, score: candidateScore };
    }
  }
  if (!chosen) throw new Error('futures optimizer: stage produced no candidates');
  return chosen;
}

/** Run the six-stage locked-winner protocol over rolling windows. */
export function runStagedOptimizer(
  series: WalkForwardSeries,
  baseConfig: BacktestConfig,
  options: StagedOptimizerOptions,
): StagedOptimizerReport {
  const runner = options.runner ?? runFuturesBacktest;
  const windows = walkForwardWindows(series.chart, options.split);
  const evidence: StagedWindowEvidence[] = [];
  const daily = series.daily ?? [];
  for (const window of windows) {
    const isChart = sliceBars(series.chart, window.isStart, window.isEnd);
    const isLtf = sliceBars(series.ltf, window.isStart, window.isEnd);
    const isDaily = sliceBars(daily, window.isStart, window.isEnd);
    const oosChart = sliceBars(series.chart, window.oosStart, window.oosEnd);
    const oosLtf = sliceBars(series.ltf, window.oosStart, window.oosEnd);
    const oosDaily = sliceBars(daily, window.oosStart, window.oosEnd);
    let locked = baseConfig;
    const stages: LockedStageEvidence[] = [];
    for (const stage of options.stages) {
      const { name, score: fitness } = fitnessFor(stage);
      const patches = stagePatches(stage.grid);
      const winner = chooseWinner(locked, patches, fitness, (config) => runner(isChart, isLtf, config, isDaily));
      stages.push({
        name: stage.name, fitness: name, candidateCount: patches.length,
        baseConfig: locked, winnerPatch: winner.patch, winnerConfig: winner.config,
        inSampleScore: winner.score, inSampleTrades: winner.result.trades.length,
        inSampleNet: winner.result.netProfit,
      });
      locked = winner.config;
    }
    const out = runner(oosChart, oosLtf, locked, oosDaily);
    evidence.push({
      window, stages, finalConfig: locked, outOfSampleTrades: out.trades.length,
      outOfSampleNet: out.netProfit, outOfSampleMaxDD: out.maxDrawdown,
    });
  }
  return {
    split: options.split,
    windows: evidence,
    outOfSampleTrades: evidence.reduce((sum, row) => sum + row.outOfSampleTrades, 0),
    outOfSampleNet: evidence.reduce((sum, row) => sum + row.outOfSampleNet, 0),
    worstOutOfSampleMaxDD: evidence.reduce((worst, row) => Math.max(worst, row.outOfSampleMaxDD), 0),
  };
}

/** Compact reviewed defaults for the CLI. A report records the exact grid used. */
export const DEFAULT_OPTIMIZER_STAGES: readonly OptimizerStage[] = [
  { name: 'Entry', fitness: 'entry-logic', grid: { 'entry.ensembleEntryThresholdPct': [62, 70, 78] } },
  { name: 'StopLoss', fitness: 'stop-loss-mae', grid: { 'stops.initialStopAtrMultiple': [2, 3, 4] } },
  { name: 'Trail', fitness: 'trailing-stop', grid: { 'stops.stopBufferMode': ['ticks', 'atr-percent'] } },
  { name: 'Targets', fitness: 'target-order', grid: { 'targets.useTargets': [false, true] } },
  { name: 'EmergencyExit', fitness: 'emergency-exit', grid: { 'stops.useStrangleTrail': [false, true] } },
  { name: 'Sizing', fitness: 'position-sizing', grid: { 'entry.riskPerTradePercent': [1, 2] } },
];
