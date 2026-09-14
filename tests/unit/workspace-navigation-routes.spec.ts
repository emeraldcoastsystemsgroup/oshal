/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify workspace discovery over real HTTP, installed profile synthesis and current application policy without dispatching package pages.
 */
/** Real Express, package loading, profile synthesis and authorization; only persistence, identity and coarse access are isolated doubles. */
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
import { createWorkspaceNavigationRoutes } from '@/app/routes/workspace-navigation-routes';
import type { AppContext } from '@/app/composition/app-context';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { SwarmAppService, type SwarmAppManifest, type SwarmApplicationRecord, type AppAccessService } from '@/features/swarm-apps';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationChange } from '@/shared/application-authorization';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const APP = 'navigation-app', ISSUER = 'https://workspace-identity.fixture.test';
const alice: AuthorizationActor = { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const admin: AuthorizationActor = { sub: 'administrator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const catalog: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'app.open': { resource: 'records', effect: 'read', minimumTier: 'viewer' },
    'records.read': { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
  roles: { opener: { tier: 'viewer', grants: [{ permission: 'app.open', scope: 'own' }] },
    reader: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'own' }] } },
  bindings: { http: [{ id: 'shell', method: 'GET', path: '/app', allOf: ['app.open'] },
    { id: 'records', method: 'GET', path: '/records', allOf: ['records.read'] },
    { id: 'combined', method: 'GET', path: '/combined', allOf: ['app.open', 'records.read'] }] },
};
const PACKAGE = `exports.createRoutes = function(ctx) {
  ctx.authorization.registerResource('records', { authorize: async function() { return true; } });
  return function(req, res) { ctx.fixtureDispatch(); res.json({ fixture: 'package-page', path: req.url }); };
};`;

let root: string, server: Server, base: string, now: number;
let apps: SwarmAppService, runtime: ApplicationAuthorizationRuntime, policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore;
let records: Map<string, SwarmApplicationRecord>, memberTenants: string[], denyCoarse: Set<string>;
let dispatches: number, queries: number;

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

async function install(overrides: Partial<SwarmAppManifest> = {}) {
  const input = manifest(overrides), directory = join(root, input.name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'authorization.yaml'), yaml.dump(catalog));
  writeFileSync(join(directory, 'routes.js'), PACKAGE);
  const file = join(directory, 'oshal-app.yaml'); writeFileSync(file, yaml.dump(input));
  await apps.loadApp(file); return records.get(input.name)!;
}

async function installGroup(defaultView?: string) {
  return install({ name: 'navigation-group', kind: 'group', theme: undefined, uses: undefined, routes: undefined,
    authorization: undefined, ui: undefined, dependencies: { apps: [APP] }, toolbar: [{ app: APP, surface: 'home' }],
    ...(defaultView ? { ribbon: { defaultView } } : {}) });
}

async function change(action: AuthorizationChange['action'] = 'grant', options: Partial<AuthorizationChange> = {}) {
  const preview = await policy.previewChange(admin, { action, app: APP, targetSub: alice.sub, targetIssuer: alice.issuer,
    ...(['grant', 'revoke'].includes(action) ? { role: 'opener' } : {}), reason: 'Isolated workspace navigation fixture',
    expectedRevision: (await store.read()).revision, ...options });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}

async function resolveActor(req: Request): Promise<AuthorizationActor> {
  const name = req.get('x-fixture-user');
  if (name === 'alice') return structuredClone({ ...alice, tenantIds: memberTenants });
  if (name === 'administrator') return structuredClone(admin);
  if (name === 'other-issuer') return { ...alice, issuer: 'https://other-identity.fixture.test' };
  if (name === 'inactive') return { ...alice, isActive: false };
  if (name === 'broken') throw new Error('Fixture identity provider unavailable');
  throw Object.assign(new Error('No verified fixture actor'), { status: 401 });
}

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
  root = mkdtempSync(join(tmpdir(), 'oshal-workspace-navigation-')); now = Date.now();
  records = new Map(); memberTenants = []; denyCoarse = new Set(); dispatches = 0; queries = 0;
  const repo = memoryRepository(), pool = { query: async () => { queries++; return { rows: [], rowCount: 0 }; } };
  store = new MemoryAuthorizationStore();
  policy = new ApplicationAuthorizationService(store, { now: () => now, resolveTier: async () => ({ tier: 'admin', explicit: false }) });
  runtime = new ApplicationAuthorizationRuntime(policy, resolveActor, { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' }, repo.findByName);
  const app = express();
  const requiresAuth: RequestHandler = (req, res, next) => {
    if (req.get('x-fixture-user')) { next(); return; } res.status(401).json({ error: 'fixture_auth_required' });
  };
  const access: Pick<AppAccessService, 'resolve'> = { resolve: async (appName, userSub) => ({ appName, userSub,
    tier: denyCoarse.has(appName) ? 'deny' : 'admin', bundle: null, source: 'default' }) };
  const context = { pool, applicationAuthorization: runtime, fixtureDispatch: () => { dispatches++; } } as unknown as AppContext;
  const mounter = new ManifestRouteMounterImpl(app, requiresAuth, context, access as AppAccessService, runtime);
  apps = new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never,
    undefined, undefined, undefined, mounter, undefined, undefined, undefined, undefined, runtime);
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

async function call(user: string | null = 'alice') {
  const response = await fetch(`${base}/api/ui/workspaces`, { headers: user ? { 'x-fixture-user': user } : {} });
  return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
}

async function names(user = 'alice'): Promise<string[]> {
  const response = await call(user); expect(response.status).toBe(200); expect(response.cache).toBe('private, no-store');
  return response.body.workspaces.map((workspace: { name: string }) => workspace.name);
}

function surface(url: string, name = APP) {
  const record = records.get(name)!;
  record.manifest.ui!.static![0].iframeUrl = url;
}

it('resolves real listApps summaries into viewer-visible records and returns only canonical navigation metadata', async () => {
  const record = await install(); await change();
  const summary = (await apps.listApps('active', { ownerSub: alice.sub, isOperator: false }))[0];
  expect(summary).not.toHaveProperty('manifest');
  const profile = await apps.synthesiseProfile(APP), saved = await store.read(), priorQueries = queries;
  expect(profile?.defaultView).toBe('tool-home');
  expect(await call()).toEqual({ status: 200, cache: 'private, no-store', body: { workspaces: [
    { name: APP, displayName: record.displayName, href: `/cockpit/?app=${APP}`, kind: 'app', theme: 'workspace' },
  ] } });
  expect(await apps.synthesiseProfile(APP)).toEqual(profile); expect(await store.read()).toEqual(saved);
  expect(queries).toBe(priorQueries); expect(dispatches).toBe(0);
  const page = await fetch(`${base}/api/${APP}/app`, { headers: { 'x-fixture-user': 'alice' } });
  expect(page.status).toBe(200); expect(await page.json()).toHaveProperty('fixture', 'package-page'); expect(dispatches).toBe(1);
});

it('requires a current verified actor and preserves thrown identity failures as 401', async () => {
  await install(); await change();
  expect((await call(null)).status).toBe(401);
  for (const user of ['unknown', 'inactive']) {
    expect(await call(user)).toMatchObject({ status: 401, cache: 'private, no-store', body: { error: 'authorization_identity_required' } });
  }
  expect(await call('broken')).toMatchObject({ status: 503, cache: 'private, no-store', body: { error: 'workspace_navigation_unavailable' } });
  expect(await names('other-issuer')).toEqual([]); expect(dispatches).toBe(0);
});

it('rechecks grants, revocation and exact expiry on every discovery request', async () => {
  await install(); expect(await names()).toEqual([]);
  await change(); expect(await names()).toEqual([APP]);
  await change('revoke'); expect(await names()).toEqual([]);
  await change('grant', { expiresAt: new Date(now + 1000).toISOString() }); expect(await names()).toEqual([APP]);
  now += 1000; expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it('does not infer the default HTTP permission from app discovery, coarse admin tier or platform administrator status', async () => {
  await install(); await change('grant', { role: 'reader' });
  expect(await runtime.canDiscover(APP, alice)).toBe(true); expect(await names()).toEqual([]);
  await change('grant', { role: 'reader', targetSub: admin.sub });
  expect(await runtime.canDiscover(APP, admin)).toBe(true); expect(await names('administrator')).toEqual([]);
  await change(); expect(await names()).toEqual([APP]); expect(dispatches).toBe(0);
});

it('admits business-only shell grants while current membership exists and preserves global explicit deny', async () => {
  await install(); await change('grant', { tenantId: 'business-a' });
  expect(await names()).toEqual([]); memberTenants = ['business-a']; expect(await names()).toEqual([APP]);
  memberTenants = ['business-b']; expect(await names()).toEqual([]);
  memberTenants = ['business-a']; await change('deny'); expect(await names()).toEqual([]);
  await change('clear-deny'); expect(await names()).toEqual([APP]); expect(dispatches).toBe(0);
});

it('uses membership fallback only for the exact read-only app.open binding', async () => {
  await install(); memberTenants = ['business-a'];
  await change('grant', { tenantId: 'business-a' }); await change('grant', { tenantId: 'business-a', role: 'reader' });
  expect(await names()).toEqual([APP]);
  for (const path of ['/records', '/combined', '/unbound']) {
    surface(`/api/${APP}${path}`); expect(await names()).toEqual([]);
  }
  surface(`/api/${APP}/records?workspace=business-a`); expect(await names()).toEqual([APP]); expect(dispatches).toBe(0);
});

it.each(['workspace=', 'workspace=business-b', 'workspace=business-a&workspace=business-b',
  'workspace[id]=business-a', 'workspace=%00', `workspace=${'a'.repeat(129)}`])('refuses invalid or unauthorized declared workspace selection: %s', async query => {
  await install(); memberTenants = ['business-a']; await change('grant', { tenantId: 'business-a' });
  surface(`/api/${APP}/app?${query}`); expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it('admits an explicit current business workspace and withdraws it after membership removal', async () => {
  await install(); memberTenants = ['business-a']; await change('grant', { tenantId: 'business-a' });
  surface(`/api/${APP}/app?workspace=business-a`); expect(await names()).toEqual([APP]);
  memberTenants = []; expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it.each(['https://external.fixture.test/app', '//external.fixture.test/app', 'javascript:alert(1)',
  '/\\external.fixture.test/app', '/unowned/app'])('omits unsupported or unowned initial surfaces: %s', async url => {
  await install(); await change(); surface(url); expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it('requires a declared iframe default and a focused app theme or group', async () => {
  const record = await install(); await change();
  record.manifest.ribbon = { defaultView: 'settings' }; expect(await names()).toEqual([]);
  record.manifest.ribbon = { defaultView: 'missing' }; expect(await names()).toEqual([]);
  record.manifest.ribbon = {}; delete record.manifest.theme; expect(await names()).toEqual([]);
  record.manifest.theme = 'workspace'; expect(await names()).toEqual([APP]); expect(dispatches).toBe(0);
});

it('rechecks active installation, current visibility and explicit coarse denial', async () => {
  const record = await install(); await change();
  record.scope = 'person'; record.ownerSub = 'someone-else'; expect(await names()).toEqual([]);
  record.ownerSub = alice.sub; expect(await names()).toEqual([APP]);
  record.scope = 'operator'; expect(await names()).toEqual([]);
  await change('grant', { targetSub: admin.sub }); expect(await names('administrator')).toEqual([APP]);
  record.scope = 'public'; denyCoarse.add(APP); expect(await names()).toEqual([]);
  denyCoarse.clear(); await apps.toggleApp(APP, false); expect(await names()).toEqual([]);
  await apps.toggleApp(APP, true); expect(await names()).toEqual([APP]);
  runtime.unregister(APP); expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it('rechecks viewer visibility after the summary list is fetched', async () => {
  const record = await install(); await change(); const list = apps.listApps.bind(apps);
  vi.spyOn(apps, 'listApps').mockImplementationOnce(async (...args) => {
    const summaries = await list(...args); record.scope = 'person'; record.ownerSub = 'someone-else'; return summaries;
  });
  expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it('admits only a group own exact kernel setup exemption and checks borrowed member HTTP grants', async () => {
  await install(); const group = await installGroup();
  await change('grant', { app: group.name, role: '@app-admin' });
  expect(await names()).toEqual([group.name]);
  group.manifest.ribbon = { defaultView: 'home' }; expect(await names()).toEqual([]);
  await change(); expect(await names()).toEqual([APP, group.name]);
  await change('revoke'); expect(await names()).toEqual([]);
  surface('/api/swarm/apps/another-group/setup-dashboard'); expect(await names()).toEqual([]);
  surface(`/api/swarm/apps/${group.name}/setup-dashboard/extra`); expect(await names()).toEqual([]);
  group.manifest.ribbon = {}; expect(await names()).toEqual([group.name]); expect(dispatches).toBe(0);
});

it('does not give a regular app the group setup exemption', async () => {
  await install(); await change(); surface(`/api/swarm/apps/${APP}/setup-dashboard`);
  expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it('selects the longest mount and retains denied ownership when that package becomes unavailable', async () => {
  await install(); await change();
  const child = await install({ name: 'nested-navigation', routes: [
    { module: 'routes.js', factory: 'createRoutes', mountPath: `/api/${APP}/nested`, auth: 'service-or-oidc' }], theme: undefined });
  surface(`/api/${APP}/nested/app`); expect(await names()).toEqual([]);
  await change('grant', { app: child.name }); expect(await names()).toEqual([APP]);
  runtime.unregister(child.name); expect(await names()).toEqual([]);
  expect(await runtime.canNavigateHttpPath(alice, `/api/${APP}-other/app`)).toBeNull(); expect(dispatches).toBe(0);
});

it('does not exempt group setup when a protected package owns its exact path', async () => {
  await install(); const group = await installGroup(); await change('grant', { app: group.name, role: '@app-admin' });
  expect(await names()).toEqual([group.name]);
  await install({ name: 'setup-owner', theme: undefined, routes: [
    { module: 'routes.js', factory: 'createRoutes', mountPath: `/api/swarm/apps/${group.name}`, auth: 'service-or-oidc' }] });
  expect(await names()).toEqual([]); expect(dispatches).toBe(0);
});

it('withdraws a workspace whose installed profile crosses a completed reload', async () => {
  const record = await install(); await change(); const synthesise = apps.synthesiseProfile.bind(apps);
  vi.spyOn(apps, 'synthesiseProfile').mockImplementationOnce(async name => {
    const profile = await synthesise(name); await apps.loadApp(record.manifestPath); return profile;
  });
  expect(await names()).toEqual([]); expect(await names()).toEqual([APP]); expect(dispatches).toBe(0);
});

it.each([false, true])('rejects a borrowed member policy decision crossing reload before membership fallback (business-only=%s)', async businessOnly => {
  const record = await install(); const group = await installGroup('home');
  if (businessOnly) memberTenants = ['business-a'];
  await change('grant', { ...(businessOnly ? { tenantId: 'business-a' } : {}) });
  await change('grant', { app: group.name, role: '@app-admin' });
  delete record.manifest.theme;
  const authorize = policy.authorize.bind(policy), generation = runtime.snapshot(APP)!.generation;
  vi.spyOn(policy, 'authorize').mockImplementationOnce(async (actor, operation) => {
    const decision = await authorize(actor, operation); await apps.loadApp(record.manifestPath); return decision;
  });
  expect(await call()).toMatchObject({ status: 503, cache: 'private, no-store', body: { error: 'workspace_navigation_unavailable' } });
  expect(runtime.snapshot(APP)!.generation).not.toBe(generation); expect(dispatches).toBe(0);
  expect(await names()).toEqual([APP, group.name]);
});
