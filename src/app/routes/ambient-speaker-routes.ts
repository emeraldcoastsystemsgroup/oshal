/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added authenticated memory-only audio diarization, owner-private speaker profile management, private-org member context, deterministic self-enrollment, and trusted transcript persistence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added receipt state transitions, failed-claim release, concurrent retry signaling, and completed lost-response acknowledgement.
 */

import express, { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import type { AppContext } from '@/app/composition/app-context';
import {
  AmbientInputError,
  AmbientModeDisabledError,
  ambientListeningFor,
  type AmbientAttributedSegmentInput,
  type AmbientListeningServiceContract,
  type AmbientTranscriptSegment,
} from '@/features/ambient-listening';
import {
  SpeakerAuthorizationError,
  SpeakerAudioInProgressError,
  SpeakerDiarizationOrchestrator,
  SpeakerInputError,
  SpeakerNoSpeechError,
  SpeakerSidecarClient,
  SpeakerSidecarError,
  SPEAKER_AUDIO_MAX_SECONDS,
  speakerProfilesFor,
  type SpeakerAssignmentInput,
  type SpeakerAudioPurpose,
  type SpeakerAudioResult,
  type SpeakerDiarizationOrchestratorContract,
  type SpeakerProfile,
  type SpeakerProfileStoreContract,
} from '@/features/speaker-diarization';
import { VoiceService } from '@/features/voice';
import { GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES } from '@/features/voice-providers';
import { createChildLogger } from '@/shared/logger';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import {
  acquireAmbientOwnerLock,
  AmbientOwnerLockBusyError,
  type AmbientOwnerLockLease,
} from '@/shared/services/database';

const logger = createChildLogger({ module: 'ambient-speaker-routes' });
const MAX_AUDIO_BYTES = GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES;
const MAX_TRANSCRIPT_CHARS = 8_000;
const METADATA_DURATION_JITTER_MS = 2_000;
const PURPOSES = new Set<SpeakerAudioPurpose>(['ambient', 'recording_import', 'self_enrollment']);
const AUDIO_ADMISSION = Symbol('audio-admission');

type AmbientSpeakerService = Pick<
  AmbientListeningServiceContract,
  'getSettings' | 'appendAttributedSegments' | 'claimAudioChunk'
  | 'completeAudioChunk' | 'releaseAudioChunk'
>;

/** @description Injectable dependencies used by isolated route tests. */
export interface AmbientSpeakerRouteOptions {
  store?: SpeakerProfileStoreContract;
  orchestrator?: SpeakerDiarizationOrchestratorContract;
  ambientService?: AmbientSpeakerService;
}

/**
 * @description Builds speaker profile, private-org context, and memory-only audio routes.
 * @param ctx - App context containing the GUC-aware pool.
 * @param options - Optional deterministic test/deployment adapters.
 * @returns Router mounted behind requiresAuth at `/api/jarvis/ambient`.
 */
export function createAmbientSpeakerRoutes(
  ctx: Pick<AppContext, 'pool'>,
  options: AmbientSpeakerRouteOptions = {},
): Router {
  const router = Router();
  const store = options.store ?? speakerProfilesFor(ctx.pool);
  const deps: SpeakerRouteDependencies = {
    pool: ctx.pool,
    ambient: options.ambientService ?? ambientListeningFor(ctx.pool),
    store,
    orchestrator: options.orchestrator ?? createOrchestrator(store),
  };
  registerSpeakerReadRoutes(router, deps);
  registerSpeakerMutationRoutes(router, deps);
  registerSpeakerAudioRoute(router, deps);
  return router;
}

interface SpeakerRouteDependencies {
  pool: AppContext['pool'];
  ambient: AmbientSpeakerService;
  store: SpeakerProfileStoreContract;
  orchestrator: SpeakerDiarizationOrchestratorContract;
}

function registerSpeakerReadRoutes(router: Router, deps: SpeakerRouteDependencies): void {
  router.get('/speakers', speakerRoute('listSpeakers', async (req, res, sub) => {
    await deps.ambient.getSettings(sub);
    const profiles = isGuestRequest(req) ? [] : await deps.store.listProfiles(sub);
    res.json({ profiles: serializeProfiles(profiles) });
  }));
  router.get('/speaker-context', speakerRoute('speakerContext', async (req, res, sub) => {
    const settings = await deps.ambient.getSettings(sub);
    if (isGuestRequest(req)) {
      res.json({ context: publicSpeakerContext(sub, callerDisplayName(req)) });
      return;
    }
    const requested = optionalUuid(req.query.tenantId, 'tenantId') ?? settings.speakerTenantId;
    res.json({ context: await deps.store.speakerContext(sub, requested, callerDisplayName(req)) });
  }));
}

function registerSpeakerMutationRoutes(router: Router, deps: SpeakerRouteDependencies): void {
  router.put('/speakers/:profileId/assignment', speakerRoute('assignSpeaker', async (req, res, sub) => {
    denyGuestPersistence(req);
    await deps.ambient.getSettings(sub);
    const profile = await deps.store.assignProfile(sub, profileId(req), readAssignment(req.body));
    if (!profile) { res.status(404).json({ error: 'speaker_profile_not_found' }); return; }
    res.json({ profile: serializeProfile(profile) });
  }));
  router.post('/speakers/:profileId/merge', speakerRoute('mergeSpeakers', async (req, res, sub) => {
    denyGuestPersistence(req);
    await deps.ambient.getSettings(sub);
    const sourceId = requiredUuid(req.body?.sourceProfileId, 'sourceProfileId');
    const profile = await deps.store.mergeProfiles(sub, profileId(req), sourceId);
    if (!profile) { res.status(404).json({ error: 'speaker_profile_not_found' }); return; }
    res.json({ profile: serializeProfile(profile) });
  }));
  router.delete('/speakers/:profileId', speakerRoute('deleteSpeaker', async (req, res, sub) => {
    denyGuestPersistence(req);
    await deps.ambient.getSettings(sub);
    const deleted = await deps.store.deleteProfile(sub, profileId(req));
    if (!deleted) { res.status(404).json({ error: 'speaker_profile_not_found' }); return; }
    res.json({ ok: true });
  }));
}

function registerSpeakerAudioRoute(router: Router, deps: SpeakerRouteDependencies): void {
  router.post('/audio', audioAdmissionGate(deps.pool), audioUpload(), speakerRoute('processAudio', (req, res, sub) => {
    return handleSpeakerAudio(req, res, sub, deps);
  }));
}

function audioAdmissionGate(pool: AppContext['pool']): RequestHandler {
  const activeOwners = new Set<string>();
  const ownerRates = new Map<string, OwnerRateWindow>();
  const maximumActive = maximumActiveUploads();
  return (req, res, next) => {
    const ownerSub = callerSub(req);
    if (!ownerSub) { res.status(401).json({ error: 'sign_in_required' }); return; }
    if (activeOwners.has(ownerSub)) {
      rejectBusyUpload(res, 'speaker_owner_audio_busy');
      return;
    }
    if (activeOwners.size >= maximumActive) {
      rejectBusyUpload(res, 'speaker_audio_capacity_reached');
      return;
    }
    if (!consumeOwnerRate(ownerRates, ownerSub)) {
      rejectBusyUpload(res, 'speaker_audio_rate_limited', 5_000);
      return;
    }
    activeOwners.add(ownerSub);
    let closed = false;
    const releaseEarly = () => { closed = true; activeOwners.delete(ownerSub); };
    res.once('close', releaseEarly);
    void acquireAmbientOwnerLock(pool, ownerSub).then((lease) => {
      res.off('close', releaseEarly);
      if (closed || res.destroyed) {
        activeOwners.delete(ownerSub);
        return lease.release();
      }
      attachAudioAdmission(req, res, activeOwners, ownerSub, lease);
      next();
      return undefined;
    }).catch((error: unknown) => {
      res.off('close', releaseEarly);
      activeOwners.delete(ownerSub);
      if (closed || res.destroyed) return;
      if (error instanceof AmbientOwnerLockBusyError) {
        rejectBusyUpload(res, 'speaker_owner_audio_busy', 2_000);
        return;
      }
      logger.error({ err: error }, 'Ambient owner lock acquisition failed');
      res.status(503).json({ error: 'speaker_audio_admission_unavailable' });
    });
  };
}

interface AudioAdmission {
  processingStarted: boolean;
  release: () => Promise<void>;
}

interface OwnerRateWindow {
  startedAt: number;
  count: number;
}

function consumeOwnerRate(windows: Map<string, OwnerRateWindow>, ownerSub: string): boolean {
  const now = Date.now();
  const current = windows.get(ownerSub);
  const window = !current || now - current.startedAt >= 60_000
    ? { startedAt: now, count: 0 } : current;
  if (window.count >= maximumUploadsPerMinute()) return false;
  window.count += 1;
  windows.set(ownerSub, window);
  pruneOwnerRateWindows(windows, now);
  return true;
}

function pruneOwnerRateWindows(windows: Map<string, OwnerRateWindow>, now: number): void {
  if (windows.size <= 1_000) return;
  for (const [ownerSub, window] of windows) {
    if (now - window.startedAt >= 60_000) windows.delete(ownerSub);
  }
  while (windows.size > 1_000) windows.delete(windows.keys().next().value as string);
}

function rejectBusyUpload(
  res: Parameters<RequestHandler>[1],
  error: string,
  retryAfterMs = 1_000,
): void {
  res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
  res.status(429).json({ error, retryAfterMs });
}

function attachAudioAdmission(
  req: Request,
  res: Parameters<RequestHandler>[1],
  activeOwners: Set<string>,
  ownerSub: string,
  lease: AmbientOwnerLockLease,
): void {
  let releasePromise: Promise<void> | null = null;
  const admission: AudioAdmission = { processingStarted: false, release: () => {
    if (releasePromise) return releasePromise;
    activeOwners.delete(ownerSub);
    releasePromise = lease.release();
    return releasePromise;
  } };
  (req as Request & { [AUDIO_ADMISSION]?: AudioAdmission })[AUDIO_ADMISSION] = admission;
  res.once('finish', () => { if (!admission.processingStarted) void admission.release(); });
  res.once('close', () => { if (!admission.processingStarted) void admission.release(); });
}

function maximumActiveUploads(): number {
  const value = Number(process.env.SPEAKER_MAX_ACTIVE_UPLOADS ?? 1);
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(1, Math.floor(value)));
}

function maximumUploadsPerMinute(): number {
  const value = Number(process.env.SPEAKER_MAX_UPLOADS_PER_OWNER_MINUTE ?? 12);
  if (!Number.isFinite(value)) return 12;
  return Math.min(60, Math.max(3, Math.floor(value)));
}

async function handleSpeakerAudio(
  req: Request,
  res: Parameters<RequestHandler>[1],
  ownerSub: string,
  deps: SpeakerRouteDependencies,
): Promise<void> {
  const admission = (req as Request & { [AUDIO_ADMISSION]?: AudioAdmission })[AUDIO_ADMISSION];
  if (admission) admission.processingStarted = true;
  const rawAudio = req.file?.buffer;
  try {
    const upload = readAudioUpload(req);
    const body = await processSpeakerAudio(req, ownerSub, upload, deps);
    res.status(201).json(body);
  } finally {
    rawAudio?.fill(0);
    await admission?.release();
  }
}

async function processSpeakerAudio(
  req: Request,
  ownerSub: string,
  upload: AudioUpload,
  deps: SpeakerRouteDependencies,
): Promise<Record<string, unknown>> {
  const settings = await deps.ambient.getSettings(ownerSub);
  assertAudioPurposeEnabled(
    upload.purpose, settings.ambientEnabled, settings.speakerDiarizationEnabled,
  );
  const guest = isGuestRequest(req);
  if (upload.purpose === 'self_enrollment' && (guest || !settings.rememberSpeakers)) {
    throw new SpeakerAuthorizationError('self enrollment requires remembered speakers in a private account');
  }
  const claim = await deps.ambient.claimAudioChunk(ownerSub, upload.clientChunkId);
  if (claim.state === 'in_progress') throw new SpeakerAudioInProgressError();
  if (claim.state === 'completed') {
    const profiles = guest ? [] : await deps.store.listProfiles(ownerSub);
    return duplicateAudioResponse(upload, profiles);
  }
  let response: Record<string, unknown>;
  try {
    response = await processClaimedSpeakerAudio(ownerSub, upload, deps, guest, settings.rememberSpeakers);
  } catch (error) {
    await releaseFailedAudioClaim(deps.ambient, ownerSub, upload.clientChunkId, claim.claimToken);
    throw error;
  }
  await deps.ambient.completeAudioChunk(ownerSub, upload.clientChunkId, claim.claimToken);
  return response;
}

async function processClaimedSpeakerAudio(
  ownerSub: string,
  upload: AudioUpload,
  deps: SpeakerRouteDependencies,
  guest: boolean,
  rememberSpeakers: boolean,
): Promise<Record<string, unknown>> {
  let result = await processWithFallback(
    deps.orchestrator, ownerSub, upload, rememberSpeakers && !guest,
  );
  if (upload.purpose === 'self_enrollment') {
    result = await finishSelfEnrollment(deps.store, ownerSub, result);
  }
  const stored = upload.purpose === 'self_enrollment' || result.turns.length === 0
    ? { accepted: 0, duplicates: 0, segments: [] }
    : await persistAttributedSegments(
      deps.ambient, ownerSub, attributedSegments(upload, result),
      upload.purpose === 'recording_import' ? 'recording_import' : 'ambient',
    );
  const profiles = guest ? [] : await deps.store.listProfiles(ownerSub);
  return audioResponse(upload, result, stored, profiles);
}

async function releaseFailedAudioClaim(
  ambient: AmbientSpeakerService,
  ownerSub: string,
  clientChunkId: string,
  claimToken: string,
): Promise<void> {
  try {
    await ambient.releaseAudioChunk(ownerSub, clientChunkId, claimToken);
  } catch (error) {
    logger.error({ err: error, clientChunkId }, 'Failed to release audio claim after processing error');
  }
}

function duplicateAudioResponse(
  upload: AudioUpload,
  profiles: SpeakerProfile[],
): Record<string, unknown> {
  return {
    purpose: upload.purpose, clientChunkId: upload.clientChunkId, duplicate: true,
    receiptStatus: 'completed',
    processing: { status: 'complete', transcription: 'unavailable', diarization: 'unavailable' },
    source: 'sidecar_only', model: null, sttProviderId: null, durationSeconds: null,
    timeline: [], accepted: 0, duplicates: 1, segments: [], profiles: serializeProfiles(profiles),
  };
}

async function persistAttributedSegments(
  ambient: AmbientSpeakerService,
  ownerSub: string,
  segments: AmbientAttributedSegmentInput[],
  mode: 'ambient' | 'recording_import',
) {
  const aggregate = { accepted: 0, duplicates: 0, segments: [] as AmbientTranscriptSegment[] };
  for (let offset = 0; offset < segments.length; offset += 100) {
    const result = await ambient.appendAttributedSegments(
      ownerSub, segments.slice(offset, offset + 100), mode,
    );
    aggregate.accepted += result.accepted;
    aggregate.duplicates += result.duplicates;
    aggregate.segments.push(...result.segments);
  }
  return aggregate;
}

function audioResponse(
  upload: AudioUpload,
  result: SpeakerAudioResult,
  stored: { accepted: number; duplicates: number; segments: AmbientTranscriptSegment[] },
  profiles: SpeakerProfile[],
): Record<string, unknown> {
  return {
    purpose: upload.purpose, clientChunkId: upload.clientChunkId,
    duplicate: false, receiptStatus: 'completed',
    processing: result.processing, source: result.source, model: result.model,
    sttProviderId: result.sttProviderId, durationSeconds: result.durationSeconds,
    timeline: result.timeline, accepted: stored.accepted, duplicates: stored.duplicates,
    segments: stored.segments.map(serializeSegment), profiles: serializeProfiles(profiles),
  };
}

interface AudioUpload {
  audio: Buffer;
  mimeType: string;
  purpose: SpeakerAudioPurpose;
  clientChunkId: string;
  capturedAt: Date;
  endedAt: Date;
  clientTranscript: string | null;
}

type SpeakerHandler = (
  req: Request,
  res: Parameters<RequestHandler>[1],
  userSub: string,
) => Promise<void>;

function speakerRoute(operation: string, handler: SpeakerHandler): RequestHandler {
  return async (req, res) => {
    const startedAt = Date.now();
    const sub = callerSub(req);
    logger.info({ operation, method: req.method }, 'Ambient speaker route entered');
    if (!sub) { res.status(401).json({ error: 'sign_in_required' }); return; }
    try {
      await handler(req, res, sub);
      logger.info({ operation, status: res.statusCode, durationMs: Date.now() - startedAt }, 'Ambient speaker route completed');
    } catch (error) {
      logger.error({ err: error, operation, durationMs: Date.now() - startedAt }, 'Ambient speaker route failed');
      writeSpeakerError(res, error);
    }
  };
}

function createOrchestrator(store: SpeakerProfileStoreContract): SpeakerDiarizationOrchestrator {
  const voice = new VoiceService();
  return new SpeakerDiarizationOrchestrator(
    new SpeakerSidecarClient(),
    { transcribe: (audio, mimeType) => transcribeForDiarization(voice, audio, mimeType) },
    store,
  );
}

async function transcribeForDiarization(voice: VoiceService, audio: Buffer, mimeType: string) {
  if (!googleTimestampMimeSupported(mimeType)) {
    return {
      providerId: 'google-cloud-stt',
      fallback: 'failed' as const,
      message: `${mimeType} cannot be safely sent to timestamped Google STT`,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), speakerSttTimeoutMs());
  try {
    return await voice.transcribeAudio(audio, mimeType, {
      providerId: 'google-cloud-stt', enableSegments: true, signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function googleTimestampMimeSupported(mimeType: string): boolean {
  return /(?:wav|x-wav|webm|ogg|flac|mpeg|mp3|mpga|mp4|m4a|quicktime|amr|octet-stream)/i.test(mimeType);
}

function speakerSttTimeoutMs(): number {
  const value = Number(process.env.SPEAKER_STT_TIMEOUT_MS ?? 55_000);
  if (!Number.isFinite(value)) return 55_000;
  return Math.min(90_000, Math.max(5_000, Math.floor(value)));
}

function audioUpload(): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 6 },
    fileFilter: (_req, file, callback) => callback(
      null, file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream',
    ),
  }).single('audio');
  return (req, res, next) => upload(req, res, (error) => {
    if (!error) { next(); return; }
    logger.error({ err: error, operation: 'audioUpload' }, 'Ambient speaker upload rejected');
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'audio_too_large' : 'invalid_audio_upload',
      maxAudioBytes: MAX_AUDIO_BYTES,
    });
  });
}

function readAudioUpload(req: Request): AudioUpload {
  const file = req.file;
  if (!file?.buffer?.length) throw new SpeakerInputError('multipart field "audio" is required');
  const body = req.body as Record<string, unknown>;
  const purpose = String(body.purpose || '') as SpeakerAudioPurpose;
  if (!PURPOSES.has(purpose)) throw new SpeakerInputError('purpose must be ambient, recording_import, or self_enrollment');
  const capturedAt = requiredDate(body.capturedAt, 'capturedAt');
  const endedAt = requiredDate(body.endedAt, 'endedAt');
  const durationMs = endedAt.getTime() - capturedAt.getTime();
  const maximumSeconds = SPEAKER_AUDIO_MAX_SECONDS[purpose];
  if (durationMs <= 0 || durationMs > (maximumSeconds * 1_000) + METADATA_DURATION_JITTER_MS) {
    throw new SpeakerInputError(
      `${purpose} audio exceeds its ${maximumSeconds}-second nominal limit`, 'audio_duration_limit',
    );
  }
  return {
    audio: file.buffer,
    mimeType: file.mimetype,
    purpose,
    clientChunkId: requiredChunkId(body.clientChunkId),
    capturedAt,
    endedAt,
    clientTranscript: optionalTranscript(body.clientTranscript),
  };
}

async function processWithFallback(
  orchestrator: SpeakerDiarizationOrchestratorContract,
  ownerSub: string,
  upload: AudioUpload,
  rememberSpeakers: boolean,
): Promise<SpeakerAudioResult> {
  try {
    const result = await orchestrator.process(
      ownerSub, upload.audio, upload.mimeType, rememberSpeakers, upload.purpose, upload.clientChunkId,
    );
    if (result.processing.transcription === 'unavailable' && upload.clientTranscript
        && upload.purpose !== 'self_enrollment') {
      return withClientFallback(result, upload.clientTranscript, upload);
    }
    return result;
  } catch (error) {
    if (error instanceof SpeakerNoSpeechError) {
      if (upload.purpose === 'self_enrollment') {
        throw new SpeakerInputError(
          'self enrollment requires audible speech', 'self_enrollment_no_speech',
        );
      }
      if (upload.clientTranscript) return fallbackOnly(upload.clientTranscript, upload);
      return silentAudioResult(upload);
    }
    if (error instanceof SpeakerSidecarError && upload.clientTranscript && upload.purpose !== 'self_enrollment') {
      return fallbackOnly(upload.clientTranscript, upload);
    }
    throw error;
  }
}

function silentAudioResult(upload: AudioUpload): SpeakerAudioResult {
  return {
    source: 'sidecar_only',
    processing: { status: 'complete', transcription: 'unavailable', diarization: 'complete' },
    model: null,
    sttProviderId: null,
    durationSeconds: (upload.endedAt.getTime() - upload.capturedAt.getTime()) / 1_000,
    timeline: [],
    turns: [],
  };
}

async function finishSelfEnrollment(
  store: SpeakerProfileStoreContract,
  ownerSub: string,
  result: SpeakerAudioResult,
): Promise<SpeakerAudioResult> {
  const speakerKeys = new Set(result.timeline.map((turn) => turn.speakerKey));
  const profileIds = new Set(result.timeline.map((turn) => turn.profileId).filter((id): id is string => Boolean(id)));
  if (speakerKeys.size !== 1 || profileIds.size !== 1) {
    await cleanupCreatedEnrollmentProfiles(store, ownerSub, result);
    throw new SpeakerInputError('self enrollment requires exactly one usable speaker', 'self_enrollment_ambiguous');
  }
  const profileId = [...profileIds][0];
  const profile = await store.assignProfile(ownerSub, profileId, { kind: 'self' });
  if (!profile) throw new Error('self-enrollment profile disappeared before assignment');
  return relabelResult(result, profileId, profile.label);
}

async function cleanupCreatedEnrollmentProfiles(
  store: SpeakerProfileStoreContract,
  ownerSub: string,
  result: SpeakerAudioResult,
): Promise<void> {
  const ids = [...new Set(result.timeline
    .filter((turn) => turn.attribution === 'created' && turn.profileId)
    .map((turn) => turn.profileId as string))];
  const outcomes = await Promise.allSettled(ids.map((id) => store.deleteProfile(ownerSub, id)));
  outcomes.filter((outcome) => outcome.status === 'rejected').forEach((outcome) => {
    logger.error({ err: (outcome as PromiseRejectedResult).reason }, 'Failed to clean ambiguous enrollment profile');
  });
}

function withClientFallback(result: SpeakerAudioResult, text: string, upload: AudioUpload): SpeakerAudioResult {
  return {
    ...result,
    source: 'client_transcript_fallback',
    processing: { ...result.processing, status: 'degraded', transcription: 'client_fallback' },
    turns: [{
      text,
      startTime: 0,
      endTime: (upload.endedAt.getTime() - upload.capturedAt.getTime()) / 1_000,
      profileId: null,
      ordinal: null,
      label: 'Speaker unavailable',
      similarity: null,
      attribution: 'unavailable',
      overlap: false,
    }],
  };
}

function fallbackOnly(text: string, upload: AudioUpload): SpeakerAudioResult {
  return withClientFallback({
    source: 'sidecar_only',
    processing: { status: 'degraded', transcription: 'unavailable', diarization: 'unavailable' },
    model: null,
    sttProviderId: null,
    durationSeconds: null,
    timeline: [],
    turns: [],
  }, text, upload);
}

function attributedSegments(upload: AudioUpload, result: SpeakerAudioResult): AmbientAttributedSegmentInput[] {
  const authoritativeEnd = result.durationSeconds === null
    ? upload.endedAt
    : new Date(upload.capturedAt.getTime() + (result.durationSeconds * 1_000));
  return result.turns.map((turn, index) => ({
    text: turn.text,
    capturedAt: offsetDate(upload.capturedAt, turn.startTime, authoritativeEnd),
    endedAt: offsetDate(upload.capturedAt, turn.endTime, authoritativeEnd),
    speakerLabel: persistedSpeakerLabel(turn.profileId, turn.ordinal, turn.label),
    speakerProfileId: turn.profileId,
    wakePhraseDetected: false,
    matchedWakePhrase: null,
    sessionId: `audio:${upload.clientChunkId}`,
    clientSegmentId: `${upload.clientChunkId}:${index}`,
  }));
}

function persistedSpeakerLabel(
  profileId: string | null,
  ordinal: number | null,
  transientLabel: string,
): string {
  if (!profileId) return transientLabel;
  return ordinal ? `Unidentified Person ${ordinal}` : 'Unidentified Speaker';
}

function offsetDate(start: Date, seconds: number, maximum: Date): Date {
  const value = new Date(start.getTime() + Math.max(0, seconds) * 1_000);
  return value > maximum ? maximum : value;
}

function relabelResult(result: SpeakerAudioResult, profileId: string, label: string): SpeakerAudioResult {
  return {
    ...result,
    timeline: result.timeline.map((turn) => turn.profileId === profileId ? { ...turn, label } : turn),
    turns: result.turns.map((turn) => turn.profileId === profileId ? { ...turn, label } : turn),
  };
}

function readAssignment(body: unknown): SpeakerAssignmentInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SpeakerInputError('assignment must be an object');
  const value = body as Record<string, unknown>;
  const kind = String(value.kind || '');
  if (!['self', 'custom', 'tenant_member', 'unassigned'].includes(kind)) {
    throw new SpeakerInputError('assignment kind must be self, custom, tenant_member, or unassigned');
  }
  return {
    kind: kind as SpeakerAssignmentInput['kind'],
    customName: typeof value.customName === 'string' ? value.customName : null,
    tenantId: optionalUuid(value.tenantId, 'tenantId'),
    memberSub: typeof value.memberSub === 'string' ? value.memberSub.trim() : null,
  };
}

function writeSpeakerError(res: Parameters<RequestHandler>[1], error: unknown): void {
  if (error instanceof SpeakerInputError || error instanceof AmbientInputError) {
    res.status(400).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof SpeakerAuthorizationError) {
    res.status(403).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof SpeakerAudioInProgressError) {
    res.setHeader('Retry-After', '2');
    res.status(409).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AmbientOwnerLockBusyError) {
    res.setHeader('Retry-After', '2');
    res.status(409).json({ error: 'speaker_owner_audio_busy', message: error.message });
    return;
  }
  if (error instanceof AmbientModeDisabledError) {
    res.status(409).json({ error: 'ambient_not_enabled', message: error.message });
    return;
  }
  if (error instanceof SpeakerSidecarError) {
    res.status(503).json({ error: error.code, message: error.message });
    return;
  }
  res.status(500).json({ error: 'speaker_service_unavailable' });
}

function denyGuestPersistence(req: Request): void {
  if (isGuestRequest(req)) {
    throw new SpeakerAuthorizationError('remembered speaker profiles are unavailable in the public tenant', 'public_tenant_profile_forbidden');
  }
}

function assertAudioPurposeEnabled(
  purpose: SpeakerAudioPurpose,
  ambientEnabled: boolean,
  diarizationEnabled: boolean,
): void {
  if (purpose !== 'ambient') return;
  if (!ambientEnabled) throw new AmbientModeDisabledError();
  if (!diarizationEnabled) {
    throw new SpeakerAuthorizationError('speaker diarization is disabled in ambient settings', 'speaker_diarization_disabled');
  }
}

function callerSub(req: Request): string | null {
  const user = (req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return user?.sub ? String(user.sub) : null;
}

function callerDisplayName(req: Request): string | null {
  const user = (req as Request & {
    oidc?: { user?: { sub?: string; name?: string; preferred_username?: string; email?: string } };
  }).oidc?.user;
  const candidates = [user?.name, user?.preferred_username, user?.email];
  const value = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (!value || value.trim() === user?.sub) return null;
  const displayName = value.trim().replace(/\s+/g, ' ');
  return displayName.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(displayName) ? displayName : null;
}

function profileId(req: Request): string {
  return requiredUuid(req.params.profileId, 'profileId');
}

function requiredUuid(value: unknown, field: string): string {
  const uuid = optionalUuid(value, field);
  if (!uuid) throw new SpeakerInputError(`${field} is required`);
  return uuid;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const uuid = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw new SpeakerInputError(`${field} must be a UUID`);
  }
  return uuid;
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' && typeof value !== 'number') throw new SpeakerInputError(`${field} is required`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new SpeakerInputError(`${field} must be an ISO timestamp`);
  return date;
}

function requiredChunkId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new SpeakerInputError('clientChunkId must contain 1-100 safe identifier characters');
  }
  return id;
}

function optionalTranscript(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new SpeakerInputError('clientTranscript must be text');
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > MAX_TRANSCRIPT_CHARS) {
    throw new SpeakerInputError(`clientTranscript must contain 1-${MAX_TRANSCRIPT_CHARS} characters`);
  }
  return text;
}

function publicSpeakerContext(userSub = '', displayName: string | null = null) {
  return {
    available: false,
    voiceProfilesAvailable: false,
    guest: true,
    tenantMemberAssignmentAvailable: false,
    reason: 'public_tenant' as const,
    selectedTenantId: null,
    organizations: [],
    members: [],
    currentUser: { userSub, displayName: displayName || 'You', profileId: null },
    unavailableMemberCount: 0,
  };
}

function serializeProfiles(profiles: SpeakerProfile[]): Array<Record<string, unknown>> {
  return profiles.map(serializeProfile);
}

function serializeProfile(profile: SpeakerProfile): Record<string, unknown> {
  return {
    ...profile,
    excerpts: profile.excerpts.map((excerpt) => ({
      text: excerpt.text,
      capturedAt: excerpt.capturedAt.toISOString(),
    })),
    firstSeenAt: profile.firstSeenAt.toISOString(),
    lastSeenAt: profile.lastSeenAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function serializeSegment(segment: AmbientTranscriptSegment) {
  return {
    ...segment,
    capturedAt: segment.capturedAt.toISOString(),
    endedAt: segment.endedAt?.toISOString() ?? null,
    createdAt: segment.createdAt.toISOString(),
  };
}
