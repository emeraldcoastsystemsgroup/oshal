/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added safe typed errors for speaker input, authorization, and sidecar availability failures.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added retry-safe signaling for an already processing audio idempotency key.
 */

/** @description Safe client-input error surfaced as HTTP 400. */
export class SpeakerInputError extends Error {
  constructor(message: string, readonly code = 'invalid_speaker_input') {
    super(message);
    this.name = 'SpeakerInputError';
  }
}

/** @description Authorization failure for public-mode persistence or private-org member linking. */
export class SpeakerAuthorizationError extends Error {
  constructor(message: string, readonly code = 'speaker_forbidden') {
    super(message);
    this.name = 'SpeakerAuthorizationError';
  }
}

/** @description Deterministic sidecar failure that may permit an explicit transcript fallback. */
export class SpeakerSidecarError extends Error {
  constructor(message: string, readonly code = 'speaker_sidecar_unavailable') {
    super(message);
    this.name = 'SpeakerSidecarError';
  }
}

/** @description Sidecar signal that a valid audio chunk contained no attributable speech. */
export class SpeakerNoSpeechError extends SpeakerSidecarError {
  constructor(message = 'No speaker turns were detected') {
    super(message, 'no_speech_detected');
    this.name = 'SpeakerNoSpeechError';
  }
}

/** @description Signals that another request still owns the same audio idempotency key. */
export class SpeakerAudioInProgressError extends Error {
  readonly code = 'speaker_audio_in_progress';

  constructor() {
    super('This audio chunk is already processing. Retry after the current request finishes.');
    this.name = 'SpeakerAudioInProgressError';
  }
}
