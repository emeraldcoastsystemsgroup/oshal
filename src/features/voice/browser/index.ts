/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added browser-only voice barrel to avoid deep imports from chat UI into services internals
 */

/**
 * @description Browser speech-to-text service for standalone chat voice input.
 */
export { STTService } from '../services/stt-service';

/**
 * @description Browser text-to-speech service for standalone chat voice playback.
 */
export { TTSService } from '../services/tts-service';
