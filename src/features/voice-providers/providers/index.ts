/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Providers barrel — exposes provider classes + shared Google auth helpers
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported the API-key-only OpenAI natural TTS provider and configuration contract.
 */

export { BrowserTTSProvider } from './browser-tts-provider';
export { BrowserSTTProvider } from './browser-stt-provider';
export { GoogleCloudTTSProvider } from './google-cloud-tts-provider';
export type { GoogleCloudTTSConfig } from './google-cloud-tts-provider';
export {
  GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES,
  GoogleCloudSTTProvider,
} from './google-cloud-stt-provider';
export type { GoogleCloudSTTAuth, GoogleCloudSTTConfig } from './google-cloud-stt-provider';
export { GeminiTTSProvider } from './gemini-tts-provider';
export type { GeminiTTSConfig } from './gemini-tts-provider';
export { OpenAITTSProvider } from './openai-tts-provider';
export type { OpenAITTSConfig } from './openai-tts-provider';
export { GeminiSTTProvider } from './gemini-stt-provider';
export { LocalSTTProvider } from './local-stt-provider';
export type { LocalSTTConfig } from './local-stt-provider';
export type { GeminiSTTConfig } from './gemini-stt-provider';
export {
  getGoogleAccessToken,
  probeGoogleAuth,
  probeGoogleOAuth,
  resolveOAuthProfilePath,
  getGoogleApiKey,
  getGoogleVoiceAuth,
  applyGoogleVoiceAuth,
  GoogleAuthNotConfiguredError,
} from './google-cloud-auth';
export type {
  GoogleAccessToken,
  GoogleAuthMode,
  GoogleVoiceAuth,
} from './google-cloud-auth';
