/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove installed Test Lab registration through real lifecycle and HTTP boundaries with disposable package/persistence fixtures.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise clearable user prerequisites, explicit malformed-token failures and protected Portrait smoke execution.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Prove real caller session plus service authentication reaches enforced package readiness without weakening principal, redirect, mode or credential boundaries.
 */

import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '@/app/composition/app-context';
import { createTestLabRoutes } from '@/app/routes/test-lab-routes';
import { readManifest, SwarmAppService, type SwarmAppManifest, type SwarmApplicationRecord } from '@/features/swarm-apps';
import { InstalledAppTestCatalog } from '@/features/swarm-apps/services/installed-app-test-catalog';
import { artifactActionsForType } from '@/shared/artifact-exchange';
import { startServiceSmokeFixture, smokeRequest, SMOKE_SECRET } from '../fixtures/service-smoke-session';
import { createPackageExecutionFixture } from '../fixtures/package-test-execution';
import { verifyAppSmokes } from '@/features/swarm-apps';

const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
const ctx = { pool } as unknown as AppContext;
const PAT = `Bearer oshal_pat_${'a'.repeat(48)}`;
let root: string;
let server: Server;
let baseUrl: string;
let originalPort: string | undefined;
let service: SwarmAppService;
let records: Map<string, SwarmApplicationRecord>;
let failActivation = false;
let denyApp = '';
let smokeValue = 'ready';
let hits: Array<{ path: string; secret?: string; authorization?: string }>;

/** @description Construct a fixture that goes through the real manifest validator. */
function manifest(name = 'example', smokeName = 'readiness'): SwarmAppManifest {
  return {
    name, displayName: name, version: '1.0.0', status: 'active', suite: 'ai-home',
    routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: `/api/${name}`, auth: 'service-or-oidc' }],
    smoke: [{ name: smokeName, method: 'GET', path: `/api/${name}/_smoke`, auth: 'service',
      expect: { status: 200, jsonPointer: '/package', rejectValues: ['noop', 'stub', 'empty'] }, requiresAi: false }],
  };
}

/** @description Persist a disposable YAML package and call the actual installer activation boundary. */
async function install(input = manifest()): Promise<SwarmApplicationRecord> {
  const file = join(root, `${input.name}.yaml`);
  writeFileSync(file, yaml.dump(input));
  return service.loadApp(file);
}

/** @description In-memory repository stands in only for persistence; lifecycle orchestration is real. */
function newService(): SwarmAppService {
  const repo = {
    findByName: async (name: string) => records.get(name) ?? null,
    list: async (status?: string) => [...records.values()].filter(r => !status || r.status === status),
    upsert: async (loaded: SwarmAppManifest, file: string) => {
      const record: SwarmApplicationRecord = {
        appId: loaded.name, name: loaded.name, displayName: loaded.displayName,
        description: '', version: loaded.version ?? '1.0.0', status: loaded.status ?? 'active',
        manifestPath: file, agentIds: [], toolNames: [], manifest: loaded,
        scope: loaded.name === 'personal' ? 'person' : 'public',
        ownerSub: loaded.name === 'personal' ? 'owner' : null, tenantId: null, guestTierApproved: null,
        loadedAt: new Date(), updatedAt: new Date(),
      };
      records.set(loaded.name, record);
      return record;
    },
    updateStatus: async (name: string, status: 'active' | 'inactive') => {
      const record = records.get(name);
      if (!record) return null;
      const updated = { ...record, status };
      records.set(name, updated);
      return updated;
    },
    delete: async (name: string) => records.delete(name),
  };
  return new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { register: async () => { if (failActivation) throw new Error('fixture activation failure'); }, unregister: () => undefined });
}

async function catalog(sub = 'operator', authorization?: string) {
  const response = await fetch(`${baseUrl}/api/test-lab/catalog`, { headers: { 'x-test-sub': sub, ...(authorization ? { authorization } : {}) } });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ scenarios: any[]; installedApps: any[] }>;
}

async function run(id: string, sub = 'operator', authorization?: string) {
  return fetch(`${baseUrl}/api/test-lab/run`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-test-sub': sub, ...(authorization ? { authorization } : {}),
  }, body: JSON.stringify({ scenarioId: id, serviceSecret: 'ignored-client-secret', apiBaseUrl: 'https://example.com' }) });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'oshal-installed-tests-'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = String(req.headers['x-test-sub'] ?? '');
    (req as any).oidc = { isAuthenticated: () => !!sub, user: { sub } };
    next();
  });
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [] }));
  app.all('/api/:app/_smoke', (req, res) => {
    hits.push({ path: req.path, secret: req.headers['x-service-secret'] as string | undefined, authorization: req.headers.authorization });
    if (records.get(req.params.app)?.manifest.smoke?.[0].requiresUser && req.headers.authorization !== PAT) {
      res.status(403).json({ error: 'no_current_access' });
      return;
    }
    res.json({ package: smokeValue });
  });
  app.use('/api/test-lab', (req, res, next) => createTestLabRoutes(ctx, {
    installedTests: service.testLabCatalog,
    visibleApps: async request => {
      const sub = String(request.headers['x-test-sub'] ?? '');
      const apps = await service.listApps('active', { ownerSub: sub, isOperator: sub === 'operator' });
      return new Map(apps.filter(app => app.name !== denyApp).map(app => [app.name, app.displayName]));
    },
    executionAuth: request => ({
      serviceSecret: request.headers['x-test-sub'] === 'operator' ? 'fixture-service-secret' : undefined,
      authorization: request.headers.authorization,
    }),
    apiBaseUrl: baseUrl,
  })(req, res, next));
  server = createServer(app);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  originalPort = process.env.PORT;
  process.env.PORT = String((server.address() as AddressInfo).port);
});

beforeEach(() => {
  records = new Map();
  service = newService();
  hits = [];
  failActivation = false;
  denyApp = '';
  smokeValue = 'ready';
});

afterAll(async () => {
  await new Promise<void>((done, reject) => server.close(err => err ? reject(err) : done()));
  if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  rmSync(root, { recursive: true, force: true });
});

describe('installed application Test Lab lifecycle over HTTP', () => {
  it('preserves artifact activation, replacement and teardown alongside test registration', async () => {
    const input = manifest('artifact-lifecycle');
    input.artifacts = { accepts: [{ id: 'open', label: 'Open', types: ['image/png'], mode: 'open' }] };
    await install(input);
    expect(artifactActionsForType('image/png').some(action => action.app === input.name)).toBe(true);
    await install({ ...input, artifacts: undefined });
    expect(artifactActionsForType('image/png').some(action => action.app === input.name)).toBe(false);
    await install(input);
    await service.toggleApp(input.name, false);
    expect(artifactActionsForType('image/png').some(action => action.app === input.name)).toBe(false);
    expect((await catalog()).installedApps).toEqual([]);
  });

  it('registers fresh installs, reloads idempotently, and replaces obsolete cases on upgrade', async () => {
    await install();
    await install();
    const initial = await catalog();
    const cases = initial.scenarios.filter(s => s.installedTest);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ id: 'app:example:smoke:readiness', installedTest: {
      appName: 'example', appVersion: '1.0.0', runnable: true, level: 'integration',
    } });
    const upgraded = manifest('example', 'new-readiness');
    upgraded.version = '2.0.0';
    await install(upgraded);
    const current = await catalog();
    expect(current.installedApps).toEqual([expect.objectContaining({ version: '2.0.0', caseIds: ['app:example:smoke:new-readiness'] })]);
    expect((await run(cases[0].id)).status).toBe(404);
  });

  it('rebuilds after startup reload and retracts on disable, manifest deactivation and uninstall', async () => {
    const installed = await install();
    service = newService();
    expect((await catalog()).installedApps).toEqual([]);
    await service.loadApp(installed.manifestPath);
    expect((await catalog()).installedApps).toHaveLength(1);
    await service.toggleApp('example', false);
    expect((await catalog()).installedApps).toEqual([]);
    await service.toggleApp('example', true);
    expect((await catalog()).installedApps).toHaveLength(1);
    await install({ ...manifest(), status: 'inactive' });
    expect((await catalog()).installedApps).toEqual([]);
    await install();
    await service.unloadApp('example');
    expect((await catalog()).installedApps).toEqual([]);
    expect((await run('app:example:smoke:readiness')).status).toBe(404);
  });

  it('leaves no executable registration after failed activation, including a failed replacement', async () => {
    failActivation = true;
    await expect(install()).rejects.toThrow(/activation failure/);
    expect((await catalog()).installedApps).toEqual([]);
    failActivation = false;
    await install();
    failActivation = true;
    await expect(install(manifest('example', 'replacement'))).rejects.toThrow(/activation failure/);
    expect((await catalog()).installedApps).toEqual([]);
  });

  it('scopes catalog and runs to viewer visibility and current access policy', async () => {
    await install(manifest('personal'));
    expect((await catalog('owner')).installedApps).toHaveLength(1);
    expect((await catalog('other')).installedApps).toEqual([]);
    expect((await run('app:personal:smoke:readiness', 'other')).status).toBe(404);
    denyApp = 'personal';
    expect((await catalog('owner')).installedApps).toEqual([]);
    expect((await run('app:personal:smoke:readiness', 'owner')).status).toBe(404);
    expect(hits).toEqual([]);
  });

  it('uses the real verifier and keeps failed assertions red', async () => {
    await install();
    const passed = await (await run('app:example:smoke:readiness')).json() as any;
    expect(passed.results[0]).toMatchObject({ state: 'pass', steps: [{ output: { executionStatus: 'passed' } }] });
    expect(hits).toEqual([{ path: '/api/example/_smoke', secret: 'fixture-service-secret', authorization: undefined }]);
    smokeValue = 'stub';
    const failed = await (await run('app:example:smoke:readiness')).json() as any;
    expect(failed.results[0]).toMatchObject({ state: 'fail', steps: [{ detail: expect.stringContaining('rejected value') }] });
  });

  it('keeps AI, mutations and unavailable service credentials explicitly pending without requests', async () => {
    await install();
    const ai = manifest('ai-case');
    ai.smoke![0].requiresAi = true;
    ai.routes![0].requiresAi = true;
    await install(ai);
    const mutating = manifest('mutation-case');
    mutating.smoke![0].method = 'POST';
    await install(mutating);
    for (const [name, user] of [['example', 'owner'], ['ai-case', 'operator'], ['mutation-case', 'operator']]) {
      const result = await (await run(`app:${name}:smoke:readiness`, user)).json() as any;
      expect(result.results[0]).toMatchObject({ state: 'degraded', steps: [{ detail: expect.stringContaining('Pending:'), output: { executionStatus: 'pending' } }] });
    }
    expect(hits).toEqual([]);
  });

  it('accepts only the current caller PAT and never lends service credentials to PAT/public probes', async () => {
    const pat = manifest('pat-case');
    pat.smoke![0].auth = 'pat';
    await install(pat);
    const unavailable = await (await run('app:pat-case:smoke:readiness', 'owner', 'Bearer arbitrary')).json() as any;
    expect(unavailable.results[0].steps[0].output.executionStatus).toBe('pending');
    const available = await (await run('app:pat-case:smoke:readiness', 'owner', PAT)).json() as any;
    expect(available.results[0].state).toBe('pass');
    expect(hits).toEqual([{ path: '/api/pat-case/_smoke', authorization: PAT, secret: undefined }]);
    const publicApp = manifest('public-case');
    publicApp.smoke![0].auth = 'public';
    await install(publicApp);
    await run('app:public-case:smoke:readiness', 'operator', PAT);
    expect(hits[1]).toEqual({ path: '/api/public-case/_smoke', authorization: undefined, secret: undefined });
  });

  it('retains protected Portrait Studio smoke syntax and checks caller authority through the Lab', async () => {
    const storeRoot = process.env.OSHAL_STORE_REPO || resolve(process.cwd(), '../oshal-applications');
    const portrait = readManifest(join(storeRoot, 'portrait-studio/oshal-app.yaml'));
    const installed = await install({ ...manifest('portrait-studio'), version: portrait.version, smoke: portrait.smoke });
    const scenario = (await catalog()).scenarios.find(s => s.installedTest?.appName === 'portrait-studio');
    expect(scenario.installedTest.appVersion).toBe(installed.version);
    expect(scenario.installedTest.name).toBe('package-readiness');
    expect(scenario.installedTest).toMatchObject({ installationEligible: false, prerequisites: expect.arrayContaining(['verified-user-context']) });
    const pending = await (await run(scenario.id)).json() as any;
    expect(pending.results[0].steps[0].output.executionStatus).toBe('pending');
    expect(hits).toEqual([]);
    const result = await (await run(scenario.id, 'operator', PAT)).json() as any;
    expect(result.results[0].state).toBe('pass');
    expect(hits[0].path).toBe('/api/portrait-studio/_smoke');
  });

  it('keeps undeclared coverage visible and gives groups member case references without duplication', async () => {
    await install({ ...manifest('member'),
      ui: { static: [{ toolName: 'member-home', label: 'Member', icon: 'codicon codicon-home', iframeUrl: '/api/member/home' }] },
      readiness: [{ name: 'ready', path: '/api/member/state', readyPointer: '/ready' }],
    });
    await install({ ...manifest('no-tests'), smoke: undefined });
    await install({ name: 'group-app', displayName: 'Group', version: '1.0.0', status: 'active', suite: 'ai-home', kind: 'group',
      dependencies: { apps: ['member'] }, toolbar: [{ app: 'member', surface: 'member-home' }],
      setup: [{ label: 'Member readiness', app: 'member', readiness: 'ready', fix: 'member-home' }],
    });
    const current = await catalog();
    expect(current.installedApps.find(a => a.name === 'no-tests')).toMatchObject({ coverage: 'not-declared', caseIds: [] });
    expect(current.installedApps.find(a => a.name === 'group-app')).toMatchObject({ coverage: 'members', caseIds: ['app:member:smoke:readiness'] });
    expect(current.scenarios.filter(s => s.installedTest)).toHaveLength(1);
  });
});

/** Declare a user smoke with catalog decorations that cannot grant unattended eligibility. */
async function installUserSmoke(prerequisites: string[] = []) {
  const input = manifest('user-case');
  Object.assign(input.smoke![0], { auth: 'pat', requiresUser: true });
  input.uses = ['test-catalog'];
  input.testing = { version: 1, catalog: 'user-tests.yaml' };
  writeFileSync(join(root, 'user-tests.yaml'), yaml.dump({ version: 1, cases: [{
    id: 'readiness', name: 'User readiness', purpose: 'Verify current user access.', level: 'integration',
    runner: { kind: 'smoke', smoke: 'readiness' }, expected: ['Current user can read.'], prerequisites,
    sideEffects: 'none', isolation: { mode: 'none' }, limits: { timeoutMs: 15000 },
    installation: prerequisites.length ? 'never' : 'safe-smoke',
  }] }));
  return install(input);
}

it('derives user prerequisites and clears them with a current PAT without unattended eligibility', async () => {
  await installUserSmoke();
  const without = (await catalog()).scenarios.find(s => s.installedTest);
  expect(without.installedTest).toMatchObject({ runnable: false, installationEligible: false,
    prerequisites: ['verified-user-context', 'caller-pat'], pendingReason: expect.stringContaining('Verified user context') });
  const pending = await (await run(without.id)).json() as any;
  expect(pending.results[0].steps[0].output.executionStatus).toBe('pending');
  expect(hits).toEqual([]);
  const withPat = (await catalog('operator', PAT)).scenarios.find(s => s.installedTest);
  expect(withPat.installedTest).toMatchObject({ runnable: true, installationEligible: false });
  const passed = await (await run(withPat.id, 'operator', PAT)).json() as any;
  expect(passed.results[0]).toMatchObject({ state: 'pass', steps: [{ output: { executionStatus: 'passed' } }] });
  expect(hits).toEqual([{ path: '/api/user-case/_smoke', authorization: PAT, secret: undefined }]);
});

it('fails malformed user PATs without requests and preserves actual HTTP refusal for revoked tokens', async () => {
  await installUserSmoke();
  const scenario = (await catalog()).scenarios.find(s => s.installedTest);
  const malformed = await (await run(scenario.id, 'operator', 'Bearer invalid')).json() as any;
  expect(malformed.results[0]).toMatchObject({ state: 'fail', steps: [{ output: { executionStatus: 'failed' } }] });
  expect(hits).toEqual([]);
  const revoked = `Bearer oshal_pat_${'b'.repeat(48)}`;
  const denied = await (await run(scenario.id, 'operator', revoked)).json() as any;
  expect(denied.results[0]).toMatchObject({ state: 'fail', steps: [{ detail: expect.stringContaining('HTTP 403') }] });
  expect(hits).toEqual([{ path: '/api/user-case/_smoke', authorization: revoked, secret: undefined }]);
});

it('does not claim arbitrary declared prerequisites are fulfilled by a supplied user PAT', async () => {
  await installUserSmoke(['account:microsoft']);
  const scenario = (await catalog('operator', PAT)).scenarios.find(s => s.installedTest);
  expect(scenario.installedTest).toMatchObject({ runnable: false, pendingReason: expect.stringContaining('account:microsoft') });
  const result = await (await run(scenario.id, 'operator', PAT)).json() as any;
  expect(result.results[0].steps[0].output.executionStatus).toBe('pending');
  expect(hits).toEqual([]);
});

describe('installed smoke registration isolation', () => {
  it('keeps same-named cases app-scoped and rejects a stale selected revision', async () => {
    const first = await install(manifest('first'));
    const second = await install(manifest('second'));
    const registry = new InstalledAppTestCatalog();
    registry.register(first);
    registry.register(second);
    const visible = new Map([['first', 'First'], ['second', 'Second']]);
    const cases = registry.list(visible, { serviceSecret: 'fixture' });
    expect(new Set(cases.map(c => c.id)).size).toBe(2);
    registry.register({ ...first, version: '2.0.0' });
    const stale = await registry.run(cases.find(c => c.appName === 'first')!, visible, { apiBaseUrl: baseUrl, serviceSecret: 'fixture' });
    expect(stale).toMatchObject({ status: 'pending', error: expect.stringContaining('changed') });
    registry.unregister('second');
    const removed = await registry.run(cases.find(c => c.appName === 'second')!, visible, { apiBaseUrl: baseUrl, serviceSecret: 'fixture' });
    expect(removed.status).toBe('pending');
    expect(hits).toEqual([]);
  });
});

it('combines real operator session and service authentication under current exact application rights', async () => {
  const fixture = await startServiceSmokeFixture();
  try {
    fixture.enable(false);
    const before = await fixture.run();
    expect(before.body.results[0]).toMatchObject({ state: 'fail', steps: [{ detail: 'HTTP 401, expected 200' }] });
    fixture.enable(true);
    const after = await fixture.run();
    expect(after.body.results[0]).toMatchObject({ state: 'pass' });
    expect(after.body.results[0].steps[0].status).toBe(200);
    expect(JSON.stringify(after.body)).not.toContain('session=');
    expect(JSON.stringify(after.body)).not.toContain(SMOKE_SECRET);
    expect((await fixture.run('foreign')).body.results[0]).toMatchObject({ state: 'fail', steps: [{ detail: 'HTTP 403, expected 200' }] });
    await fixture.change('revoke');
    expect((await fixture.run()).body.results[0]).toMatchObject({ state: 'fail', steps: [{ detail: 'HTTP 403, expected 200' }] });
  } finally { await fixture.close(); }
});

it('keeps anonymous and nonoperator requests outside the service-session transport', async () => {
  const fixture = await startServiceSmokeFixture();
  try {
    expect((await fixture.run('unknown')).status).toBe(401);
    const reader = await fixture.run('reader');
    expect(reader.body.results[0].state).toBe('degraded');
    expect(reader.body.results[0].steps[0].output.executionStatus).toBe('pending');
    expect(await fixture.transport('unknown')).toBeUndefined();
    expect(await fixture.transport('reader')).toBeUndefined();
    expect(await fixture.transport('owner', PAT)).toBeUndefined();
    const transport = (await fixture.transport())!;
    fixture.actors.owner.isSwarmAdmin = false;
    await expect(transport(fixture.base + fixture.smokePath, smokeRequest())).rejects.toThrow(/Current service smoke authority/);
  } finally { await fixture.close(); }
});

it('refuses a changed exact actor before the request-bound service smoke leaves the controller', async () => {
  const fixture = await startServiceSmokeFixture();
  try {
    const transport = (await fixture.transport())!;
    fixture.actors.owner.issuer = fixture.actors.foreign.issuer;
    await expect(transport(fixture.base + fixture.smokePath, smokeRequest())).rejects.toThrow(/Current service smoke authority/);
  } finally { await fixture.close(); }
});

it('never constructs a caller-session transport for a runnable Node package case', async () => {
  const fixture = await startServiceSmokeFixture();
  try {
    const node = createPackageExecutionFixture(fixture.root, { name: 'session-smoke' });
    fixture.catalog.register(node.record);
    const test = fixture.catalog.list(new Map([['session-smoke', 'Session smoke']]), { canRunSuites: true })
      .find(item => item.id === node.caseId);
    expect(test).toMatchObject({ runnable: true, runner: { kind: 'node-test' }, auth: 'none' });
    const result = await fixture.run('owner', node.caseId);
    expect(result).toMatchObject({ status: 409, body: { error: expect.stringContaining('cancellable run with history') } });
    expect(fixture.callbacks()).toBe(0);
    expect(JSON.stringify(test)).not.toContain('session=');
  } finally { await fixture.close(); }
});

it('never sends session bytes to another origin, path, mutation or redirect target', async () => {
  const fixture = await startServiceSmokeFixture();
  let leaked = 0;
  const listener = createServer((_req, res) => { leaked++; res.end('unexpected'); });
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  const destination = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/outside`;
  try {
    const transport = (await fixture.transport())!;
    await expect(transport(destination, smokeRequest())).rejects.toThrow(/approved local read boundary/);
    await expect(transport(fixture.base + '/another-path', smokeRequest())).rejects.toThrow(/approved local read boundary/);
    await expect(transport(fixture.base + fixture.smokePath, { ...smokeRequest(), method: 'POST' })).rejects.toThrow(/approved local read boundary/);
    fixture.redirect(destination);
    expect((await transport(fixture.base + fixture.smokePath, { ...smokeRequest(), redirect: 'follow' as 'manual' })).status).toBe(302);
    expect(leaked).toBe(0);
  } finally { listener.closeAllConnections(); await new Promise<void>(done => listener.close(() => done())); await fixture.close(); }
});

it.each([
  { auth: 'public', method: 'GET' }, { auth: 'pat', method: 'GET' },
  { auth: 'service', method: 'POST' }, { auth: 'service', method: 'GET', requiresUser: true },
] as const)('keeps $auth/$method user=$requiresUser outside the service-session callback', async selection => {
  const input = manifest('mode-boundary');
  Object.assign(input.smoke![0], selection);
  const installed = await install(manifest('mode-boundary'));
  let transported = 0, normal = 0;
  const result = await verifyAppSmokes([{ requestedName: input.name, record: { ...installed, manifest: input } }], {
    apiBaseUrl: baseUrl, authorization: PAT, serviceSecret: SMOKE_SECRET,
    serviceSmokeFetch: async () => { transported++; throw new Error('Unexpected session transport'); },
    fetchImpl: async () => { normal++; return { status: 200, text: async () => '{"package":"ready"}' }; },
  });
  expect(transported).toBe(0); expect(normal).toBe(1); expect(result.success).toBe(true);
});
