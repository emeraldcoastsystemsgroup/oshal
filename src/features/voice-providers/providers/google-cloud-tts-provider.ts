/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Google Cloud Text-to-Speech provider — Chirp 3 HD voices via REST; auth reuses the google-bot OAuth profile so no second credential store
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched to getGoogleVoiceAuth + applyGoogleVoiceAuth — supports GOOGLE_API_KEY (query-string) and OAuth Bearer in one call path; unblocks TTS tickets without OAuth consent
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reverted to OAuth-only — texttospeech.googleapis.com returns UNAUTHENTICATED for API keys per Google policy. Gemini TTS is the new default for API-key users; this provider stays available for operators who complete google-bot OAuth consent
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Recognize mounted Google application-default service accounts as paid Cloud TTS credentials.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Omit unsupported pitch controls for Chirp 3 HD voices so paid Cloud narration synthesizes successfully.
 */

import { createChildLogger } from '@/shared/logger';
import type {
  TTSProvider,
  TTSSynthesizeRequest,
  TTSSynthesizeResult,
  TTSVoice,
  VoiceProviderStatus,
} from '../types';
import {
  GoogleAuthNotConfiguredError,
  getGoogleAccessToken,
  probeGoogleCloudAuth,
} from './google-cloud-auth';

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const VOICES_ENDPOINT = 'https://texttospeech.googleapis.com/v1/voices';

const logger = createChildLogger({ module: 'google-cloud-tts-provider' });

/**
 * @description Per-instance configuration passed in at registry construction.
 */
export interface GoogleCloudTTSConfig {
  defaultVoice: string;
  defaultLanguageCode: string;
  audioEncoding: 'MP3' | 'LINEAR16' | 'OGG_OPUS';
}

/**
 * @description Server-side TTS provider that calls Google Cloud Text-to-Speech.
 * Returns real audio bytes for server-rendered content (e.g. pre-generated
 * Little Monsters lesson audio). Chirp 3 HD voices are the intended default.
 */
export class GoogleCloudTTSProvider implements TTSProvider {
  public readonly id = 'google-cloud-tts';
  public readonly displayName = 'Google Cloud TTS (Chirp 3 HD)';
  public readonly kind = 'server' as const;

  constructor(private readonly config: GoogleCloudTTSConfig) {}

  /**
   * @description Lightweight readiness probe — does a usable Google OAuth
   * profile exist on disk. Does NOT make a network call.
   *
   * @returns Structured status with remediation hint when not configured.
   */
  async getStatus(): Promise<VoiceProviderStatus> {
    const probe = probeGoogleCloudAuth();
    return {
      configured: probe.ready,
      providerId: this.id,
      reason: probe.ready ? undefined : probe.reason,
    };
  }

  /**
   * @description Synthesize `request.text` into audio bytes using Cloud TTS.
   * Throws `GoogleAuthNotConfiguredError` if OAuth consent has not been
   * completed — callers should translate that into a 503 with a hint.
   *
   * @param request Synthesis request.
   * @returns Audio bytes + format.
   */
  async synthesize(request: TTSSynthesizeRequest): Promise<TTSSynthesizeResult> {
    const token = await getGoogleAccessToken();
    const voiceName = request.voiceId || this.config.defaultVoice;
    const body = {
      input: { text: request.text },
      voice: {
        languageCode: request.languageCode || this.config.defaultLanguageCode,
        name: voiceName,
      },
      audioConfig: {
        audioEncoding: this.config.audioEncoding,
        ...(request.speakingRate !== undefined ? { speakingRate: request.speakingRate } : {}),
        ...(request.pitch !== undefined && supportsPitch(voiceName)
          ? { pitch: request.pitch }
          : {}),
      },
    };
    logger.info(
      { chars: request.text.length, voice: body.voice.name },
      'Cloud TTS synthesize call',
    );
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, errBody }, 'Cloud TTS call failed');
      throw new Error(`Google Cloud TTS returned ${response.status}: ${errBody}`);
    }
    const json = (await response.json()) as { audioContent: string };
    return {
      providerId: this.id,
      audio: Buffer.from(json.audioContent, 'base64'),
      audioFormat: mapAudioFormat(this.config.audioEncoding),
      voiceId: body.voice.name,
    };
  }

  /**
   * @description Fetch the list of available voices, filtered to the default
   * language code. Returns an empty list when unconfigured rather than
   * throwing — the UI can gracefully show "log in first" in that case.
   *
   * @returns Catalog of Cloud TTS voices for this language.
   */
  async listVoices(): Promise<TTSVoice[]> {
    try {
      const token = await getGoogleAccessToken();
      const url = `${VOICES_ENDPOINT}?languageCode=${encodeURIComponent(
        this.config.defaultLanguageCode,
      )}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      });
      if (!response.ok) {
        const errBody = await response.text();
        logger.error({ status: response.status, errBody }, 'Cloud TTS listVoices failed');
        return [];
      }
      const json = (await response.json()) as { voices?: RawCloudVoice[] };
      return (json.voices || []).map(toTTSVoice);
    } catch (error) {
      if (error instanceof GoogleAuthNotConfiguredError) {
        logger.warn({ reason: error.reason }, 'Cloud TTS voices listed while unconfigured');
        return [];
      }
      throw error;
    }
  }
}

/**
 * @description Chirp 3 HD currently rejects the Cloud TTS pitch parameter.
 */
function supportsPitch(voiceName: string): boolean {
  return !voiceName.toLowerCase().includes('chirp3-hd');
}

/**
 * @description Raw voice shape returned by the Cloud TTS /voices endpoint.
 */
interface RawCloudVoice {
  name: string;
  languageCodes: string[];
  ssmlGender?: 'MALE' | 'FEMALE' | 'NEUTRAL' | 'SSML_VOICE_GENDER_UNSPECIFIED';
  naturalSampleRateHertz?: number;
}

/**
 * @description Normalize a raw Cloud voice into the framework's TTSVoice
 * shape, keeping only fields the UI cares about.
 */
function toTTSVoice(raw: RawCloudVoice): TTSVoice {
  const gender =
    raw.ssmlGender && raw.ssmlGender !== 'SSML_VOICE_GENDER_UNSPECIFIED'
      ? raw.ssmlGender
      : 'UNSPECIFIED';
  return {
    id: raw.name,
    displayName: raw.name,
    languageCode: raw.languageCodes[0] || 'en-US',
    gender,
    naturalSampleRateHertz: raw.naturalSampleRateHertz,
  };
}

/**
 * @description Map a Cloud TTS encoding label to a browser-safe MIME type.
 */
function mapAudioFormat(encoding: GoogleCloudTTSConfig['audioEncoding']): string {
  switch (encoding) {
    case 'MP3':
      return 'audio/mpeg';
    case 'LINEAR16':
      return 'audio/wav';
    case 'OGG_OPUS':
      return 'audio/ogg';
    default:
      return 'audio/mpeg';
  }
}
