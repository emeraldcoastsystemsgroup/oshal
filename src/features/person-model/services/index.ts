/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: person-model services barrel.
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
