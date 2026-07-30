/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Feature barrel for persona-evals — the persona regression-eval (golden-task) gate. Suites live in ai-lab/persona-evals/<persona>.yaml; the runner executes the persona AS DEPLOYED through an injected LLMService lane and evaluates tiered (structural/semantic) assertions honestly.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export RubricJudgeLane — the seam the app layer binds to the shared quality-judge bot so semantic grading is bot work with captured cost, not a controller-side LLM call.
 */

export type {
  AssertionResult,
  AssertionStatus,
  AssertionTier,
  EvalAssertion,
  EvalLaneInfo,
  EvalSummary,
  EvalTask,
  PersonaEvalReport,
  PersonaEvalSuite,
  SemanticAssertionType,
  StructuralAssertionType,
  TaskResult,
  TaskStatus,
} from './types';

export {
  PersonaEvalResultsStore,
  PersonaEvalRunner,
  PersonaEvalSuiteError,
  buildPersonaSystemPrompt,
  buildTaskPrompt,
  evaluateStructuralAssertion,
  extractFirstJson,
  gradeRubric,
  isSemanticCapable,
  listPersonaEvalSuites,
  loadPersonaEvalSuite,
  parseJudgeScore,
  resolveSuiteDir,
  rollupTaskStatus,
  summarize,
  validateAssertion,
  validateSuite,
  type PersonaEvalRunnerDeps,
  type RubricGrade,
  type RubricJudgeLane,
  type StoredReportSummary,
  type StructuralEvalContext,
} from './services';
