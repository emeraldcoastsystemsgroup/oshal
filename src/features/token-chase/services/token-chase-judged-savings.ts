/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 4b (ADR-046 §12): the judged cost-savings HEADLINE report — pure aggregation over corpus rows carrying the step-4 judge grades. Per provider/model lane: baseline vs variant $, $ and % saved, and quality-held counts (judgeScore >= configurable bar, default 80). HONESTY RULE enforced in the shape itself: llm-judged frames roll into verifiedSavedUsd, lexical-fallback frames into a SEPARATE lexicalProxySavedUsd — the two are never blended into one "verified" number.
 */

/**
 * @description One corpus observation flattened to what the judged savings report needs — the
 * cost pair, the lane identity, and the step-4 judge grade (score + which lane produced it).
 * Rows persisted before step 4 shipped carry null judge fields and are counted as `ungraded`.
 */
export interface JudgedSavingsRow {
  baselineCostUsd: number | null;
  variantCostUsd: number | null;
  /** The variant lane's provider id (null when the replay did not report one). */
  provider: string | null;
  /** The variant lane's model id. */
  model: string | null;
  /** The step-4 judge score 0..100, or null for pre-step-4 rows. */
  judgeScore: number | null;
  /** Which judge lane scored it — the honesty split key. Null for ungraded rows. */
  judgeMode: 'llm' | 'lexical-fallback' | null;
}

/**
 * @description One judge-mode bucket inside a lane: how many frames that mode graded, how many
 * held the quality bar, and the dollars saved by ONLY the held-and-cheaper frames (a pricier
 * variant is never banked, held or not).
 */
export interface JudgedModeBucket {
  /** Frames this judge mode graded. */
  frames: number;
  /** Frames whose judgeScore met the bar (>= threshold). */
  qualityHeld: number;
  /** Dollars saved summing max(0, baseline − variant) over held frames only. */
  heldSavedUsd: number;
  /** Baseline cost of the held frames — the denominator for heldSavedPct. */
  heldBaselineUsd: number;
  /** Held savings as a percent of the held frames' baseline cost (null when none). */
  heldSavedPct: number | null;
}

/**
 * @description The headline table row: one (provider/model) variant lane's totals plus the
 * per-judge-mode quality buckets. `savedUsd`/`savedPct` are raw cost deltas for context; the
 * bankable numbers live in the `llm` and `lexical` buckets, kept apart by design.
 */
export interface JudgedLaneReport {
  /** Human lane key: `${provider} / ${model}`. */
  lane: string;
  provider: string | null;
  model: string | null;
  /** All graded frames replayed on this lane. */
  frames: number;
  baselineCostUsd: number;
  variantCostUsd: number;
  /** baseline − variant across ALL the lane's frames (context, not a bankable claim). */
  savedUsd: number;
  /** savedUsd as a percent of baselineCostUsd (null when baseline is 0). */
  savedPct: number | null;
  /** Frames graded by the real LLM judge. */
  llm: JudgedModeBucket;
  /** Frames graded only by the lexical proxy — reported separately, never blended. */
  lexical: JudgedModeBucket;
  /** Frames with no step-4 grade at all (persisted before the assessor shipped). */
  ungraded: number;
}

/**
 * @description The step-4b report (ADR-046 §12): per-lane table + totals + the two clearly
 * separated headline numbers. `verifiedSavedUsd` counts ONLY llm-judged frames that held the
 * bar; `lexicalProxySavedUsd` is the proxy-scored sibling and carries an explicit caveat in its
 * name — the honesty rule is structural, not editorial.
 */
export interface JudgedSavingsReport {
  scope: 'run' | 'all';
  runId?: string;
  /** The quality bar applied (judgeScore >= threshold counts as held). */
  threshold: number;
  /** Total graded observations considered. */
  observations: number;
  /** Per provider/model lane rows, largest baseline spend first. */
  lanes: JudgedLaneReport[];
  totals: {
    baselineCostUsd: number;
    variantCostUsd: number;
    savedUsd: number;
    savedPct: number | null;
  };
  /** THE headline: $ saved on frames the LLM judge verified held the bar. */
  verifiedSavedUsd: number;
  /** How many llm-judged frames held the bar. */
  verifiedFrames: number;
  /** Proxy-only savings (lexical-fallback frames that held) — NOT part of verifiedSavedUsd. */
  lexicalProxySavedUsd: number;
  /** How many lexical-fallback frames held the bar. */
  lexicalProxyFrames: number;
  /** Frames with no judge grade — excluded from both headline numbers. */
  ungradedFrames: number;
  currency: 'USD';
}

/**
 * @description The default quality bar: a frame's swap is trusted when the judge scored it at
 * least this. Overridable per request (?bar=) and per deployment (TOKEN_CHASE_JUDGE_BAR).
 */
export const DEFAULT_JUDGE_QUALITY_BAR = 80;

/** Round to 6 dp (the corpus stores NUMERIC(12,6)) to avoid float dust in the payload. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Fresh all-zero mode bucket. */
function emptyBucket(): JudgedModeBucket {
  return { frames: 0, qualityHeld: 0, heldSavedUsd: 0, heldBaselineUsd: 0, heldSavedPct: null };
}

/** Fold one row into a mode bucket (held frames bank max(0, b − v); pricier swaps bank nothing). */
function foldBucket(bucket: JudgedModeBucket, row: JudgedSavingsRow, threshold: number): void {
  bucket.frames += 1;
  if ((row.judgeScore ?? -1) >= threshold) {
    bucket.qualityHeld += 1;
    const b = num(row.baselineCostUsd);
    bucket.heldSavedUsd += Math.max(0, b - num(row.variantCostUsd));
    bucket.heldBaselineUsd += b;
  }
}

/** Finalize a bucket: round the dollar sums and derive the held-savings percent. */
function sealBucket(bucket: JudgedModeBucket): JudgedModeBucket {
  return {
    ...bucket,
    heldSavedUsd: round6(bucket.heldSavedUsd),
    heldBaselineUsd: round6(bucket.heldBaselineUsd),
    heldSavedPct: bucket.heldBaselineUsd > 0 ? Math.round((bucket.heldSavedUsd / bucket.heldBaselineUsd) * 100) : null,
  };
}

/**
 * @description Roll judged corpus rows into the step-4b headline report. Pure and deterministic
 * so the savings math is unit-testable with mock rows and the endpoint stays a thin corpus read.
 * @param rows - Flattened judged observations (see {@link JudgedSavingsRow}).
 * @param threshold - The quality bar (judgeScore >= threshold counts as held).
 * @param scope - 'run' for one run, 'all' for the caller's whole corpus.
 * @param runId - The run id when scope === 'run'.
 * @returns The judged savings report with llm-verified and lexical-proxy numbers kept separate.
 */
export function aggregateJudgedSavings(
  rows: JudgedSavingsRow[],
  threshold: number,
  scope: 'run' | 'all',
  runId?: string,
): JudgedSavingsReport {
  const laneMap = new Map<string, JudgedLaneReport>();
  for (const row of rows) {
    const laneKey = `${row.provider ?? 'unknown'} / ${row.model ?? 'unknown'}`;
    let lane = laneMap.get(laneKey);
    if (!lane) {
      lane = {
        lane: laneKey, provider: row.provider, model: row.model, frames: 0,
        baselineCostUsd: 0, variantCostUsd: 0, savedUsd: 0, savedPct: null,
        llm: emptyBucket(), lexical: emptyBucket(), ungraded: 0,
      };
      laneMap.set(laneKey, lane);
    }
    lane.frames += 1;
    lane.baselineCostUsd += num(row.baselineCostUsd);
    lane.variantCostUsd += num(row.variantCostUsd);
    if (row.judgeMode === 'llm') foldBucket(lane.llm, row, threshold);
    else if (row.judgeMode === 'lexical-fallback') foldBucket(lane.lexical, row, threshold);
    else lane.ungraded += 1;
  }

  const lanes = [...laneMap.values()]
    .map((lane) => sealLane(lane))
    .sort((a, b) => b.baselineCostUsd - a.baselineCostUsd);
  return buildReport(lanes, rows.length, threshold, scope, runId);
}

/** Finalize one lane: round totals, derive savedPct, seal both mode buckets. */
function sealLane(lane: JudgedLaneReport): JudgedLaneReport {
  const baselineCostUsd = round6(lane.baselineCostUsd);
  const variantCostUsd = round6(lane.variantCostUsd);
  const savedUsd = round6(baselineCostUsd - variantCostUsd);
  return {
    ...lane,
    baselineCostUsd,
    variantCostUsd,
    savedUsd,
    savedPct: baselineCostUsd > 0 ? Math.round((savedUsd / baselineCostUsd) * 100) : null,
    llm: sealBucket(lane.llm),
    lexical: sealBucket(lane.lexical),
  };
}

/** Assemble the report totals + the two separated headline numbers from the sealed lanes. */
function buildReport(
  lanes: JudgedLaneReport[],
  observations: number,
  threshold: number,
  scope: 'run' | 'all',
  runId?: string,
): JudgedSavingsReport {
  let baselineCostUsd = 0;
  let variantCostUsd = 0;
  let verifiedSavedUsd = 0;
  let verifiedFrames = 0;
  let lexicalProxySavedUsd = 0;
  let lexicalProxyFrames = 0;
  let ungradedFrames = 0;
  for (const lane of lanes) {
    baselineCostUsd += lane.baselineCostUsd;
    variantCostUsd += lane.variantCostUsd;
    verifiedSavedUsd += lane.llm.heldSavedUsd;
    verifiedFrames += lane.llm.qualityHeld;
    lexicalProxySavedUsd += lane.lexical.heldSavedUsd;
    lexicalProxyFrames += lane.lexical.qualityHeld;
    ungradedFrames += lane.ungraded;
  }
  const savedUsd = round6(baselineCostUsd - variantCostUsd);
  return {
    scope,
    ...(runId ? { runId } : {}),
    threshold,
    observations,
    lanes,
    totals: {
      baselineCostUsd: round6(baselineCostUsd),
      variantCostUsd: round6(variantCostUsd),
      savedUsd,
      savedPct: baselineCostUsd > 0 ? Math.round((savedUsd / round6(baselineCostUsd)) * 100) : null,
    },
    verifiedSavedUsd: round6(verifiedSavedUsd),
    verifiedFrames,
    lexicalProxySavedUsd: round6(lexicalProxySavedUsd),
    lexicalProxyFrames,
    ungradedFrames,
    currency: 'USD',
  };
}
