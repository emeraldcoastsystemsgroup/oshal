/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: person-model services barrel.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phases 2-4: export the intent front door, trend/profile reads, projection ledger and semantic leg.
 */

export { ensurePersonModelSchema, personModelSchemaStatements } from './person-model-schema';
export { recallQuery, resolvePersonProfiles, ownerHasAmbientData } from './recall-query';
export { detectRecallIntent, buildRecallReceiptsBlock, buildRecallSpokenAnswer } from './recall-guard';
export type { RecallIntent, RecallRange, RecallReceipt, RecallResult } from './person-model-types';
export {
  buildEnrichmentPrompt, parseEnrichmentJson, TAXONOMY_VERSION, TONE_VALUES, INTENT_VALUES,
  type EnrichmentInput, type EnrichmentResult, type Tone, type Intent,
} from './enrichment-prompt';
export { enrichBatch, type EnrichBrainInvoker, type EnrichBatchItem, type EnrichOutcome } from './enrichment-service';
export {
  eligibleProfileIds, recordConsent, purgeDerivedForProfile, listPersonConsentStatus,
  type ConsentInput, type PersonConsentStatus,
} from './consent-gate';
export { purgeExpiredPersonModelData } from './person-model-maintenance';
export { getOpenAsks, updateAskStatus, type PersonAsk } from './asks-query';
export {
  detectPersonModelIntent, detectOpenAsksIntent, detectTrendIntent, detectConnectionIntent, answerPersonModelIntent,
  buildOpenAsksSpokenAnswer, buildTrendSpokenAnswer, buildConnectionSpokenAnswer,
} from './person-model-intent';
export { weeklyTopicTrends, topicsConnecting, listHeardPeople, personProfileSummary, clampWeeks } from './trends-query';
export {
  AMBIENT_RECALL_COLLECTION, ragChunksTableExists, listUnprojectedSegments, purgeOrphanChunks, purgeChunksForProfile,
  rebuildRollups, reconcileProjectionLedger, readProjectionLedger, ownersWithUnprojectedSegments,
  type UnprojectedSegment, type ProjectionLedgerRow,
} from './projection-ledger';
export { semanticLegAvailable, projectOwnerSegments, relatedRecall, rebuildOwnerProjection } from './semantic-projection';
export type {
  PersonModelIntent, OpenAsksIntent, TrendIntent, ConnectionIntent, RelatedReceipt, TopicTrendRow, TopicTrendResult,
  PersonConnection, HeardPerson, PersonTopic, PersonPresenceDay, PersonProfileSummary,
} from './person-model-types';
