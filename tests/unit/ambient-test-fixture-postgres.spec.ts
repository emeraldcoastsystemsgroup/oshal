/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The REAL-BOUNDARY half of the ADR-100 Test Lab attributed-ingest fixture. The claim it protects — "the Lab can prove an ask and a profile for a fixture voice" — is a claim about rows that only the database produces: the trusted attributed append, the consent ledger, enrichBatch's ask/rollup/relation persistence, and the getOpenAsks / personProfileSummary reads over them. So this drives the real router over real HTTP against a PostgreSQL started for this file, on the deployment's own migration chain plus the lazy person-model DDL, with every collaborator real except the analyst's reply. It fails LOUDLY without Docker; a skipping guard is no guard.
 */

import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseBootstrapService } from '@/features/tool-registry';
import { getOpenAsks, personModelSchemaStatements, personProfileSummary } from '@/features/person-model';
import {
  AMBIENT_FIXTURE_MODEL,
  AMBIENT_FIXTURE_TOPIC,
  AMBIENT_FIXTURE_VOICE_LABEL,
  createAmbientTestFixtureRoutes,
  fixtureLineText,
} from '@/app/routes/ambient-test-fixture-routes';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'scripts', 'migrations');
const SECRET = 'ambient-fixture-postgres-spec-secret-placeholder';
const RUN = randomUUID().slice(0, 8);
const OWNER_A = `spec-fixture-${RUN}-a`;
const OWNER_B = `spec-fixture-${RUN}-b`;
const MOUNT = '/api/jarvis/ambient/test-fixture';

// A PostgreSQL this file owns: the address is invented at start(), nothing inherits a DSN, and the
// container is force-removed in stop(), so no statement here can reach a deployment.
const database = new DisposablePostgres({
  purpose: 'ambient-test-fixture',
  database: 'ambient_fixture',
  memory: '512m',
  max: 4,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 120_000,
});

let pool: Pool;
let listener: { url: string; close: () => Promise<void> };

/** Serves the REAL fixture router behind an injected session, the way requiresAuth leaves a request. */
async function startListener(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.header('x-spec-owner');
    if (sub) (req as express.Request & { oidc?: unknown }).oidc = { user: { sub }, isAuthenticated: () => true };
    next();
  });
  // Real service, real profile store, real enrichBatch — only the analyst's reply is the fixture's.
  app.use(MOUNT, createAmbientTestFixtureRoutes({ pool }));
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}${MOUNT}/attributed-line`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function seed(owner: string, token: string, headers: Record<string, string> = {}) {
  const response = await fetch(listener.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-spec-owner': owner,
      'x-service-secret': SECRET, ...headers,
    },
    body: JSON.stringify({ token }),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${sql}`, params);
  return Number(rows[0].n);
}

describe('ADR-100 Test Lab attributed-ingest fixture on a real PostgreSQL', () => {
  beforeAll(async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    process.env.SPEAKER_PROFILE_SECRET = 'ambient-fixture-spec-speaker-secret-placeholder';
    pool = await database.start();
    process.env.RUN_MIGRATIONS = 'true';
    delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    const applied = await new DatabaseBootstrapService(pool, MIGRATIONS_DIR).applyMigrations();
    expect(applied, 'the ambient transcript store must exist').toContain('068-ambient-listening.sql');
    expect(applied, 'the speaker profile store must exist').toContain('069-ambient-speakers.sql');
    expect(applied, 'the deletion/re-projection parity triggers must exist').toContain('138-person-model-parity.sql');
    for (const statement of personModelSchemaStatements()) await pool.query(statement);
    listener = await startListener();
  }, 600_000);

  afterAll(async () => {
    delete process.env.SWARM_SERVICE_SECRET;
    delete process.env.SPEAKER_PROFILE_SECRET;
    try { await listener?.close(); } finally { await database.stop(); }
  }, 120_000);

  it('writes an ATTRIBUTED transcript line, a granted consent and an ask a real read can find', async () => {
    const token = `fxa${RUN}`;
    const seeded = await seed(OWNER_A, token);
    expect(seeded.status, JSON.stringify(seeded.json)).toBe(201);
    expect(seeded.json).toMatchObject({ duplicate: false, consentRecorded: true, enriched: 1, asks: 1 });

    const segment = await pool.query(
      `SELECT transcript_text, speaker_profile_id::text AS profile_id, client_segment_id
         FROM ambient_transcript_segments WHERE user_sub = $1`,
      [OWNER_A],
    );
    expect(segment.rows).toHaveLength(1);
    expect(segment.rows[0].transcript_text).toBe(fixtureLineText(token));
    expect(
      segment.rows[0].profile_id,
      'THE point of the fixture: the line carries a speaker, which POST /segments refuses to accept',
    ).toBe(seeded.json.profileId);
    expect(segment.rows[0].client_segment_id).toBe(`testlab-fixture-${token}`);

    const consent = await pool.query(
      `SELECT status, scope, is_minor, method FROM ambient_speaker_consents WHERE owner_sub = $1`,
      [OWNER_A],
    );
    expect(consent.rows).toEqual([{ status: 'granted', scope: 'transcript', is_minor: false, method: 'owner_attested' }]);

    const asks = await getOpenAsks(pool, OWNER_A);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ kind: 'ask', status: 'open', isInference: true, personLabel: AMBIENT_FIXTURE_VOICE_LABEL });
    expect(asks[0].sourceQuote, 'an ask is always shown beside the verbatim line').toBe(fixtureLineText(token));
    const askModel = await pool.query('SELECT model FROM ambient_person_asks WHERE owner_sub = $1', [OWNER_A]);
    expect(askModel.rows[0].model, 'a fixture inference must never read as analyst output').toBe(AMBIENT_FIXTURE_MODEL);
  }, 120_000);

  it('reads back as a per-person profile: label, granted consent, topic, presence and the ask', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT speaker_profile_id::text AS profile_id FROM ambient_transcript_segments WHERE user_sub = $1`,
      [OWNER_A],
    );
    const profile = await personProfileSummary(pool, OWNER_A, String(rows[0].profile_id));

    expect(profile).not.toBeNull();
    expect(profile?.label).toBe(AMBIENT_FIXTURE_VOICE_LABEL);
    expect(profile?.consent).toMatchObject({ status: 'granted', eligible: true, isMinor: false });
    expect(profile?.topics.map((topic) => topic.topic)).toContain(AMBIENT_FIXTURE_TOPIC);
    expect(profile?.asks.map((ask) => ask.sourceQuote)).toContain(fixtureLineText(`fxa${RUN}`));
    expect(profile?.presence.length, 'presence is a transcript fact, not an inference').toBeGreaterThan(0);
  }, 60_000);

  it('is idempotent on a replayed token and keeps ONE fixture voice per owner across runs', async () => {
    const first = await pool.query(
      `SELECT DISTINCT speaker_profile_id::text AS profile_id FROM ambient_transcript_segments WHERE user_sub = $1`,
      [OWNER_A],
    );
    const replay = await seed(OWNER_A, `fxa${RUN}`);
    expect(replay.status).toBe(201);
    expect(replay.json).toMatchObject({ duplicate: true, consentRecorded: false, asks: 0 });
    expect(await count('ambient_person_asks WHERE owner_sub = $1', [OWNER_A]), 'a replay must not duplicate the ask').toBe(1);
    expect(await count('ambient_speaker_consents WHERE owner_sub = $1', [OWNER_A]), 'the append-only ledger is not re-appended').toBe(1);

    const second = await seed(OWNER_A, `fxb${RUN}`);
    expect(second.status).toBe(201);
    expect(second.json.profileId, 'a stable per-owner voiceprint matches, it does not mint a second voice').toBe(String(first.rows[0].profile_id));
    expect(await count('ambient_speaker_profiles WHERE owner_sub = $1', [OWNER_A])).toBe(1);
    expect(await count('ambient_person_asks WHERE owner_sub = $1', [OWNER_A])).toBe(2);
  }, 120_000);

  it('gives a second owner their own voice and never their neighbour\'s ask', async () => {
    const mine = await seed(OWNER_B, `fxc${RUN}`);
    expect(mine.status).toBe(201);

    const theirs = await pool.query(
      `SELECT DISTINCT speaker_profile_id::text AS profile_id FROM ambient_transcript_segments WHERE user_sub = $1`,
      [OWNER_A],
    );
    expect(mine.json.profileId).not.toBe(String(theirs.rows[0].profile_id));

    const asks = await getOpenAsks(pool, OWNER_B);
    expect(asks).toHaveLength(1);
    expect(asks[0].sourceQuote).toBe(fixtureLineText(`fxc${RUN}`));
    expect(await personProfileSummary(pool, OWNER_B, String(theirs.rows[0].profile_id)), 'another owner\'s voice is not readable').toBeNull();
  }, 120_000);

  it('refuses the same request when the caller holds no service secret', async () => {
    const response = await fetch(listener.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-spec-owner': OWNER_B },
      body: JSON.stringify({ token: `fxd${RUN}` }),
    });
    expect(response.status).toBe(401);
    expect(await count('ambient_transcript_segments WHERE client_segment_id = $1', [`testlab-fixture-fxd${RUN}`])).toBe(0);
  }, 60_000);
});
