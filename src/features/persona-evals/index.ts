/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Feature barrel for persona-evals — the persona regression-eval (golden-task) gate. Suites live in ai-lab/persona-evals/<persona>.yaml; the runner executes the persona AS DEPLOYED through an injected LLMService lane and evaluates tiered (structural/semantic) assertions honestly.
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
  type StoredReportSummary,
  type StructuralEvalContext,
} from './services';
