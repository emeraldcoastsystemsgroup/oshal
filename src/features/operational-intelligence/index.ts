/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added operational-intelligence feature barrel (WS-7)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced the eval-results store API (slice-root module, not covered by the ./services star-export) through the barrel
 */

export * from './services';
export {
  queryEvalRuns,
  computeGreenWall,
  computeEvalTrend,
  recordEvalRun,
  type EvalRun,
} from './eval-results-store';
