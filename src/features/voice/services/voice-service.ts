/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Created stub backend VoiceService to unblock server startup
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced stub with registry-backed impl — delegates to TTS/STT provider registries, surfaces browser/unconfigured fallbacks instead of lying about transcription
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | synthesizeSpeech now accepts an optional providerId override for preview-any-provider UX on the voice settings page
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Non-auth provider errors (bad audio, rate-limit, etc.) now return `fallback: 'failed'` in the envelope instead of bubbling to a 500 — the client always gets a structured payload to render
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added safe STT provider override and timestamp-segment request options for deterministic diarization alignment.
 */

import { createChildLogger } from '@/shared/logger';
import {
  GoogleAuthNotConfiguredError,
  getSTTProviderRegistry,
  getTTSProviderRegistry,
  type STTProvider,
  type TTSProvider,
  type TTSVoice,
} from '@/features/voice-providers';

const logger = createChildLogger({ module: 'voice-service' });

/**
 * @description Result returned to HTTP callers for `POST /api/voice/synthesize`.
 * Shape matches `SynthesizeResponseSchema` in voice-schemas.ts — `audioData`
 * is base64-encoded audio, `fallback` signals a non-server path.
 */
export interface SynthesizeResult {
  providerId: string;
  audioData?: string;
  format?: string;
  voiceId?: string;
  fallback?: 'browser' | 'unconfigured' | 'failed';
  message?: string;
}

/**
 * @description Result returned to HTTP callers for `POST /api/voice/transcribe`.
 */
export interface TranscribeResult {
  providerId: string;
  text?: string;
  confidence?: number;
  segments?: Array<{ text: string; startTime: number; endTime: number }>;
  languageCode?: string;
  fallback?: 'browser' | 'unconfigured' | 'failed';
  message?: string;
}

/** @description Optional provider and timestamp controls for server STT callers. */
export interface TranscribeOptions {
  providerId?: string;
  enableSegments?: boolean;
  signal?: AbortSignal;
}

/**
 * @description Backend voice service — resolves the configured TTS/STT
 * provider from the registry and calls it, translating
 * `GoogleAuthNotConfiguredError` into a `fallback: 'unconfigured'` response
 * so the client can render a remediation hint instead of crashing.
 */
export class VoiceService {
  private readonly ttsRegistry = getTTSProviderRegistry();
  private readonly sttRegistry = getSTTProviderRegistry();

  /**
   * @description Transcribe an uploaded audio buffer using the configured STT
   * provider. Returns a browser directive when the provider is `browser`, an
   * unconfigured fallback when the provider can't reach its backend, or a
   * real transcript otherwise.
   *
   * @param buffer Raw audio bytes from the multipart upload.
   * @param mimetype Audio MIME type as reported by the uploader.
   * @param options Optional explicit provider and timestamp-segment controls.
   * @returns Shape consumed by `TranscribeResponseSchema`.
   */
  async transcribeAudio(
    buffer: Buffer,
    mimetype: string,
    options: TranscribeOptions = {},
  ): Promise<TranscribeResult> {
    const provider = options.providerId
      ? this.sttRegistry.get(options.providerId)
      : this.sttRegistry.resolveForApp();
    if (!provider) {
      logger.warn({ requestedProviderId: options.providerId }, 'transcribeAudio requested unavailable provider');
      return {
        providerId: options.providerId || 'unavailable',
        fallback: 'unconfigured',
        message: 'Requested STT provider is not configured',
      };
    }
    logger.info(
      { providerId: provider.id, kind: provider.kind, bytes: buffer.length, mimetype },
      'transcribeAudio resolved provider',
    );
    if (provider.kind === 'browser') {
      return {
        providerId: provider.id,
        fallback: 'browser',
        message: 'Browser STT selected — use Web Speech API on the client',
      };
    }
    return this.runServerSTT(
      provider, buffer, mimetype, options.enableSegments === true, options.signal,
    );
  }

  /**
   * @description Call a server-side STT provider and translate configuration
   * errors into a structured `fallback` payload rather than an exception.
   *
   * @param provider Resolved server-kind STT provider.
   * @param buffer Audio bytes.
   * @param mimetype MIME type for encoding resolution.
   * @param enableSegments Whether timestamp-capable providers should return segments.
   * @param signal Optional abort signal for a bounded remote transcription call.
   * @returns Transcription result or unconfigured fallback.
   */
  private async runServerSTT(
    provider: STTProvider,
    buffer: Buffer,
    mimetype: string,
    enableSegments: boolean,
    signal?: AbortSignal,
  ): Promise<TranscribeResult> {
    try {
      const result = await provider.transcribe({ audio: buffer, mimeType: mimetype, enableSegments, signal });
      return {
        providerId: result.providerId,
        text: result.text,
        confidence: result.confidence,
        segments: result.segments,
        languageCode: result.languageCode,
      };
    } catch (error) {
      if (error instanceof GoogleAuthNotConfiguredError) {
        logger.warn({ providerId: provider.id, reason: error.reason }, 'STT unconfigured');
        return {
          providerId: provider.id,
          fallback: 'unconfigured',
          message: error.reason,
        };
      }
      logger.error({ err: error, providerId: provider.id }, 'STT call failed');
      return {
        providerId: provider.id,
        fallback: 'failed',
        message: (error as Error).message,
      };
    }
  }

  /**
   * @description Synthesize text into audio (or browser-directive) using
   * either the swarm-default TTS provider or a caller-specified one.
   *
   * @param text Text to synthesize.
   * @param voice Optional voice ID override.
   * @param providerId Optional explicit provider (e.g. "gemini-tts"); when
   *   omitted, resolves through the swarm-default flow.
   * @returns Shape consumed by `SynthesizeResponseSchema`.
   */
  async synthesizeSpeech(
    text: string,
    voice?: string,
    providerId?: string,
  ): Promise<SynthesizeResult> {
    const provider = providerId
      ? this.ttsRegistry.get(providerId) || this.ttsRegistry.resolveForApp()
      : this.ttsRegistry.resolveForApp();
    if (providerId && !this.ttsRegistry.get(providerId)) {
      logger.warn(
        { requested: providerId, resolved: provider.id },
        'synthesizeSpeech requested unknown provider — falling back to default',
      );
    }
    logger.info(
      { providerId: provider.id, kind: provider.kind, chars: text.length, voice },
      'synthesizeSpeech resolved provider',
    );
    if (provider.kind === 'browser') {
      return {
        providerId: provider.id,
        fallback: 'browser',
        message: 'Browser TTS selected — use speechSynthesis on the client',
        voiceId: voice,
      };
    }
    return this.runServerTTS(provider, text, voice);
  }

  /**
   * @description Call a server-side TTS provider and base64-encode the audio
   * bytes for JSON transport. Translates configuration errors to a fallback.
   *
   * @param provider Resolved server-kind TTS provider.
   * @param text Text to synthesize.
   * @param voice Optional voice override.
   * @returns Synthesis result with base64 audio or unconfigured fallback.
   */
  private async runServerTTS(
    provider: TTSProvider,
    text: string,
    voice: string | undefined,
  ): Promise<SynthesizeResult> {
    try {
      const result = await provider.synthesize({ text, voiceId: voice });
      return {
        providerId: result.providerId,
        audioData: result.audio ? result.audio.toString('base64') : undefined,
        format: result.audioFormat,
        voiceId: result.voiceId,
      };
    } catch (error) {
      if (error instanceof GoogleAuthNotConfiguredError) {
        logger.warn({ providerId: provider.id, reason: error.reason }, 'TTS unconfigured');
        return {
          providerId: provider.id,
          fallback: 'unconfigured',
          message: error.reason,
        };
      }
      logger.error({ err: error, providerId: provider.id }, 'TTS call failed');
      return {
        providerId: provider.id,
        fallback: 'failed',
        message: (error as Error).message,
      };
    }
  }

  /**
   * @description List voices exposed by the configured TTS provider. Browser
   * providers return an empty list because voices are enumerated client-side
   * via `speechSynthesis.getVoices()` — callers detect the browser case via
   * the `source` field.
   *
   * @returns Envelope matching GetVoicesResponseSchema (`voices` + `source`).
   */
  async getAvailableVoices(): Promise<{
    voices: Array<{ id: string; name: string; gender: string; language: string }>;
    source: string;
    providerId: string;
  }> {
    const provider = this.ttsRegistry.resolveForApp();
    const voices = await this.safeListVoices(provider);
    return {
      voices: voices.map((v) => ({
        id: v.id,
        name: v.displayName,
        gender: v.gender || 'UNSPECIFIED',
        language: v.languageCode,
      })),
      source: provider.id,
      providerId: provider.id,
    };
  }

  /**
   * @description List voices while treating auth errors as "empty list" —
   * the voices endpoint is used by UI dropdowns and should never crash when
   * OAuth hasn't been completed.
   *
   * @param provider Resolved TTS provider.
   * @returns Voice list, or empty when unconfigured.
   */
  private async safeListVoices(provider: TTSProvider): Promise<TTSVoice[]> {
    try {
      return await provider.listVoices();
    } catch (error) {
      if (error instanceof GoogleAuthNotConfiguredError) {
        logger.warn({ providerId: provider.id, reason: error.reason }, 'listVoices unconfigured');
        return [];
      }
      logger.error({ err: error, providerId: provider.id }, 'listVoices failed');
      return [];
    }
  }
}
