/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial TTS/STT provider contract — pluggable voice harness parallel to LLM provider registry, browser + server-side providers behind a single interface
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added optional abort signal for bounded memory-only STT calls.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Allow applications to request bounded performance direction without changing every provider consumer's default delivery.
 */

/**
 * @description Kind of audio delivery the provider performs.
 * - `browser`: no server work; tells the client to synthesize/recognize locally via Web Speech API.
 * - `server`: the provider returns synthesized audio bytes or transcribed text from a remote service.
 */
export type VoiceProviderKind = 'browser' | 'server';

/**
 * @description Status a provider reports when asked whether it can fulfill a request.
 */
export interface VoiceProviderStatus {
  configured: boolean;
  providerId: string;
  reason?: string;
}

/**
 * @description Request payload for a TTS synthesis call.
 */
export interface TTSSynthesizeRequest {
  text: string;
  voiceId?: string;
  languageCode?: string;
  speakingRate?: number;
  pitch?: number;
  performanceInstructions?: string;
}

/**
 * @description Result returned from a TTS synthesis call.
 * Server providers populate `audio` + `audioFormat`; browser providers set
 * `useBrowserSynthesis` so the client renders locally via speechSynthesis.
 */
export interface TTSSynthesizeResult {
  providerId: string;
  audio?: Buffer;
  audioFormat?: string;
  useBrowserSynthesis?: boolean;
  voiceId?: string;
  text?: string;
}

/**
 * @description Descriptor for a TTS voice listed by a provider.
 */
export interface TTSVoice {
  id: string;
  displayName: string;
  languageCode: string;
  gender?: 'MALE' | 'FEMALE' | 'NEUTRAL' | 'UNSPECIFIED';
  naturalSampleRateHertz?: number;
}

/**
 * @description Pluggable TTS provider. Implementations live under
 * `src/features/voice-providers/providers/`.
 */
export interface TTSProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: VoiceProviderKind;
  getStatus(): Promise<VoiceProviderStatus>;
  synthesize(request: TTSSynthesizeRequest): Promise<TTSSynthesizeResult>;
  listVoices(): Promise<TTSVoice[]>;
}

/**
 * @description Request payload for an STT transcription call.
 */
export interface STTTranscribeRequest {
  audio: Buffer;
  mimeType: string;
  languageCode?: string;
  enableSegments?: boolean;
  signal?: AbortSignal;
}

/**
 * @description Individual timestamped segment returned by STT providers that
 * support verbose output (e.g. lecture transcription).
 */
export interface STTSegment {
  text: string;
  startTime: number;
  endTime: number;
}

/**
 * @description Result returned from an STT transcription call.
 * Server providers populate `text` (+ optional segments). Browser providers
 * return `useBrowserRecognition: true` so the client uses Web Speech API.
 */
export interface STTTranscribeResult {
  providerId: string;
  text: string;
  confidence?: number;
  segments?: STTSegment[];
  useBrowserRecognition?: boolean;
  languageCode?: string;
}

/**
 * @description Pluggable STT provider. Implementations live under
 * `src/features/voice-providers/providers/`.
 */
export interface STTProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: VoiceProviderKind;
  getStatus(): Promise<VoiceProviderStatus>;
  transcribe(request: STTTranscribeRequest): Promise<STTTranscribeResult>;
}

/**
 * @description Shape of the voice config block inside
 * `config-seed/global-config.json` (swarm-level defaults).
 */
export interface SwarmVoiceConfig {
  tts: {
    default: string;
    serverSide?: string;
    providers: Record<string, Record<string, unknown>>;
  };
  stt: {
    default: string;
    providers: Record<string, Record<string, unknown>>;
  };
}

/**
 * @description Shape of the voice block inside a swarm app manifest
 * (e.g. `swarm-apps/little-monsters.yaml`). Each channel can pick a specific
 * provider or defer to the swarm default via the sentinel `swarm-default`.
 */
export interface SwarmAppVoiceConfig {
  tts?: { provider: string };
  stt?: { provider: string };
}

/**
 * @description Sentinel value in a swarm app manifest that means
 * "defer to the swarm-level default for this channel".
 */
export const SWARM_DEFAULT_SENTINEL = 'swarm-default';
