/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the Home plan admits an installed application only through current application policy, converging with workspace discovery across grant, revocation and explicit coarse deny.
 */
/** Real Express, package loading and authorization; only persistence, identity and coarse access are isolated doubles. */
import express, { type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import { createSwarmAppRoutes } from '@/app/routes/swarm-app-routes';
import { createWorkspaceNavigationRoutes } from '@/app/routes/workspace-navigation-routes';
import type { AppContext } from '@/app/composition/app-context';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { SwarmAppService, type SwarmAppManifest, type SwarmApplicationRecord, type AppAccessService } from '@/features/swarm-apps';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationChange } from '@/shared/application-authorization';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const APP = 'home-plan-app', FRAMEWORK = 'home-plan-framework', ISSUER = 'https://home-plan-identity.fixture.test';
const alice: AuthorizationActor = { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const admin: AuthorizationActor = { sub: 'administrator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const catalog: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'app.open': { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
  roles: { opener: { tier: 'viewer', grants: [{ permission: 'app.open', scope: 'own' }] } },
  bindings: { http: [{ id: 'shell', method: 'GET', path: '/app', allOf: ['app.open'] }] },
};
const PACKAGE = `exports.createRoutes = function(ctx) {
  ctx.authorization.registerResource('records', { authorize: async function() { return true; } });
  return function(req, res) { res.json({ fixture: 'package-page', path: req.url }); };
};`;

let root: string, server: Server, base: string, now: number;
let apps: SwarmAppService, runtime: ApplicationAuthorizationRuntime, policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore;
let records: Map<string, SwarmApplicationRecord>, denyCoarse: Set<string>;

/** @description Shape one installable fixture manifest; the framework variant carries no package authorization. */
function manifest(overrides: Partial<SwarmAppManifest> = {}): SwarmAppManifest {
  const name = overrides.name ?? APP;
  return { name, displayName: `Fixture ${name}`, version: '1.0.0', status: 'active', suite: 'ai-home',
    theme: 'workspace', uses: ['application-authorization'],
    access: { supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier: 'admin' },
    authorization: { version: 1, catalog: 'authorization.yaml' },
    routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: `/api/${name}`, auth: 'service-or-oidc' }],
    ui: { static: [{ toolName: 'home', label: 'Home', icon: 'codicon codicon-home', iframeUrl: `/api/${name}/app` }] },
    ...overrides };
}

/** @description Install one fixture manifest; the file name decides package (enforced) versus framework (legacy) posture. */
async function install(overrides: Partial<SwarmAppManifest> = {}, fileName = 'oshal-app.yaml') {
  const input = manifest(overrides), directory = join(root, input.name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'authorization.yaml'), yaml.dump(catalog));
  writeFileSync(join(directory, 'routes.js'), PACKAGE);
  const file = join(directory, fileName); writeFileSync(file, yaml.dump(input));
  await apps.loadApp(file); return records.get(input.name)!;
}

/** @description Apply one real policy change through preview/apply, exactly as an administrator would. */
async function change(action: AuthorizationChange['action'] = 'grant', options: Partial<AuthorizationChange> = {}) {
  const preview = await policy.previewChange(admin, { action, app: APP, targetSub: alice.sub, targetIssuer: alice.issuer,
    ...(['grant', 'revoke'].includes(action) ? { role: 'opener' } : {}), reason: 'Isolated Home plan fixture',
    expectedRevision: (await store.read()).revision, ...options });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}

/** @description Resolve only fixture principals; an unknown caller is an identity failure, never an anonymous one. */
async function resolveActor(req: Request): Promise<AuthorizationActor> {
  const name = req.get('x-fixture-user');
  if (name === 'alice') return structuredClone(alice);
  if (name === 'administrator') return structuredClone(admin);
  if (name === 'inactive') return { ...alice, isActive: false };
  throw Object.assign(new Error('No verified fixture actor'), { status: 401 });
}

/** @description Keep every installation in memory so the suite touches no database. */
function memoryRepository() {
  return {
    findByName: async (name: string) => records.get(name) ?? null,
    list: async (status?: string) => [...records.values()].filter(row => !status || row.status === status),
    upsert: async (loaded: SwarmAppManifest, file: string) => {
      const record: SwarmApplicationRecord = { appId: loaded.name, name: loaded.name, displayName: loaded.displayName,
        description: '', version: loaded.version || '1.0.0', status: loaded.status || 'active', manifestPath: file,
        agentIds: [], toolNames: [], manifest: loaded, scope: 'public', ownerSub: null, tenantId: null,
        guestTierApproved: null, loadedAt: new Date(now), updatedAt: new Date(now) };
      records.set(record.name, record); return record;
    },
    updateStatus: async (name: string, status: 'active' | 'inactive') => {
      const record = records.get(name); if (!record) return null;
      const updated = { ...record, status }; records.set(name, updated); return updated;
    },
    delete: async (name: string) => records.delete(name),
  };
}

beforeEach(async () => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true'); vi.stubEnv('APP_ACCESS_ENFORCEMENT', 'enforce');
  vi.stubEnv('APP_PACKAGE_MIGRATIONS', 'false');
  root = mkdtempSync(join(tmpdir(), 'oshal-home-plan-')); now = Date.now();
  records = new Map(); denyCoarse = new Set();
  const repo = memoryRepository(), pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  store = new MemoryAuthorizationStore();
  policy = new ApplicationAuthorizationService(store, { now: () => now, resolveTier: async () => ({ tier: 'admin', explicit: false }) });
  runtime = new ApplicationAuthorizationRuntime(policy, resolveActor, { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' }, repo.findByName);
  const app = express();
  const requiresAuth: RequestHandler = (req, res, next) => {
    const name = req.get('x-fixture-user');
    if (!name) { res.status(401).json({ error: 'fixture_auth_required' }); return; }
    (req as typeof req & { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub: name } };
    next();
  };
  const access: Pick<AppAccessService, 'resolve'> = { resolve: async (appName, userSub) => ({ appName, userSub,
    tier: denyCoarse.has(appName) ? 'deny' : 'admin', bundle: null, source: 'default' }) };
  const context = { pool, applicationAuthorization: runtime } as unknown as AppContext;
  const mounter = new ManifestRouteMounterImpl(app, requiresAuth, context, access as AppAccessService, runtime);
  apps = new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never,
    undefined, undefined, undefined, mounter, undefined, undefined, undefined, undefined, runtime);
  app.use('/api/swarm/apps', requiresAuth, createSwarmAppRoutes(apps, access as AppAccessService, {
    isAuthorizationProtected: record => runtime.protectedApp(record.name),
    authorization: { canDiscover: (name, actor) => runtime.canDiscover(name, actor), resolveActor },
  }));
  app.use('/api/ui', requiresAuth, createWorkspaceNavigationRoutes({ apps, runtime, resolveActor, access }));
  app.use((_req, res) => res.status(404).json({ error: 'fixture_not_found' }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  const withinTemp = relative(resolve(tmpdir()), resolve(root));
  if (!withinTemp || withinTemp.startsWith('..')) throw new Error('Invalid fixture cleanup path');
  rmSync(root, { recursive: true, force: true });
});

/** @description Read one caller's Home plan over real HTTP. */
async function call(user: string | null = 'alice') {
  const response = await fetch(`${base}/api/swarm/apps/home-plan`, { headers: user ? { 'x-fixture-user': user } : {} });
  return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
}

/** @description Names of the applications Home would render for one caller. */
async function homePlan(user = 'alice'): Promise<string[]> {
  const response = await call(user); expect(response.status).toBe(200); expect(response.cache).toBe('no-store');
  return response.body.apps.map((entry: { name: string }) => entry.name);
}

/** @description Names of the workspaces the top navigation would render for one caller. */
async function workspaces(user = 'alice'): Promise<string[]> {
  const response = await fetch(`${base}/api/ui/workspaces`, { headers: { 'x-fixture-user': user } });
  expect(response.status).toBe(200);
  return (await response.json()).workspaces.map((entry: { name: string }) => entry.name);
}

it('admits a protected application on Home only while the caller holds a current grant, converging with workspace discovery', async () => {
  await install();
  expect(await homePlan()).toEqual([]); expect(await workspaces()).toEqual([]);
  await change();
  expect(await homePlan()).toEqual([APP]); expect(await workspaces()).toEqual([APP]);
  await change('revoke');
  expect(await homePlan()).toEqual([]); expect(await workspaces()).toEqual([]);
});

it('drops an application whose explicit coarse access resolves to deny even while its grant is current', async () => {
  await install(); await change();
  expect(await homePlan()).toEqual([APP]);
  denyCoarse.add(APP);
  expect(await homePlan()).toEqual([]); expect(await workspaces()).toEqual([]);
  denyCoarse.delete(APP);
  expect(await homePlan()).toEqual([APP]);
});

it('keeps an unprotected framework application on Home with no application grant', async () => {
  await install({ name: FRAMEWORK, theme: undefined, uses: undefined, routes: undefined, authorization: undefined,
    ui: { static: [{ toolName: 'home', label: 'Home', icon: 'codicon codicon-home', iframeUrl: `/api/${FRAMEWORK}/app` }] } },
  'framework.yaml');
  await install();
  expect(runtime.protectedApp(FRAMEWORK)).toBe(false); expect(runtime.protectedApp(APP)).toBe(true);
  expect(await homePlan()).toEqual([FRAMEWORK]);
  await change();
  expect((await homePlan()).slice().sort()).toEqual([APP, FRAMEWORK].sort());
});

it('refuses a Home plan to a caller with no current verified identity', async () => {
  await install(); await change();
  expect((await call(null)).status).toBe(401);
  expect(await call('inactive')).toMatchObject({ status: 401, body: { error: 'authorization_identity_required' } });
  expect(await call('unknown')).toMatchObject({ status: 401, body: { error: 'authorization_identity_required' } });
});
