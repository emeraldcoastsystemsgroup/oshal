/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the Haven user-model feature (ADR-079)
 */

export { UserModelService } from './services/user-model-service';
export {
  buildHavenPreamble, withHavenContext, learnFromExchange, userModelFor,
} from './services/haven-context-service';
export {
  FACET_ORDER, isStorableFact, mergeFactUpdate, decayFact, renderHotCore, parseTeach,
  parseExtraction, computeSuggestions, buildExtractionPrompt,
  type UserModelFacet, type UserModelFact, type FactCandidate, type SuggestionCandidate,
} from './services/user-model-logic';
