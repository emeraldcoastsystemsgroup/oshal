/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic matcher, ambiguity, owner-bound encryption, timeline/STT alignment, and enrollment privacy coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Covered the sidecar's explicit no-speech signal and safe tenant identity availability.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SPEAKER_MATCH_THRESHOLD,
  SpeakerDiarizationOrchestrator,
  SpeakerNoSpeechError,
  SpeakerProfileStore,
  SpeakerSidecarClient,
  cosineSpeakerSimilarity,
  decryptSpeakerEmbedding,
  encryptSpeakerEmbedding,
  isPrivateOrgMemberPair,
  moveSpeakerAssignment,
  normalizeSpeakerEmbedding,
  selectBestSpeakerMatch,
  shouldUpdateSpeakerCentroid,
  updateSpeakerCentroid,
  type SpeakerProfile,
  type SpeakerProfileStoreContract,
  type SpeakerSidecarResult,
} from '../../src/features/speaker-diarization';

const ORIGINAL_SECRET = process.env.SESSION_SECRET;
const ORIGINAL_PROFILE_SECRET = process.env.SPEAKER_PROFILE_SECRET;
const ORIGINAL_PREVIOUS_PROFILE_SECRET = process.env.SPEAKER_PROFILE_SECRET_PREVIOUS;
const ORIGINAL_SIDECAR_URL = process.env.SPEAKER_DIARIZATION_URL;
const ORIGINAL_SIDECAR_KEY = process.env.SPEAKER_SERVICE_KEY;
const ORIGINAL_SCHEMA_BOOTSTRAP = process.env.OSHAL_SCHEMA_BOOTSTRAP;

beforeEach(() => {
  process.env.SESSION_SECRET = 'speaker-tests-have-a-long-secret';
  delete process.env.SPEAKER_PROFILE_SECRET;
  delete process.env.SPEAKER_PROFILE_SECRET_PREVIOUS;
});
afterEach(() => {
  restoreEnv('SESSION_SECRET', ORIGINAL_SECRET);
  restoreEnv('SPEAKER_PROFILE_SECRET', ORIGINAL_PROFILE_SECRET);
  restoreEnv('SPEAKER_PROFILE_SECRET_PREVIOUS', ORIGINAL_PREVIOUS_PROFILE_SECRET);
  restoreEnv('SPEAKER_DIARIZATION_URL', ORIGINAL_SIDECAR_URL);
  restoreEnv('SPEAKER_SERVICE_KEY', ORIGINAL_SIDECAR_KEY);
  restoreEnv('OSHAL_SCHEMA_BOOTSTRAP', ORIGINAL_SCHEMA_BOOTSTRAP);
  vi.unstubAllGlobals();
});

describe('speaker sidecar contract', () => {
  it('authenticates and preserves an unembeddable short speaker timeline', async () => {
    process.env.SPEAKER_DIARIZATION_URL = 'http://speaker.test:8099';
    process.env.SPEAKER_SERVICE_KEY = 'speaker-service-secret';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      modelId: 'pyannote-v1', sampleRate: 16_000, durationSeconds: 0.4,
      turns: [{ turnIndex: 0, speakerKey: 'SPEAKER_00', startTime: 0, endTime: 0.4, overlap: false }],
      speakers: [{ speakerKey: 'SPEAKER_00', embedding: [], voicedSeconds: 0.4 }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SpeakerSidecarClient().diarize(Buffer.from('audio'), 'audio/webm');

    expect(result.speakers[0].embedding).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('http://speaker.test:8099/v1/diarize');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      'X-Speaker-Service-Key': 'speaker-service-secret',
    });
  });

  it('rejects a coercible numeric string from the sidecar', async () => {
    process.env.SPEAKER_DIARIZATION_URL = 'http://speaker.test:8099';
    process.env.SPEAKER_SERVICE_KEY = 'speaker-service-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      modelId: 'pyannote-v1', sampleRate: '16000', durationSeconds: 1,
      turns: [{ turnIndex: 0, speakerKey: 'SPEAKER_00', startTime: 0, endTime: 1, overlap: false }],
      speakers: [{ speakerKey: 'SPEAKER_00', embedding: [1, 0], voicedSeconds: 1 }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(new SpeakerSidecarClient().diarize(
      Buffer.from('audio'), 'audio/webm',
    )).rejects.toThrow('sampleRate is invalid');
  });

  it('rejects a string overlap flag instead of treating "false" as truthy', async () => {
    process.env.SPEAKER_DIARIZATION_URL = 'http://speaker.test:8099';
    process.env.SPEAKER_SERVICE_KEY = 'speaker-service-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      modelId: 'pyannote-v1', sampleRate: 16_000, durationSeconds: 1,
      turns: [{ turnIndex: 0, speakerKey: 'SPEAKER_00', startTime: 0, endTime: 1, overlap: 'false' }],
      speakers: [{ speakerKey: 'SPEAKER_00', embedding: [1, 0], voicedSeconds: 1 }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(new SpeakerSidecarClient().diarize(
      Buffer.from('audio'), 'audio/webm',
    )).rejects.toThrow('overlap is invalid');
  });

  it('maps the sidecar no-speech response to the expected non-failure signal', async () => {
    process.env.SPEAKER_DIARIZATION_URL = 'http://speaker.test:8099';
    process.env.SPEAKER_SERVICE_KEY = 'speaker-service-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'no_speech_detected', message: 'No voiced speech was detected.',
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })));

    const promise = new SpeakerSidecarClient().diarize(Buffer.from('quiet'), 'audio/webm');

    await expect(promise).rejects.toBeInstanceOf(SpeakerNoSpeechError);
    await expect(promise).rejects.toMatchObject({ code: 'no_speech_detected' });
  });
});

describe('deterministic speaker matcher', () => {
  it('normalizes, compares, and updates a centroid deterministically', () => {
    const left = normalizeSpeakerEmbedding([3, 4]);
    const right = normalizeSpeakerEmbedding([2.9, 4.1]);
    const updated = updateSpeakerCentroid(left, 2, right);

    expect(cosineSpeakerSimilarity(left, left)).toBeCloseTo(1, 8);
    expect(cosineSpeakerSimilarity(left, right)).toBeGreaterThan(SPEAKER_MATCH_THRESHOLD);
    expect(Math.hypot(...updated)).toBeCloseTo(1, 8);
    expect(shouldUpdateSpeakerCentroid(0.89)).toBe(false);
    expect(shouldUpdateSpeakerCentroid(0.90)).toBe(true);
  });

  it('refuses an ambiguous best match instead of choosing by stable id', () => {
    const sample = normalizeSpeakerEmbedding([1, 0.2, 0.1]);
    const result = selectBestSpeakerMatch(sample, [
      { id: 'a', embedding: normalizeSpeakerEmbedding([1, 0.19, 0.1]) },
      { id: 'b', embedding: normalizeSpeakerEmbedding([1, 0.21, 0.1]) },
    ], SPEAKER_MATCH_THRESHOLD);

    expect(result).toBeNull();
  });
});

describe('speaker embedding crypto', () => {
  it('round-trips only for the owning subject and never stores plaintext JSON', () => {
    const embedding = normalizeSpeakerEmbedding([0.3, -0.2, 0.8]);
    const envelope = encryptSpeakerEmbedding('auth0|owner-a', embedding);

    expect(envelope).toMatch(/^speaker-v2:[a-f0-9]{16}:/);
    expect(envelope).not.toContain(JSON.stringify(embedding));
    const decrypted = decryptSpeakerEmbedding('auth0|owner-a', envelope);
    decrypted.forEach((value, index) => expect(value).toBeCloseTo(embedding[index], 12));
    expect(() => decryptSpeakerEmbedding('auth0|owner-b', envelope)).toThrow();
  });

  it('decrypts with only the configured previous key during secret rotation', () => {
    process.env.SPEAKER_PROFILE_SECRET = 'speaker-profile-old-secret';
    const embedding = normalizeSpeakerEmbedding([0.7, 0.2, -0.1]);
    const envelope = encryptSpeakerEmbedding('auth0|owner-a', embedding);
    process.env.SPEAKER_PROFILE_SECRET = 'speaker-profile-new-secret';
    process.env.SPEAKER_PROFILE_SECRET_PREVIOUS = 'speaker-profile-old-secret';

    const decrypted = decryptSpeakerEmbedding('auth0|owner-a', envelope);

    decrypted.forEach((value, index) => expect(value).toBeCloseTo(embedding[index], 12));
  });

  it('durably rewraps owner profiles before the previous key is removed', async () => {
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'runtime';
    process.env.SPEAKER_PROFILE_SECRET = 'speaker-profile-old-secret';
    const oldEnvelope = encryptSpeakerEmbedding('auth0|owner-a', [0.7, 0.2, -0.1]);
    process.env.SPEAKER_PROFILE_SECRET = 'speaker-profile-new-secret';
    process.env.SPEAKER_PROFILE_SECRET_PREVIOUS = 'speaker-profile-old-secret';
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT profile_id,embedding_ciphertext FROM ambient_speaker_profiles')) {
        return { rows: [{ profile_id: 'profile-a', embedding_ciphertext: oldEnvelope }] };
      }
      if (sql.startsWith('SELECT p.*')) return { rows: [profileRow()] };
      return { rows: [], values };
    });
    const store = new SpeakerProfileStore({
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as never);

    await store.listProfiles('auth0|owner-a');
    const update = query.mock.calls.find(([sql]) => String(sql).includes(
      'UPDATE ambient_speaker_profiles SET embedding_ciphertext=$3',
    ));
    const currentEnvelope = String(update?.[1]?.[2]);
    delete process.env.SPEAKER_PROFILE_SECRET_PREVIOUS;

    expect(currentEnvelope).toMatch(/^speaker-v2:[a-f0-9]{16}:/);
    expect(currentEnvelope).not.toBe(oldEnvelope);
    expect(decryptSpeakerEmbedding('auth0|owner-a', currentEnvelope)).toHaveLength(3);
  });
});

describe('owner-private speaker recognition context', () => {
  it('replays one chunk speaker observation without applying the centroid update twice', async () => {
    const envelope = encryptSpeakerEmbedding('auth0|owner', normalizeSpeakerEmbedding([1, 0, 0]));
    let observationStored = false;
    let centroidUpdates = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT profile_id,similarity,created_profile FROM ambient_speaker_observations')) {
        return { rows: observationStored
          ? [{ profile_id: 'profile-a', similarity: 1, created_profile: false }] : [] };
      }
      if (sql.includes('SELECT profile_id,embedding_ciphertext,sample_count FROM ambient_speaker_profiles')) {
        return { rows: [{ profile_id: 'profile-a', embedding_ciphertext: envelope, sample_count: 1 }] };
      }
      if (sql.startsWith('SELECT embedding_ciphertext,sample_count')) {
        return { rows: [{ embedding_ciphertext: envelope, sample_count: 1 }] };
      }
      if (sql.includes('sample_count=sample_count+1')) {
        centroidUpdates += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT p.*')) return { rows: [profileRow()] };
      if (sql.includes('INSERT INTO ambient_speaker_observations')) observationStored = true;
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new SpeakerProfileStore({ connect: async () => client } as never);
    vi.spyOn(store as never, 'ensureSchema').mockResolvedValue(undefined);
    const observation = { clientChunkId: 'chunk-a', speakerKey: 'SPEAKER_00' };

    const first = await store.identify('auth0|owner', [1, 0, 0], 'pyannote-v1', observation);
    const retry = await store.identify('auth0|owner', [1, 0, 0], 'pyannote-v1', observation);

    expect(first.profile.profileId).toBe('profile-a');
    expect(retry.profile.profileId).toBe('profile-a');
    expect(centroidUpdates).toBe(1);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes(
      'INSERT INTO ambient_speaker_observations',
    ))).toHaveLength(1);
  });

  it('limits profile excerpts to retained owner text and maps safe context metadata', async () => {
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'runtime';
    const capturedAt = '2026-07-09T22:30:00.000Z';
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT p.*') ? [{
      ...profileRow(), profile_id: '00000000-0000-4000-8000-000000000001',
      sample_count: 4, segment_count: 7,
      assignment_kind: 'tenant_member', tenant_id: 'tenant-1', member_sub: 'auth0|wife',
      member_display_name: 'Sam Carter',
      excerpts: [{ text: 'Please remind me tomorrow.', capturedAt }],
      first_seen_at: capturedAt,
      last_seen_at: capturedAt,
      updated_at: capturedAt,
    }] : [] }));
    const store = new SpeakerProfileStore({ query } as never);

    const profiles = await store.listProfiles('auth0|owner-a');
    const select = query.mock.calls.find(([sql]) => String(sql).startsWith('SELECT p.*'))?.[0] as string;

    expect(profiles[0]).toMatchObject({
      label: 'Sam Carter',
      segmentCount: 7,
      excerpts: [{ text: 'Please remind me tomorrow.', capturedAt: new Date(capturedAt) }],
    });
    expect(select).toContain('segment.user_sub=p.owner_sub');
    expect(select).toContain('settings.transcript_retention_days');
    expect(select).toContain('LIMIT 2');
  });
});

describe('private organization member linking', () => {
  it('requires the caller and target in a kind=org membership query', async () => {
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));

    const allowed = await isPrivateOrgMemberPair(
      { query } as never, 'tenant-1', 'auth0|owner', 'auth0|target',
    );

    expect(allowed).toBe(true);
    expect(query.mock.calls[0][0]).toContain("t.kind='org'");
    expect(query.mock.calls[0][1]).toEqual(['tenant-1', 'auth0|owner', 'auth0|target']);
  });

  it('schema revokes member assignments when either owner or target leaves and stores no audio', () => {
    const migration = readFileSync('scripts/migrations/069-ambient-speakers.sql', 'utf8');

    expect(migration).toContain('ambient_speaker_assignment_owner_membership_fk');
    expect(migration).toContain('FOREIGN KEY (tenant_id, owner_sub)');
    expect(migration).toContain('FOREIGN KEY (tenant_id, member_sub)');
    expect(migration).toContain('ambient_speaker_one_self_per_owner');
    expect(migration).toContain('FOREIGN KEY (speaker_profile_id, user_sub)');
    expect(migration).toContain('REFERENCES ambient_speaker_profiles(profile_id, owner_sub)');
    expect(migration).toContain('ON DELETE SET NULL (speaker_profile_id)');
    expect(migration).toContain('ambient_settings_speaker_membership_fk');
    expect(migration).toContain('FOREIGN KEY (speaker_tenant_id, user_sub)');
    expect(migration).toContain('ON DELETE SET NULL (speaker_tenant_id)');
    expect(migration).not.toMatch(/audio_(?:bytes|blob|data)|raw_audio/i);
  });

  it('clear-all erases biometric profiles while retaining the never-reuse ordinal counter', () => {
    const service = readFileSync(
      'src/features/ambient-listening/services/ambient-listening-service.ts', 'utf8',
    );
    const clearHelper = service.slice(service.indexOf('async function clearSpeakerDataIfPresent'));

    expect(clearHelper).toContain("DELETE FROM ambient_speaker_profiles WHERE owner_sub=$1");
    expect(clearHelper).not.toContain('DELETE FROM ambient_speaker_ordinal_counters');
  });

  it('moves a source self assignment during merge instead of duplicating it', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    });

    await moveSpeakerAssignment(
      { query } as never, 'owner', 'target-profile', 'source-self-profile',
    );

    expect(calls[1].text).toContain('UPDATE ambient_speaker_assignments SET profile_id=$1');
    expect(calls[1].values).toEqual(['target-profile', 'source-self-profile', 'owner']);
    expect(calls.some((call) => call.text.includes('INSERT INTO ambient_speaker_assignments'))).toBe(false);
  });

  it('progressively records safe member names without using raw subjects as labels', async () => {
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'runtime';
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT t.tenant_id,t.name,m.role')) {
        return { rows: [{ tenant_id: 'tenant-1', name: 'Home', role: 'admin' }] };
      }
      if (sql.includes('SELECT target.user_sub,target.role,target.display_name')) {
        return { rows: [
          { user_sub: 'auth0|owner', role: 'admin', display_name: 'oshal maintainers' },
          { user_sub: 'auth0|wife', role: 'member', display_name: 'Sam Carter' },
          { user_sub: 'auth0|opaque-subject', role: 'member', display_name: null },
        ] };
      }
      return { rows: [], values };
    });
    const store = new SpeakerProfileStore({
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as never);

    const context = await store.speakerContext('auth0|owner', 'tenant-1', 'oshal maintainers');

    expect(context.tenantMemberAssignmentAvailable).toBe(true);
    expect(context.members.map((member) => ({
      displayName: member.displayName, identityAvailable: member.identityAvailable,
    }))).toEqual([
      { displayName: 'Sam Carter', identityAvailable: true },
    ]);
    expect(context.currentUser).toEqual({
      userSub: 'auth0|owner', displayName: 'oshal maintainers', profileId: null,
    });
    expect(context.unavailableMemberCount).toBe(1);
    expect(query.mock.calls.some(([sql, values]) => String(sql).includes(
      'UPDATE oshal_tenant_memberships SET display_name=$2',
    ) && values?.[1] === 'oshal maintainers')).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("tenant.kind='org'"))).toBe(true);
  });
});

describe('speaker audio orchestration', () => {
  it('rejects an overlong decoded recording before profile mutation while STT runs concurrently', async () => {
    const store = fakeStore();
    const transcribe = vi.fn();
    const sidecar = sidecarResult();
    sidecar.durationSeconds = 60;
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecar }, { transcribe }, store,
    );

    await expect(orchestrator.process(
      'owner', Buffer.from('audio'), 'audio/webm', true, 'recording_import',
    )).rejects.toThrow('decoded audio exceeds 55 seconds');
    expect(store.identify).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it('keeps explicit import diarization and STT concurrent', async () => {
    let resolveDiarization!: (value: SpeakerSidecarResult) => void;
    let resolveTranscription!: (value: { providerId: string; text: string }) => void;
    const diarize = vi.fn(() => new Promise<SpeakerSidecarResult>((resolve) => { resolveDiarization = resolve; }));
    const transcribe = vi.fn(() => new Promise<{ providerId: string; text: string }>((resolve) => {
      resolveTranscription = resolve;
    }));
    const orchestrator = new SpeakerDiarizationOrchestrator({ diarize }, { transcribe }, fakeStore());

    const pending = orchestrator.process(
      'owner', Buffer.from('audio'), 'audio/webm', false, 'recording_import',
    );
    await vi.waitFor(() => {
      expect(diarize).toHaveBeenCalledOnce();
      expect(transcribe).toHaveBeenCalledOnce();
    });
    resolveDiarization(sidecarResult());
    resolveTranscription({ providerId: 'whole-text', text: 'Concurrent text.' });

    await expect(pending).resolves.toMatchObject({ sttProviderId: 'whole-text' });
  });

  it('does not call cloud STT when ambient sidecar reports no speech', async () => {
    const transcribe = vi.fn();
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => { throw new SpeakerNoSpeechError(); } },
      { transcribe },
      fakeStore(),
    );

    await expect(orchestrator.process(
      'owner', Buffer.from('quiet'), 'audio/webm', false, 'ambient', 'quiet-chunk',
    )).rejects.toBeInstanceOf(SpeakerNoSpeechError);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('matches each sidecar speaker once and attributes timestamped STT by maximum overlap', async () => {
    const store = fakeStore();
    const transcribe = vi.fn(async () => ({
      providerId: 'google-stt',
      segments: [
        { text: 'Hello there.', startTime: 0.1, endTime: 1.8 },
        { text: 'General Kenobi.', startTime: 2.2, endTime: 3.8 },
      ],
    }));
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecarResult() }, { transcribe }, store,
    );

    const result = await orchestrator.process(
      'auth0|owner-a', Buffer.from('audio'), 'audio/webm', true, 'ambient', 'chunk-observation',
    );

    expect(store.identify).toHaveBeenCalledTimes(2);
    expect(store.identify).toHaveBeenNthCalledWith(
      1, 'auth0|owner-a', expect.any(Array), 'pyannote-v1',
      { clientChunkId: 'chunk-observation', speakerKey: 'SPEAKER_00' },
    );
    expect(result.turns.map((turn) => turn.label)).toEqual(['Unidentified Person 1', 'Unidentified Person 2']);
    expect(result.processing).toEqual({ status: 'complete', transcription: 'provider', diarization: 'complete' });
    expect(result.timeline).toHaveLength(2);
  });

  it('retries a partial multi-speaker failure without mutating the first observation twice', async () => {
    const base = fakeStore();
    const observations = new Map<string, Awaited<ReturnType<typeof base.identify>>>();
    let failSecond = true;
    let mutations = 0;
    base.identify = vi.fn(async (_owner, _embedding, _model, observation) => {
      const key = `${observation?.clientChunkId}:${observation?.speakerKey}`;
      const replay = observations.get(key);
      if (replay) return replay;
      if (observation?.speakerKey === 'SPEAKER_01' && failSecond) {
        failSecond = false;
        throw new Error('transient second-speaker persistence failure');
      }
      mutations += 1;
      const match = { profile: profile(mutations), similarity: 1, created: true };
      observations.set(key, match);
      return match;
    });
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecarResult() },
      { transcribe: async () => ({ providerId: 'stt', text: 'Words.' }) },
      base,
    );

    await expect(orchestrator.process(
      'owner', Buffer.from('audio'), 'audio/webm', true, 'ambient', 'partial-chunk',
    )).rejects.toThrow('second-speaker');
    await expect(orchestrator.process(
      'owner', Buffer.from('audio'), 'audio/webm', true, 'ambient', 'partial-chunk',
    )).resolves.toMatchObject({ timeline: expect.any(Array) });

    expect(mutations).toBe(2);
    expect(base.identify).toHaveBeenCalledTimes(4);
  });

  it('keeps whole-text STT explicitly unattributed', async () => {
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecarResult() },
      { transcribe: async () => ({ providerId: 'whole-text', text: 'A combined sentence.' }) },
      fakeStore(),
    );

    const result = await orchestrator.process('owner', Buffer.from('audio'), 'audio/webm', true);

    expect(result.turns[0]).toMatchObject({ label: 'Speaker unavailable', profileId: null, attribution: 'unavailable' });
    expect(result.processing.status).toBe('degraded');
  });

  it('skips STT entirely for deterministic self enrollment', async () => {
    const transcribe = vi.fn();
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => enrollmentSidecarResult() },
      { transcribe },
      fakeStore(),
    );

    const result = await orchestrator.process('owner', Buffer.from('audio'), 'audio/webm', true, 'self_enrollment');

    expect(transcribe).not.toHaveBeenCalled();
    expect(result.turns).toEqual([]);
    expect(result.timeline).toHaveLength(1);
  });

  it('rejects multi-speaker enrollment before any profile mutation', async () => {
    const store = fakeStore();
    const transcribe = vi.fn();
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecarResult() }, { transcribe }, store,
    );

    await expect(orchestrator.process(
      'owner', Buffer.from('audio'), 'audio/webm', true, 'self_enrollment',
    )).rejects.toThrow('at least 5s of clean voice');
    expect(store.identify).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('preserves a short-speaker timeline without creating a biometric profile', async () => {
    const store = fakeStore();
    const sidecar = sidecarResult();
    sidecar.speakers[0].embedding = null;
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecar },
      { transcribe: async () => ({ providerId: 'google-stt', segments: [{ text: 'Hi.', startTime: 0, endTime: 1 }] }) },
      store,
    );

    const result = await orchestrator.process('owner', Buffer.from('audio'), 'audio/webm', true);

    expect(store.identify).toHaveBeenCalledTimes(1);
    expect(result.timeline[0]).toMatchObject({ label: 'Unidentified Speaker', profileId: null, attribution: 'session' });
  });

  it('does not persist a padded embedding with too little voiced audio', async () => {
    const store = fakeStore();
    const sidecar = sidecarResult();
    sidecar.speakers = [{ ...sidecar.speakers[0], voicedSeconds: 0.3 }];
    sidecar.turns = [{ ...sidecar.turns[0], endTime: 0.3 }];
    sidecar.durationSeconds = 0.3;
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecar },
      { transcribe: async () => ({ providerId: 'stt', text: 'Short.' }) },
      store,
    );

    const result = await orchestrator.process('owner', Buffer.from('audio'), 'audio/webm', true);

    expect(store.identify).not.toHaveBeenCalled();
    expect(result.timeline[0]).toMatchObject({ profileId: null, label: 'Unidentified Speaker' });
  });

  it('marks text spanning different speakers unavailable and coalesces adjacent same-speaker words', async () => {
    const store = fakeStore();
    const transcriber = { transcribe: async () => ({
      providerId: 'google-stt',
      segments: [
        { text: 'Crossed', startTime: 1.5, endTime: 2.5 },
        { text: 'same', startTime: 0.1, endTime: 0.5 },
        { text: 'speaker', startTime: 0.6, endTime: 1.0 },
      ],
    }) };
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecarResult() }, transcriber, store,
    );

    const result = await orchestrator.process('owner', Buffer.from('audio'), 'audio/webm', true);

    expect(result.turns[0]).toMatchObject({ text: 'Crossed', attribution: 'unavailable' });
    expect(result.turns[1]).toMatchObject({ text: 'same speaker', label: 'Unidentified Person 1' });
    expect(result.turns).toHaveLength(2);
  });

  it('keeps exclusive words and voiced seconds from a turn with only a small partial overlap', async () => {
    const store = fakeStore();
    const sidecar: SpeakerSidecarResult = {
      modelId: 'pyannote-v1', sampleRate: 16_000, durationSeconds: 10,
      speakers: [
        { speakerKey: 'speaker-1', embedding: normalizeSpeakerEmbedding([1, 0]), voicedSeconds: 10 },
        { speakerKey: 'speaker-2', embedding: normalizeSpeakerEmbedding([0, 1]), voicedSeconds: 0.2 },
      ],
      turns: [
        { turnIndex: 0, speakerKey: 'speaker-1', startTime: 0, endTime: 10, overlap: true },
        { turnIndex: 1, speakerKey: 'speaker-2', startTime: 4, endTime: 4.2, overlap: true },
      ],
    };
    const orchestrator = new SpeakerDiarizationOrchestrator(
      { diarize: async () => sidecar },
      { transcribe: async () => ({
        providerId: 'google-stt', segments: [{ text: 'Clearly speaker one.', startTime: 1, endTime: 2 }],
      }) },
      store,
    );

    const result = await orchestrator.process('owner', Buffer.from('audio'), 'audio/webm', true);

    expect(store.identify).toHaveBeenCalledTimes(1);
    expect(result.turns[0]).toMatchObject({ attribution: 'created', label: 'Unidentified Person 1' });
  });
});

function sidecarResult(): SpeakerSidecarResult {
  return {
    modelId: 'pyannote-v1',
    sampleRate: 16_000,
    durationSeconds: 4,
    speakers: [
      { speakerKey: 'SPEAKER_00', embedding: normalizeSpeakerEmbedding([1, 0, 0]), voicedSeconds: 2 },
      { speakerKey: 'SPEAKER_01', embedding: normalizeSpeakerEmbedding([0, 1, 0]), voicedSeconds: 2 },
    ],
    turns: [
      { turnIndex: 0, speakerKey: 'SPEAKER_00', startTime: 0, endTime: 2, overlap: false },
      { turnIndex: 1, speakerKey: 'SPEAKER_01', startTime: 2, endTime: 4, overlap: false },
    ],
  };
}

function enrollmentSidecarResult(): SpeakerSidecarResult {
  const base = sidecarResult();
  return {
    ...base,
    durationSeconds: 6,
    speakers: [{ ...base.speakers[0], voicedSeconds: 6 }],
    turns: [{ ...base.turns[0], endTime: 6 }],
  };
}

function fakeStore(): SpeakerProfileStoreContract & { identify: ReturnType<typeof vi.fn> } {
  let ordinal = 0;
  const identify = vi.fn(async () => {
    ordinal += 1;
    return { profile: profile(ordinal), similarity: 1, created: true };
  });
  return {
    identify,
    listProfiles: async () => [],
    assignProfile: async () => null,
    mergeProfiles: async () => null,
    deleteProfile: async () => false,
    speakerContext: async () => ({
      available: false, voiceProfilesAvailable: true, guest: false,
      tenantMemberAssignmentAvailable: false,
      reason: 'no_private_org', selectedTenantId: null, organizations: [], members: [],
      currentUser: { userSub: 'owner', displayName: 'You', profileId: null },
      unavailableMemberCount: 0,
    }),
  };
}

function profile(ordinal: number): SpeakerProfile {
  const now = new Date('2026-07-09T23:00:00.000Z');
  return {
    profileId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
    ordinal,
    label: `Unidentified Person ${ordinal}`,
    assignment: { kind: 'unassigned', customName: null, tenantId: null, memberSub: null },
    embeddingModel: 'pyannote-v1',
    sampleCount: 1,
    segmentCount: 0,
    excerpts: [],
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
  };
}

function profileRow() {
  const now = '2026-07-09T23:00:00.000Z';
  return {
    profile_id: 'profile-a', unidentified_ordinal: 1, embedding_model: 'pyannote-v1',
    sample_count: 1, segment_count: 0, excerpts: [],
    first_seen_at: now, last_seen_at: now, updated_at: now,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
