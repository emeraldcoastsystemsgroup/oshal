/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise authorization through real package loading, activation and mounted HTTP routes.
 */
/** Real temporary package activation and Express dispatch; persistence is isolated, policy and lifecycle are real. */
import express, { type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationRuntime, applicationAuthorizationMode } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import { createApplicationAuthorizationGate } from '@/app/middleware/application-authorization-gate';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { SwarmAppService, type SwarmAppManifest, type SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const ISSUER = 'https://runtime-identity.fixture.test';
const admin: AuthorizationActor = { sub: 'administrator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const alice: AuthorizationActor = { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const catalog: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'records.read': { resource: 'records', effect: 'read', minimumTier: 'viewer' },
    'records.write': { resource: 'records', effect: 'write', minimumTier: 'editor' } },
  roles: { reader: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'own' }] },
    editor: { tier: 'editor', grants: [{ permission: 'records.read', scope: 'own' }, { permission: 'records.write', scope: 'own' }] } },
  bindings: { http: [{ id: 'read-record', method: 'GET', path: '/records/:id', allOf: ['records.read'] },
    { id: 'write-record', method: 'POST', path: '/records', allOf: ['records.write'] }] },
};
const PACKAGE = `exports.createRoutes = function(ctx) {
  if (ctx.authorization && ctx.fixtureHasCatalog()) ctx.authorization.registerResource('records', {
    authorize: async function(input) { ctx.fixtureObserve('adapter'); return !input.operation.path || !input.operation.path.endsWith('/other-owner'); }
  });
  ctx.fixtureFactoryContext({ management: Boolean(ctx.applicationAuthorization), tool: Boolean(ctx.authorizationTool), authorization: Boolean(ctx.authorization) });
  return function(req, res) {
    const observation = ctx.fixtureObserve('handler');
    res.json({ ok: true, marker: 'version-one', path: req.url, observation, actor: ctx.authorization.currentActor() });
  };
};`;

let root: string, server: Server, base: string;
let apps: SwarmAppService, runtime: ApplicationAuthorizationRuntime, policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore;
let mounter: ManifestRouteMounterImpl;
let records: Map<string, SwarmApplicationRecord>;
let queries: string[], repoWrites: number, factoryContexts: unknown[];
let observations: Array<{ phase: string; identity: ReturnType<typeof getRequestIdentity>; actor: ReturnType<typeof getApplicationAuthorizationActor> }>;
let failTakeout: boolean, hasCatalog: boolean;
let activationPause: { entered(): void; wait: Promise<void> } | undefined;

function manifest(overrides: Partial<SwarmAppManifest> = {}): SwarmAppManifest {
  return { name: 'runtime-app', displayName: 'Runtime fixture', version: '1.0.0', status: 'active', suite: 'ai-home', uses: ['application-authorization'],
    access: { supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier: 'admin' },
    authorization: { version: 1, catalog: 'authorization.yaml' },
    routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: '/api/runtime-app', auth: 'service-or-oidc' }], ...overrides };
}
function writePackage(input = manifest(), source: unknown = catalog) {
  const directory = join(root, input.name); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'authorization.yaml'), yaml.dump(source));
  writeFileSync(join(directory, 'routes.js'), PACKAGE);
  const file = join(directory, 'oshal-app.yaml'); writeFileSync(file, yaml.dump(input)); return file;
}
async function grant(role = 'reader', target = alice) {
  const preview = await policy.previewChange(admin, { action: 'grant', app: 'runtime-app', targetSub: target.sub, targetIssuer: target.issuer,
    role, reason: 'Isolated runtime authorization proof', expectedRevision: (await store.read()).revision });
  return policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
}
async function call(path = '/records/owned', { user = 'alice', method = 'GET', headers = {} }: { user?: string | null; method?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + '/api/runtime-app' + path, { method, headers: { ...(user ? { 'x-fixture-user': user } : {}), ...headers } });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true'); vi.stubEnv('APP_ACCESS_ENFORCEMENT', 'enforce');
  vi.stubEnv('SWARM_SERVICE_SECRET', 'example-runtime-fixture-service-secret');
  vi.stubEnv('APP_PACKAGE_MIGRATIONS', 'false');
  root = mkdtempSync(join(tmpdir(), 'oshal-authorization-runtime-'));
  records = new Map(); queries = []; repoWrites = 0; factoryContexts = []; observations = []; failTakeout = false; hasCatalog = true; activationPause = undefined;
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } };
  const repo = {
    findByName: async (name: string) => records.get(name) ?? null,
    list: async (status?: string) => [...records.values()].filter(row => !status || row.status === status),
    upsert: async (loaded: SwarmAppManifest, file: string) => {
      repoWrites++;
      const record: SwarmApplicationRecord = { appId: loaded.name, name: loaded.name, displayName: loaded.displayName,
        description: '', version: loaded.version || '1.0.0', status: loaded.status || 'active', manifestPath: file, agentIds: [], toolNames: [],
        manifest: loaded, scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
      records.set(record.name, record); return record;
    },
    updateStatus: async (name: string, status: 'active' | 'inactive') => {
      repoWrites++; const row = records.get(name); if (!row) return null;
      const next = { ...row, status }; records.set(name, next); return next;
    },
    delete: async (name: string) => { repoWrites++; return records.delete(name); },
  };
  store = new MemoryAuthorizationStore();
  policy = new ApplicationAuthorizationService(store, { resolveTier: async () => ({ tier: 'admin', explicit: false }) });
  const actor = async (req: Request) => {
    const name = req.get('x-fixture-user');
    if (name === 'alice') return structuredClone(alice);
    if (name === 'administrator') return structuredClone(admin);
    throw Object.assign(new Error('No verified fixture actor'), { status: 401 });
  };
  runtime = new ApplicationAuthorizationRuntime(policy, actor, { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' }, repo.findByName);
  const app = express();
  // Simulate a platform administrator scope upstream; package execution must narrow it.
  app.use((_req, _res, next) => runWithRequestIdentity({ sub: 'upstream-operator', principalIssuer: ISSUER, isOperator: true }, next));
  const requiresAuth: RequestHandler = (req, res, next) => {
    if (req.get('x-fixture-user')) { next(); return; } res.status(401).json({ error: 'fixture_auth_required' });
  };
  const observe = (phase: string) => {
    const observation = { phase, identity: getRequestIdentity(), actor: getApplicationAuthorizationActor() };
    observations.push(structuredClone(observation)); return observation;
  };
  const ctx = { pool, fixtureObserve: observe, fixtureHasCatalog: () => hasCatalog,
    fixtureFactoryContext: (value: unknown) => factoryContexts.push(value), applicationAuthorization: runtime, authorizationTool: {} } as unknown as AppContext;
  mounter = new ManifestRouteMounterImpl(app, requiresAuth, ctx,
    { resolve: async () => ({ appName: 'runtime-app', userSub: 'alice', tier: 'admin', source: 'default' }) } as never, runtime);
  app.use((_req, res) => res.status(404).json({ error: 'fixture_not_found' }));
  apps = new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never,
    undefined, undefined, undefined, mounter, undefined, undefined, undefined,
    { register: async () => {
      if (activationPause) { activationPause.entered(); await activationPause.wait; }
      if (failTakeout) throw new Error('Fixture activation failure');
    }, unregister: () => undefined }, runtime);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  const withinTemp = relative(resolve(tmpdir()), resolve(root));
  if (!withinTemp || withinTemp.startsWith('..')) throw new Error('Invalid fixture cleanup path');
  rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

describe('Application authorization runtime integration', () => {
  it('discovers a tenant-scoped app only for a member of its assigned business tenant', async () => {
    await apps.loadApp(writePackage());
    const preview = await policy.previewChange(admin, { action: 'grant', app: 'runtime-app',
      targetSub: alice.sub, targetIssuer: alice.issuer, tenantId: 'business-a', role: 'reader',
      reason: 'Tenant-only discovery fixture', expectedRevision: 0 });
    await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
    expect(await runtime.canDiscover('runtime-app', alice)).toBe(false);
    expect(await runtime.canDiscover('runtime-app', { ...alice, tenantIds: ['business-a'] })).toBe(true);
    expect(await runtime.canDiscover('runtime-app', { ...alice, tenantIds: ['business-b'] })).toBe(false);
  });

  it('enforces named HTTP grants despite a default admin tier and platform administrator status', async () => {
    await apps.loadApp(writePackage());
    expect((await call()).status).toBe(403);
    expect((await call('/records/owned', { user: 'administrator' })).status).toBe(403);
    expect(observations).toHaveLength(0);
    await grant();
    expect((await call()).status).toBe(200);
    expect((await call('/records', { method: 'POST' })).status).toBe(403);
    await grant('editor');
    expect((await call('/records', { method: 'POST' })).status).toBe(200);
    expect(factoryContexts).toEqual([{ management: false, tool: false, authorization: true }]);
  });

  it('narrows both adapter checks and package execution to the verified non-operator business identity', async () => {
    await apps.loadApp(writePackage()); await grant();
    const response = await call(); expect(response.status).toBe(200);
    expect(observations.map(row => row.phase)).toEqual(['adapter', 'handler']);
    for (const row of observations) {
      expect(row.identity).toEqual({ sub: alice.sub, principalIssuer: ISSUER, isOperator: false });
      expect(row.actor).toEqual(alice);
    }
    expect(response.body.actor.sub).toBe(alice.sub);
  });

  it('refuses missing actors, raw service secrets, unbound routes and other-owned resources before handlers', async () => {
    await apps.loadApp(writePackage()); await grant();
    expect((await call('/records/owned', { user: null })).status).toBe(401);
    expect((await call('/records/owned', { user: null, headers: { 'x-service-secret': 'example-runtime-fixture-service-secret' } })).status).toBe(401);
    const unbound = await call('/unbound'); expect(unbound.status).toBe(403); expect(unbound.body.error).toBe('authorization_operation_unbound');
    expect((await call('/records/other-owner')).status).toBe(403);
    expect(observations.filter(row => row.phase === 'handler')).toHaveLength(0);
  });

  it('retracts access on deactivate/uninstall and reloads package code without losing stable assignments', async () => {
    const file = writePackage(); await apps.loadApp(file); await grant();
    expect(await runtime.canDiscover('runtime-app', alice)).toBe(true);
    await apps.toggleApp('runtime-app', false);
    expect((await call()).status).toBe(404); expect(await runtime.canDiscover('runtime-app', alice)).toBe(false);
    expect(policy.getApp('runtime-app')).toBeNull();
    await apps.toggleApp('runtime-app', true);
    expect((await call()).status).toBe(200);
    writeFileSync(join(root, 'runtime-app', 'routes.js'), PACKAGE.replace('version-one', 'version-two'));
    await apps.loadApp(file);
    expect((await call()).body.marker).toBe('version-two');
    expect((await store.read()).assignments).toHaveLength(1);
    await apps.unloadApp('runtime-app');
    expect((await call()).status).toBe(404); expect(policy.getApp('runtime-app')).toBeNull();
  });

  it('rejects malformed catalogs before package persistence, SQL, factory code or grants change', async () => {
    const file = writePackage(manifest(), { ...catalog, version: 999 });
    await expect(apps.loadApp(file)).rejects.toThrow();
    expect(repoWrites).toBe(0); expect(queries).toEqual([]); expect(factoryContexts).toEqual([]);
    expect(records.size).toBe(0); expect((await store.read()).assignments).toEqual([]);
    expect(policy.getApp('runtime-app')).toBeNull();
  });

  it('leaves failed activation inactive and absent from authorization and test discovery', async () => {
    failTakeout = true;
    await expect(apps.loadApp(writePackage())).rejects.toThrow('Fixture activation failure');
    expect(records.get('runtime-app')?.status).toBe('inactive');
    expect(policy.getApp('runtime-app')).toBeNull();
    expect(await runtime.canDiscover('runtime-app', alice)).toBe(false);
    expect((await call()).status).toBe(404);
  });

  it('closes the previous router during an unfinished reload and publishes only after activation completes', async () => {
    const file = writePackage(); await apps.loadApp(file); await grant();
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>(done => { entered = done; });
    activationPause = { entered, wait: new Promise<void>(done => { release = done; }) };
    const loading = apps.loadApp(file); await began;
    try {
      expect((await call()).status).toBe(503);
      expect(await runtime.canDiscover('runtime-app', alice)).toBe(false);
    } finally { release(); await loading; }
    expect((await call()).status).toBe(200);
  });

  it('rejects changed catalog meanings before overwriting the existing installed app or router', async () => {
    const file = writePackage(); await apps.loadApp(file); await grant();
    const priorWrites = repoWrites, priorQueries = queries.length;
    writeFileSync(join(root, 'runtime-app', 'authorization.yaml'), yaml.dump({ ...catalog,
      roles: { ...catalog.roles, reader: { tier: 'editor', grants: catalog.roles.editor.grants } } }, { noRefs: true }));
    await expect(apps.loadApp(file)).rejects.toThrow('authorization_catalog_migration_required');
    expect(repoWrites).toBe(priorWrites); expect(queries).toHaveLength(priorQueries);
    expect((await call()).status).toBe(200);
    expect((await call('/records', { method: 'POST' })).status).toBe(403);
  });

  it('requires explicit app-admin for no-catalog enforced packages and treats unknown rollout modes as enforce', async () => {
    hasCatalog = false;
    await apps.loadApp(writePackage(manifest({ authorization: undefined })));
    expect((await call()).body.error).toBe('authorization_app_admin_required');
    await grant('@app-admin'); expect((await call()).status).toBe(200);
    expect(applicationAuthorizationMode({ OSHAL_APPLICATION_AUTHORIZATION_MODE: 'typo' })).toBe('enforce');
    expect(applicationAuthorizationMode({})).toBe('enforce');
    expect(applicationAuthorizationMode({ OSHAL_APPLICATION_AUTHORIZATION_MODE: 'legacy' })).toBe('legacy');
  });

  it('fails a protected package closed when a declared route factory cannot load', async () => {
    const file = writePackage(); writeFileSync(join(root, 'runtime-app', 'routes.js'), 'exports.createRoutes = null;');
    await expect(apps.loadApp(file)).rejects.toThrow();
    expect(records.get('runtime-app')?.status).toBe('inactive'); expect(policy.getApp('runtime-app')).toBeNull();
    expect((await call()).status).toBe(404);
  });

  it('enforces the same named grants and unavailable state on a hard-mounted route', async () => {
    await apps.loadApp(writePackage());
    const hard = express(); hard.use(createApplicationAuthorizationGate(apps, runtime));
    hard.get('/api/runtime-app/records/:id', (_req, res) => res.json({ identity: getRequestIdentity(), actor: getApplicationAuthorizationActor() }));
    const hardServer = hard.listen(0, '127.0.0.1'); await new Promise<void>(done => hardServer.once('listening', done));
    const endpoint = `http://127.0.0.1:${(hardServer.address() as AddressInfo).port}/api/runtime-app/records/owned`;
    try {
      expect((await fetch(endpoint, { headers: { 'x-fixture-user': 'alice' } })).status).toBe(403);
      await grant(); const allowed = await fetch(endpoint, { headers: { 'x-fixture-user': 'alice' } });
      expect(allowed.status).toBe(200); expect((await allowed.json()).identity.isOperator).toBe(false);
      await apps.toggleApp('runtime-app', false);
      expect((await fetch(endpoint, { headers: { 'x-fixture-user': 'alice' } })).status).toBe(503);
    } finally { hardServer.closeAllConnections(); await new Promise<void>(done => hardServer.close(() => done())); }
  });
});
