/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Browser STT provider — returns directive for client to recognize locally via Web Speech API; zero server cost, zero credentials
 */

import type {
  STTProvider,
  STTTranscribeRequest,
  STTTranscribeResult,
  VoiceProviderStatus,
} from '../types';

/**
 * @description Provider that delegates recognition to the client's
 * `SpeechRecognition` API. Audio never leaves the browser.
 */
export class BrowserSTTProvider implements STTProvider {
  public readonly id = 'browser';
  public readonly displayName = 'Browser Web Speech API';
  public readonly kind = 'browser' as const;

  /**
   * @description Browser STT is always "configured" — it has no server deps.
   *
   * @returns Ready status.
   */
  async getStatus(): Promise<VoiceProviderStatus> {
    return { configured: true, providerId: this.id };
  }

  /**
   * @description Return a directive telling the client to recognize locally.
   * Server-side callers that actually need a transcript must choose a
   * non-browser provider (audio is not uploaded here).
   *
   * @param _request Unused audio payload (ignored in browser mode).
   * @returns Result with `useBrowserRecognition: true` and empty text.
   */
  async transcribe(_request: STTTranscribeRequest): Promise<STTTranscribeResult> {
    return {
      providerId: this.id,
      text: '',
      useBrowserRecognition: true,
    };
  }
}
