/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b real-boundary guard for the provider offers and TTS/STT spend, on the boot sequence end to end: a disposable PostgreSQL with the WHOLE migration tree (183 and 184 included), apply-rls.mjs enforcing, and the real provisioner's final phase minting oshal_app — then everything as that enforcing role behind the real GUC pool wrapper. Proves: a non-operator's offer write is refused by the table (42501) while every identity reads the offers; the CHECKs refuse a negative price and an unknown audience; the snapshot reads the price; a TTS call and an STT call through the REAL VoiceService and the REAL spend recorder each land ONE oshal_cost_events row and a chat_tasks rollup owned by the caller and carrying the accountable bot, at units times the offer price (characters; seconds measured from a WAV); a free provider writes nothing; another person cannot see those rows; and a system call is the swarm's own row with no owner. Doubles: only the speech providers' credential probes and vendor calls.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseBootstrapService } from '@/features/tool-registry';
import { provisionRuntimeRoles } from '../../scripts/governance/provision-app-role.mjs';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { CAPABILITY_FLEET_SCOPE, CapabilityRowSnapshot, systemCapabilityPrincipal, userCapabilityPrincipal, type CapabilityCaller } from '@/shared/capability-providers';
import { CapabilityOfferStore, CapabilitySwarmRowStore, createCapabilitySpendRecorder } from '@/features/capability-providers';
import { VoiceService } from '../../src/features/voice/services/voice-service';
import { getSTTProviderRegistry, resetSTTProviderRegistryForTesting } from '../../src/features/voice-providers/services/stt-provider-registry';
import { getTTSProviderRegistry, resetTTSProviderRegistryForTesting } from '../../src/features/voice-providers/services/tts-provider-registry';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BOT = 'a0000000-0000-0000-0000-000000000050';
const OPERATOR = { sub: 'spend-operator-sub', isOperator: true };
const PERSON = { sub: 'spend-person-a', isOperator: false };
const OTHER = { sub: 'spend-person-b', isOperator: false };
const appPassword = randomBytes(24).toString('hex');
const botPassword = randomBytes(24).toString('hex');
const db = new DisposablePostgres({ purpose: 'capability-offers-spend', image: 'pgvector/pgvector:pg16', database: 'oshal', memory: '512m', max: 4, statementTimeoutMs: 120_000 });
let app: Pool;
let snapshot: CapabilityRowSnapshot;
const savedBootstrap = process.env.OSHAL_SCHEMA_BOOTSTRAP;

const url = (user: string, password: string): string => {
  const { host, port, database } = db.connection;
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
};

/** A one-second 16 kHz mono 16-bit WAV. */
function oneSecondWav(): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + 32_000, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16_000, 24); head.writeUInt32LE(32_000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(32_000, 40);
  return Buffer.concat([head, Buffer.alloc(32_000)]);
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_DB_GUC', 'on');
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  vi.stubEnv('RUN_MIGRATIONS', 'true');
  delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
  await db.start();
  await new DatabaseBootstrapService(db.pool, resolve(REPO_ROOT, 'scripts', 'migrations')).applyMigrations();
  const { user, password } = db.connection;
  execFileSync(process.execPath, ['scripts/governance/apply-rls.mjs'], {
    cwd: REPO_ROOT, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: url(user, password), OSHAL_RLS_APPLY: 'apply-enforce' },
  });
  // A named object, not a literal: the provisioner's inferred parameter type lists only its defaulted keys.
  const roles = { bootstrapUrl: url(user, password), appUrl: url('oshal_app', appPassword), botUrl: url('oshal_bot', botPassword), phase: 'final' };
  await provisionRuntimeRoles(roles);
  const { host, port, database } = db.connection;
  app = wrapPoolWithGuc(new Pool({ host, port, database, user: 'oshal_app', password: appPassword, max: 4 }));
  const rows = new CapabilitySwarmRowStore(app);
  const offers = new CapabilityOfferStore(app);
  snapshot = new CapabilityRowSnapshot({ listAll: () => rows.listAll(), listOffers: () => offers.listAll() });
  resetSTTProviderRegistryForTesting();
  resetTTSProviderRegistryForTesting();
  for (const id of ['gemini-stt', 'local-stt']) {
    vi.spyOn(getSTTProviderRegistry().get(id)!, 'getStatus').mockResolvedValue({ configured: true, providerId: id });
    vi.spyOn(getSTTProviderRegistry().get(id)!, 'transcribe').mockResolvedValue({ providerId: id, text: 'hello there' });
  }
  const tts = getTTSProviderRegistry().get('google-cloud-tts')!;
  vi.spyOn(tts, 'getStatus').mockResolvedValue({ configured: true, providerId: 'google-cloud-tts' });
  vi.spyOn(tts, 'listVoices').mockResolvedValue([]);
  vi.spyOn(tts, 'synthesize').mockResolvedValue({ providerId: 'google-cloud-tts', audio: Buffer.from('mp3'), audioFormat: 'audio/mpeg' });
}, 420_000);

afterAll(async () => {
  snapshot?.stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSTTProviderRegistryForTesting();
  resetTTSProviderRegistryForTesting();
  if (savedBootstrap === undefined) delete process.env.OSHAL_SCHEMA_BOOTSTRAP; else process.env.OSHAL_SCHEMA_BOOTSTRAP = savedBootstrap;
  try { await app?.end(); } finally { await db.stop(); }
}, 90_000);

const offerStore = () => new CapabilityOfferStore(app);
const rowStore = () => new CapabilitySwarmRowStore(app);
const voice = () => new VoiceService({ rows: snapshot, offers: snapshot, spend: createCapabilitySpendRecorder(app) });
const caller = (sub: string): CapabilityCaller => ({ principal: userCapabilityPrincipal({ sub, isOperator: false }), appId: null, agentId: BOT });

describe('provider offers on the enforcing role (migration 184)', () => {
  it('the operator writes prices; a non-operator is refused by the table; every identity reads', async () => {
    await runWithRequestIdentity(OPERATOR, () => offerStore().upsert('stt', 'gemini-stt', { unitPriceUsd: 0.0004, quotaLabel: 'shared free tier' }, OPERATOR.sub));
    await runWithRequestIdentity(OPERATOR, () => offerStore().upsert('tts', 'google-cloud-tts', { unitPriceUsd: 0.00003, quotaLabel: null }, OPERATOR.sub));
    await expect(runWithRequestIdentity(PERSON, () => offerStore().upsert('stt', 'gemini-stt', { unitPriceUsd: 0, quotaLabel: null }, PERSON.sub)))
      .rejects.toMatchObject({ code: '42501' });
    const seen = await runWithRequestIdentity(OTHER, () => offerStore().listAll());
    expect(seen.map((o) => `${o.capability}:${o.providerId}:${o.unitPriceUsd}:${o.quotaLabel}`)).toEqual(['stt:gemini-stt:0.0004:shared free tier', 'tts:google-cloud-tts:0.00003:null']);
  }, 30_000);

  it('the CHECKs refuse a negative price and an unknown audience', async () => {
    await expect(runWithRequestIdentity(OPERATOR, () => app.query(`INSERT INTO oshal_capability_provider_offers (capability, provider_id, unit_price_usd) VALUES ('stt', 'local-stt', -1)`)))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => app.query(`INSERT INTO oshal_capability_provider_offers (capability, provider_id, offered_to) VALUES ('stt', 'local-stt', 'world')`)))
      .rejects.toMatchObject({ code: '23514' });
  }, 30_000);

  it('the snapshot reads the swarm rows and the offer prices', async () => {
    await runWithRequestIdentity(OPERATOR, () => rowStore().upsert(CAPABILITY_FLEET_SCOPE, 'tts', 'google-cloud-tts', {}, OPERATOR.sub));
    await runWithRequestIdentity(OPERATOR, () => rowStore().upsert(CAPABILITY_FLEET_SCOPE, 'stt', 'gemini-stt', {}, OPERATOR.sub));
    await snapshot.refresh();
    expect(snapshot.status()).toMatchObject({ loaded: true, rowCount: 2, offerCount: 2 });
    expect(snapshot.offerFor('stt', 'gemini-stt')?.unitPriceUsd).toBe(0.0004);
  }, 30_000);
});

describe('TTS and STT spend lands as the caller\'s own rows, with the bot (ADR-173 D4)', () => {
  const ledgerFor = (sub: string | null) => db.pool.query<{ provider_id: string; owner_sub: string | null; agent_id: string; cost_usd: string }>(
    `SELECT provider_id, owner_sub, agent_id, cost_usd::text FROM oshal_cost_events WHERE owner_sub IS NOT DISTINCT FROM $1 ORDER BY id`, [sub]);

  it('a TTS call writes one ledger row and a rollup: 11 characters at the offer price, the bot and the caller', async () => {
    const out = await runWithRequestIdentity(PERSON, () => voice().synthesizeSpeech('hello world', undefined, undefined, { caller: caller(PERSON.sub) }));
    expect(out.providerId).toBe('google-cloud-tts');
    const ledger = await ledgerFor(PERSON.sub);
    expect(ledger.rows).toEqual([{ provider_id: 'tts:google-cloud-tts', owner_sub: PERSON.sub, agent_id: BOT, cost_usd: '0.000330' }]);
    const rollup = await db.pool.query<{ agent_id: string; owner_sub: string; total_cost: number; total_requests: number }>(
      `SELECT agent_id, owner_sub, total_cost, total_requests FROM chat_tasks WHERE task_id LIKE 'capability-tts-google-cloud-tts-%'`);
    expect(rollup.rows).toHaveLength(1);
    expect(rollup.rows[0]).toMatchObject({ agent_id: BOT, owner_sub: PERSON.sub, total_requests: 1 });
    expect(rollup.rows[0].total_cost).toBeCloseTo(0.00033, 12);
  }, 30_000);

  it('an STT call writes one ledger row: one measured second at the offer price, the bot and the caller', async () => {
    await runWithRequestIdentity(PERSON, () => voice().transcribeAudio(oneSecondWav(), 'audio/wav', { caller: caller(PERSON.sub) }));
    const ledger = await ledgerFor(PERSON.sub);
    expect(ledger.rows[1]).toEqual({ provider_id: 'stt:gemini-stt', owner_sub: PERSON.sub, agent_id: BOT, cost_usd: '0.000400' });
  }, 30_000);

  it('a free provider writes nothing', async () => {
    await runWithRequestIdentity(OPERATOR, () => rowStore().upsert(CAPABILITY_FLEET_SCOPE, 'stt', 'local-stt', {}, OPERATOR.sub));
    await snapshot.refresh();
    const before = (await db.pool.query('SELECT count(*)::int AS n FROM oshal_cost_events')).rows[0].n;
    await runWithRequestIdentity(PERSON, () => voice().transcribeAudio(oneSecondWav(), 'audio/wav', { caller: caller(PERSON.sub) }));
    expect((await db.pool.query('SELECT count(*)::int AS n FROM oshal_cost_events')).rows[0].n).toBe(before);
  }, 30_000);

  it('another person cannot see the caller\'s spend rows; the caller sees their own', async () => {
    const theirs = await runWithRequestIdentity(OTHER, () => app.query(`SELECT count(*)::int AS n FROM oshal_cost_events WHERE agent_id = $1`, [BOT]));
    expect(theirs.rows[0].n).toBe(0);
    const mine = await runWithRequestIdentity(PERSON, () => app.query(`SELECT count(*)::int AS n FROM oshal_cost_events WHERE agent_id = $1`, [BOT]));
    expect(mine.rows[0].n).toBe(2);
  }, 30_000);

  it('a system call is the swarm\'s own row: no owner', async () => {
    await runWithRequestIdentity(OPERATOR, () => rowStore().upsert(CAPABILITY_FLEET_SCOPE, 'stt', 'gemini-stt', {}, OPERATOR.sub));
    await snapshot.refresh();
    await runWithSystemIdentity(() => voice().transcribeAudio(oneSecondWav(), 'audio/wav', {
      caller: { principal: systemCapabilityPrincipal('scheduled transcription'), appId: null, agentId: BOT },
    }));
    expect((await ledgerFor(null)).rows).toEqual([{ provider_id: 'stt:gemini-stt', owner_sub: null, agent_id: BOT, cost_usd: '0.000400' }]);
  }, 30_000);
});
