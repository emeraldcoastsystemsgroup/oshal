/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local speech-to-text provider: transcription that never leaves the host. Every other STT provider here is a cloud call (Google Cloud V2, Gemini, or the browser's own engine), which is the wrong default for material you are contractually or commercially not free to hand to a third party — a customer's recorded call being the case that prompted this. Speaks to the pinned sherpa-onnx sidecar that already does diarization on the compose network, so the transcript comes back SPEAKER-LABELLED rather than as one undifferentiated block. Built as a sibling behind STTProvider; the cloud providers are untouched.
 */

import { createChildLogger } from '@/shared/logger';
import type {
  STTProvider,
  STTSegment,
  STTTranscribeRequest,
  STTTranscribeResult,
  VoiceProviderStatus,
} from '../types/provider-types';

const logger = createChildLogger({ module: 'local-stt-provider' });

/** @description Deployment settings for the local speaker/ASR sidecar. */
export interface LocalSTTConfig {
  /** Sidecar base URL, e.g. http://speaker-diarization:8080 (compose-private). */
  baseUrl?: string;
  /** Shared service key the sidecar requires on every call. */
  serviceKey?: string;
  /** Ceiling for one transcription. Long recordings are minutes of CPU, not milliseconds. */
  timeoutMs?: number;
}

interface SidecarSegment {
  index: number;
  speakerKey: string;
  startTime: number;
  endTime: number;
  text: string;
}

interface SidecarTranscript {
  modelId: string;
  asrModelId: string;
  durationSeconds: number;
  speakerCount: number;
  segments: SidecarSegment[];
}

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * @description Server-side STT provider backed by the on-host sherpa-onnx sidecar.
 * Returns speaker-labelled segments; no audio or text leaves the machine.
 */
export class LocalSTTProvider implements STTProvider {
  public readonly id = 'local-stt';

  public readonly displayName = 'Local (on-host) speech-to-text';

  public readonly kind = 'server' as const;

  constructor(private readonly config: LocalSTTConfig = {}) {}

  /** @description Resolve the sidecar base URL from config or environment. @returns {string} Base URL, without a trailing slash. */
  private baseUrl(): string {
    const raw = this.config.baseUrl || process.env.SPEAKER_DIARIZATION_URL || '';
    return raw.replace(/\/+$/, '');
  }

  /** @description Resolve the sidecar service key. @returns {string} Key, empty when unset. */
  private serviceKey(): string {
    return (this.config.serviceKey || process.env.SPEAKER_SERVICE_KEY || '').trim();
  }

  /**
   * @description Report readiness. Configured means we know where the sidecar is and hold
   * its key; it does NOT promise the optional ASR model is installed in that image — the
   * sidecar answers 503 for that, and saying so here would be a claim we cannot verify
   * without calling it.
   * @returns {Promise<VoiceProviderStatus>} Structured status with an actionable reason.
   */
  async getStatus(): Promise<VoiceProviderStatus> {
    const base = this.baseUrl();
    const key = this.serviceKey();
    const reason = !base
      ? 'SPEAKER_DIARIZATION_URL is not set — the local speaker sidecar is where transcription runs'
      : !key
        ? 'SPEAKER_SERVICE_KEY is not set — the sidecar refuses unauthenticated calls'
        : undefined;
    return { configured: Boolean(base && key), providerId: this.id, ...(reason ? { reason } : {}) };
  }

  /**
   * @description Transcribe audio on this host, speaker-labelled.
   * @param request - Audio buffer plus its mime type; `signal` cancels a long run.
   * @returns {Promise<STTTranscribeResult>} Flattened text plus per-speaker segments.
   * @throws {Error} When the sidecar is unconfigured, unreachable, or has no ASR model.
   */
  async transcribe(request: STTTranscribeRequest): Promise<STTTranscribeResult> {
    const status = await this.getStatus();
    if (!status.configured) throw new Error(`local-stt is not configured: ${status.reason}`);

    const started = Date.now();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = new AbortController();
    const cancel = setTimeout(() => timer.abort(), timeoutMs);
    // Caller cancellation must win over our own ceiling, not race it.
    request.signal?.addEventListener('abort', () => timer.abort(), { once: true });

    logger.info({ operation: 'transcribe', bytes: request.audio.length, mimeType: request.mimeType }, 'local transcription started');
    try {
      const response = await fetch(`${this.baseUrl()}/v1/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': request.mimeType || 'application/octet-stream',
          'X-Speaker-Service-Key': this.serviceKey(),
        },
        body: new Uint8Array(request.audio),
        signal: timer.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`local speaker sidecar returned ${response.status}: ${detail.slice(0, 300)}`);
      }
      const body = (await response.json()) as SidecarTranscript;
      const segments: STTSegment[] = (body.segments || []).map((segment) => ({
        text: `${segment.speakerKey}: ${segment.text}`,
        startTime: segment.startTime,
        endTime: segment.endTime,
      }));
      logger.info(
        {
          operation: 'transcribe',
          durationMs: Date.now() - started,
          audioSeconds: body.durationSeconds,
          segments: segments.length,
          speakers: body.speakerCount,
        },
        'local transcription completed',
      );
      return {
        providerId: this.id,
        text: (body.segments || []).map((segment) => segment.text).join(' ').trim(),
        languageCode: request.languageCode || 'en-US',
        ...(request.enableSegments === false ? {} : { segments }),
      };
    } catch (error) {
      logger.error({ err: error, operation: 'transcribe', durationMs: Date.now() - started }, 'local transcription failed');
      throw error;
    } finally {
      clearTimeout(cancel);
    }
  }
}
