/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added public-tenant gating, multipart contract, trusted persistence, fallback provenance, self-enrollment, and memory clearing route coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Covered failed-claim retry, in-progress conflict, and completed lost-response acknowledgement.
 */

import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as nodeRequest } from 'node:http';
import {
  createAmbientSpeakerRoutes,
  type AmbientSpeakerRouteOptions,
} from '../../src/app/routes/ambient-speaker-routes';
import {
  SpeakerSidecarError,
  SpeakerNoSpeechError,
  type SpeakerAudioResult,
  type SpeakerProfile,
  type SpeakerProfileStoreContract,
} from '../../src/features/speaker-diarization';
import type {
  AmbientAttributedSegmentInput,
  AmbientSettings,
  AmbientTranscriptSegment,
} from '../../src/features/ambient-listening';

const NOW = new Date('2026-07-09T23:00:00.000Z');
const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const ORIGINAL_ACTIVE_UPLOADS = process.env.SPEAKER_MAX_ACTIVE_UPLOADS;
const ORIGINAL_OWNER_RATE = process.env.SPEAKER_MAX_UPLOADS_PER_OWNER_MINUTE;

describe('ambient speaker routes', () => {
  const servers: Array<{ close: (callback: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
    restoreEnv('SPEAKER_MAX_ACTIVE_UPLOADS', ORIGINAL_ACTIVE_UPLOADS);
    restoreEnv('SPEAKER_MAX_UPLOADS_PER_OWNER_MINUTE', ORIGINAL_OWNER_RATE);
  });

  it('hides private organization context and profile persistence from a guest', async () => {
    const fixture = await startFixture(servers);
    const context = await fetch(`${fixture.baseUrl}/api/jarvis/ambient/speaker-context`, {
      headers: { 'x-test-sub': 'guest-1', 'x-test-guest': 'true' },
    });
    const assignment = await fetch(`${fixture.baseUrl}/api/jarvis/ambient/speakers/${PROFILE_ID}/assignment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-sub': 'guest-1', 'x-test-guest': 'true' },
      body: JSON.stringify({ kind: 'custom', customName: 'Alice' }),
    });

    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ context: {
      available: false, voiceProfilesAvailable: false, guest: true, reason: 'public_tenant',
      currentUser: { userSub: 'guest-1', displayName: 'You', profileId: null },
    } });
    expect(assignment.status).toBe(403);
  });

  it('returns retained text context for recognizing an owner-private speaker profile', async () => {
    const fixture = await startFixture(servers);

    const response = await fetch(`${fixture.baseUrl}/api/jarvis/ambient/speakers`, {
      headers: { 'x-test-sub': 'auth0|owner-a' },
    });
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.profiles[0]).toMatchObject({
      segmentCount: 1,
      excerpts: [{ text: 'Please remind me about the dentist.', capturedAt: NOW.toISOString() }],
    });
  });

  it('accepts the pinned multipart contract, persists trusted attribution, and clears audio memory', async () => {
    let receivedBuffer: Buffer | null = null;
    const orchestrator = {
      process: vi.fn(async (_sub, audio: Buffer) => {
        receivedBuffer = audio;
        const assigned = attributedResult();
        assigned.timeline[0].label = 'Sam Carter';
        assigned.turns[0].label = 'Sam Carter';
        return assigned;
      }),
    };
    const fixture = await startFixture(servers, { orchestrator });
    const response = await postAudio(fixture.baseUrl, { purpose: 'ambient' });
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ accepted: 1, source: 'sidecar_and_stt' });
    expect(body.timeline[0].label).toBe('Sam Carter');
    expect(fixture.appended[0][0]).toMatchObject({ speakerProfileId: PROFILE_ID, speakerLabel: 'Unidentified Person 1' });
    expect(orchestrator.process).toHaveBeenCalledWith(
      'auth0|owner-a', expect.any(Buffer), 'audio/webm', true, 'ambient', 'chunk-1',
    );
    expect(receivedBuffer && [...receivedBuffer].every((byte) => byte === 0)).toBe(true);
  });

  it('uses client transcript only after sidecar failure and persists unavailable attribution', async () => {
    const fixture = await startFixture(servers, {
      orchestrator: { process: vi.fn(async () => { throw new SpeakerSidecarError('offline'); }) },
    });
    const response = await postAudio(fixture.baseUrl, {
      purpose: 'ambient',
      clientTranscript: 'Fallback words from the browser.',
    });
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      source: 'client_transcript_fallback',
      processing: { status: 'degraded', transcription: 'client_fallback', diarization: 'unavailable' },
    });
    expect(fixture.appended[0][0]).toMatchObject({
      text: 'Fallback words from the browser.', speakerProfileId: null, speakerLabel: 'Speaker unavailable',
    });
  });

  it('treats a quiet ambient chunk as a successful no-op', async () => {
    const ambientService = fakeAmbientService([]);
    const append = vi.spyOn(ambientService, 'appendAttributedSegments');
    const fixture = await startFixture(servers, {
      ambientService,
      orchestrator: { process: vi.fn(async () => { throw new SpeakerNoSpeechError(); }) },
    });

    const response = await postAudio(fixture.baseUrl, { purpose: 'ambient' });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ accepted: 0, timeline: [], segments: [] });
    expect(append).not.toHaveBeenCalled();
  });

  it('preserves a browser transcript when the diarizer finds no speaker turns', async () => {
    const fixture = await startFixture(servers, {
      orchestrator: { process: vi.fn(async () => { throw new SpeakerNoSpeechError(); }) },
    });

    const response = await postAudio(fixture.baseUrl, {
      purpose: 'ambient', clientTranscript: 'Browser heard useful words.',
    });

    expect(response.status).toBe(201);
    expect(fixture.appended[0][0]).toMatchObject({
      text: 'Browser heard useful words.', speakerProfileId: null,
    });
  });

  it('acknowledges a completed retry after a lost response without biasing profiles', async () => {
    const processAudio = vi.fn(async () => attributedResult());
    const fixture = await startFixture(servers, { orchestrator: { process: processAudio } });

    const first = await postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'same-chunk' });
    const firstBody = await first.json();
    const retry = await postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'same-chunk' });

    expect(first.status).toBe(201);
    expect(firstBody).toMatchObject({ duplicate: false, receiptStatus: 'completed', accepted: 1 });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({
      duplicate: true, receiptStatus: 'completed', accepted: 0, duplicates: 1,
    });
    expect(processAudio).toHaveBeenCalledOnce();
  });

  it('releases a failed claim so the same client chunk can be processed on retry', async () => {
    const processAudio = vi.fn()
      .mockRejectedValueOnce(new Error('transient processor failure'))
      .mockResolvedValueOnce(attributedResult());
    const fixture = await startFixture(servers, { orchestrator: { process: processAudio } });

    const failed = await postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'retry-me' });
    const retried = await postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'retry-me' });

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ duplicate: false, accepted: 1 });
    expect(processAudio).toHaveBeenCalledTimes(2);
  });

  it('returns a retryable conflict while an identical receipt is still processing', async () => {
    const ambientService = fakeAmbientService([]);
    vi.spyOn(ambientService, 'claimAudioChunk').mockResolvedValue({ state: 'in_progress' });
    const processAudio = vi.fn(async () => attributedResult());
    const fixture = await startFixture(servers, {
      ambientService, orchestrator: { process: processAudio },
    });

    const response = await postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'busy' });

    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toMatchObject({ error: 'speaker_audio_in_progress' });
    expect(processAudio).not.toHaveBeenCalled();
  });

  it('keeps a completion-failed receipt in progress until its bounded recovery lease', async () => {
    const ambientService = fakeAmbientService([]);
    vi.spyOn(ambientService, 'completeAudioChunk').mockRejectedValue(new Error('database unavailable'));
    const processAudio = vi.fn(async () => attributedResult());
    const fixture = await startFixture(servers, {
      ambientService, orchestrator: { process: processAudio },
    });

    const first = await postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'fenced' });
    const retry = await postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'fenced' });

    expect(first.status).toBe(500);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: 'speaker_audio_in_progress' });
    expect(processAudio).toHaveBeenCalledOnce();
  });

  it('assigns exactly one enrollment profile as self without persisting transcript text', async () => {
    const store = fakeStore();
    const assign = vi.spyOn(store, 'assignProfile');
    const ambientService = fakeAmbientService([]);
    const append = vi.spyOn(ambientService, 'appendAttributedSegments');
    const fixture = await startFixture(servers, {
      store,
      ambientService,
      orchestrator: { process: vi.fn(async () => enrollmentResult()) },
    });
    const response = await postAudio(fixture.baseUrl, { purpose: 'self_enrollment' });
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(201);
    expect(assign).toHaveBeenCalledWith('auth0|owner-a', PROFILE_ID, { kind: 'self' });
    expect(append).not.toHaveBeenCalled();
    expect(body).toMatchObject({ accepted: 0, timeline: [{ label: 'You' }] });
  });

  it('uses decoded duration for import timestamps when client media metadata reports one second', async () => {
    const result = attributedResult();
    result.durationSeconds = 5;
    result.timeline[0].endTime = 5;
    result.turns[0].endTime = 5;
    const fixture = await startFixture(servers, {
      orchestrator: { process: async () => result },
    });

    const response = await postAudio(fixture.baseUrl, {
      purpose: 'recording_import', endedAt: '2026-07-09T23:00:01.000Z',
    });

    expect(response.status).toBe(201);
    expect(fixture.appended[0][0].endedAt?.toISOString()).toBe('2026-07-09T23:00:05.000Z');
  });

  it('allows bounded recorder-stop metadata jitter while decoded duration stays strict', async () => {
    const fixture = await startFixture(servers);

    const jittered = await postAudio(fixture.baseUrl, {
      purpose: 'ambient', clientChunkId: 'jitter-ok', endedAt: '2026-07-09T23:00:21.500Z',
    });
    const excessive = await postAudio(fixture.baseUrl, {
      purpose: 'ambient', clientChunkId: 'jitter-too-far', endedAt: '2026-07-09T23:00:22.001Z',
    });

    expect(jittered.status).toBe(201);
    expect(excessive.status).toBe(400);
    expect(await excessive.json()).toMatchObject({ error: 'audio_duration_limit' });
  });

  it('persists an explicit recording import while continuous ambient capture is off', async () => {
    const ambientService = fakeAmbientService([], {
      ambientEnabled: false, speakerDiarizationEnabled: false, rememberSpeakers: false,
    });
    const append = vi.spyOn(ambientService, 'appendAttributedSegments');
    const fixture = await startFixture(servers, { ambientService });

    const response = await postAudio(fixture.baseUrl, { purpose: 'recording_import' });

    expect(response.status).toBe(201);
    expect(append).toHaveBeenCalledWith(
      'auth0|owner-a', expect.any(Array), 'recording_import',
    );
  });

  it('rejects concurrent owner/global uploads before buffering another multipart body', async () => {
    process.env.SPEAKER_MAX_ACTIVE_UPLOADS = '1';
    let release!: (value: SpeakerAudioResult) => void;
    const processAudio = vi.fn()
      .mockImplementationOnce(() => new Promise<SpeakerAudioResult>((resolve) => { release = resolve; }))
      .mockResolvedValue(attributedResult());
    const fixture = await startFixture(servers, { orchestrator: { process: processAudio } });
    const first = postAudio(fixture.baseUrl, { purpose: 'ambient', clientChunkId: 'held' });
    await vi.waitFor(() => expect(processAudio).toHaveBeenCalledOnce());

    const sameOwner = await postAudio(fixture.baseUrl, {
      purpose: 'ambient', clientChunkId: 'same-owner', ownerSub: 'auth0|owner-a',
    });
    const otherOwner = await postAudio(fixture.baseUrl, {
      purpose: 'ambient', clientChunkId: 'other-owner', ownerSub: 'auth0|owner-b',
    });
    release(attributedResult());

    expect(sameOwner.status).toBe(429);
    expect(await sameOwner.json()).toMatchObject({ error: 'speaker_owner_audio_busy' });
    expect(otherOwner.status).toBe(429);
    expect(await otherOwner.json()).toMatchObject({ error: 'speaker_audio_capacity_reached' });
    expect((await first).status).toBe(201);
  });

  it('holds the admission slot after a client closes until bounded processing settles', async () => {
    process.env.SPEAKER_MAX_ACTIVE_UPLOADS = '1';
    let release!: (value: SpeakerAudioResult) => void;
    const processAudio = vi.fn()
      .mockImplementationOnce(() => new Promise<SpeakerAudioResult>((resolve) => { release = resolve; }))
      .mockResolvedValue(attributedResult());
    const ambientService = fakeAmbientService([]);
    const completed = vi.spyOn(ambientService, 'completeAudioChunk');
    const fixture = await startFixture(servers, {
      ambientService, orchestrator: { process: processAudio },
    });
    const client = startCloseableAudioUpload(fixture.baseUrl, 'closed-client');
    await vi.waitFor(() => expect(processAudio).toHaveBeenCalledOnce());
    client.destroy();

    const whileRunning = await postAudioWithNode(
      fixture.baseUrl, 'after-close', 'auth0|owner-b',
    );
    expect(whileRunning).toBe(429);

    release(attributedResult());
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterSettled = await postAudioWithNode(
      fixture.baseUrl, 'after-settled', 'auth0|owner-b',
    );
    expect(afterSettled).toBe(201);
  });

  it('rate-limits sequential owner uploads and enforces the 7 MiB preflight cap', async () => {
    process.env.SPEAKER_MAX_UPLOADS_PER_OWNER_MINUTE = '3';
    const fixture = await startFixture(servers);
    for (let index = 0; index < 3; index += 1) {
      const response = await postAudio(fixture.baseUrl, {
        purpose: 'ambient', clientChunkId: `rate-${index}`,
      });
      expect(response.status).toBe(201);
    }
    const limited = await postAudio(fixture.baseUrl, {
      purpose: 'ambient', clientChunkId: 'rate-limited',
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'speaker_audio_rate_limited' });

    const separate = await startFixture(servers);
    const tooLarge = await postAudio(separate.baseUrl, {
      purpose: 'ambient', clientChunkId: 'too-large', audioBytes: (7 * 1024 * 1024) + 1,
    });
    expect(tooLarge.status).toBe(413);
  });
});

async function startFixture(
  servers: Array<{ close: (callback: () => void) => void }>,
  overrides: AmbientSpeakerRouteOptions = {},
) {
  const appended: AmbientAttributedSegmentInput[][] = [];
  const ambientService = overrides.ambientService ?? fakeAmbientService(appended);
  const options: AmbientSpeakerRouteOptions = {
    store: overrides.store ?? fakeStore(),
    orchestrator: overrides.orchestrator ?? { process: async () => attributedResult() },
    ambientService,
  };
  const app = express();
  app.use(express.json());
  app.use(testIdentity());
  app.use('/api/jarvis/ambient', createAmbientSpeakerRoutes({ pool: fakeLockPool() as never }, options));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, appended };
}

function fakeAmbientService(
  appended: AmbientAttributedSegmentInput[][],
  patch: Partial<AmbientSettings> = {},
) {
  const chunkStates = new Map<string, { status: 'processing' | 'completed'; claimToken: string }>();
  let claimSequence = 0;
  const settings: AmbientSettings = {
    assistantName: 'Jarvis', wakePhrases: ['hey jarvis'], ambientEnabled: true,
    transcriptRetentionDays: 30, timeZone: 'America/Chicago', dailyReviewEnabled: true,
    dailyReviewTime: '21:00', suggestFollowUps: true, speakerDiarizationEnabled: true,
    rememberSpeakers: true, speakerTenantId: null, updatedAt: NOW,
    ...patch,
  };
  return {
    getSettings: async () => settings,
    claimAudioChunk: async (sub: string, clientChunkId: string) => {
      const key = `${sub}:${clientChunkId}`;
      const receipt = chunkStates.get(key);
      if (receipt?.status === 'completed') return { state: 'completed' as const };
      if (receipt?.status === 'processing') return { state: 'in_progress' as const };
      claimSequence += 1;
      const claimToken = `claim-${claimSequence}`;
      chunkStates.set(key, { status: 'processing', claimToken });
      return { state: 'claimed' as const, claimToken };
    },
    completeAudioChunk: async (sub: string, clientChunkId: string, claimToken: string) => {
      const key = `${sub}:${clientChunkId}`;
      if (chunkStates.get(key)?.claimToken === claimToken) {
        chunkStates.set(key, { status: 'completed', claimToken });
      }
    },
    releaseAudioChunk: async (sub: string, clientChunkId: string, claimToken: string) => {
      const key = `${sub}:${clientChunkId}`;
      if (chunkStates.get(key)?.claimToken === claimToken) chunkStates.delete(key);
    },
    appendAttributedSegments: async (_sub: string, segments: AmbientAttributedSegmentInput[]) => {
      appended.push(segments);
      return {
        accepted: segments.length,
        duplicates: 0,
        segments: segments.map((segment, index) => storedSegment(segment, index)),
      };
    },
  };
}

function fakeStore(): SpeakerProfileStoreContract {
  let current = profile();
  return {
    listProfiles: async () => [current],
    identify: async () => ({ profile: current, similarity: 1, created: false }),
    assignProfile: async (_sub, id, input) => {
      if (id !== PROFILE_ID) return null;
      current = { ...current, label: input.kind === 'self' ? 'You' : current.label, assignment: {
        kind: input.kind, customName: input.customName ?? null,
        tenantId: input.tenantId ?? null, memberSub: input.memberSub ?? null,
      } };
      return current;
    },
    mergeProfiles: async () => current,
    deleteProfile: async () => true,
    speakerContext: async () => ({
      available: true,
      voiceProfilesAvailable: true,
      guest: false,
      tenantMemberAssignmentAvailable: false,
      reason: 'private_org_available',
      selectedTenantId: '00000000-0000-4000-8000-000000000099',
      organizations: [],
      members: [],
      currentUser: { userSub: 'auth0|owner-a', displayName: 'You', profileId: PROFILE_ID },
      unavailableMemberCount: 0,
    }),
  };
}

function fakeLockPool() {
  const client = {
    query: async (sql: string) => ({
      rows: sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [{ pg_advisory_unlock: true }],
    }),
    release: () => undefined,
  };
  return { connect: async () => client };
}

function attributedResult(): SpeakerAudioResult {
  return {
    source: 'sidecar_and_stt',
    processing: { status: 'complete', transcription: 'provider', diarization: 'complete' },
    model: 'pyannote-v1', sttProviderId: 'google-cloud-stt', durationSeconds: 2,
    timeline: [{
      turnIndex: 0, speakerKey: 'SPEAKER_00', startTime: 0, endTime: 2, overlap: false,
      profileId: PROFILE_ID, ordinal: 1, label: 'Unidentified Person 1', attribution: 'created',
    }],
    turns: [{
      text: 'Hello there.', startTime: 0, endTime: 2, profileId: PROFILE_ID, ordinal: 1,
      label: 'Unidentified Person 1', similarity: 1, attribution: 'created', overlap: false,
    }],
  };
}

function enrollmentResult(): SpeakerAudioResult {
  const result = attributedResult();
  return {
    ...result,
    source: 'sidecar_only',
    sttProviderId: null,
    processing: { status: 'complete', transcription: 'unavailable', diarization: 'complete' },
    turns: [],
  };
}

function profile(): SpeakerProfile {
  return {
    profileId: PROFILE_ID, ordinal: 1, label: 'Unidentified Person 1',
    assignment: { kind: 'unassigned', customName: null, tenantId: null, memberSub: null },
    embeddingModel: 'pyannote-v1', sampleCount: 1, segmentCount: 1,
    excerpts: [{ text: 'Please remind me about the dentist.', capturedAt: NOW }],
    firstSeenAt: NOW, lastSeenAt: NOW, updatedAt: NOW,
  };
}

function storedSegment(segment: AmbientAttributedSegmentInput, index: number): AmbientTranscriptSegment {
  return { ...segment, segmentId: `segment-${index}`, createdAt: NOW };
}

function testIdentity() {
  return (req: Request, _res: ExpressResponse, next: NextFunction) => {
    const sub = req.header('x-test-sub');
    if (sub) {
      (req as Request & { oidc?: unknown }).oidc = {
        user: { sub, is_guest: req.header('x-test-guest') === 'true' },
      };
    }
    next();
  };
}

async function postAudio(
  baseUrl: string,
  options: {
    purpose: string;
    clientTranscript?: string;
    endedAt?: string;
    clientChunkId?: string;
    ownerSub?: string;
    audioBytes?: number;
  },
): Promise<Response> {
  const form = new FormData();
  const audio = options.audioBytes ? Buffer.alloc(options.audioBytes) : Buffer.from('not-real-audio');
  form.append('audio', new Blob([audio], { type: 'audio/webm' }), 'chunk.webm');
  form.append('purpose', options.purpose);
  form.append('clientChunkId', options.clientChunkId ?? 'chunk-1');
  form.append('capturedAt', '2026-07-09T23:00:00.000Z');
  form.append('endedAt', options.endedAt ?? '2026-07-09T23:00:02.000Z');
  if (options.clientTranscript) form.append('clientTranscript', options.clientTranscript);
  return fetch(`${baseUrl}/api/jarvis/ambient/audio`, {
    method: 'POST', headers: { 'x-test-sub': options.ownerSub ?? 'auth0|owner-a' },
    body: form,
  });
}

function startCloseableAudioUpload(baseUrl: string, clientChunkId: string) {
  const boundary = 'oshal-speaker-test-boundary';
  const body = multipartAudioBody(boundary, clientChunkId);
  const target = new URL('/api/jarvis/ambient/audio', baseUrl);
  const request = nodeRequest(target, {
    method: 'POST', agent: false,
    headers: {
      'x-test-sub': 'auth0|owner-a',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  });
  request.on('error', () => undefined);
  request.end(body);
  return request;
}

function postAudioWithNode(baseUrl: string, clientChunkId: string, ownerSub: string): Promise<number> {
  const boundary = `oshal-speaker-test-${clientChunkId}`;
  const body = multipartAudioBody(boundary, clientChunkId);
  const target = new URL('/api/jarvis/ambient/audio', baseUrl);
  return new Promise((resolve, reject) => {
    const request = nodeRequest(target, {
      method: 'POST', agent: false,
      headers: {
        'x-test-sub': ownerSub,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode || 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function multipartAudioBody(boundary: string, clientChunkId: string): Buffer {
  const fields = [
    ['purpose', 'ambient'],
    ['clientChunkId', clientChunkId],
    ['capturedAt', '2026-07-09T23:00:00.000Z'],
    ['endedAt', '2026-07-09T23:00:02.000Z'],
  ].map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('');
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="chunk.webm"\r\n`
    + `Content-Type: audio/webm\r\n\r\nnot-real-audio\r\n${fields}--${boundary}--\r\n`,
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
