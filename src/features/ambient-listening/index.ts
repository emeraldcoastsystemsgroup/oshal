/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the ambient-listening feature barrel.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported trusted speaker-attributed transcript input for the app-layer audio route.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported the durable audio receipt claim contract.
 */

export { AmbientListeningService, ambientListeningFor, type AmbientListeningServiceContract } from './services/ambient-listening-service';
export {
  DEFAULT_AMBIENT_SETTINGS,
  normalizeAmbientSettings,
  normalizeAmbientSegmentBatch,
  normalizeLocalDate,
  ambientLocalClock,
  dueAmbientReviewDate,
  buildAmbientDailyReview,
  extractAmbientSuggestions,
} from './services/ambient-listening-logic';
export {
  AmbientInputError,
  AmbientModeDisabledError,
  type AmbientSettings,
  type AmbientSettingsPatch,
  type AmbientSegmentInput,
  type AmbientAttributedSegmentInput,
  type AmbientTranscriptSegment,
  type AmbientActionSuggestion,
  type AmbientDailyReview,
  type AmbientDayTranscript,
  type AmbientAppendResult,
  type AmbientAudioChunkClaim,
  type AmbientClearResult,
  type AmbientDueReview,
} from './services/ambient-listening-types';
