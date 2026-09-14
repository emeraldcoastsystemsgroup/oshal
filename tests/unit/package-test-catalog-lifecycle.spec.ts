/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verify declarative registration through actual activation and HTTP boundaries without executing package suites.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SwarmAppService, type SwarmAppManifest, type SwarmApplicationRecord } from '@/features/swarm-apps';
import { createTestLabRoutes } from '@/app/routes/test-lab-routes';
import { packageManifest, packageTestCase, writeTestPackage } from '../fixtures/package-testing';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let root: string, server: Server, base: string, service: SwarmAppService;
let records: Map<string, SwarmApplicationRecord>, writes: number, smokeCalls: number;
let activation: () => Promise<void>;

function newService() {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const repo = {
    findByName: async (name: string) => records.get(name) ?? null,
    list: async (status?: string) => [...records.values()].filter(row => !status || row.status === status),
    upsert: async (manifest: SwarmAppManifest, file: string) => {
      writes++;
      const record: SwarmApplicationRecord = { appId: manifest.name, name: manifest.name, displayName: manifest.displayName,
        description: '', version: manifest.version || '1.0.0', status: manifest.status || 'active', manifestPath: file,
        agentIds: [], toolNames: [], manifest, scope: manifest.name.startsWith('private') ? 'person' : 'public', ownerSub: 'owner', tenantId: null,
        guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
      records.set(record.name, record); return record;
    },
    updateStatus: async (name: string, status: 'active' | 'inactive') => {
      writes++; const row = records.get(name); if (!row) return null;
      const updated = { ...row, status }; records.set(name, updated); return updated;
    },
    delete: async (name: string) => records.delete(name),
  };
  return new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { register: () => activation(), unregister: () => undefined });
}
async function catalog(user = 'owner') {
  const response = await fetch(base + '/api/test-lab/catalog', { headers: { cookie: `session=${user}` } });
  expect(response.status).toBe(200); return await response.json() as any;
}
async function run(id: string, user = 'owner', expectedCases?: unknown) {
  const response = await fetch(base + '/api/test-lab/run', { method: 'POST', headers: { cookie: `session=${user}`, 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: id, expectedCases }) });
  return { status: response.status, body: await response.json() as any };
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'oshal-test-catalog-lifecycle-'));
  records = new Map(); writes = 0; smokeCalls = 0; activation = async () => undefined; service = newService();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: req.headers.cookie?.includes('other') ? 'other' : 'owner' } } }); next(); });
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [] }));
  app.get('/api/:app/ready', (_req, res) => { smokeCalls++; res.json({ ready: true }); });
  app.use('/api/test-lab', (req, res, next) => createTestLabRoutes({} as never, {
    installedTests: service.testLabCatalog,
    visibleApps: async request => new Map((await service.listApps('active', { ownerSub: request.headers.cookie?.includes('other') ? 'other' : 'owner' }))
      .map(app => [app.name, app.displayName])), apiBaseUrl: base,
  })(req, res, next));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; vi.stubEnv('PORT', new URL(base).port);
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); vi.unstubAllEnvs();
  if (!relative(resolve(tmpdir()), resolve(root)).startsWith('oshal-test-catalog-lifecycle-')) throw new Error('Unsafe fixture cleanup');
  rmSync(root, { recursive: true, force: true });
});

it('registers local suites alongside legacy smoke, reloads idempotently and removes replaced cases', async () => {
  const fixture = writeTestPackage(root); await service.loadApp(fixture.file); await service.loadApp(fixture.file);
  const initial = await catalog(), cases = initial.scenarios.filter((row: any) => row.installedTest);
  expect(cases.map((row: any) => row.id)).toEqual(['app:catalog-fixture:smoke:ready', 'app:catalog-fixture:test:behavior']);
  expect(cases[1].installedTest).toMatchObject({ caseId: 'behavior', appVersion: '1.0.0', level: 'unit', runnable: false,
    runner: { kind: 'vitest', scope: 'package' }, sideEffects: 'fixture-write', installationEligible: false });
  expect(cases[1].installedTest.source).toMatch(/^local:[a-f0-9]{64}$/);
  expect(initial.installedApps[0].coverage).toBe('catalog');
  expect((await run(cases[1].id)).body.results[0]).toMatchObject({ state: 'degraded', steps: [{ output: { executionStatus: 'pending' } }] });
  expect(smokeCalls).toBe(0);
  expect((await run(cases[0].id)).body.results[0].state).toBe('pass'); expect(smokeCalls).toBe(1);
  fixture.manifest.version = '2.0.0'; writeFileSync(fixture.file, yaml.dump(fixture.manifest));
  writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), yaml.dump({ version: 1, cases: [packageTestCase({ id: 'replacement' })] }));
  await service.loadApp(fixture.file);
  const current = await catalog(); expect(current.installedApps[0]).toMatchObject({ version: '2.0.0', caseIds: ['app:catalog-fixture:smoke:ready', 'app:catalog-fixture:test:replacement'] });
  expect((await run(cases[1].id)).status).toBe(404);
});

it('decorates a smoke without duplicating it and keeps core/browser/additional-prerequisite cases pending', async () => {
  const smoke = packageTestCase({ id: 'ready', level: 'integration', runner: { kind: 'smoke', smoke: 'ready' }, sideEffects: 'none', isolation: { mode: 'none' }, prerequisites: ['account:fixture'], installation: 'never' });
  const core = packageTestCase({ id: 'core-picker', level: 'browser', runner: { kind: 'playwright', scope: 'core', revision: 'a'.repeat(40), files: ['tests/shared-picker.spec.ts'] } });
  const fixture = writeTestPackage(root, packageManifest(), [smoke, core]); await service.loadApp(fixture.file);
  const result = await catalog(), cases = result.scenarios.filter((row: any) => row.installedTest);
  expect(cases).toHaveLength(2); expect(cases[0].id).toBe('app:catalog-fixture:smoke:ready');
  for (const row of cases) expect((await run(row.id)).body.results[0].state).toBe('degraded');
  expect(cases[1].regressionTests[0].path).toBe(`core@${'a'.repeat(40)}:tests/shared-picker.spec.ts`);
  expect(smokeCalls).toBe(0);
});

it('rebuilds after restart, retracts on deactivate/uninstall and refuses private metadata/runs to another viewer', async () => {
  const fixture = writeTestPackage(root, packageManifest('private-fixture')); await service.loadApp(fixture.file);
  expect((await catalog('other')).installedApps).toEqual([]);
  expect((await run('app:private-fixture:test:behavior', 'other')).status).toBe(404);
  service = newService(); expect((await catalog()).installedApps).toEqual([]);
  await service.loadApp(fixture.file); expect((await catalog()).installedApps).toHaveLength(1);
  await service.toggleApp('private-fixture', false); expect((await catalog()).installedApps).toEqual([]);
  await service.toggleApp('private-fixture', true); expect((await catalog()).installedApps).toHaveLength(1);
  await service.unloadApp('private-fixture'); expect((await catalog()).installedApps).toEqual([]);
});

it('binds selected case revisions to source and suite content without exposing provenance secrets', async () => {
  const fixture = writeTestPackage(root); await service.loadApp(fixture.file);
  const visible = new Map([['catalog-fixture', 'Fixture']]);
  const first = service.testLabCatalog.list(visible).find(row => row.caseId === 'behavior')!;
  writeFileSync(join(fixture.dir, 'tests/behavior.spec.ts'), 'throw new Error("new suite bytes");'); await service.loadApp(fixture.file);
  const changed = service.testLabCatalog.list(visible).find(row => row.caseId === 'behavior')!;
  expect(changed.revision).not.toBe(first.revision);
  expect((await service.testLabCatalog.run(first, visible, { apiBaseUrl: base })).error).toContain('changed');
  writeFileSync(join(fixture.dir, '.oshal-install.json'), JSON.stringify({ repo: 'https://token:secret@example.test/repository', registry: 'fixture' }));
  await service.loadApp(fixture.file);
  const replaced = service.testLabCatalog.list(visible).find(row => row.caseId === 'behavior')!;
  expect(replaced.source).not.toBe(changed.source); expect(JSON.stringify(replaced)).not.toContain('token:secret');
  expect((await service.testLabCatalog.run(changed, visible, { apiBaseUrl: base })).status).toBe('pending');
  expect(smokeCalls).toBe(0);
});

it('checks selected HTTP revisions before executing and rejects malformed revision maps', async () => {
  const fixture = writeTestPackage(root); await service.loadApp(fixture.file);
  const id = 'app:catalog-fixture:smoke:ready';
  for (const invalid of [null, [], 'anything', { [id]: 'not-a-revision' }]) {
    expect((await run(id, 'owner', invalid)).status).toBe(400);
  }
  expect((await run(id, 'owner', {})).body.results[0].steps[0].detail).toContain('Case changed after selection');
  expect(smokeCalls).toBe(0);
  const revision = (await catalog()).scenarios.find((row: any) => row.id === id).installedTest.revision;
  expect((await run(id, 'owner', { [id]: revision })).body.results[0].state).toBe('pass');
  expect(smokeCalls).toBe(1);
});

it('preserves the previous registration when malformed replacement validation fails before writes', async () => {
  const fixture = writeTestPackage(root); await service.loadApp(fixture.file);
  const before = await catalog(), priorWrites = writes;
  writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), 'version: 99');
  await expect(service.loadApp(fixture.file)).rejects.toThrow('version'); expect(writes).toBe(priorWrites);
  expect((await catalog()).installedApps).toEqual(before.installedApps);
  expect((await run('app:catalog-fixture:smoke:ready')).body.results[0].state).toBe('pass');
});

it('validates before toggle side effects and compensates a catalog failure discovered after activation', async () => {
  const fixture = writeTestPackage(root); await service.loadApp(fixture.file); await service.toggleApp('catalog-fixture', false);
  writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), 'version: 99'); const before = writes;
  await expect(service.toggleApp('catalog-fixture', true)).rejects.toThrow('version'); expect(writes).toBe(before);
  writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), yaml.dump({ version: 1, cases: [packageTestCase()] }));
  activation = async () => { writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), 'version: 99'); };
  await expect(service.toggleApp('catalog-fixture', true)).rejects.toThrow('version');
  expect(records.get('catalog-fixture')?.status).toBe('inactive'); expect((await catalog()).installedApps).toEqual([]);
});

it('has no orphan cases when a completed package is replaced by a failing activation', async () => {
  const fixture = writeTestPackage(root); await service.loadApp(fixture.file);
  activation = async () => { throw new Error('Fixture activation failed'); };
  await expect(service.loadApp(fixture.file)).rejects.toThrow('Fixture activation failed');
  expect((await catalog()).installedApps).toEqual([]); expect(records.get('catalog-fixture')?.status).toBe('inactive');
});

it('aggregates a code-free group through member case references without copying cases', async () => {
  const member = packageManifest();
  member.ui = { static: [{ toolName: 'member-home', label: 'Member', icon: 'codicon codicon-home', iframeUrl: '/api/catalog-fixture/home' }] };
  member.readiness = [{ name: 'ready', path: '/api/catalog-fixture/state', readyPointer: '/ready' }];
  await service.loadApp(writeTestPackage(root, member).file);
  const group: SwarmAppManifest = { name: 'group-fixture', displayName: 'Group', version: '1.0.0', status: 'active', suite: 'ai-home', kind: 'group',
    dependencies: { apps: ['catalog-fixture'] },
    toolbar: [{ app: 'catalog-fixture', surface: 'member-home' }], setup: [{ label: 'Set up member', app: 'catalog-fixture', readiness: 'ready', fix: 'member-home' }] };
  await service.loadApp(writeTestPackage(root, group).file);
  const result = await catalog();
  expect(result.scenarios.filter((row: any) => row.installedTest)).toHaveLength(2);
  expect(result.installedApps.find((row: any) => row.name === 'group-fixture').caseIds).toEqual([
    'app:catalog-fixture:smoke:ready', 'app:catalog-fixture:test:behavior',
  ]);
});
