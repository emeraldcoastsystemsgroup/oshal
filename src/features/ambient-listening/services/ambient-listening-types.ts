/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added typed contracts for opt-in ambient settings, text-only transcript segments, daily reviews, and confirmation-required action proposals.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added per-user daily review enable/time and follow-up suggestion preferences plus due-review delivery contracts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added privacy-off-by-default speaker diarization, remembered-profile, selected private-org, and trusted attributed-segment contracts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added durable audio receipt state contracts for safe retries and lost-response acknowledgement.
 */

/** @description The persisted, owner-scoped ambient-listening preferences. */
export interface AmbientSettings {
  assistantName: string;
  wakePhrases: string[];
  ambientEnabled: boolean;
  transcriptRetentionDays: number;
  timeZone: string;
  dailyReviewEnabled: boolean;
  dailyReviewTime: string;
  suggestFollowUps: boolean;
  speakerDiarizationEnabled: boolean;
  rememberSpeakers: boolean;
  speakerTenantId: string | null;
  updatedAt: Date;
}

/** @description The settings fields a signed-in owner may change. */
export interface AmbientSettingsPatch {
  assistantName?: string;
  wakePhrases?: string[];
  ambientEnabled?: boolean;
  transcriptRetentionDays?: number;
  timeZone?: string;
  dailyReviewEnabled?: boolean;
  dailyReviewTime?: string;
  suggestFollowUps?: boolean;
  speakerDiarizationEnabled?: boolean;
  rememberSpeakers?: boolean;
  speakerTenantId?: string | null;
}

/** @description A validated text segment ready for durable persistence. */
export interface AmbientSegmentInput {
  text: string;
  capturedAt: Date;
  endedAt: Date | null;
  speakerLabel: string | null;
  wakePhraseDetected: boolean;
  matchedWakePhrase: string | null;
  sessionId: string | null;
  clientSegmentId: string | null;
  speakerProfileId: string | null;
}

/** @description Server-trusted speaker attribution ready for the durable transcript store. */
export interface AmbientAttributedSegmentInput extends AmbientSegmentInput {
  speakerProfileId: string | null;
}

/** @description One owner-scoped transcript segment returned from storage. */
export interface AmbientTranscriptSegment extends AmbientSegmentInput {
  segmentId: string;
  createdAt: Date;
}

/** @description A proposed action extracted from a transcript; it is never an executed action. */
export interface AmbientActionSuggestion {
  suggestionId: string;
  kind: 'reminder' | 'task' | 'follow-up';
  title: string;
  prompt: string;
  evidence: string;
  sourceSegmentIds: string[];
  proposedTarget: 'calendar' | 'tasks';
  requiresConfirmation: true;
  status: 'proposed';
}

/** @description An extractive daily summary plus confirmation-required suggestions. */
export interface AmbientDailyReview {
  localDate: string;
  timeZone: string;
  summary: string;
  sourceSegmentCount: number;
  suggestions: AmbientActionSuggestion[];
  createdAt: Date;
  updatedAt: Date;
}

/** @description One local day's transcript and its latest optional review. */
export interface AmbientDayTranscript {
  localDate: string;
  timeZone: string;
  segments: AmbientTranscriptSegment[];
  review: AmbientDailyReview | null;
}

/** @description Result of an idempotent transcript batch append. */
export interface AmbientAppendResult {
  accepted: number;
  duplicates: number;
  segments: AmbientTranscriptSegment[];
}

/** @description Durable processing state for one owner-scoped audio idempotency key. */
export type AmbientAudioChunkClaim =
  | { state: 'claimed'; claimToken: string }
  | { state: 'in_progress' }
  | { state: 'completed' };

/** @description Counts returned after explicit deletion of all owner ambient data and voice profiles. */
export interface AmbientClearResult {
  deletedSegments: number;
  deletedSpeakerProfiles: number;
}

/** @description One automatically due review and the owner whose proposal inbox receives it. */
export interface AmbientDueReview {
  userSub: string;
  review: AmbientDailyReview;
}

/**
 * @description A safe client-input error that route handlers may return as HTTP 400.
 */
export class AmbientInputError extends Error {
  constructor(message: string, readonly code = 'invalid_ambient_input') {
    super(message);
    this.name = 'AmbientInputError';
  }
}

/**
 * @description Signals that text capture was attempted before the owner opted in.
 */
export class AmbientModeDisabledError extends Error {
  constructor() {
    super('Ambient listening is off. Enable it in settings before saving transcript segments.');
    this.name = 'AmbientModeDisabledError';
  }
}
