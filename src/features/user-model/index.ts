/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the Haven user-model feature (ADR-079)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the three closed ADR-079 deferrals: connector-signal facts, deterministic model compaction, and the opt-in push-proactivity gate/policy.
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
export {
  CONNECTOR_FACT_KEY_PREFIX, CONNECTOR_EXPIRY_WARNING_DAYS,
  readConnectorSignalRows, connectorCapabilityLabels, connectorSignalCandidates,
  connectorSignalFactKeys, connectorAttentionMessages, daysUntilExpiry,
  type ConnectorSignalRow, type ConnectorPgLike,
} from './services/connector-signal-facts';
export {
  DEFAULT_MAX_ACTIVE_FACTS, isCompactionProtected, factRetentionScore, planModelCompaction,
  type CompactionPlan,
} from './services/model-compaction';
export {
  HAVEN_PUSH_TOPIC, HAVEN_PUSH_DAILY_CAP, PUSHABLE_SUGGESTION_KINDS,
  evaluatePushGate, selectPushableSuggestions, formatHavenPush,
  type HavenPushGate, type PushGateReason, type PushPreferenceLike,
  type PendingSuggestion, type HavenPushMessage,
} from './services/haven-proactivity';
