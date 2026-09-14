/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise registered-source delivery, current rights and exact-principal preferences through PostgreSQL and Express.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { JarvisBriefingService } from '@/app/composition/jarvis-briefing-service';
import { buildOpenWorkBlock } from '@/app/routes/jarvis-task-store';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { validateBriefingDeclarations } from '@/shared/briefings';
import { createBriefingAccessCheck } from '@/app/composition/jarvis-briefing-wiring';
import { AUTONOMOUS_SCENARIOS } from '@/app/routes/test-lab-autonomous-scenarios';
import { SwarmAppService, type SwarmApplicationRecord, type SwarmAppManifest } from '@/features/swarm-apps';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { packageManifest, writeTestPackage } from '../fixtures/package-testing';
import { startBriefingFixture, alice, otherIssuer, source, sourceId } from '../fixtures/jarvis-briefings';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let fixture: Awaited<ReturnType<typeof startBriefingFixture>>;
beforeAll(async () => { fixture = await startBriefingFixture(); }, 120_000);
beforeEach(async () => {
  await fixture.pool.query('TRUNCATE jarvis_tasks,jarvis_briefing_preferences,jarvis_briefing_cursors');
  fixture.state.allowed = true; fixture.state.recipient = alice;
  await fixture.service.register('briefing-fixture', '1.0.0', [source]);
});
afterAll(async () => { await fixture?.stop(); });

it('discovers registered sources and preserves untouched delivery through the actual scheduled task writer and task HTTP route', async () => {
  const catalog = await (await fixture.call()).json();
  expect(catalog.sources[0]).toMatchObject({ sourceId, preference: { enabled: true, frequency: 'as-available', channel: 'voice' } });
  expect(await fixture.publish('fresh-source-task')).toBe(true);
  const response = await fetch(fixture.base + '/api/jarvis/tasks', { headers: { 'x-fixture-auth': '1' } });
  expect(await response.json()).toMatchObject({ tasks: [{ id: 'fresh-source-task', briefing: { sourceId, channel: 'voice' } }] });
  expect(await (await fixture.call('/claim', 'POST', { taskIds: ['fresh-source-task'] })).json()).toEqual({ claimed: [{ id: 'fresh-source-task', channel: 'voice' }] });
  expect(await fixture.service.claim(alice, ['fresh-source-task'])).toEqual({ claimed: [] });
});

it('disabling immediately suppresses new scheduled delivery and hides already queued source tasks', async () => {
  await fixture.publish('queued-before-disable');
  expect((await fixture.call('/' + sourceId, 'PUT', { enabled: false, frequency: 'daily', channel: 'screen' })).status).toBe(200);
  expect(await fixture.publish('suppressed-after-disable')).toBe(false);
  expect(await fixture.service.claim(alice, ['queued-before-disable'])).toEqual({ claimed: [] });
  expect(await fixture.service.visibleTasks(alice, (await fixture.pool.query('SELECT * FROM jarvis_tasks')).rows)).toEqual([]);
  expect((await fixture.pool.query('SELECT id FROM jarvis_tasks')).rows).toEqual([{ id: 'queued-before-disable' }]);
});

it('frequency claims are atomic across browsers, persist across service reconstruction, and batch the due source once', async () => {
  await fixture.service.savePreference(alice, sourceId, { enabled: true, frequency: 'hourly', channel: 'bubble' });
  await fixture.publish('first'); const now = new Date('2026-09-11T12:00:00Z');
  const results = await Promise.all([fixture.service.claim(alice, ['first'], now), fixture.service.claim(alice, ['first'], now)]);
  expect(results.flatMap(result => result.claimed)).toEqual([{ id: 'first', channel: 'bubble' }]);
  await fixture.publish('second'); await fixture.publish('third');
  const restarted = new JarvisBriefingService(fixture.pool, { resolveRecipient: async () => alice, canAccess: async () => true });
  expect((await restarted.catalog(alice)).sources).toEqual([]);
  await restarted.register('briefing-fixture', '1.0.0', [source]);
  expect(await restarted.claim(alice, ['second','third'], new Date(now.getTime() + 3_599_999))).toEqual({ claimed: [] });
  expect((await restarted.claim(alice, ['second','third'], new Date(now.getTime() + 3_600_000))).claimed).toHaveLength(2);
});

it('concurrent claims leave pool capacity for fresh authority reads and preserve one winning announcement', async () => {
  await fixture.publish('pool-contention');
  const raw = new Pool({ ...fixture.pool.options, password: fixture.pool.options.password, max: 2, connectionTimeoutMillis: 500 });
  const pool = wrapPoolWithGuc(raw);
  const canAccess = async () => runWithRequestIdentity({ sub: alice.sub, principalIssuer: alice.issuer, isOperator: false }, async () => {
    const result = await pool.query("SELECT current_setting('oshal.current_sub') AS sub,current_setting('oshal.is_operator') AS operator");
    expect(result.rows[0]).toEqual({ sub: alice.sub, operator: 'off' }); return true;
  });
  const services = [0, 1].map(() => new JarvisBriefingService(pool, { resolveRecipient: async () => alice, canAccess }));
  try {
    for (const service of services) await service.register('briefing-fixture', '1.0.0', [source]);
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => services[index % 2].claim(alice, ['pool-contention'])));
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? outcome.value.claimed : [])).toEqual([{ id: 'pool-contention', channel: 'voice' }]);
    expect((await fixture.pool.query('SELECT * FROM jarvis_briefing_cursors')).rowCount).toBe(1);
  } finally { await raw.end(); }
});

it.each([1, 2])('bounds authority starvation with %i total connections, rolls back claims and ignores a late successful read', async maximum => {
  await fixture.publish('single-pool');
  const raw = new Pool({ ...fixture.pool.options, password: fixture.pool.options.password, max: maximum, connectionTimeoutMillis: 5_000 });
  const pool = wrapPoolWithGuc(raw);
  const occupied = maximum > 1 ? await raw.connect() : undefined;
  let completed = 0;
  const service = new JarvisBriefingService(pool, { resolveRecipient: async () => alice, canAccess: async () => {
    await pool.query('SELECT 1'); completed += 1; return true;
  } });
  try {
    await service.register('briefing-fixture', '1.0.0', [source]);
    await expect(service.claim(alice, ['single-pool'])).rejects.toThrow('briefing_authority_timeout');
    await vi.waitFor(() => expect(completed).toBe(2));
    expect((await raw.query("SELECT delivered FROM jarvis_tasks WHERE id='single-pool'")).rows[0].delivered).toBe(false);
    expect((await raw.query('SELECT * FROM jarvis_briefing_cursors')).rowCount).toBe(0);
  } finally { occupied?.release(); await raw.end(); }
});

it('bounds recipient refresh starvation before publication and never invokes the task writer after timeout', async () => {
  const raw = new Pool({ ...fixture.pool.options, password: fixture.pool.options.password, max: 1, connectionTimeoutMillis: 5_000 });
  const pool = wrapPoolWithGuc(raw); const write = vi.fn(async () => true);
  let completed = 0;
  const service = new JarvisBriefingService(pool, { resolveRecipient: async () => {
    await pool.query('SELECT 1'); completed += 1; return alice;
  }, canAccess: async () => true });
  try {
    await service.register('briefing-fixture', '1.0.0', [source]);
    await expect(service.publish(alice.sub, source.sessionId, write)).rejects.toThrow('briefing_authority_timeout');
    await vi.waitFor(() => expect(completed).toBe(2));
    expect(write).not.toHaveBeenCalled();
    expect((await raw.query('SELECT * FROM jarvis_tasks')).rowCount).toBe(0);
  } finally { await raw.end(); }
});

it('keeps a source retracted when an earlier activation commits during retirement', async () => {
  const client = await fixture.pool.connect();
  let loading: Promise<void> | undefined, retiring: Promise<void> | undefined;
  try {
    await client.query('BEGIN'); await client.query('LOCK TABLE jarvis_briefing_sources IN SHARE MODE');
    loading = fixture.service.register('briefing-fixture', '2.0.0', [source]);
    await vi.waitFor(async () => expect(Number((await fixture.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE jarvis_briefing_sources%' ")).rows[0].count)).toBe(1));
    retiring = fixture.service.unregister('briefing-fixture');
    expect((await fixture.service.catalog(alice)).sources).toEqual([]);
    await client.query('COMMIT'); await Promise.all([loading, retiring]);
    expect((await fixture.service.catalog(alice)).sources).toEqual([]);
    expect((await fixture.pool.query('SELECT active FROM jarvis_briefing_sources WHERE source_id=$1', [sourceId])).rows[0].active).toBe(false);
  } finally { await client.query('ROLLBACK'); client.release(); await Promise.all([loading, retiring]); }
});

it('separates identical subjects across issuers and refuses body-supplied actors and unsupported channels', async () => {
  await fixture.publish('issuer-first');
  await fixture.service.savePreference(otherIssuer, sourceId, { enabled: false, frequency: 'weekly', channel: 'screen' });
  expect((await fixture.service.catalog(alice)).sources[0].preference.enabled).toBe(true);
  expect(await fixture.service.claim(otherIssuer, ['issuer-first'])).toEqual({ claimed: [] });
  const response = await fetch(fixture.base + '/api/jarvis/tasks', { headers: { 'x-fixture-auth': '1', 'x-fixture-issuer': 'other' } });
  expect(await response.json()).toEqual({ tasks: [] });
  expect((await fixture.call('/' + sourceId, 'PUT', { enabled: true, frequency: 'daily', channel: 'voice', actor: alice })).status).toBe(400);
  expect((await fixture.call('/' + sourceId, 'PUT', { enabled: true, frequency: 'daily', channel: 'sms' })).status).toBe(400);
  expect((await fixture.call('/' + sourceId, 'PUT', { enabled: true, frequency: 'daily', channel: 'voice' }, { Origin: 'https://foreign.fixture.test' })).status).toBe(403);
  expect((await fetch(fixture.base + '/api/jarvis/briefings')).status).toBe(401);
});

it('quarantines unqualified legacy source rows from HTTP and prompt fallback but retains ordinary user work', async () => {
  await fixture.pool.query(`INSERT INTO jarvis_tasks(id,user_sub,session_id,title,status,result) VALUES
    ('legacy',$1,$2,'Legacy source','done','DO NOT EXPOSE LEGACY SOURCE'),('ordinary',$1,'ordinary-thread','Normal work','done','Normal result')`, [alice.sub, source.sessionId]);
  const rows = (await fixture.pool.query('SELECT * FROM jarvis_tasks')).rows;
  expect((await fixture.service.visibleTasks(alice, rows)).map(row => row.id)).toEqual(['ordinary']);
  const prompt = await runWithRequestIdentity({ sub: alice.sub, principalIssuer: null, isOperator: false }, () => buildOpenWorkBlock({ pool: fixture.pool } as never, alice.sub));
  expect(prompt).toContain('Normal result'); expect(prompt).not.toContain('DO NOT EXPOSE');
});

it('retains source/session ownership after removal and never reclassifies removed pending briefings as ordinary work', async () => {
  await fixture.publish('retired-task'); await fixture.service.unregister('briefing-fixture');
  expect((await fixture.service.catalog(alice)).sources).toEqual([]);
  expect(await fixture.publish('retired-producer')).toBe(false);
  expect(await fixture.service.claim(alice, ['retired-task'])).toEqual({ claimed: [] });
  await expect(fixture.service.register('other-app', '1.0.0', [source])).rejects.toThrow();
  expect(await fixture.service.ordinaryTasks((await fixture.pool.query('SELECT * FROM jarvis_tasks')).rows)).toEqual([]);
});

it('rechecks permission revocation after waiting for the preference lock', async () => {
  await fixture.publish('revoked-while-waiting');
  const client = await fixture.pool.connect(); let pending: ReturnType<typeof fixture.service.claim> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([alice.issuer,alice.sub,sourceId])]);
    pending = fixture.service.claim(alice, ['revoked-while-waiting']);
    await vi.waitFor(async () => expect(Number((await fixture.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory'")).rows[0].count)).toBeGreaterThan(0));
    fixture.state.allowed = false; await client.query('COMMIT');
    expect(await pending).toEqual({ claimed: [] });
    expect((await fixture.pool.query("SELECT delivered FROM jarvis_tasks WHERE id='revoked-while-waiting'")).rows[0].delivered).toBe(false);
  } finally { await client.query('ROLLBACK'); client.release(); await pending; }
});

it('refuses ambiguous recipients and fails closed when preferences cannot be read', async () => {
  fixture.state.recipient = null; expect(await fixture.publish('ambiguous')).toBe(false); fixture.state.recipient = alice;
  await fixture.pool.query('ALTER TABLE jarvis_briefing_preferences RENAME TO fixture_hidden_preferences');
  try { expect(await fixture.publish('unavailable')).toBe(false); }
  finally { await fixture.pool.query('ALTER TABLE fixture_hidden_preferences RENAME TO jarvis_briefing_preferences'); }
});

it('rejects malformed, duplicate and unowned-bot declarations before registration', () => {
  expect(validateBriefingDeclarations([source])).toEqual([source]);
  expect(() => validateBriefingDeclarations([source, source])).toThrow();
  expect(() => validateBriefingDeclarations([{ ...source, channel: 'sms' }])).toThrow();
  expect(() => validateBriefingDeclarations([{ ...source, botAgentId: '12345678-1234-4234-8234-123456789abc' }])).toThrow();
  expect(() => validateBriefingDeclarations([source], [], true)).toThrow('owned bot authorization binding');
});

it('keeps ordinary work visible behind more than one page of disabled source rows', async () => {
  await fixture.pool.query(`INSERT INTO jarvis_tasks(id,user_sub,session_id,title,status,result,created_at)
    VALUES('older-work',$1,'ordinary-thread','Ordinary work','done','ORDINARY RETAINED',NOW()-INTERVAL '1 day')`, [alice.sub]);
  await fixture.pool.query(`INSERT INTO jarvis_tasks(id,user_sub,session_id,briefing_source_id,principal_issuer,title,status,result)
    SELECT 'hidden-'||n,$1,$2,$3,$4,'Hidden source','done','HIDDEN SOURCE' FROM generate_series(1,120)n`, [alice.sub,source.sessionId,sourceId,otherIssuer.issuer]);
  const response = await fetch(fixture.base + '/api/jarvis/tasks', { headers: { 'x-fixture-auth': '1' } });
  expect((await response.json()).tasks.map((row: { id: string }) => row.id)).toEqual(['older-work']);
  const prompt = await runWithRequestIdentity({ sub: alice.sub, principalIssuer: null, isOperator: false }, () => buildOpenWorkBlock({ pool: fixture.pool } as never, alice.sub));
  expect(prompt).toContain('ORDINARY RETAINED'); expect(prompt).not.toContain('HIDDEN SOURCE');
});

it('ordinary chat cannot claim an active or retired producer session', async () => {
  for (const retire of [false, true]) {
    if (retire) await fixture.service.unregister('briefing-fixture');
    const response = await fetch(fixture.base + '/api/jarvis/ask', { method: 'POST', headers: { 'x-fixture-auth': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Fixture ordinary chat', sessionId: source.sessionId }) });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'session_not_found' });
  }
  expect((await fixture.pool.query('SELECT id FROM jarvis_tasks')).rows).toEqual([]);
});

it('pagination retains microsecond timestamps when hidden and ordinary rows share a creation instant', async () => {
  await fixture.pool.query(`INSERT INTO jarvis_tasks(id,user_sub,session_id,briefing_source_id,principal_issuer,title,status,created_at)
    SELECT 'z-hidden-'||n,$1,$2,$3,$4,'Hidden','done','2026-09-11T12:00:00.123456Z' FROM generate_series(1,100)n`,
  [alice.sub,source.sessionId,sourceId,otherIssuer.issuer]);
  await fixture.pool.query(`INSERT INTO jarvis_tasks(id,user_sub,session_id,title,status,created_at)
    SELECT 'a-ordinary-'||n,$1,'normal-thread','Ordinary','done','2026-09-11T12:00:00.123456Z' FROM generate_series(1,55)n`, [alice.sub]);
  const rows = await fixture.service.listTasks(alice.sub, alice, 50);
  expect(rows).toHaveLength(50); expect(rows.every(row => row.id.startsWith('a-ordinary-'))).toBe(true);
});

it('rechecks source generation when it retires during an awaited final access check', async () => {
  await fixture.publish('retiring');
  let checking = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(done => { entered = done; });
  const blocked = new Promise<void>(done => { release = done; });
  const service = new JarvisBriefingService(fixture.pool, { resolveRecipient: async () => alice, canAccess: async () => {
    if (++checking === 3) { entered(); await blocked; } return true;
  } });
  await service.register('briefing-fixture', '1.0.0', [source]);
  const pending = service.claim(alice, ['retiring']); await waiting;
  await service.unregister('briefing-fixture'); release();
  expect(await pending).toEqual({ claimed: [] });
  expect((await fixture.pool.query("SELECT delivered FROM jarvis_tasks WHERE id='retiring'")).rows[0].delivered).toBe(false);
});

it('refreshes current account state after waiting on a claim lock even for legacy apps', async () => {
  await fixture.publish('account-disabled'); let active = true;
  const service = new JarvisBriefingService(fixture.pool, { resolveRecipient: async () => alice,
    canAccess: createBriefingAccessCheck({ targetActor: async () => ({ ...alice, isActive: active }), isProtected: async () => false,
      runtime: { canDiscover: async () => true } as never }) });
  await service.register('briefing-fixture', '1.0.0', [source]);
  const client = await fixture.pool.connect(); let pending: ReturnType<typeof service.claim> | undefined;
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([alice.issuer,alice.sub,sourceId])]);
    pending = service.claim(alice, ['account-disabled']);
    await vi.waitFor(async () => expect(Number((await fixture.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory'")).rows[0].count)).toBeGreaterThan(0));
    active = false; await client.query('COMMIT'); expect(await pending).toEqual({ claimed: [] });
  } finally { await client.query('ROLLBACK'); client.release(); await pending; }
});

it('control-table RLS denies ordinary database sessions and accepts the real on operator value', async () => {
  const client = await fixture.pool.connect();
  try {
    await client.query('CREATE ROLE briefing_rls_fixture NOLOGIN');
    await client.query('GRANT SELECT,INSERT ON jarvis_briefing_sources,jarvis_briefing_preferences TO briefing_rls_fixture');
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE briefing_rls_fixture');
    await client.query("SELECT set_config('oshal.is_operator','off',true)");
    expect((await client.query('SELECT * FROM jarvis_briefing_sources')).rows).toEqual([]);
    await client.query("SELECT set_config('oshal.is_operator','on',true)");
    expect((await client.query('SELECT * FROM jarvis_briefing_sources')).rows).toHaveLength(1);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

it('registered Lab catalog probe reads caller preferences without changing cursors or task delivery', async () => {
  await fixture.publish('lab-read-only'); vi.stubEnv('PORT', new URL(fixture.base).port);
  try {
    const step = AUTONOMOUS_SCENARIOS.find(item => item.id === 'jarvis-briefing-preferences')!.steps[0];
    expect((await step.run('briefing-fixture=1')).state).toBe('pass');
    expect((await fixture.pool.query('SELECT * FROM jarvis_briefing_preferences')).rowCount).toBe(0);
    expect((await fixture.pool.query('SELECT * FROM jarvis_briefing_cursors')).rowCount).toBe(0);
    expect((await fixture.pool.query("SELECT delivered FROM jarvis_tasks WHERE id='lab-read-only'")).rows[0].delivered).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

it('real manifest load registers sources and disable retracts route, Lab and authorization before delayed persistence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oshal-briefing-lifecycle-')); const events: string[] = [];
  let record: SwarmApplicationRecord | null = null, release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const manifest = { ...packageManifest('briefing-fixture'), uses: ['test-catalog', 'jarvis-briefings'], briefings: [source] };
  const repo = { findByName: async () => record, list: async () => record ? [record] : [],
    upsert: async (value: SwarmAppManifest, path: string) => {
      record = { name: value.name, displayName: value.displayName, version: value.version, status: value.status,
        manifestPath: path, manifest: value, agentIds: [], toolNames: [], scope: 'public' } as SwarmApplicationRecord; return record;
    }, updateStatus: async (_name: string, status: 'active' | 'inactive') => { record = record ? { ...record, status } : null; return record; } };
  const service = new SwarmAppService(fixture.pool, repo as never, {} as never, undefined, undefined, undefined,
    { mount: async () => undefined, unmount: () => { events.push('routes'); } } as never, undefined, undefined, undefined, undefined,
    { prepare: async () => undefined, start: async () => undefined, complete: () => undefined, unregister: () => { events.push('authorization'); } } as never, undefined,
    { register: (...args) => fixture.service.register(...args), unregister: async app => {
      events.push('briefings'); await fixture.service.unregister(app); await blocked;
    } });
  let pending: Promise<unknown> | undefined;
  try {
    const pkg = writeTestPackage(root, manifest); await service.loadApp(pkg.file);
    expect((await fixture.service.catalog(alice)).sources).toHaveLength(1);
    expect(service.testLabCatalog.list(new Map([['briefing-fixture','Fixture']])).length).toBeGreaterThan(0);
    pending = service.toggleApp('briefing-fixture', false);
    await vi.waitFor(() => expect(events).toContain('briefings'));
    expect(events.slice(0,3)).toEqual(['authorization','routes','briefings']);
    expect(service.testLabCatalog.list(new Map([['briefing-fixture','Fixture']]))).toEqual([]);
    expect((await fixture.service.catalog(alice)).sources).toEqual([]);
    release(); await pending;
    writeFileSync(pkg.file, yaml.dump({ ...manifest, briefings: [{ ...source, botAgentId: '12345678-1234-4234-8234-123456789abc' }] }));
    await expect(service.loadApp(pkg.file)).rejects.toThrow('belong');
  } finally {
    release(); await pending;
    if (!relative(resolve(tmpdir()), resolve(root)).startsWith('oshal-briefing-lifecycle-')) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
