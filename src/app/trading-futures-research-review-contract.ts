/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound Futures review context and validate evidence-linked research proposals without trading authority.
 */
import { z } from 'zod';
import { normalizeFuturesResearchConfig, type FuturesResearchRun } from './trading-futures-research-dispatch';

const text = z.string().trim().min(1).max(4000);
const reviewSchema = z.object({
  summary: text,
  limitations: z.array(text).min(1).max(12),
  evidence: z.array(z.object({ root: z.string(), fingerprint: z.string() }).strict()).min(1).max(8),
  nextStudy: z.object({
    rationale: text,
    stageGrids: z.record(z.string(), z.record(z.string(), z.array(z.unknown()))),
  }).strict().nullable(),
}).strict();

/** @description A research hypothesis, never a prediction grade or an order. */
export type FuturesResearchReviewResult = z.infer<typeof reviewSchema>;

/** @description Owner-scoped persisted review state; attempt IDs fence late replies. */
export interface FuturesResearchReview {
  status: 'reviewing' | 'completed' | 'failed';
  attemptId: string;
  requestedAt: string;
  completedAt?: string;
  result?: FuturesResearchReviewResult;
  error?: string;
}

/**
 * @description Send finite study facts, never filesystem paths, credentials or source error text.
 * @param run - Caller-owned completed study.
 * @returns Bounded reason-only request with a strict output contract.
 */
export function futuresReviewPrompt(run: FuturesResearchRun): string {
  const { roots, timeframe, ltfTimeframe, source, adjust, minVolume, start, end, split, stageGrids } = run.config;
  const markets = run.markets.map((m) => ({
    root: m.root, evidenceFingerprint: m.evidenceFingerprint,
    chartAsOf: m.chartAsOf, ltfAsOf: m.ltfAsOf, latestCompleteOosEnd: m.latestCompleteOosEnd,
    outOfSampleTrades: m.outOfSampleTrades, outOfSampleNet: m.outOfSampleNet,
    worstOutOfSampleMaxDD: m.worstOutOfSampleMaxDD,
    totalWindows: m.report.windows.length,
    recentWindows: m.report.windows.slice(-8).map((w) => ({
      window: w.window, outOfSampleTrades: w.outOfSampleTrades, outOfSampleNet: w.outOfSampleNet,
      outOfSampleMaxDD: w.outOfSampleMaxDD,
      stages: w.stages.map(({ name, candidateCount, winnerPatch, inSampleTrades, inSampleNet }) =>
        ({ name, candidateCount, winnerPatch, inSampleTrades, inSampleNet })),
    })),
  }));
  return [
    'Review the supplied Futures study as research only. No tools, fetching, orders or strategy promotion.',
    'Negative or empty evidence is not success. These are historical backtests, NOT forward predictions or live performance.',
    'Repeated use of OOS results to choose a grid is exploratory tuning; it needs a new untouched holdout before promotion.',
    'Context contains at most the last eight windows per market; totalWindows states the full count. Do not invent missing facts.',
    'Return ONLY JSON: {"summary":"...","limitations":["..."],"evidence":[{"root":"...","fingerprint":"exact supplied fingerprint"}],"nextStudy":null OR {"rationale":"...","stageGrids":{...}}}. Cite every root exactly once.',
    'nextStudy may change stageGrids only. Include only axes to replace; omitted stages retain the current study grid.',
    'Allowed axes: Entry.entry.ensembleEntryThresholdPct integer 1..100; StopLoss.stops.initialStopAtrMultiple number >0..10; Trail.stops.stopBufferMode ticks|atr-percent; Targets.targets.useTargets boolean; EmergencyExit.stops.useStrangleTrail boolean; Sizing.entry.riskPerTradePercent number >0..5.',
    'At most 8 values per axis, 64 candidates per stage, 512 estimated backtests total. No forecast, direction, target price or order fields.',
    JSON.stringify({ study: { roots, timeframe, ltfTimeframe, source, adjust, minVolume, start, end, split, stageGrids }, markets }),
  ].join('\n');
}

/**
 * @description Refuse invented evidence, unknown authority fields and out-of-budget proposals.
 * @param response - Untrusted bot output.
 * @param run - Immutable completed study supplying the evidence and study envelope.
 * @returns Validated review whose proposed grids are safe to load into the console, not auto-apply.
 */
export function parseFuturesReview(response: string, run: FuturesResearchRun): FuturesResearchReviewResult {
  if (Buffer.byteLength(response, 'utf8') > 64_000) throw new RangeError('Futures review exceeds 64 KB');
  const result = reviewSchema.parse(JSON.parse(response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  const expected = run.markets.map((m) => `${m.root}:${m.evidenceFingerprint}`).sort();
  const actual = result.evidence.map((e) => `${e.root}:${e.fingerprint}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Futures review evidence does not match this run');
  if (result.nextStudy) {
    if (!Object.keys(result.nextStudy.stageGrids).length) throw new Error('Futures next study must propose a grid change');
    const normalized = normalizeFuturesResearchConfig({
      ...run.config, endMode: 'fixed', stageGrids: { ...run.config.stageGrids, ...result.nextStudy.stageGrids },
    });
    if (JSON.stringify(normalized.stageGrids) === JSON.stringify(run.config.stageGrids)) throw new Error('Futures next study has no grid change');
    result.nextStudy.stageGrids = normalized.stageGrids as Record<string, Record<string, unknown[]>>;
  }
  return result;
}
