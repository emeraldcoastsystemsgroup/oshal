/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added controller orchestration that matches sidecar speaker keys once, runs existing memory-only STT separately, and attributes timestamped text by maximum proven timeline overlap.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Made ambient capture sidecar-first to avoid cloud STT for silence and added chunk-keyed profile observations.
 */

import { createChildLogger } from '@/shared/logger';
import { SpeakerInputError, SpeakerNoSpeechError } from './speaker-errors';
import {
  normalizeSpeakerEmbedding,
  SPEAKER_MATCH_THRESHOLD,
  selectBestSpeakerMatch,
  updateSpeakerCentroid,
} from './speaker-matcher';
import type {
  SpeakerAttributedTurn,
  SpeakerAudioPurpose,
  SpeakerAudioResult,
  SpeakerDiarizationOrchestratorContract,
  SpeakerProfileStoreContract,
  SpeakerSidecarContract,
  SpeakerSidecarResult,
  SpeakerTimelineTurn,
  SpeakerTranscriptionContract,
  SpeakerTranscriptionResult,
  SpeakerTranscriptionSegment,
} from './types';
import { SPEAKER_AUDIO_MAX_SECONDS } from './types';

const logger = createChildLogger({ module: 'speaker-diarization-orchestrator' });
const MIN_PROFILE_VOICED_SECONDS = 1.5;
const MIN_ENROLLMENT_VOICED_SECONDS = 5;
const MIN_STT_OVERLAP_RATIO = 0.6;
const MAX_COALESCE_GAP_SECONDS = 1;

interface SessionCluster {
  id: string;
  ordinal: number;
  embedding: number[];
  sampleCount: number;
}

interface ResolvedSpeaker {
  profileId: string | null;
  ordinal: number | null;
  label: string;
  similarity: number;
  attribution: 'matched' | 'created' | 'session';
}

/** @description Coordinates deterministic diarization, existing STT, and optional owner-private profiles. */
export class SpeakerDiarizationOrchestrator implements SpeakerDiarizationOrchestratorContract {
  constructor(
    private readonly sidecar: SpeakerSidecarContract,
    private readonly transcriber: SpeakerTranscriptionContract,
    private readonly store: SpeakerProfileStoreContract,
  ) {}

  /**
   * @description Processes memory-only audio and attributes only timestamped text with proven overlap.
   * @param ownerSub - Authenticated transcript owner.
   * @param audio - Bounded memory buffer that is discarded after this call.
   * @param mimeType - Validated audio MIME type.
   * @param rememberSpeakers - Whether encrypted cross-chunk profiles may be persisted.
   * @param purpose - Ambient, explicit import, or transcription-free self enrollment.
   * @returns Speaker timeline even if STT is unavailable, plus safely attributed text turns.
   */
  async process(
    ownerSub: string,
    audio: Buffer,
    mimeType: string,
    rememberSpeakers: boolean,
    purpose: SpeakerAudioPurpose = 'ambient',
    clientChunkId?: string,
  ): Promise<SpeakerAudioResult> {
    const startedAt = Date.now();
    let diarization: SpeakerSidecarResult | null = null;
    logger.info({ operation: 'process', audioBytes: audio.length, rememberSpeakers }, 'Speaker orchestration entered');
    try {
      const concurrent = await processAudioInputs(
        this.sidecar, this.transcriber, audio, mimeType, purpose,
      );
      diarization = concurrent.diarization;
      assertDecodedDuration(diarization, purpose);
      if (purpose === 'self_enrollment' && !validEnrollmentSample(diarization)) {
        throw new SpeakerInputError(
          `self enrollment requires one speaker with at least ${MIN_ENROLLMENT_VOICED_SECONDS}s of clean voice`,
          'self_enrollment_ambiguous',
        );
      }
      const resolved = rememberSpeakers
        ? await this.resolvePersistent(ownerSub, diarization, clientChunkId)
        : this.resolveForSession(diarization);
      const timeline = buildTimeline(diarization, resolved);
      if (purpose === 'self_enrollment') return enrollmentResult(diarization, timeline);
      const transcription = requireTranscription(concurrent.transcription);
      const result = buildAudioResult(diarization, timeline, resolved, transcription);
      logger.info({ operation: 'process', turns: result.turns.length, durationMs: Date.now() - startedAt }, 'Speaker orchestration completed');
      return result;
    } catch (error) {
      if (error instanceof SpeakerNoSpeechError) {
        logger.info({ operation: 'process', durationMs: Date.now() - startedAt }, 'Speaker audio contained no speech');
      } else {
        logger.error({ err: error, operation: 'process', durationMs: Date.now() - startedAt }, 'Speaker orchestration failed');
      }
      throw error;
    } finally {
      diarization?.speakers.forEach((speaker) => speaker.embedding?.fill(0));
    }
  }

  private async resolvePersistent(
    ownerSub: string,
    diarization: SpeakerSidecarResult,
    clientChunkId?: string,
  ): Promise<Map<string, ResolvedSpeaker>> {
    const resolved = new Map<string, ResolvedSpeaker>();
    for (const speaker of diarization.speakers) {
      if (!speaker.embedding || !usableProfileSample(diarization, speaker.speakerKey, speaker.voicedSeconds)) {
        resolved.set(speaker.speakerKey, unresolvedShortSpeaker());
        continue;
      }
      const observation = clientChunkId ? { clientChunkId, speakerKey: speaker.speakerKey } : undefined;
      const match = await this.store.identify(ownerSub, speaker.embedding, diarization.modelId, observation);
      resolved.set(speaker.speakerKey, {
        profileId: match.profile.profileId,
        ordinal: match.profile.ordinal,
        label: match.profile.label,
        similarity: match.similarity,
        attribution: match.created ? 'created' : 'matched',
      });
    }
    return resolved;
  }

  private resolveForSession(diarization: SpeakerSidecarResult): Map<string, ResolvedSpeaker> {
    const clusters: SessionCluster[] = [];
    const resolved = new Map<string, ResolvedSpeaker>();
    for (const speaker of diarization.speakers) {
      if (!speaker.embedding) {
        resolved.set(speaker.speakerKey, unresolvedShortSpeaker());
        continue;
      }
      const embedding = normalizeSpeakerEmbedding(speaker.embedding);
      const best = selectBestSpeakerMatch(embedding, clusters, SPEAKER_MATCH_THRESHOLD);
      const cluster = best ? clusters.find((item) => item.id === best.id)! : createSessionCluster(clusters, embedding);
      if (best) updateSessionCluster(cluster, embedding);
      resolved.set(speaker.speakerKey, {
        profileId: null,
        ordinal: cluster.ordinal,
        label: `Unidentified Person ${cluster.ordinal}`,
        similarity: best?.similarity ?? 1,
        attribution: 'session',
      });
    }
    return resolved;
  }
}

async function processAudioInputs(
  sidecar: SpeakerSidecarContract,
  transcriber: SpeakerTranscriptionContract,
  audio: Buffer,
  mimeType: string,
  purpose: SpeakerAudioPurpose,
): Promise<{ diarization: SpeakerSidecarResult; transcription: SpeakerTranscriptionResult | null }> {
  if (purpose === 'recording_import') {
    return diarizeAndTranscribe(sidecar, transcriber, audio, mimeType);
  }
  const diarization = await sidecar.diarize(audio, mimeType);
  assertDecodedDuration(diarization, purpose);
  if (!hasVoicedTurns(diarization)) throw new SpeakerNoSpeechError();
  if (purpose === 'self_enrollment') return { diarization, transcription: null };
  const transcription = await transcriber.transcribe(audio, mimeType);
  return { diarization, transcription };
}

async function diarizeAndTranscribe(
  sidecar: SpeakerSidecarContract,
  transcriber: SpeakerTranscriptionContract,
  audio: Buffer,
  mimeType: string,
): Promise<{ diarization: SpeakerSidecarResult; transcription: SpeakerTranscriptionResult }> {
  const [diarization, transcription] = await Promise.allSettled([
    sidecar.diarize(audio, mimeType),
    transcriber.transcribe(audio, mimeType),
  ]);
  if (diarization.status === 'rejected') {
    if (transcription.status === 'rejected') {
      logger.error({ err: transcription.reason }, 'Concurrent speaker transcription also failed');
    }
    throw diarization.reason;
  }
  if (transcription.status === 'rejected') throw transcription.reason;
  return { diarization: diarization.value, transcription: transcription.value };
}

function assertDecodedDuration(diarization: SpeakerSidecarResult, purpose: SpeakerAudioPurpose): void {
  if (diarization.durationSeconds <= SPEAKER_AUDIO_MAX_SECONDS[purpose] + 0.5) return;
  throw new SpeakerInputError(
    `${purpose} decoded audio exceeds ${SPEAKER_AUDIO_MAX_SECONDS[purpose]} seconds`,
    'audio_duration_limit',
  );
}

function hasVoicedTurns(diarization: SpeakerSidecarResult): boolean {
  return diarization.turns.length > 0 && diarization.speakers.some((speaker) => speaker.voicedSeconds > 0);
}

function requireTranscription(
  value: SpeakerTranscriptionResult | null,
): SpeakerTranscriptionResult {
  if (!value) throw new Error('speaker transcription result is unexpectedly unavailable');
  return value;
}

function unresolvedShortSpeaker(): ResolvedSpeaker {
  return {
    profileId: null,
    ordinal: null,
    label: 'Unidentified Speaker',
    similarity: 0,
    attribution: 'session',
  };
}

function enrollmentResult(
  diarization: SpeakerSidecarResult,
  timeline: SpeakerTimelineTurn[],
): SpeakerAudioResult {
  return {
    source: 'sidecar_only',
    processing: { status: 'complete', transcription: 'unavailable', diarization: 'complete' },
    model: diarization.modelId,
    sttProviderId: null,
    durationSeconds: diarization.durationSeconds,
    timeline,
    turns: [],
  };
}

function buildTimeline(
  diarization: SpeakerSidecarResult,
  resolved: Map<string, ResolvedSpeaker>,
): SpeakerTimelineTurn[] {
  return diarization.turns.map((turn) => {
    const speaker = requiredResolved(resolved, turn.speakerKey);
    return {
      turnIndex: turn.turnIndex,
      speakerKey: turn.speakerKey,
      startTime: turn.startTime,
      endTime: turn.endTime,
      overlap: turn.overlap,
      profileId: speaker.profileId,
      ordinal: speaker.ordinal,
      label: speaker.label,
      attribution: speaker.attribution,
    };
  });
}

function buildAudioResult(
  diarization: SpeakerSidecarResult,
  timeline: SpeakerTimelineTurn[],
  resolved: Map<string, ResolvedSpeaker>,
  transcription: Awaited<ReturnType<SpeakerTranscriptionContract['transcribe']>>,
): SpeakerAudioResult {
  const segments = normalizeTranscriptionSegments(transcription.segments);
  if (segments.length > 0) {
    return completeResult(diarization, timeline, resolved, segments, transcription.providerId);
  }
  if (transcription.text?.trim() && !transcription.fallback) {
    return wholeTextResult(diarization, timeline, transcription.text, transcription.providerId);
  }
  return {
    source: 'sidecar_only',
    processing: { status: 'degraded', transcription: 'unavailable', diarization: 'complete' },
    model: diarization.modelId,
    sttProviderId: transcription.providerId,
    durationSeconds: diarization.durationSeconds,
    timeline,
    turns: [],
  };
}

function completeResult(
  diarization: SpeakerSidecarResult,
  timeline: SpeakerTimelineTurn[],
  resolved: Map<string, ResolvedSpeaker>,
  segments: SpeakerTranscriptionSegment[],
  providerId: string,
): SpeakerAudioResult {
  const turns = segments.map((segment) => attributeSegment(segment, diarization, resolved));
  const coalesced = coalesceAttributedTurns(turns);
  const unavailable = coalesced.some((turn) => turn.attribution === 'unavailable');
  return {
    source: 'sidecar_and_stt',
    processing: { status: unavailable ? 'degraded' : 'complete', transcription: 'provider', diarization: 'complete' },
    model: diarization.modelId,
    sttProviderId: providerId,
    durationSeconds: diarization.durationSeconds,
    timeline,
    turns: coalesced,
  };
}

function wholeTextResult(
  diarization: SpeakerSidecarResult,
  timeline: SpeakerTimelineTurn[],
  text: string,
  providerId: string,
): SpeakerAudioResult {
  return {
    source: 'sidecar_and_stt',
    processing: { status: 'degraded', transcription: 'provider', diarization: 'complete' },
    model: diarization.modelId,
    sttProviderId: providerId,
    durationSeconds: diarization.durationSeconds,
    timeline,
    turns: [unavailableTurn(text.trim(), 0, diarization.durationSeconds)],
  };
}

function attributeSegment(
  segment: SpeakerTranscriptionSegment,
  diarization: SpeakerSidecarResult,
  resolved: Map<string, ResolvedSpeaker>,
): SpeakerAttributedTurn {
  const winner = unambiguousOverlap(segment, diarization.turns);
  if (!winner) return unavailableTurn(segment.text, segment.startTime, segment.endTime);
  const speaker = requiredResolved(resolved, winner.speakerKey);
  return {
    text: segment.text,
    startTime: segment.startTime,
    endTime: segment.endTime,
    profileId: speaker.profileId,
    ordinal: speaker.ordinal,
    label: speaker.label,
    similarity: speaker.similarity,
    attribution: speaker.attribution,
    overlap: false,
  };
}

function unambiguousOverlap(
  segment: SpeakerTranscriptionSegment,
  turns: SpeakerSidecarResult['turns'],
) {
  const matches = turns.map((turn) => ({
    turn,
    overlap: Math.max(0, Math.min(segment.endTime, turn.endTime) - Math.max(segment.startTime, turn.startTime)),
  })).filter((entry) => entry.overlap > 0);
  if (matches.length === 0) return null;
  if (new Set(matches.map((entry) => entry.turn.speakerKey)).size !== 1) return null;
  const covered = matches.reduce((sum, entry) => sum + entry.overlap, 0);
  const duration = segment.endTime - segment.startTime;
  if (duration <= 0 || covered / duration < MIN_STT_OVERLAP_RATIO) return null;
  return matches.sort((left, right) => right.overlap - left.overlap
    || left.turn.turnIndex - right.turn.turnIndex)[0].turn;
}

function coalesceAttributedTurns(turns: SpeakerAttributedTurn[]): SpeakerAttributedTurn[] {
  const result: SpeakerAttributedTurn[] = [];
  for (const turn of turns) {
    const previous = result[result.length - 1];
    if (!previous || !canCoalesce(previous, turn)) { result.push({ ...turn }); continue; }
    previous.text = joinTranscriptText(previous.text, turn.text);
    previous.endTime = turn.endTime;
    previous.similarity = minimumSimilarity(previous.similarity, turn.similarity);
  }
  return result;
}

function canCoalesce(left: SpeakerAttributedTurn, right: SpeakerAttributedTurn): boolean {
  return left.profileId === right.profileId
    && left.label === right.label
    && left.attribution === right.attribution
    && left.overlap === right.overlap
    && right.startTime - left.endTime <= MAX_COALESCE_GAP_SECONDS;
}

function joinTranscriptText(left: string, right: string): string {
  return `${left.trim()} ${right.trim()}`.replace(/\s+([,.;!?])/g, '$1');
}

function minimumSimilarity(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : Math.min(left, right);
}

function usableProfileSample(
  diarization: SpeakerSidecarResult,
  speakerKey: string,
  voicedSeconds: number,
): boolean {
  return Math.min(voicedSeconds, exclusiveSpeakerSeconds(diarization, speakerKey)) >= MIN_PROFILE_VOICED_SECONDS;
}

function validEnrollmentSample(diarization: SpeakerSidecarResult): boolean {
  if (diarization.speakers.length !== 1 || !diarization.speakers[0].embedding) return false;
  const speaker = diarization.speakers[0];
  return diarization.durationSeconds >= MIN_ENROLLMENT_VOICED_SECONDS
    && Math.min(speaker.voicedSeconds, exclusiveSpeakerSeconds(diarization, speaker.speakerKey))
      >= MIN_ENROLLMENT_VOICED_SECONDS;
}

function exclusiveSpeakerSeconds(diarization: SpeakerSidecarResult, speakerKey: string): number {
  const own = mergeIntervals(diarization.turns
    .filter((turn) => turn.speakerKey === speakerKey)
    .map((turn) => [turn.startTime, turn.endTime] as const));
  const other = mergeIntervals(diarization.turns
    .filter((turn) => turn.speakerKey !== speakerKey)
    .map((turn) => [turn.startTime, turn.endTime] as const));
  return own.reduce((sum, interval) => sum + intervalExclusiveDuration(interval, other), 0);
}

function mergeIntervals(intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0])) {
    const previous = merged[merged.length - 1];
    if (!previous || start > previous[1]) merged.push([start, end]);
    else previous[1] = Math.max(previous[1], end);
  }
  return merged;
}

function intervalExclusiveDuration(
  own: readonly [number, number],
  others: ReadonlyArray<readonly [number, number]>,
): number {
  const overlap = others.reduce((sum, other) => {
    return sum + Math.max(0, Math.min(own[1], other[1]) - Math.max(own[0], other[0]));
  }, 0);
  return Math.max(0, own[1] - own[0] - overlap);
}

function unavailableTurn(text: string, startTime: number, endTime: number): SpeakerAttributedTurn {
  return {
    text,
    startTime,
    endTime,
    profileId: null,
    ordinal: null,
    label: 'Speaker unavailable',
    similarity: null,
    attribution: 'unavailable',
    overlap: false,
  };
}

function normalizeTranscriptionSegments(value: SpeakerTranscriptionSegment[] | undefined): SpeakerTranscriptionSegment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((segment) => {
    return typeof segment.text === 'string' && segment.text.trim().length > 0
      && Number.isFinite(segment.startTime) && Number.isFinite(segment.endTime)
      && segment.startTime >= 0 && segment.endTime >= segment.startTime;
  }).map((segment) => ({ ...segment, text: segment.text.trim().replace(/\s+/g, ' ') }));
}

function requiredResolved(resolved: Map<string, ResolvedSpeaker>, key: string): ResolvedSpeaker {
  const speaker = resolved.get(key);
  if (!speaker) throw new Error('validated sidecar speaker key was not resolved');
  return speaker;
}

function createSessionCluster(clusters: SessionCluster[], embedding: number[]): SessionCluster {
  const ordinal = clusters.length + 1;
  const cluster = { id: `session-${ordinal}`, ordinal, embedding, sampleCount: 1 };
  clusters.push(cluster);
  return cluster;
}

function updateSessionCluster(cluster: SessionCluster, embedding: number[]): void {
  cluster.embedding = updateSpeakerCentroid(cluster.embedding, cluster.sampleCount, embedding);
  cluster.sampleCount += 1;
}
