/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase feature barrel (ADR-046)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export step-2 replay service + determinism verdict (ADR-046)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export step-5 savings: summarizeCorpusSavings (corpus read) + savings aggregation types (ADR-046)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export step-4 assessor (assessVariantQuality + injected QualityGrader contract + TOKEN_CHASE_RUBRIC) and step-4b judged savings (summarizeJudgedSavings + aggregateJudgedSavings + report types) (ADR-046)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Export the per-run spend gate (TokenChaseBudgetGate + readTokenChaseBudgetUsd + the injected GovernanceCheck contract) — the TOKEN_CHASE_BUDGET_USD ceiling the optimizer consults before each round (BACKLOG "per-run judge budget cap")
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Export the step-2b debugger corpus read (listRunObservations + DebuggerObservation) — the read-only recorded replay/variant/grade history the debugger view renders (ADR-046 §10)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Export the keep-winner → re-baseline loop (BACKLOG "auto keep-winner then re-baseline"): selectWinner + thresholds + the TOKEN_CHASE_AUTO_PROMOTE gate (token-chase-keep-winner), the promotion store + audit + revert (token-chase-promotion-service), the per-run JUDGE spend cap TokenChaseJudgeBudget (TOKEN_CHASE_JUDGE_BUDGET_USD — distinct from the replay-spend TokenChaseBudgetGate), and the optimizer's promoted-lane BaselineOverride
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Export the forward TAIL-replay consumer (ADR-046 §1/§8): TokenChaseTailReplayService.replayForward restages frame N's workspace tree from its content-addressed snapshot, replays N..end on the accountable bot, determinism-gates each frame, and STOPS at the first divergence; pinned reads served, unpinned warned; pre-tail frames single-replay unchanged
 */

export {
  TokenChaseReadService,
  type TokenChaseAccess,
  type TokenChaseRunSummary,
  type TokenChaseFrameSummary,
  type TokenChaseFrameDetail,
} from './services/token-chase-read-service';

export {
  TokenChaseReplayService,
  type ReplayResult,
  type ReplayStatus,
} from './services/token-chase-replay-service';

export {
  TokenChaseTailReplayService,
  type TailReplayResult,
  type TailReplayStatus,
  type TailFrameOutcome,
  type TailFrameStatus,
  type RestageResult,
  type TailReplayOptions,
  type TailFrameSource,
  type TailReplayer,
  type TailReplayCallResponse,
} from './services/token-chase-tail-replay-service';

export {
  TokenChaseOptimizeService,
  buildTokenChaseDemoComparison,
  type BaselineOverride,
  type VariantLane,
  type VariantReplayResult,
  type LaneMetrics,
  type OptimizerObservationMeta,
} from './services/token-chase-optimize-service';

export {
  selectWinner,
  readKeepWinnerThresholds,
  isAutoPromoteEnabled,
  DEFAULT_PROMOTE_MIN_SAVINGS_USD,
  type FrameWinner,
  type KeepWinnerThresholds,
  type RejectedCandidate,
  type WinnerRejection,
  type WinnerSelection,
} from './services/token-chase-keep-winner';

export {
  promoteFrameWinner,
  revertPromotion,
  listPromotions,
  listActivePromotions,
  listPromotionAudit,
  type PromotionAuditEntry,
  type PromotionInput,
  type PromotionRecord,
  type PromotionSource,
  type PromotionStatus,
} from './services/token-chase-promotion-service';

export {
  TokenChaseJudgeBudget,
  readTokenChaseJudgeBudgetUsd,
  DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD,
  type JudgeBudgetCheck,
  type JudgeBudgetStatus,
  type JudgeSpendProbe,
} from './services/token-chase-judge-budget';

export {
  listRunObservations,
  recordOptimizerObservation,
  summarizeCorpusSavings,
  summarizeJudgedSavings,
  type DebuggerObservation,
} from './services/token-chase-corpus-service';

export {
  assessVariantQuality,
  frameIdOf,
  TOKEN_CHASE_RUBRIC,
  type AssessorGradeInput,
  type AssessorVerdict,
  type JudgeAssessment,
  type QualityGrader,
} from './services/token-chase-assessor';

export {
  aggregateJudgedSavings,
  DEFAULT_JUDGE_QUALITY_BAR,
  type JudgedLaneReport,
  type JudgedModeBucket,
  type JudgedSavingsReport,
  type JudgedSavingsRow,
} from './services/token-chase-judged-savings';

export {
  aggregateSavingsRows,
  resultsToSavingsRows,
  type SavingsRow,
  type SavingsSummary,
} from './services/token-chase-savings';

export {
  assessDeterminism,
  EQUIVALENT_SIMILARITY_THRESHOLD,
  type DeterminismVerdict,
  type DeterminismStatus,
} from './services/determinism-verdict';

export {
  TokenChaseBudgetGate,
  readTokenChaseBudgetUsd,
  DEFAULT_TOKEN_CHASE_BUDGET_USD,
  type GovernanceCheck,
  type GovernanceDecision,
  type TokenChaseBudgetStatus,
} from './services/token-chase-budget-gate';
