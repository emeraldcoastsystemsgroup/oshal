/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Services barrel for the persona-evals slice (FSD): assertion engine, suite loader, runner, semantic judge, results store.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the RubricJudgeLane seam so the app layer can bind semantic grading to the shared quality-judge bot without a deep import.
 */

export {
  evaluateStructuralAssertion,
  extractFirstJson,
  validateAssertion,
  type StructuralEvalContext,
} from './assertion-engine';

export {
  PersonaEvalSuiteError,
  listPersonaEvalSuites,
  loadPersonaEvalSuite,
  resolveSuiteDir,
  validateSuite,
} from './suite-loader';

export {
  gradeRubric,
  isSemanticCapable,
  parseJudgeScore,
  type RubricGrade,
  type RubricJudgeLane,
} from './semantic-judge';

export {
  PersonaEvalRunner,
  buildPersonaSystemPrompt,
  buildTaskPrompt,
  rollupTaskStatus,
  summarize,
  type PersonaEvalRunnerDeps,
} from './persona-eval-runner';

export {
  PersonaEvalResultsStore,
  type StoredReportSummary,
} from './results-store';
