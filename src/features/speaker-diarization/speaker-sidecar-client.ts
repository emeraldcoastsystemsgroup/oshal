/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added bounded memory-only audio transport, service-key authentication, and strict validation for the deterministic diarization-only timeline contract.
 */

import { createChildLogger } from '@/shared/logger';
import { SpeakerNoSpeechError, SpeakerSidecarError } from './speaker-errors';
import { normalizeSpeakerEmbedding } from './speaker-matcher';
import type {
  SpeakerSidecarContract,
  SpeakerSidecarResult,
  SpeakerSidecarSpeaker,
  SpeakerSidecarTurn,
} from './types';

const logger = createChildLogger({ module: 'speaker-sidecar-client' });
const MAX_TURNS = 500;
const MAX_SPEAKERS = 64;

/** @description HTTP client for a deterministic audio diarization/STT sidecar. */
export class SpeakerSidecarClient implements SpeakerSidecarContract {
  constructor(
    private readonly endpoint = configuredEndpoint(),
    private readonly timeoutMs = configuredTimeout(),
  ) {}

  /**
   * @description Sends an audio buffer without writing it to disk and validates every returned turn.
   * @param audio - Bounded in-memory audio bytes.
   * @param mimeType - Validated audio content type.
   * @returns Strictly validated transcript turns and embedding model.
   */
  async diarize(audio: Buffer, mimeType: string): Promise<SpeakerSidecarResult> {
    const startedAt = Date.now();
    logger.info({ operation: 'diarize', audioBytes: audio.length, mimeType }, 'Speaker sidecar request entered');
    if (!this.endpoint) throw new SpeakerSidecarError('speaker diarization sidecar is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST', body: new Uint8Array(audio), signal: controller.signal,
        headers: {
          'Content-Type': mimeType,
          Accept: 'application/json',
          'X-Speaker-Service-Key': configuredServiceKey(),
        },
      });
      if (!response.ok) throw await sidecarHttpError(response);
      const result = validateSidecarResult(await response.json());
      logger.info({ operation: 'diarize', turns: result.turns.length, durationMs: Date.now() - startedAt }, 'Speaker sidecar request completed');
      return result;
    } catch (error) {
      if (error instanceof SpeakerNoSpeechError) {
        logger.info(
          { operation: 'diarize', durationMs: Date.now() - startedAt },
          'Speaker sidecar found no speech',
        );
        throw error;
      }
      logger.error({ err: error, operation: 'diarize', durationMs: Date.now() - startedAt }, 'Speaker sidecar request failed');
      if (error instanceof SpeakerSidecarError) throw error;
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'speaker sidecar timed out' : 'speaker sidecar request failed';
      throw new SpeakerSidecarError(message);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function sidecarHttpError(response: Response): Promise<SpeakerSidecarError> {
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = requireRecord(JSON.parse(raw), 'speaker sidecar error response must be an object');
  } catch (error) {
    logger.error({ err: error, status: response.status }, 'Speaker sidecar returned an invalid error envelope');
  }
  const code = typeof body.error === 'string' ? body.error : 'speaker_sidecar_unavailable';
  const message = typeof body.message === 'string'
    ? body.message : `speaker sidecar returned HTTP ${response.status}`;
  if (response.status === 422 && code === 'no_speech_detected') {
    return new SpeakerNoSpeechError(message);
  }
  return new SpeakerSidecarError(message, code);
}

function configuredEndpoint(): string {
  const base = String(process.env.SPEAKER_DIARIZATION_URL || '').trim();
  if (!base) return '';
  return base.endsWith('/v1/diarize') ? base : `${base.replace(/\/$/, '')}/v1/diarize`;
}

function configuredServiceKey(): string {
  const value = String(process.env.SPEAKER_SERVICE_KEY || '').trim();
  if (!value) throw new SpeakerSidecarError('SPEAKER_SERVICE_KEY is not configured');
  return value;
}

function configuredTimeout(): number {
  const value = Number(process.env.SPEAKER_DIARIZATION_TIMEOUT_MS ?? 45_000);
  if (!Number.isFinite(value)) return 45_000;
  return Math.min(120_000, Math.max(1_000, Math.floor(value)));
}

function validateSidecarResult(value: unknown): SpeakerSidecarResult {
  const record = requireRecord(value, 'speaker sidecar response must be an object');
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  if (!modelId || modelId.length > 120) throw new SpeakerSidecarError('speaker sidecar modelId is invalid');
  if (!Array.isArray(record.turns) || record.turns.length < 1 || record.turns.length > MAX_TURNS) {
    throw new SpeakerSidecarError(`speaker sidecar must return 1-${MAX_TURNS} turns`);
  }
  if (!Array.isArray(record.speakers) || record.speakers.length < 1 || record.speakers.length > MAX_SPEAKERS) {
    throw new SpeakerSidecarError(`speaker sidecar must return 1-${MAX_SPEAKERS} speakers`);
  }
  const durationSeconds = readDuration(record.durationSeconds, 'durationSeconds', 180);
  const speakers = record.speakers.map((speaker, index) => validateSpeaker(speaker, index));
  const turns = record.turns.map((turn, index) => validateTurn(turn, index, durationSeconds));
  assertSpeakerKeys(turns, speakers);
  return {
    modelId,
    sampleRate: readInteger(record.sampleRate, 'sampleRate', 8_000, 192_000),
    durationSeconds,
    turns,
    speakers,
  };
}

function validateTurn(value: unknown, index: number, durationSeconds: number): SpeakerSidecarTurn {
  const turn = requireRecord(value, `speaker sidecar turn ${index} must be an object`);
  const speakerKey = readSpeakerKey(turn.speakerKey, `turn ${index} speakerKey`);
  const startTime = readDuration(turn.startTime, `turn ${index} startTime`, durationSeconds);
  const endTime = readDuration(turn.endTime, `turn ${index} endTime`, durationSeconds);
  if (endTime < startTime) throw new SpeakerSidecarError(`speaker sidecar turn ${index} ends before it starts`);
  return {
    turnIndex: readInteger(turn.turnIndex, `turn ${index} turnIndex`, 0, MAX_TURNS - 1),
    speakerKey,
    startTime,
    endTime,
    overlap: readBoolean(turn.overlap, `turn ${index} overlap`),
  };
}

function validateSpeaker(value: unknown, index: number): SpeakerSidecarSpeaker {
  const speaker = requireRecord(value, `speaker sidecar speaker ${index} must be an object`);
  if (!Array.isArray(speaker.embedding)) {
    throw new SpeakerSidecarError(`speaker sidecar speaker ${index} embedding is missing`);
  }
  if (speaker.embedding.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new SpeakerSidecarError(`speaker sidecar speaker ${index} embedding is invalid`);
  }
  return {
    speakerKey: readSpeakerKey(speaker.speakerKey, `speaker ${index} speakerKey`),
    embedding: speaker.embedding.length > 0 ? normalizeSpeakerEmbedding(speaker.embedding) : null,
    voicedSeconds: readDuration(speaker.voicedSeconds, `speaker ${index} voicedSeconds`, 180),
  };
}

function readDuration(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new SpeakerSidecarError(`speaker sidecar ${field} is invalid`);
  }
  return value;
}

function readInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SpeakerSidecarError(`speaker sidecar ${field} is invalid`);
  }
  return value;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new SpeakerSidecarError(`speaker sidecar ${field} is invalid`);
  return value;
}

function readSpeakerKey(value: unknown, field: string): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new SpeakerSidecarError(`speaker sidecar ${field} is invalid`);
  }
  return key;
}

function assertSpeakerKeys(turns: SpeakerSidecarTurn[], speakers: SpeakerSidecarSpeaker[]): void {
  const keys = new Set(speakers.map((speaker) => speaker.speakerKey));
  if (keys.size !== speakers.length || turns.some((turn) => !keys.has(turn.speakerKey))) {
    throw new SpeakerSidecarError('speaker sidecar returned inconsistent speaker keys');
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpeakerSidecarError(message);
  return value as Record<string, unknown>;
}
