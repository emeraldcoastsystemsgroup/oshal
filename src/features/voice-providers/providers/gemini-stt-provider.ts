/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Gemini STT provider — sends audio via generateContent with an inlineData audio part; authenticates with GOOGLE_API_KEY, replacing the OAuth requirement that keeps Cloud STT off the default path
 */

import { createChildLogger } from '@/shared/logger';
import type {
  STTProvider,
  STTTranscribeRequest,
  STTTranscribeResult,
  VoiceProviderStatus,
} from '../types';
import { GoogleAuthNotConfiguredError, getGoogleApiKey } from './google-cloud-auth';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const logger = createChildLogger({ module: 'gemini-stt-provider' });

/**
 * @description Per-instance configuration.
 */
export interface GeminiSTTConfig {
  model: string;
  defaultLanguageCode: string;
  transcribePrompt: string;
}

/**
 * @description Server-side STT provider using Gemini's native audio
 * understanding. Audio is uploaded inline; Gemini returns a plain transcript.
 */
export class GeminiSTTProvider implements STTProvider {
  public readonly id = 'gemini-stt';
  public readonly displayName = 'Gemini STT (Google AI Studio)';
  public readonly kind = 'server' as const;

  constructor(private readonly config: GeminiSTTConfig) {}

  /**
   * @description Ready when an API key is present.
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
   * @description Transcribe by sending the audio inline to `generateContent`
   * with a transcription prompt. Gemini returns the transcript as text.
   *
   * @param request Transcription request.
   * @returns Transcript + provider id.
   */
  async transcribe(request: STTTranscribeRequest): Promise<STTTranscribeResult> {
    const key = getGoogleApiKey();
    if (!key) {
      // Use the structured not-configured signal so VoiceService maps it to
      // `fallback: 'unconfigured'` instead of the generic 'failed' state —
      // that gives the voice-settings UI a setup hint instead of "Empty response".
      throw new GoogleAuthNotConfiguredError(
        'GOOGLE_API_KEY / GEMINI_API_KEY is not set — get a key at aistudio.google.com',
      );
    }
    const url = `${GEMINI_BASE}/models/${this.config.model}:generateContent?key=${encodeURIComponent(key)}`;
    const mimeType = normalizeMimeType(request.mimeType);
    const body = {
      contents: [
        {
          parts: [
            { text: this.config.transcribePrompt },
            {
              inlineData: {
                mimeType,
                data: request.audio.toString('base64'),
              },
            },
          ],
        },
      ],
    };
    logger.info(
      { bytes: request.audio.length, mimeType, model: this.config.model },
      'Gemini STT call',
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, errBody }, 'Gemini STT call failed');
      throw translateGeminiError(response.status, errBody);
    }
    const json = (await response.json()) as GeminiSTTResponse;
    return {
      providerId: this.id,
      text: extractTranscript(json),
      languageCode: request.languageCode || this.config.defaultLanguageCode,
    };
  }
}

/**
 * @description Raw response shape for Gemini `generateContent` with text output.
 */
interface GeminiSTTResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

/**
 * @description Concatenate every text part in the first candidate — Gemini
 * occasionally chunks the transcript across parts.
 */
function extractTranscript(json: GeminiSTTResponse): string {
  const parts = json.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p) => p.text || '')
    .join(' ')
    .trim();
}

/**
 * @description Map a Gemini API error into a typed error the VoiceService can
 * recognize. `SERVICE_DISABLED` (403) is treated as "unconfigured" so the
 * service responds with a remediation hint instead of a generic 500.
 *
 * @param status HTTP status returned by generativelanguage.googleapis.com.
 * @param body Raw response body (the Gemini API returns a JSON error envelope).
 * @returns Error instance.
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
 * @description Normalize browser-friendly MIME types for the Gemini inline
 * audio part. Verified live against 2.5-flash: webm is accepted as-is (the
 * model tolerates it despite not being in the documented list). Anything
 * unknown falls back to audio/wav.
 */
function normalizeMimeType(incoming: string | undefined): string {
  const lower = (incoming || '').toLowerCase();
  if (lower.includes('wav')) return 'audio/wav';
  if (lower.includes('mp3') || lower.includes('mpeg') || lower.includes('mpga')) return 'audio/mp3';
  if (lower.includes('aiff')) return 'audio/aiff';
  if (lower.includes('aac')) return 'audio/aac';
  if (lower.includes('webm')) return 'audio/webm';
  if (lower.includes('ogg') || lower.includes('opus')) return 'audio/ogg';
  if (lower.includes('flac')) return 'audio/flac';
  return 'audio/wav';
}
