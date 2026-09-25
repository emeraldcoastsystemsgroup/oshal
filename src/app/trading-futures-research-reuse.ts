/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Match exact completed-window inputs before optimization; retain auditable, process-fenced report reuse.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep source notification opt-in outside historical evidence fingerprints.
 */
import { createHash } from 'node:crypto';
import type { BacktestConfig, FuturesBar, OptimizerStage, StagedOptimizerReport, WalkForwardWindow } from '../features/trading';
import type { FuturesResearchConfig } from './trading-futures-research-dispatch';
import type { FuturesResearchMarket } from './trading-futures-research-study';
import { fingerprintFuturesEvidence } from './trading-futures-prediction-evidence';

/** @description Durable computation evidence; reuse never changes the sample or promotion verdict. */
export interface FuturesStudyComputation {
  status: 'computed' | 'reused';
  inputFingerprint: string;
  reportFingerprint: string;
  reusedFromRunId?: string;
}

/** @description Internal worker context, selected from the owned ledger, never from console input. */
export interface FuturesStudyReuse {
  generation: string;
  previous?: { runId: string; markets: FuturesResearchMarket[] };
}

/** @description Exclude operational controls that do not change a historical experiment.
 * @param config - Normalized run settings. @returns The reproducible study definition.
 */
export function futuresStudyDefinition(config: FuturesResearchConfig): object {
  const { end: _end, endMode: _endMode, nightlyCron: _cron, nightlyReview: _review, predictions: _predictions, sourceAlerts: _alerts, ...definition } = config;
  return definition;
}

/** @description Hash resolved settings and ordered completed-horizon bars without retaining another archive copy.
 * @param input - The actual optimizer inputs plus the parent API generation. @returns An exact-input reuse key.
 */
export function futuresStudyInputFingerprint(input: {
  generation: string; config: FuturesResearchConfig; root: string; base: BacktestConfig;
  stages: OptimizerStage[]; windows: WalkForwardWindow[]; chart: FuturesBar[]; ltf: FuturesBar[];
  ltfResampledFromMinute: boolean;
}): string {
  const { generation, config, root, base, stages, windows, chart, ltf, ltfResampledFromMinute } = input;
  const hash = createHash('sha256').update(fingerprintFuturesEvidence({
    format: 1, generation, root, definition: futuresStudyDefinition(config), base, windows, ltfResampledFromMinute,
    // Axis and candidate ordering breaks score ties, so canonical object-key sorting must not erase it.
    stages: stages.map(stage => ({ ...stage, grid: Object.entries(stage.grid) })),
  }));
  const end = Date.parse(windows.at(-1)!.oosEnd);
  for (const [kind, bars] of [['chart', chart], ['ltf', ltf]] as const) {
    hash.update(`\n${kind}\n`);
    for (const bar of bars) if (Date.parse(bar.t) < end) hash.update(`${JSON.stringify([bar.t, bar.o, bar.h, bar.l, bar.c, bar.v])}\n`);
  }
  return hash.digest('hex');
}

/** @description Refuse legacy, changed or damaged receipts; a cache miss must run the optimizer normally.
 * @param reuse - Internally selected same-owner/schedule evidence. @param root - Current market.
 * @param inputFingerprint - Freshly derived exact-input key. @param windows - Actual completed windows.
 * @returns A verified prior report and source run, or no match.
 */
export function reusableFuturesReport(reuse: FuturesStudyReuse, root: string, inputFingerprint: string, windows: WalkForwardWindow[]): { report: StagedOptimizerReport; runId: string } | undefined {
  const previous = reuse.previous;
  const market = Array.isArray(previous?.markets) ? previous.markets.find(item => item?.root === root) : undefined;
  const receipt = market?.computation;
  if (!previous?.runId || !receipt || !['computed', 'reused'].includes(receipt.status) || receipt.inputFingerprint !== inputFingerprint) return;
  const report = market?.report;
  if (!Array.isArray(report?.windows) || !report.windows.length) return;
  if (receipt.reportFingerprint !== fingerprintFuturesEvidence(report)) return;
  if (fingerprintFuturesEvidence(report.windows.map(row => row?.window)) !== fingerprintFuturesEvidence(windows)) return;
  return { report, runId: previous.runId };
}
