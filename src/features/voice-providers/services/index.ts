/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Services barrel — exposes registries + config loader
 */

export {
  TTSProviderRegistry,
  getTTSProviderRegistry,
  resetTTSProviderRegistryForTesting,
} from './tts-provider-registry';
export {
  STTProviderRegistry,
  getSTTProviderRegistry,
  resetSTTProviderRegistryForTesting,
} from './stt-provider-registry';
export {
  loadSwarmVoiceConfig,
  resolveGlobalConfigPath,
  DEFAULT_VOICE_CONFIG,
} from './voice-config-loader';
