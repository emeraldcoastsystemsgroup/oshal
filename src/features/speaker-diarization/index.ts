/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added public barrel for deterministic speaker diarization, encrypted profiles, sidecar orchestration, and contracts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported the audio-in-progress retry signal.
 */

export {
  cosineSpeakerSimilarity,
  normalizeSpeakerEmbedding,
  SPEAKER_AMBIGUITY_MARGIN,
  SPEAKER_CENTROID_UPDATE_THRESHOLD,
  SPEAKER_MATCH_THRESHOLD,
  shouldUpdateSpeakerCentroid,
  selectBestSpeakerMatch,
  updateSpeakerCentroid,
  type SpeakerBestMatch,
  type SpeakerMatchCandidate,
} from './speaker-matcher';
export {
  currentSpeakerEmbeddingKeyId,
  decryptSpeakerEmbedding,
  decryptSpeakerEmbeddingForRotation,
  encryptSpeakerEmbedding,
  speakerEmbeddingNeedsRewrap,
  type SpeakerEmbeddingDecryption,
} from './speaker-embedding-crypto';
export {
  SpeakerInputError,
  SpeakerAudioInProgressError,
  SpeakerAuthorizationError,
  SpeakerNoSpeechError,
  SpeakerSidecarError,
} from './speaker-errors';
export {
  SpeakerProfileStore,
  speakerProfilesFor,
  isPrivateOrgMemberPair,
  moveSpeakerAssignment,
} from './speaker-profile-store';
export { SpeakerSidecarClient } from './speaker-sidecar-client';
export { SpeakerDiarizationOrchestrator } from './speaker-diarization-orchestrator';
export type {
  SpeakerAssignment,
  SpeakerAssignmentInput,
  SpeakerAssignmentKind,
  SpeakerAttributedTurn,
  SpeakerAudioProcessing,
  SpeakerAudioPurpose,
  SpeakerAudioResult,
  SpeakerContext,
  SpeakerCurrentUser,
  SpeakerDiarizationOrchestratorContract,
  SpeakerMatchResult,
  SpeakerOrganization,
  SpeakerObservationKey,
  SpeakerProfile,
  SpeakerProfileExcerpt,
  SpeakerProfileStoreContract,
  SpeakerSidecarContract,
  SpeakerSidecarResult,
  SpeakerSidecarSpeaker,
  SpeakerSidecarTurn,
  SpeakerTenantMember,
  SpeakerTimelineTurn,
  SpeakerTranscriptionContract,
  SpeakerTranscriptionResult,
  SpeakerTranscriptionSegment,
} from './types';
export { SPEAKER_AUDIO_MAX_SECONDS } from './types';
