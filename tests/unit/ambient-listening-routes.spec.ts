/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added authenticated owner-scope, API-shape, raw-audio rejection, and proposal-only daily review route coverage.
 */

import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AMBIENT_DELETE_CONFIRMATION,
  createAmbientListeningRoutes,
} from '../../src/app/routes/ambient-listening-routes';
import {
  buildAmbientDailyReview,
  normalizeAmbientSegmentBatch,
  type AmbientActionSuggestion,
  type AmbientListeningServiceContract,
  type AmbientSettings,
} from '../../src/features/ambient-listening';

const NOW = new Date('2026-07-09T22:00:00.000Z');

describe('Jarvis ambient routes', () => {
  const servers: Array<{ close: (callback: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  it('uses only the authenticated subject for settings and rejects missing identity', async () => {
    const fixture = await startFixture();
    const authed = await fetch(`${fixture.baseUrl}/api/jarvis/ambient/settings`, {
      headers: { 'x-test-sub': 'auth0|owner-a' },
    });
    const unauthenticated = await fetch(`${fixture.baseUrl}/api/jarvis/ambient/settings`);

    expect(authed.status).toBe(200);
    expect(unauthenticated.status).toBe(401);
    expect(fixture.seenSubjects).toEqual(['auth0|owner-a']);
  });

  it('accepts a text batch but rejects any raw audio-shaped payload', async () => {
    const fixture = await startFixture();
    const textResponse = await post(fixture.baseUrl, '/segments', {
      segments: [{ id: 'client-1', text: 'This is finalized text.' }],
    });
    const audioResponse = await post(fixture.baseUrl, '/segments', {
      segments: [{ text: 'This has a forbidden attachment.', audioData: 'base64' }],
    });

    expect(textResponse.status).toBe(201);
    expect(await textResponse.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(audioResponse.status).toBe(400);
    expect(await audioResponse.json()).toMatchObject({ error: 'raw_audio_not_allowed' });
  });

  it('returns summary and proposed actions while only queueing confirmation questions', async () => {
    const fixture = await startFixture();
    const response = await post(fixture.baseUrl, '/days/2026-07-09/review', {});
    const body = await response.json() as {
      summary: string;
      proposedActions: AmbientActionSuggestion[];
      actionsExecuted: number;
      queuedSuggestions: number;
    };

    expect(response.status).toBe(200);
    expect(body.summary).toContain('Captured 1 text transcript segment');
    expect(body.proposedActions[0]).toMatchObject({ status: 'proposed', requiresConfirmation: true });
    expect(body.actionsExecuted).toBe(0);
    expect(body.queuedSuggestions).toBe(1);
    expect(fixture.queued[0]).toMatchObject({ userSub: 'auth0|owner-a' });
    expect(fixture.queued[0].suggestion.prompt).toContain('would you like me');
  });

  it('requires explicit all-data wording and reports deleted voice profiles', async () => {
    const fixture = await startFixture();
    const obsolete = await deleteData(fixture.baseUrl, 'DELETE AMBIENT TRANSCRIPTS');
    const response = await deleteData(fixture.baseUrl, AMBIENT_DELETE_CONFIRMATION);

    expect(obsolete.status).toBe(400);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ambientEnabled: false, deletedSegments: 3, deletedSpeakerProfiles: 2,
    });
  });

  async function startFixture() {
    const seenSubjects: string[] = [];
    const queued: Array<{ userSub: string; suggestion: AmbientActionSuggestion }> = [];
    const service = fakeService(seenSubjects);
    const app = express();
    app.use(express.json());
    app.use(testIdentity());
    app.use('/api/jarvis/ambient', createAmbientListeningRoutes(
      { pool: {} as never },
      { service, suggestionSink: async (userSub, suggestion) => { queued.push({ userSub, suggestion }); } },
    ));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return { baseUrl: `http://127.0.0.1:${address.port}`, seenSubjects, queued };
  }
});

function fakeService(seenSubjects: string[]): AmbientListeningServiceContract {
  const settings: AmbientSettings = {
    assistantName: 'Jarvis', wakePhrases: ['hey jarvis'], ambientEnabled: true,
    transcriptRetentionDays: 30, timeZone: 'America/Chicago', updatedAt: NOW,
    dailyReviewEnabled: true, dailyReviewTime: '21:00', suggestFollowUps: true,
  };
  return {
    getSettings: async (sub) => { seenSubjects.push(sub); return settings; },
    updateSettings: async (sub) => { seenSubjects.push(sub); return settings; },
    appendSegments: async (sub, payload) => {
      seenSubjects.push(sub);
      const values = normalizeAmbientSegmentBatch(payload, NOW);
      return {
        accepted: values.length, duplicates: 0,
        segments: values.map((item, index) => ({ ...item, segmentId: `s${index}`, createdAt: NOW })),
      };
    },
    claimAudioChunk: async () => ({
      state: 'claimed', claimToken: '00000000-0000-4000-8000-000000000001',
    }),
    completeAudioChunk: async () => undefined,
    releaseAudioChunk: async () => undefined,
    getDay: async (sub, localDate) => {
      seenSubjects.push(sub);
      return { localDate, timeZone: settings.timeZone, segments: [], review: null };
    },
    reviewDay: async (sub, localDate) => {
      seenSubjects.push(sub);
      return buildAmbientDailyReview(localDate, settings.timeZone, [{
        segmentId: 'wife-1', speakerLabel: 'Alice', text: 'the operator, remind me to call the dentist tomorrow.',
      }], NOW);
    },
    deleteDay: async (sub) => { seenSubjects.push(sub); return 0; },
    clearTranscriptData: async (sub) => {
      seenSubjects.push(sub);
      return { deletedSegments: 3, deletedSpeakerProfiles: 2 };
    },
    reviewDueDays: async () => [],
  };
}

function testIdentity() {
  return (req: Request, _res: ExpressResponse, next: NextFunction) => {
    const sub = req.header('x-test-sub');
    if (sub) (req as Request & { oidc?: unknown }).oidc = { user: { sub } };
    next();
  };
}

function post(baseUrl: string, path: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/jarvis/ambient${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-sub': 'auth0|owner-a' },
    body: JSON.stringify(body),
  });
}

function deleteData(baseUrl: string, confirm: string): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/jarvis/ambient/data`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-test-sub': 'auth0|owner-a' },
    body: JSON.stringify({ confirm }),
  });
}
