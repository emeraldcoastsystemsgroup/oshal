/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added typed contracts for deterministic speaker profiles, owner-private assignments, private-org context, sidecar diarization, and memory-only audio results.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added per-chunk speaker observation keys for retry-idempotent centroid mutation.
 */

/** @description Labels a remembered voice without treating the label as authentication. */
export type SpeakerAssignmentKind = 'self' | 'custom' | 'tenant_member' | 'unassigned';

/** @description Supported reasons for sending a bounded audio chunk to the diarizer. */
export type SpeakerAudioPurpose = 'ambient' | 'recording_import' | 'self_enrollment';

/** @description Release-safe duration ceilings shared by route preflight and decoded sidecar validation. */
export const SPEAKER_AUDIO_MAX_SECONDS: Record<SpeakerAudioPurpose, number> = {
  ambient: 20,
  recording_import: 55,
  self_enrollment: 10,
};

/** @description User-controlled assignment attached to an owner-private voice profile. */
export interface SpeakerAssignment {
  kind: SpeakerAssignmentKind;
  customName: string | null;
  tenantId: string | null;
  memberSub: string | null;
}

/** @description Short retained transcript context used by the owner to recognize a voice. */
export interface SpeakerProfileExcerpt {
  text: string;
  capturedAt: Date;
}

/** @description Safe profile metadata returned to the owning user; embeddings are never exposed. */
export interface SpeakerProfile {
  profileId: string;
  ordinal: number;
  label: string;
  assignment: SpeakerAssignment;
  embeddingModel: string;
  sampleCount: number;
  segmentCount: number;
  excerpts: SpeakerProfileExcerpt[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  updatedAt: Date;
}

/** @description Result of matching one speaker embedding to the owner's remembered profiles. */
export interface SpeakerMatchResult {
  profile: SpeakerProfile;
  similarity: number;
  created: boolean;
}

/** @description Owner-scoped idempotency identity for one sidecar speaker observation. */
export interface SpeakerObservationKey {
  clientChunkId: string;
  speakerKey: string;
}

/** @description Minimal tenant member metadata suitable for the private-org picker. */
export interface SpeakerTenantMember {
  userSub: string;
  displayName: string;
  identityAvailable: boolean;
  role: string;
}

/** @description One private organization the caller may use for a speaker assignment. */
export interface SpeakerOrganization {
  tenantId: string;
  name: string;
  role: string;
}

/** @description Caller identity metadata used to exclude self from org-member assignment choices. */
export interface SpeakerCurrentUser {
  userSub: string;
  displayName: string;
  profileId: string | null;
}

/** @description Server-derived capability and member list for the selected private organization. */
export interface SpeakerContext {
  available: boolean;
  voiceProfilesAvailable: boolean;
  guest: boolean;
  tenantMemberAssignmentAvailable: boolean;
  reason: 'private_org_available' | 'no_private_org' | 'public_tenant';
  selectedTenantId: string | null;
  organizations: SpeakerOrganization[];
  members: SpeakerTenantMember[];
  currentUser: SpeakerCurrentUser;
  unavailableMemberCount: number;
}

/** @description Untrusted timeline turn after strict sidecar shape and range validation. */
export interface SpeakerSidecarTurn {
  turnIndex: number;
  speakerKey: string;
  startTime: number;
  endTime: number;
  overlap: boolean;
}

/** @description One sidecar speaker key and its deterministic embedding centroid. */
export interface SpeakerSidecarSpeaker {
  speakerKey: string;
  embedding: number[] | null;
  voicedSeconds: number;
}

/** @description Validated deterministic timeline produced by the diarization-only sidecar. */
export interface SpeakerSidecarResult {
  modelId: string;
  sampleRate: number;
  durationSeconds: number;
  turns: SpeakerSidecarTurn[];
  speakers: SpeakerSidecarSpeaker[];
}

/** @description Speaker-attributed transcript turn returned by the controller orchestrator. */
export interface SpeakerAttributedTurn {
  text: string;
  startTime: number;
  endTime: number;
  profileId: string | null;
  ordinal: number | null;
  label: string;
  similarity: number | null;
  attribution: 'matched' | 'created' | 'session' | 'unavailable';
  overlap: boolean;
}

/** @description Diarization timeline returned even when transcription is unavailable. */
export interface SpeakerTimelineTurn {
  turnIndex: number;
  speakerKey: string;
  startTime: number;
  endTime: number;
  overlap: boolean;
  profileId: string | null;
  ordinal: number | null;
  label: string;
  attribution: 'matched' | 'created' | 'session';
}

/** @description Timestamped STT segment eligible for overlap-based speaker attribution. */
export interface SpeakerTranscriptionSegment {
  text: string;
  startTime: number;
  endTime: number;
}

/** @description Existing voice-provider output normalized behind an injectable boundary. */
export interface SpeakerTranscriptionResult {
  providerId: string;
  text?: string;
  segments?: SpeakerTranscriptionSegment[];
  fallback?: 'browser' | 'unconfigured' | 'failed';
  message?: string;
}

/** @description Processing provenance surfaced so degraded fallback is never mistaken for diarization. */
export interface SpeakerAudioProcessing {
  status: 'complete' | 'degraded';
  transcription: 'provider' | 'client_fallback' | 'unavailable';
  diarization: 'complete' | 'unavailable';
}

/** @description Complete in-memory audio result before transcript persistence. */
export interface SpeakerAudioResult {
  source: 'sidecar_and_stt' | 'sidecar_only' | 'client_transcript_fallback';
  processing: SpeakerAudioProcessing;
  model: string | null;
  sttProviderId: string | null;
  durationSeconds: number | null;
  timeline: SpeakerTimelineTurn[];
  turns: SpeakerAttributedTurn[];
}

/** @description Assignment write accepted by the owner-private profile store. */
export interface SpeakerAssignmentInput {
  kind: SpeakerAssignmentKind;
  customName?: string | null;
  tenantId?: string | null;
  memberSub?: string | null;
}

/** @description Store boundary used by routes and the diarization orchestrator. */
export interface SpeakerProfileStoreContract {
  listProfiles(ownerSub: string): Promise<SpeakerProfile[]>;
  identify(
    ownerSub: string,
    embedding: number[],
    model: string,
    observation?: SpeakerObservationKey,
  ): Promise<SpeakerMatchResult>;
  assignProfile(ownerSub: string, profileId: string, input: SpeakerAssignmentInput): Promise<SpeakerProfile | null>;
  mergeProfiles(ownerSub: string, targetProfileId: string, sourceProfileId: string): Promise<SpeakerProfile | null>;
  deleteProfile(ownerSub: string, profileId: string): Promise<boolean>;
  speakerContext(
    ownerSub: string,
    selectedTenantId?: string | null,
    callerDisplayName?: string | null,
  ): Promise<SpeakerContext>;
}

/** @description Sidecar boundary kept injectable for deterministic tests and deployments. */
export interface SpeakerSidecarContract {
  diarize(audio: Buffer, mimeType: string): Promise<SpeakerSidecarResult>;
}

/** @description Injected existing STT provider boundary, separate from deterministic diarization. */
export interface SpeakerTranscriptionContract {
  transcribe(audio: Buffer, mimeType: string): Promise<SpeakerTranscriptionResult>;
}

/** @description Orchestrator boundary used by the authenticated audio route. */
export interface SpeakerDiarizationOrchestratorContract {
  process(
    ownerSub: string,
    audio: Buffer,
    mimeType: string,
    rememberSpeakers: boolean,
    purpose?: SpeakerAudioPurpose,
    clientChunkId?: string,
  ): Promise<SpeakerAudioResult>;
}
