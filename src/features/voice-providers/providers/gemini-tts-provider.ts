/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Gemini TTS provider — uses generativelanguage.googleapis.com with the GOOGLE_API_KEY; wraps raw PCM in WAV header so browsers can play the result without client-side decoding; becomes the new swarm default because it authenticates with an API key (unlike Cloud TTS which needs OAuth)
 */

import { createChildLogger } from '@/shared/logger';
import type {
  TTSProvider,
  TTSSynthesizeRequest,
  TTSSynthesizeResult,
  TTSVoice,
  VoiceProviderStatus,
} from '../types';
import { GoogleAuthNotConfiguredError, getGoogleApiKey } from './google-cloud-auth';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const logger = createChildLogger({ module: 'gemini-tts-provider' });

/**
 * @description Catalog of Gemini prebuilt voices. These are the names accepted
 * by `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. Listed in the
 * Gemini API docs — keeping a static list here because the API does not
 * expose a /voices enumeration endpoint for these names.
 */
const GEMINI_PREBUILT_VOICES = [
  'Kore',
  'Puck',
  'Charon',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;

/**
 * @description Per-instance configuration.
 */
export interface GeminiTTSConfig {
  model: string;
  defaultVoice: string;
  sampleRateHz: number;
}

/**
 * @description Server-side TTS provider using the Gemini API. Authenticates
 * via GOOGLE_API_KEY / GEMINI_API_KEY — no OAuth needed, which is why it is
 * the default TTS in the swarm config.
 */
export class GeminiTTSProvider implements TTSProvider {
  public readonly id = 'gemini-tts';
  public readonly displayName = 'Gemini TTS (Google AI Studio)';
  public readonly kind = 'server' as const;

  constructor(private readonly config: GeminiTTSConfig) {}

  /**
   * @description Ready when an API key is present in the environment.
   *
   * @returns Structured status.
   */
  async getStatus(): Promise<VoiceProviderStatus> {
    const key = getGoogleApiKey();
    return {
      providerId: this.id,
      configured: Boolean(key),
      reason: key
        ? undefined
        : 'GOOGLE_API_KEY / GEMINI_API_KEY env var is empty — get a key at aistudio.google.com',
    };
  }

  /**
   * @description Call Gemini TTS and return WAV-wrapped PCM audio.
   *
   * @param request Synthesis request.
   * @returns Audio bytes + audio/wav MIME type.
   */
  async synthesize(request: TTSSynthesizeRequest): Promise<TTSSynthesizeResult> {
    const key = getGoogleApiKey();
    if (!key) {
      // Use the structured not-configured signal so VoiceService maps it to
      // `fallback: 'unconfigured'` instead of the generic 'failed' state —
      // that gives the voice-settings UI a setup hint instead of "Empty response".
      throw new GoogleAuthNotConfiguredError(
        'GOOGLE_API_KEY / GEMINI_API_KEY is not set — get a key at aistudio.google.com',
      );
    }
    const voiceName = request.voiceId || this.config.defaultVoice;
    const url = `${GEMINI_BASE}/models/${this.config.model}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ parts: [{ text: request.text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    };
    logger.info({ chars: request.text.length, voice: voiceName, model: this.config.model }, 'Gemini TTS call');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, errBody }, 'Gemini TTS call failed');
      throw translateGeminiError(response.status, errBody);
    }
    const json = (await response.json()) as GeminiTTSResponse;
    const audioPart = extractAudioPart(json);
    const pcm = Buffer.from(audioPart.data, 'base64');
    return {
      providerId: this.id,
      audio: wrapPcmInWav(pcm, this.config.sampleRateHz),
      audioFormat: 'audio/wav',
      voiceId: voiceName,
    };
  }

  /**
   * @description Return the static list of Gemini prebuilt voices. The API
   * doesn't expose enumeration for these, so the list is maintained in code.
   *
   * @returns Catalog of voices.
   */
  async listVoices(): Promise<TTSVoice[]> {
    return GEMINI_PREBUILT_VOICES.map((name) => ({
      id: name,
      displayName: name,
      languageCode: 'en-US',
      gender: 'UNSPECIFIED',
    }));
  }
}

/**
 * @description Raw response shape for Gemini `generateContent` when the
 * response modality is AUDIO.
 */
interface GeminiTTSResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data: string };
      }>;
    };
  }>;
}

/**
 * @description Dig the base64 audio payload out of the Gemini response. Throws
 * when the response shape doesn't contain audio (e.g. the model returned text
 * despite responseModalities: AUDIO — usually means the model ID doesn't
 * support audio output).
 */
function extractAudioPart(json: GeminiTTSResponse): { data: string } {
  const parts = json.candidates?.[0]?.content?.parts || [];
  const audio = parts.find((p) => p.inlineData?.data);
  if (!audio?.inlineData?.data) {
    throw new Error(
      'Gemini TTS returned no audio part — verify the model ID supports audio output (e.g. gemini-2.5-flash-preview-tts)',
    );
  }
  return { data: audio.inlineData.data };
}

/**
 * @description Map a Gemini API error into a typed error the VoiceService can
 * recognize. `SERVICE_DISABLED` (403) is treated as "unconfigured" so the
 * service responds with a remediation hint instead of a generic 500.
 *
 * @param status HTTP status returned by generativelanguage.googleapis.com.
 * @param body Raw response body (the Gemini API returns a JSON error envelope).
 * @returns Error instance — `GoogleAuthNotConfiguredError` for expected
 *   setup issues, generic `Error` for everything else.
 */
function translateGeminiError(status: number, body: string): Error {
  if (status === 403 && /SERVICE_DISABLED|has not been used/i.test(body)) {
    const match = body.match(/visiting (https:\/\/[^\s"]+)/);
    const enableUrl = match ? match[1] : 'https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com';
    return new GoogleAuthNotConfiguredError(
      `Gemini API is disabled on your Google Cloud project — enable it at ${enableUrl}`,
    );
  }
  if (status === 401 || status === 403) {
    return new GoogleAuthNotConfiguredError(
      `GOOGLE_API_KEY rejected by Gemini API (${status}). Verify the key at aistudio.google.com.`,
    );
  }
  return new Error(`Gemini API returned ${status}: ${body}`);
}

/**
 * @description Wrap raw 16-bit mono PCM bytes in a minimal WAV container so
 * browsers can play the audio via a standard `<audio>` element.
 *
 * @param pcm Raw little-endian 16-bit PCM samples.
 * @param sampleRate Sample rate (Gemini TTS emits 24000 Hz by default).
 * @returns WAV-formatted audio buffer.
 */
function wrapPcmInWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
