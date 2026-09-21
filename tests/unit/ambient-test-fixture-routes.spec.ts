/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The GATE half of the ADR-100 Test Lab attributed-ingest fixture. It runs the REAL router with the REAL requireServiceSecret middleware over a real HTTP listener, because the claim it protects is "a normal session cannot reach the fixture" — a claim about the gate, which a mocked gate cannot evidence. It also pins the two properties that bound the fixture's reach: the owner is read ONLY from the validated session (a body-asserted owner is ignored), and the analyst reply the fixture substitutes parses through the production taxonomy validator into exactly one ask.
 */

import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AMBIENT_FIXTURE_TOPIC,
  AMBIENT_FIXTURE_VOICE_LABEL,
  createAmbientTestFixtureRoutes,
  fixtureAskText,
  fixtureLineText,
  fixtureVoiceEmbedding,
} from '../../src/app/routes/ambient-test-fixture-routes';
import { parseEnrichmentJson } from '../../src/features/person-model';

const SECRET = 'ambient-fixture-spec-service-secret-placeholder';
const OWNER = 'auth0|ambient-fixture-spec-owner';
const OTHER = 'auth0|ambient-fixture-spec-intruder';
const PROFILE = '7c1f2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const SEGMENT = 'seg-ambient-fixture-spec';
const MOUNT = '/api/jarvis/ambient/test-fixture';

/** Everything the doubled collaborators saw, so the spec can assert whose store was written. */
interface Seen {
  identified: Array<{ ownerSub: string; model: string; dimensions: number }>;
  assigned: Array<{ ownerSub: string; profileId: string; customName?: string | null }>;
  appended: Array<{ ownerSub: string; mode: string; speakerProfileId: string | null; clientSegmentId: string | null; text: string }>;
  enriched: Array<{ ownerSub: string; profileId: string | null; model?: string }>;
  queries: Array<{ sql: string; params: unknown[] }>;
  analystReplies: string[];
}

function emptySeen(): Seen {
  return { identified: [], assigned: [], appended: [], enriched: [], queries: [], analystReplies: [] };
}

/** Doubles for the DATABASE-backed collaborators only; the router and its gate stay real. */
function collaborators(seen: Seen): Parameters<typeof createAmbientTestFixtureRoutes>[1] {
  return {
    service: {
      getSettings: async () => ({ timeZone: 'America/New_York' }) as never,
      appendAttributedSegments: async (ownerSub: string, segments: readonly any[], mode?: string) => {
        const first = segments[0];
        seen.appended.push({
          ownerSub, mode: mode ?? 'ambient', speakerProfileId: first.speakerProfileId,
          clientSegmentId: first.clientSegmentId, text: first.text,
        });
        return { accepted: 1, duplicates: 0, segments: [{ segmentId: SEGMENT, text: first.text, capturedAt: new Date() }] } as never;
      },
    },
    store: {
      identify: async (ownerSub: string, embedding: number[], model: string) => {
        seen.identified.push({ ownerSub, model, dimensions: embedding.length });
        return { profile: { profileId: PROFILE }, similarity: 1, created: true } as never;
      },
      assignProfile: async (ownerSub: string, profileId: string, input: any) => {
        seen.assigned.push({ ownerSub, profileId, customName: input.customName });
        return { assignment: { customName: input.customName } } as never;
      },
    },
    enrich: (async (_pool: unknown, ownerSub: string, batch: readonly any[], invoke: any, opts: any) => {
      seen.enriched.push({ ownerSub, profileId: batch[0].profileId, model: opts.model });
      seen.analystReplies.push(await invoke('task', 'prompt'));
      return { requested: 1, enriched: 1, asks: 1 };
    }) as never,
  };
}

/** A pool that records reads; the fixture only SELECTs here (the doubled append never duplicates). */
function recordingPool(seen: Seen) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      seen.queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

async function serveFixture(seen: Seen, sub: string | null): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (sub) (req as express.Request & { oidc?: unknown }).oidc = { user: { sub }, isAuthenticated: () => true };
    next();
  });
  app.use(MOUNT, createAmbientTestFixtureRoutes({ pool: recordingPool(seen) } as never, collaborators(seen)));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}${MOUNT}/attributed-line`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
}

describe('ADR-100 Test Lab attributed-ingest fixture — the gate', () => {
  const closers: Array<() => Promise<void>> = [];
  let seen: Seen;

  beforeEach(() => {
    seen = emptySeen();
    process.env.SWARM_SERVICE_SECRET = SECRET;
  });

  afterEach(async () => {
    delete process.env.SWARM_SERVICE_SECRET;
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function fixture(sub: string | null = OWNER): Promise<string> {
    const { url, close } = await serveFixture(seen, sub);
    closers.push(close);
    return url;
  }

  it('refuses an ordinary signed-in session: no service secret, no fixture', async () => {
    const url = await fixture();
    const response = await post(url, {}, { token: 'labtoken1' });

    expect(response.status).toBe(401);
    expect(seen.appended, 'nothing may be written on a refused request').toEqual([]);
  });

  it('refuses a signed-in session presenting the wrong secret', async () => {
    const url = await fixture();
    const response = await post(url, { 'x-service-secret': `${SECRET}-not` }, { token: 'labtoken1' });

    expect(response.status).toBe(401);
    expect(seen.appended).toEqual([]);
  });

  it('refuses everyone when the deployment configures no secret at all', async () => {
    delete process.env.SWARM_SERVICE_SECRET;
    const url = await fixture();
    const response = await post(url, { 'x-service-secret': SECRET }, { token: 'labtoken1' });

    expect(response.status, 'an unconfigured control plane is closed, not open').toBe(503);
    expect(seen.appended).toEqual([]);
  });

  it('refuses a valid secret with no signed-in owner — the fixture has no one to seed', async () => {
    const url = await fixture(null);
    const response = await post(url, { 'x-service-secret': SECRET }, { token: 'labtoken1' });

    expect(response.status).toBe(401);
    expect(response.json.error).toBe('sign_in_required');
    expect(seen.identified).toEqual([]);
  });

  it('seeds one attributed line for the SESSION owner when both credentials are present', async () => {
    const url = await fixture();
    const response = await post(url, { 'x-service-secret': SECRET }, { token: 'labtoken1' });

    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({
      token: 'labtoken1', profileId: PROFILE, segmentId: SEGMENT, label: AMBIENT_FIXTURE_VOICE_LABEL,
      duplicate: false, asks: 1, ask: fixtureAskText('labtoken1'),
    });
    expect(seen.appended).toEqual([{
      ownerSub: OWNER,
      // recording_import, so seeding never requires or flips the owner's ambient_enabled setting.
      mode: 'recording_import',
      speakerProfileId: PROFILE,
      clientSegmentId: 'testlab-fixture-labtoken1',
      text: fixtureLineText('labtoken1'),
    }]);
    expect(seen.identified).toEqual([{ ownerSub: OWNER, model: 'test-lab-fixture-voice-v1', dimensions: 192 }]);
    expect(seen.assigned).toEqual([{ ownerSub: OWNER, profileId: PROFILE, customName: AMBIENT_FIXTURE_VOICE_LABEL }]);
    expect(seen.enriched).toEqual([{ ownerSub: OWNER, profileId: PROFILE, model: 'test-lab-fixture' }]);
  });

  it('ignores an owner asserted in the body — a secret holder cannot seed someone else', async () => {
    const url = await fixture();
    const response = await post(url, { 'x-service-secret': SECRET }, {
      token: 'labtoken1', userSub: OTHER, ownerSub: OTHER, owner: OTHER,
    });

    expect(response.status).toBe(201);
    const owners = new Set([
      ...seen.identified.map((s) => s.ownerSub), ...seen.assigned.map((s) => s.ownerSub),
      ...seen.appended.map((s) => s.ownerSub), ...seen.enriched.map((s) => s.ownerSub),
    ]);
    expect([...owners], 'every collaborator must be handed the session subject only').toEqual([OWNER]);
    expect(seen.queries.every((q) => !JSON.stringify(q.params).includes(OTHER))).toBe(true);
  });

  it('refuses a token that could not name a segment', async () => {
    const url = await fixture();
    const short = await post(url, { 'x-service-secret': SECRET }, { token: 'ab' });
    const hostile = await post(url, { 'x-service-secret': SECRET }, { token: 'a/../b' });
    const missing = await post(url, { 'x-service-secret': SECRET }, {});

    for (const response of [short, hostile, missing]) {
      expect(response.status).toBe(400);
      expect(response.json.error).toBe('invalid_fixture_token');
    }
    expect(seen.appended).toEqual([]);
  });

  it('substitutes only the analyst reply, and that reply survives the production taxonomy validator', async () => {
    const url = await fixture();
    await post(url, { 'x-service-secret': SECRET }, { token: 'labtoken1' });

    expect(seen.analystReplies).toHaveLength(1);
    const parsed = parseEnrichmentJson(seen.analystReplies[0], [{ segmentId: SEGMENT, text: 'x' }]);
    expect(parsed).toEqual([{
      segmentId: SEGMENT, tone: 'neutral', intent: 'ask_request',
      topics: [AMBIENT_FIXTURE_TOPIC], ask: fixtureAskText('labtoken1'), commitment: null,
    }]);
  });

  it('gives each owner their own stable fixture voiceprint', () => {
    const a = fixtureVoiceEmbedding(OWNER);
    const b = fixtureVoiceEmbedding(OTHER);

    expect(a).toHaveLength(192);
    expect(fixtureVoiceEmbedding(OWNER), 'stable, so a repeat run matches one profile').toEqual(a);
    expect(a, 'owner-salted, so two owners never share a fixture profile').not.toEqual(b);
    expect(a.every((value) => value >= -1 && value < 1)).toBe(true);
  });
});
