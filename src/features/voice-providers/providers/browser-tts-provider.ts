/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Browser TTS provider — returns directive for client to synthesize locally via Web Speech API; zero server cost, zero credentials, the safe default
 */

import type {
  TTSProvider,
  TTSSynthesizeRequest,
  TTSSynthesizeResult,
  TTSVoice,
  VoiceProviderStatus,
} from '../types';

/**
 * @description Provider that delegates synthesis to the client's `speechSynthesis`
 * API. Server returns a directive, no audio bytes. The canonical "free" default.
 */
export class BrowserTTSProvider implements TTSProvider {
  public readonly id = 'browser';
  public readonly displayName = 'Browser Web Speech API';
  public readonly kind = 'browser' as const;

  /**
   * @description Browser TTS is always "configured" — it has no server deps.
   * Whether the browser actually supports speechSynthesis is a client check.
   *
   * @returns Ready status.
   */
  async getStatus(): Promise<VoiceProviderStatus> {
    return { configured: true, providerId: this.id };
  }

  /**
   * @description Return a directive telling the client to synthesize locally.
   *
   * @param request Synthesis request.
   * @returns Result with `useBrowserSynthesis: true`.
   */
  async synthesize(request: TTSSynthesizeRequest): Promise<TTSSynthesizeResult> {
    return {
      providerId: this.id,
      useBrowserSynthesis: true,
      text: request.text,
      voiceId: request.voiceId,
    };
  }

  /**
   * @description Voice enumeration happens in the browser; return an empty
   * list so the UI knows to fall back to `speechSynthesis.getVoices()`.
   *
   * @returns Empty array.
   */
  async listVoices(): Promise<TTSVoice[]> {
    return [];
  }
}
