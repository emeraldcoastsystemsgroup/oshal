/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove installed Test Lab registration through real lifecycle and HTTP boundaries with disposable package/persistence fixtures.
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

async function catalog(sub = 'operator') {
  const response = await fetch(`${baseUrl}/api/test-lab/catalog`, { headers: { 'x-test-sub': sub } });
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

  it('retains existing Portrait Studio smoke syntax and checks it through the Lab against a fixture route', async () => {
    const storeRoot = process.env.OSHAL_STORE_REPO || resolve(process.cwd(), '../oshal-applications');
    const portrait = readManifest(join(storeRoot, 'portrait-studio/oshal-app.yaml'));
    const installed = await install({ ...manifest('portrait-studio'), version: portrait.version, smoke: portrait.smoke });
    const scenario = (await catalog()).scenarios.find(s => s.installedTest?.appName === 'portrait-studio');
    expect(scenario.installedTest.appVersion).toBe(installed.version);
    expect(scenario.installedTest.name).toBe('package-readiness');
    const result = await (await run(scenario.id)).json() as any;
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
