/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Services barrel — exposes registries + config loader
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stopped re-exporting resetTTSProviderRegistryForTesting / resetSTTProviderRegistryForTesting. They are named "ForTesting" but no test (and no store package — searched oshal-applications and oshal-app-private) has ever imported either, so they were pure surface area on a KERNEL SKILL barrel (voice-providers is pinned in src/app/composition/kernel-skills.ts, i.e. everything exported here is a contract installed packages may bind to). The underlying functions stay in tts-provider-registry.ts / stt-provider-registry.ts for any future in-slice spec to deep-import.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export VoicePrefsStore (JVV-012 per-user TTS provider/voice selection).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: export the text-to-speech and speech-to-text capability adapters (createTtsCapabilityAdapter, createSttCapabilityAdapter) the shared resolver walks. Additive: nothing installed packages bind to changes.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b: export measureAudioSeconds, the container-level clip duration speech-to-text spend is priced on.
 */

export {
  TTSProviderRegistry,
  getTTSProviderRegistry,
} from './tts-provider-registry';
export {
  STTProviderRegistry,
  getSTTProviderRegistry,
} from './stt-provider-registry';
export {
  loadSwarmVoiceConfig,
  resolveGlobalConfigPath,
  DEFAULT_VOICE_CONFIG,
} from './voice-config-loader';
export {
  VoicePrefsStore,
  type VoiceUserPrefs,
} from './voice-prefs-store';
export { measureAudioSeconds } from './audio-duration';
export {
  createSttCapabilityAdapter,
  createTtsCapabilityAdapter,
  resolveVoiceListTtlMs,
  type SttRegistryGetter,
  type TtsRegistryGetter,
} from './voice-capability-adapters';
