/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase keep-winner decision service (ADR-046 step 4 loop, BACKLOG "auto keep-winner then re-baseline"): pure, deterministic winner selection over one frame's persisted graded observations. The quality bar is the LLM judge ONLY — lexical-fallback and ungraded rows are structurally ineligible (the honesty rule: a proxy score never promotes a lane), the judge score must meet the configurable min-quality bar, and the lane must be strictly cheaper by at least the configurable min-savings floor. Also home of the operator auto-mode gate: TOKEN_CHASE_AUTO_PROMOTE is default OFF because promotion is a visible, reversible action — never a silent side effect.
 */

import type { DebuggerObservation } from './token-chase-corpus-service';
import { DEFAULT_JUDGE_QUALITY_BAR } from './token-chase-judged-savings';

/**
 * @description The default minimum realized savings (baseline − variant, USD) a candidate must
 * clear to be promotable. Zero means "any strictly positive savings" — the strictly-cheaper
 * requirement itself never relaxes; this floor only raises it.
 */
export const DEFAULT_PROMOTE_MIN_SAVINGS_USD = 0;

/** @description The thresholds the keep-winner bar applies (see {@link readKeepWinnerThresholds}). */
export interface KeepWinnerThresholds {
  /** Minimum LLM-judge score (0..100) a candidate must hold. */
  minQuality: number;
  /** Minimum baseline−variant savings in USD (candidate must also be strictly cheaper). */
  minSavingsUsd: number;
}

/**
 * @description Resolves the promotion thresholds from the environment.
 * `TOKEN_CHASE_PROMOTE_MIN_QUALITY` (0..100) defaults to the judged-report bar
 * (`TOKEN_CHASE_JUDGE_BAR`, else 80) so "promotable" and "quality-held in the report" agree by
 * default. `TOKEN_CHASE_PROMOTE_MIN_SAVINGS_USD` (>= 0) defaults to
 * {@link DEFAULT_PROMOTE_MIN_SAVINGS_USD}. Invalid values fall back — there is no "0 quality"
 * arm by accident (an explicit 0 is accepted; garbage is not).
 * @param env - Environment bag (injectable for tests); defaults to process.env.
 * @returns The resolved thresholds, always finite and in range.
 */
export function readKeepWinnerThresholds(env: NodeJS.ProcessEnv = process.env): KeepWinnerThresholds {
  const qualityRaw = Number.parseFloat(String(env.TOKEN_CHASE_PROMOTE_MIN_QUALITY ?? ''));
  const judgeBar = Number.parseFloat(String(env.TOKEN_CHASE_JUDGE_BAR ?? ''));
  const minQuality = Number.isFinite(qualityRaw) && qualityRaw >= 0 && qualityRaw <= 100
    ? qualityRaw
    : (Number.isFinite(judgeBar) && judgeBar >= 0 && judgeBar <= 100 ? judgeBar : DEFAULT_JUDGE_QUALITY_BAR);
  const savingsRaw = Number.parseFloat(String(env.TOKEN_CHASE_PROMOTE_MIN_SAVINGS_USD ?? ''));
  const minSavingsUsd = Number.isFinite(savingsRaw) && savingsRaw >= 0 ? savingsRaw : DEFAULT_PROMOTE_MIN_SAVINGS_USD;
  return { minQuality, minSavingsUsd };
}

/**
 * @description The operator gate for auto keep-winner. Promotion is a visible, reversible action,
 * so auto-apply is OFF unless the operator explicitly sets `TOKEN_CHASE_AUTO_PROMOTE=true` (or
 * `1`). Anything else — unset, empty, "false", "yes", typos — is OFF.
 * @param env - Environment bag (injectable for tests); defaults to process.env.
 * @returns True only on the explicit opt-in values.
 */
export function isAutoPromoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.TOKEN_CHASE_AUTO_PROMOTE ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/** @description Why a candidate observation was excluded from winning (audit-friendly). */
export type WinnerRejection =
  | 'ungraded'
  | 'lexical-fallback-judged'
  | 'below-quality-bar'
  | 'missing-cost-pair'
  | 'missing-variant-model'
  | 'below-min-savings';

/** @description One excluded candidate with the reason it failed the bar. */
export interface RejectedCandidate {
  variantProvider: string | null;
  variantModel: string | null;
  judgeScore: number | null;
  judgeMode: 'llm' | 'lexical-fallback' | null;
  savedUsd: number | null;
  reason: WinnerRejection;
}

/** @description The winning candidate: the observation plus its realized savings. */
export interface FrameWinner {
  observation: DebuggerObservation;
  /** baseline − variant for the winning row, USD (always > 0 and >= minSavingsUsd). */
  savedUsd: number;
}

/** @description The full selection outcome — winner (or null) plus every rejection, for the audit trail. */
export interface WinnerSelection {
  winner: FrameWinner | null;
  rejected: RejectedCandidate[];
  thresholds: KeepWinnerThresholds;
}

/** Classifies one candidate against the bar; returns the rejection reason or null when eligible. */
function rejectionOf(o: DebuggerObservation, t: KeepWinnerThresholds): WinnerRejection | null {
  if (o.judgeMode == null || o.judgeScore == null) return 'ungraded';
  if (o.judgeMode !== 'llm') return 'lexical-fallback-judged';
  if (o.judgeScore < t.minQuality) return 'below-quality-bar';
  if (o.baselineCostUsd == null || o.variantCostUsd == null) return 'missing-cost-pair';
  if (!o.variantModel) return 'missing-variant-model';
  const saved = o.baselineCostUsd - o.variantCostUsd;
  if (!(saved > 0) || saved < t.minSavingsUsd) return 'below-min-savings';
  return null;
}

/** The savings a candidate realizes (only meaningful for eligible rows). */
function savedOf(o: DebuggerObservation): number | null {
  if (o.baselineCostUsd == null || o.variantCostUsd == null) return null;
  return o.baselineCostUsd - o.variantCostUsd;
}

/**
 * @description Token Chase keep-winner selection (ADR-046 step 4, "automate keep-winner"): given
 * ONE frame's persisted graded observations, pick the variant lane that may be promoted to the
 * frame's new baseline. The bar, in order:
 *
 *  1. LLM-judged ONLY — `judgeMode === 'llm'`. Lexical-fallback and ungraded rows are never
 *     promotable no matter how cheap (a proxy score is not a judgement — the honesty rule).
 *  2. `judgeScore >= minQuality` (the configurable quality bar).
 *  3. A real cost pair, and STRICTLY cheaper by at least `minSavingsUsd`.
 *
 * Among eligible candidates the winner is the largest savings; ties break to the higher judge
 * score, then lexicographic variant model for determinism. Pure and synchronous so the decision
 * is unit-testable row-for-row.
 * @param observations - The frame's persisted observations (one per graded replay).
 * @param thresholds - The bar; see {@link readKeepWinnerThresholds}.
 * @returns Winner (or null) + per-candidate rejections + the thresholds applied.
 */
export function selectWinner(
  observations: DebuggerObservation[],
  thresholds: KeepWinnerThresholds = readKeepWinnerThresholds(),
): WinnerSelection {
  const rejected: RejectedCandidate[] = [];
  const eligible: FrameWinner[] = [];
  for (const o of observations) {
    const reason = rejectionOf(o, thresholds);
    if (reason) {
      rejected.push({
        variantProvider: o.variantProvider,
        variantModel: o.variantModel,
        judgeScore: o.judgeScore,
        judgeMode: o.judgeMode,
        savedUsd: savedOf(o),
        reason,
      });
      continue;
    }
    eligible.push({ observation: o, savedUsd: savedOf(o) as number });
  }
  eligible.sort((a, b) =>
    b.savedUsd - a.savedUsd
    || (b.observation.judgeScore ?? 0) - (a.observation.judgeScore ?? 0)
    || String(a.observation.variantModel).localeCompare(String(b.observation.variantModel)));
  return { winner: eligible[0] ?? null, rejected, thresholds };
}
