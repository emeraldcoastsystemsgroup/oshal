/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Quality-judge feature barrel — the ONE public surface for the shared LLM-judge/grading service (JudgeService + verdict types + the pure lexical/parsing helpers for consumers like token-chase and persona evals). No deep imports: always @/features/quality-judge.
 */

export {
  JudgeService,
  QUALITY_JUDGE_AGENT_ID,
  type JudgeBrainInvoker,
  type JudgeServiceOptions,
} from './services/judge-service';

export {
  buildJudgePrompt,
  clampScore,
  extractJudgeJson,
  jaccardSimilarity,
  lexicalFallbackGrade,
  mapRubricDimensions,
  validateLlmVerdict,
  type JudgeGradeInput,
  type JudgeMode,
  type JudgeVerdict,
} from './services/judge-verdict';
