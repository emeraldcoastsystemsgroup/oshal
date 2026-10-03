/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1 real-boundary companion for the capability swarm rows: migration 183 as shipped on a DISPOSABLE PostgreSQL this spec owns, the real CapabilitySwarmRowStore and CapabilityRowSnapshot, and the real GUC pool wrapper, as the ENFORCING oshal_app role (self-validated: current_user, not superuser, not RLS-bypassing, table owner under FORCE RLS). Proves the S1 Done-when on the real boundary: every identity (a person, a guest, the system, a caller with no subject) reads the swarm rows; a non-operator write is refused by the TABLE's own policy (42501) whatever code path it takes; the CHECKs refuse shapes no validator produces; a swarm write changes the NEXT resolution with no restart, through the real snapshot; and end to end through the real operator route and the real /api/voice/transcribe route, one operator PUT moves the next dictation from the seed (gemini-stt) to local-stt at the swarm-default rung, while a non-operator's PUT and a session-less call are refused. Doubles: the speech providers' credential probes and network calls (getStatus / transcribe spies); the database, the role, the policies, the snapshot and both routes are real. The deployment database is never touched (the fixture publishes its own loopback port).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  CAPABILITY_FLEET_SCOPE,
  CapabilityRowSnapshot,
  installCapabilityRowSnapshot,
  resolveCapabilityProvider,
  userCapabilityPrincipal,
} from '@/shared/capability-providers';
import { CapabilitySwarmRowStore } from '@/features/capability-providers';
import { createSttCapabilityAdapter, getSTTProviderRegistry } from '@/features/voice-providers';
import { resetSTTProviderRegistryForTesting } from '../../src/features/voice-providers/services/stt-provider-registry';
import { VoiceService } from '@/features/voice';
import { createVoiceRoutes } from '@/app/routes/voice-routes';
import { createCapabilityProviderRoutes } from '@/app/routes/capability-provider-routes';
import { capabilityProviderAdapters } from '@/app/composition/capability-provider-runtime';

const OPERATOR = { sub: 'capability-operator-sub', isOperator: true };
const PERSON = { sub: 'capability-person-sub', isOperator: false };
const GUEST = { sub: 'guest-capability-visitor', isOperator: false };
const NOBODY = { sub: null, isOperator: false };
const VOICE_CONFIG = {
  voice: {
    tts: { default: 'browser', providers: { browser: {} } },
    stt: { default: 'gemini-stt', providers: { browser: {}, 'gemini-stt': { model: 'gemini-2.5-flash', defaultLanguageCode: 'en-US', transcribePrompt: 'Transcribe.' }, 'local-stt': {} } },
  },
};

const database = new DisposablePostgres({ purpose: 'capability-swarm-rows', database: 'capability_rows_fixture', migrations: ['183-capability-swarm-rows.sql'], max: 4 });
let appPool: Pool;
let store: CapabilitySwarmRowStore;
let configDir = '';

beforeAll(async () => {
  vi.stubEnv('OSHAL_DB_GUC', 'on');
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR.sub);
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-rows-config-'));
  fs.writeFileSync(path.join(configDir, 'global-config.json'), JSON.stringify(VOICE_CONFIG));
  vi.stubEnv('OSHAL_GLOBAL_CONFIG_PATH', path.join(configDir, 'global-config.json'));
  const superuser = await database.start();
  const appPassword = randomUUID();
  // The runtime role as app-role-provisioning.sql shapes it: it OWNS the table and is scoped only
  // because the table forces row security.
  await superuser.query(`CREATE ROLE oshal_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${appPassword}'`);
  await superuser.query('GRANT USAGE ON SCHEMA public TO oshal_app');
  await superuser.query('ALTER TABLE oshal_capability_swarm_rows OWNER TO oshal_app');
  const conn = database.connection;
  appPool = wrapPoolWithGuc(new Pool({ host: conn.host, port: conn.port, database: conn.database, user: 'oshal_app', password: appPassword, max: 4 }));
  store = new CapabilitySwarmRowStore(appPool);
}, 180_000);

afterAll(async () => {
  installCapabilityRowSnapshot(null);
  resetSTTProviderRegistryForTesting();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
  try { await appPool?.end(); } finally { await database.stop(); }
});

describe('capability swarm rows on a real PostgreSQL, as the enforcing role', () => {
  it('self-validates the role: oshal_app, not superuser, not RLS-bypassing, owner under FORCE RLS', async () => {
    const who = await runWithSystemIdentity(() => appPool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; forced: boolean; owner: string }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
         FROM pg_roles r, pg_class c WHERE r.rolname = current_user AND c.relname = 'oshal_capability_swarm_rows'`,
    ));
    expect(who.rows[0]).toEqual({ current_user: 'oshal_app', rolsuper: false, rolbypassrls: false, forced: true, owner: 'oshal_app' });
  }, 30_000);

  it('the operator writes the swarm STT default in ONE upsert, and a second upsert is an update', async () => {
    const row = await runWithRequestIdentity(OPERATOR, () => store.upsert(CAPABILITY_FLEET_SCOPE, 'stt', 'gemini-stt', {}, OPERATOR.sub));
    expect(row).toMatchObject({ scopeId: 'fleet-default', capability: 'stt', providerId: 'gemini-stt', options: {}, updatedBy: OPERATOR.sub });
    expect(row.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await runWithRequestIdentity(OPERATOR, () => store.upsert(CAPABILITY_FLEET_SCOPE, 'tts', 'google-cloud-tts', { voice: 'en-US-Chirp3-HD-Kore' }, OPERATOR.sub));
    const again = await runWithRequestIdentity(OPERATOR, () => store.upsert(CAPABILITY_FLEET_SCOPE, 'stt', 'local-stt', {}, OPERATOR.sub));
    expect(again.providerId).toBe('local-stt');
    const count = await runWithSystemIdentity(() => appPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM oshal_capability_swarm_rows WHERE capability = 'stt'`));
    expect(count.rows[0].n).toBe('1');
  }, 30_000);

  it('EVERY identity reads the swarm rows: a person, a guest, the system and a caller with no subject', async () => {
    for (const identity of [PERSON, GUEST, NOBODY]) {
      const rows = await runWithRequestIdentity(identity, () => store.listAll());
      expect(rows.map((r) => `${r.capability}:${r.providerId}`), `identity ${identity.sub ?? '(none)'}`).toEqual(['stt:local-stt', 'tts:google-cloud-tts']);
    }
    expect((await runWithSystemIdentity(() => store.listAll())).length).toBe(2);
  }, 30_000);

  it('a NON-OPERATOR write is refused by the TABLE itself (42501), and an update or delete touches nothing', async () => {
    await expect(runWithRequestIdentity(PERSON, () => store.upsert(CAPABILITY_FLEET_SCOPE, 'image', 'openrouter', {}, PERSON.sub)))
      .rejects.toMatchObject({ code: '42501' });
    await expect(runWithRequestIdentity(GUEST, () => store.upsert(CAPABILITY_FLEET_SCOPE, 'stt', 'gemini-stt', {}, GUEST.sub)))
      .rejects.toMatchObject({ code: '42501' });
    const updated = await runWithRequestIdentity(PERSON, () => appPool.query(
      `UPDATE oshal_capability_swarm_rows SET provider_id = 'gemini-stt' WHERE capability = 'stt'`));
    expect(updated.rowCount).toBe(0);
    await expect(runWithRequestIdentity(PERSON, () => store.remove(CAPABILITY_FLEET_SCOPE, 'stt'))).resolves.toBe(false);
    const still = await runWithSystemIdentity(() => store.get(CAPABILITY_FLEET_SCOPE, 'stt'));
    expect(still?.providerId).toBe('local-stt');
  }, 30_000);

  it('the CHECKs refuse a blank or spaced scope, an unknown capability, a spaced provider and non-object options', async () => {
    const write = (sql: string) => runWithRequestIdentity(OPERATOR, () => appPool.query(sql));
    await expect(write(`INSERT INTO oshal_capability_swarm_rows (scope_id, capability, provider_id) VALUES ('  ', 'stt', 'local-stt')`)).rejects.toMatchObject({ code: '23514' });
    await expect(write(`INSERT INTO oshal_capability_swarm_rows (scope_id, capability, provider_id) VALUES ('fleet default', 'stt', 'local-stt')`)).rejects.toMatchObject({ code: '23514' });
    await expect(write(`INSERT INTO oshal_capability_swarm_rows (scope_id, capability, provider_id) VALUES ('fleet-default', 'music', 'x')`)).rejects.toMatchObject({ code: '23514' });
    await expect(write(`INSERT INTO oshal_capability_swarm_rows (scope_id, capability, provider_id) VALUES ('fleet-default', 'video', 'bad id')`)).rejects.toMatchObject({ code: '23514' });
    await expect(write(`INSERT INTO oshal_capability_swarm_rows (scope_id, capability, provider_id, options) VALUES ('fleet-default', 'video', 'veo', '[]'::jsonb)`)).rejects.toMatchObject({ code: '23514' });
  }, 30_000);

  it('a swarm write changes the NEXT resolution with no restart, through the real snapshot', async () => {
    await runWithRequestIdentity(OPERATOR, () => store.remove(CAPABILITY_FLEET_SCOPE, 'stt'));
    resetSTTProviderRegistryForTesting();
    for (const id of ['gemini-stt', 'local-stt']) vi.spyOn(getSTTProviderRegistry().get(id)!, 'getStatus').mockResolvedValue({ configured: true, providerId: id });
    const adapter = createSttCapabilityAdapter(() => getSTTProviderRegistry());
    const snapshot = new CapabilityRowSnapshot(store);
    const resolve = () => resolveCapabilityProvider(adapter, { capability: 'stt', principal: userCapabilityPrincipal(PERSON as { sub: string; isOperator: boolean }), appId: null, agentId: null }, { rows: snapshot });
    expect(await resolve()).toMatchObject({ ok: false, missing: 'rows-not-loaded' });
    await snapshot.refresh();
    expect(await resolve()).toMatchObject({ ok: true, providerId: 'gemini-stt', rung: 'swarm-default', source: 'global-config.json voice.stt.default' });
    await runWithRequestIdentity(OPERATOR, () => store.upsert(CAPABILITY_FLEET_SCOPE, 'stt', 'local-stt', {}, OPERATOR.sub));
    await snapshot.refresh();
    expect(await resolve()).toMatchObject({ ok: true, providerId: 'local-stt', rung: 'swarm-default', source: 'row' });
    await runWithRequestIdentity(OPERATOR, () => store.remove(CAPABILITY_FLEET_SCOPE, 'stt'));
    await snapshot.refresh();
    expect(await resolve()).toMatchObject({ ok: true, providerId: 'gemini-stt', source: 'global-config.json voice.stt.default' });
    snapshot.stop();
  }, 30_000);
});

/** The request identity a session would establish, plus the authenticated OIDC user the routes read. */
function testSession(req: Request, _res: Response, next: NextFunction): void {
  const sub = typeof req.headers['x-test-sub'] === 'string' ? req.headers['x-test-sub'] : null;
  if (sub) (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
  runWithRequestIdentity({ sub, isOperator: sub === OPERATOR.sub }, () => next());
}

describe('end to end: one operator PUT moves the next dictation, with no restart', () => {
  let server: Server;
  let base = '';
  let snapshot: CapabilityRowSnapshot;

  beforeAll(async () => {
    await runWithRequestIdentity(OPERATOR, () => store.remove(CAPABILITY_FLEET_SCOPE, 'stt'));
    resetSTTProviderRegistryForTesting();
    const registry = getSTTProviderRegistry();
    for (const id of ['gemini-stt', 'local-stt']) {
      vi.spyOn(registry.get(id)!, 'getStatus').mockResolvedValue({ configured: true, providerId: id });
      vi.spyOn(registry.get(id)!, 'transcribe').mockResolvedValue({ providerId: id, text: `heard by ${id}` });
    }
    snapshot = new CapabilityRowSnapshot(store);
    await snapshot.refresh();
    installCapabilityRowSnapshot(snapshot);
    const app = express();
    app.use(express.json());
    app.use(testSession);
    app.use('/api/voice', createVoiceRoutes());
    app.use('/api/capability-providers', createCapabilityProviderRoutes({
      store, snapshot: () => snapshot, adapters: capabilityProviderAdapters, voice: new VoiceService(),
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    base = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    snapshot?.stop();
    installCapabilityRowSnapshot(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const dictate = async (sub: string) => {
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('RIFF-not-really-audio')], { type: 'audio/wav' }), 'clip.wav');
    const res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'x-test-sub': sub }, body: form });
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> } };
  };
  const put = (sub: string | null, body: unknown) => fetch(`${base}/api/capability-providers/swarm/stt`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...(sub ? { 'x-test-sub': sub } : {}) }, body: JSON.stringify(body) });

  it('before: the seed answers a person\'s dictation (gemini-stt, swarm-default)', async () => {
    const out = await dictate(PERSON.sub);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ providerId: 'gemini-stt', text: 'heard by gemini-stt', rung: 'swarm-default' });
  }, 30_000);

  it('a non-operator\'s PUT and a session-less PUT are refused before anything is written', async () => {
    expect((await put(PERSON.sub, { providerId: 'local-stt' })).status).toBe(403);
    const sessionless = await put(null, { providerId: 'local-stt' });
    expect(sessionless.status).toBe(403);
    expect((await sessionless.json() as { error: string }).error).toBe('operator_session_required');
    expect(await runWithSystemIdentity(() => store.get(CAPABILITY_FLEET_SCOPE, 'stt'))).toBeNull();
  }, 30_000);

  it('ONE operator PUT moves the very next dictation to local-stt at the swarm-default rung — no restart', async () => {
    const res = await put(OPERATOR.sub, { providerId: 'local-stt' });
    expect(res.status).toBe(200);
    const body = await res.json() as { row: { providerId: string; updatedBy: string }; availability: { available: boolean }; swarmDefault: { source: string } };
    expect(body.row).toMatchObject({ providerId: 'local-stt', updatedBy: OPERATOR.sub });
    expect(body.availability.available).toBe(true);
    expect(body.swarmDefault.source).toBe('row');
    const out = await dictate(PERSON.sub);
    expect(out.body.data).toMatchObject({ providerId: 'local-stt', text: 'heard by local-stt', rung: 'swarm-default' });
  }, 30_000);

  it('an unknown provider is a 400 naming the accepted ids, and nothing changes', async () => {
    const res = await put(OPERATOR.sub, { providerId: 'whisper-9000' });
    expect(res.status).toBe(400);
    // The config's STT providers merge over the built-in defaults, so google-cloud-stt is registered too.
    expect(await res.json()).toMatchObject({ code: 'unknown_provider', accepted: ['browser', 'gemini-stt', 'google-cloud-stt', 'local-stt'] });
    expect((await dictate(PERSON.sub)).body.data).toMatchObject({ providerId: 'local-stt' });
  }, 30_000);

  it('DELETE returns the capability to its seed for the next dictation', async () => {
    const res = await fetch(`${base}/api/capability-providers/swarm/stt`, { method: 'DELETE', headers: { 'x-test-sub': OPERATOR.sub } });
    expect(res.status).toBe(200);
    expect((await dictate(PERSON.sub)).body.data).toMatchObject({ providerId: 'gemini-stt', rung: 'swarm-default' });
  }, 30_000);
});
