/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added operational-intelligence feature barrel (WS-7)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced the eval-results store API (slice-root module, not covered by the ./services star-export) through the barrel
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export scoped feature-token evidence contracts and pure reducer without adding database or HTTP read authority.
 */

export * from './services';
export {
  aggregateFeatureTokenEvidence,
  type FeatureTokenEvidence, type StoredFeatureTokenEvidence, type FeatureTokenEvidenceRow,
  type FeatureTokenEvidenceScope, type FeatureTokenProfile, type FeatureTokenReport,
} from './services/feature-token-evidence';
export {
  queryEvalRuns,
  computeGreenWall,
  computeEvalTrend,
  recordEvalRun,
  type EvalRun,
} from './eval-results-store';
