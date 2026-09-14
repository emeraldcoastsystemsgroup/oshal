/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Mount real service-only package smokes under exact-principal application policy and the real Lab session transport using disposable local HTTP fixtures.
 */
import express, { type Request } from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { InstalledAppTestCatalog, type AppSmokeFetch, type SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import { createServiceSmokeFetch } from '@/app/composition/test-lab-wiring';
import { createTestLabRoutes, type TestLabRouteOptions } from '@/app/routes/test-lab-routes';
import type { AppContext } from '@/app/composition/app-context';

export const SMOKE_SECRET = 'synthetic-service-smoke-secret';
const appName = 'session-smoke';
const smokePath = '/api/session-smoke/_smoke';

/** @description Write the minimal actual service-only package. @param root Owned fixture directory. @returns Installed record. */
function packageRecord(root: string): SwarmApplicationRecord {
  const manifest = { name: appName, displayName: 'Session smoke', version: '1.0.0', status: 'active' as const,
    suite: 'ai-home' as const, routes: [{ module: 'routes.js', factory: 'routes', mountPath: smokePath, auth: 'service' as const }],
    smoke: [{ name: 'readiness', method: 'GET' as const, path: smokePath, auth: 'service' as const,
      expect: { status: 200, jsonPointer: '/package', rejectValues: ['empty'] } }] };
  const manifestPath = join(root, 'oshal-app.yaml');
  writeFileSync(manifestPath, yaml.dump(manifest));
  writeFileSync(join(root, 'routes.js'), `exports.routes = () => (_req, res) => res.json({package:'${appName}'});`);
  return { appId: appName, name: appName, displayName: manifest.displayName, description: '', version: '1.0.0', status: 'active',
    manifestPath, manifest, agentIds: [], toolNames: [], scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null,
    loadedAt: new Date(), updatedAt: new Date() };
}

/** @description Grant or revoke the exact original fixture identity. @param policy Real policy service.
 * @param store Current revision. @param owner Verified operator. @param action Add or remove. @returns Applied receipt.
 */
async function role(policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore, owner: AuthorizationActor, action: 'grant' | 'revoke') {
  const review = await policy.previewChange(owner, { action, app: appName, targetSub: owner.sub, targetIssuer: owner.issuer,
    role: '@app-admin', reason: 'Synthetic service-smoke acceptance', expectedRevision: (await store.read()).revision });
  return policy.applyChange(owner, { previewId: review.previewId, idempotencyKey: randomUUID() });
}

/** @description Create an actual cookie-only HTTP identity boundary and current application role store.
 * @returns Fixture controls and cleanup; no live database, credentials or provider calls are used.
 */
export async function startServiceSmokeFixture() {
  const environment = { APP_PACKAGE_DYNAMIC_ROUTES: process.env.APP_PACKAGE_DYNAMIC_ROUTES, SWARM_SERVICE_SECRET: process.env.SWARM_SERVICE_SECRET };
  process.env.APP_PACKAGE_DYNAMIC_ROUTES = 'true'; process.env.SWARM_SERVICE_SECRET = SMOKE_SECRET;
  const root = mkdtempSync(join(tmpdir(), 'service-smoke-session-'));
  const record = packageRecord(root), store = new MemoryAuthorizationStore();
  const owner = { sub: 'same-sub', issuer: 'https://first.fixture.test', isActive: true, isSwarmAdmin: true };
  const actors: Record<string, AuthorizationActor> = { owner, foreign: { ...owner, issuer: 'https://second.fixture.test' },
    reader: { ...owner, sub: 'reader', isSwarmAdmin: false } };
  const resolveActor = async (req: Request) => {
    const actor = actors[/(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''];
    if (!actor) throw Object.assign(new Error('Verified fixture session required'), { status: 401 });
    return { ...actor };
  };
  const policy = new ApplicationAuthorizationService(store);
  const runtime = new ApplicationAuthorizationRuntime(policy, resolveActor, { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' });
  await runtime.start(record); runtime.complete(record); await role(policy, store, owner, 'grant');
  const catalog = new InstalledAppTestCatalog(); catalog.register(record);
  const app = express(); app.use(express.json());
  app.use(async (req, _res, next) => {
    const actor = await resolveActor(req).catch(() => undefined);
    Object.assign(req, { oidc: { isAuthenticated: () => !!actor, user: actor } }); next();
  });
  const ctx = {} as AppContext;
  let redirectTo = '';
  app.get(smokePath, (_req, res, next) => { if (redirectTo) res.redirect(302, redirectTo); else next(); });
  const mounter = new ManifestRouteMounterImpl(app, (_req, res) => { res.sendStatus(401); }, ctx, undefined, runtime);
  await mounter.mount(appName, root, record.manifest.routes!);
  let base = '', enabled = true, callbacks = 0;
  const options: TestLabRouteOptions = { installedTests: catalog, visibleApps: async () => new Map([[appName, 'Session smoke']]),
    executionAuth: req => ({ serviceSecret: req.oidc?.user?.isSwarmAdmin ? SMOKE_SECRET : undefined, canRunSuites: req.oidc?.user?.isSwarmAdmin === true }),
    serviceSmokeFetch: async (req, test) => { callbacks++; return enabled ? createServiceSmokeFetch(req, resolveActor, base, test.path) : undefined; },
    apiBaseUrl: undefined };
  app.use('/api/test-lab', createTestLabRoutes(ctx, options));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  options.apiBaseUrl = base;
  return fixtureControls({ root, base, server, actors, owner, policy, store, catalog, resolveActor,
    environment, redirect: (value: string) => { redirectTo = value; }, enable: (value: boolean) => { enabled = value; }, callbacks: () => callbacks });
}

/** @description Keep lifecycle and caller-scoped probe helpers out of the mount setup. @param state Owned fixture state.
 * @returns Narrow test ports with real HTTP and normal authorization changes.
 */
function fixtureControls(state: {
  root: string; base: string; server: ReturnType<ReturnType<typeof express>['listen']>; actors: Record<string, AuthorizationActor>;
  owner: AuthorizationActor; policy: ApplicationAuthorizationService; store: MemoryAuthorizationStore; catalog: InstalledAppTestCatalog;
  resolveActor: (req: Request) => Promise<AuthorizationActor>; enable: (value: boolean) => void; callbacks: () => number;
  environment: Record<string, string | undefined>; redirect: (value: string) => void;
}) {
  const request = (who = 'owner', authorization?: string) => ({ headers: { cookie: `session=${who}`, ...(authorization ? { authorization } : {}) },
    oidc: { isAuthenticated: () => who in state.actors, user: state.actors[who] } }) as unknown as Request;
  return { ...state, smokePath, request,
    transport: (who = 'owner', authorization?: string) => createServiceSmokeFetch(request(who, authorization), state.resolveActor, state.base, smokePath),
    change: (action: 'grant' | 'revoke') => role(state.policy, state.store, state.owner, action),
    run: async (who = 'owner', scenarioId = `app:${appName}:smoke:readiness`) => {
      const response = await fetch(state.base + '/api/test-lab/run', { method: 'POST', headers: { cookie: `session=${who}`, 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId, apiBaseUrl: 'https://ignored.invalid', cookie: 'session=foreign' }) });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      state.server.closeAllConnections(); await new Promise<void>(done => state.server.close(() => done())); rmSync(state.root, { recursive: true, force: true });
      for (const [key, value] of Object.entries(state.environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    },
  };
}

/** @description Build a fixed request for direct transport boundary tests. @returns Read-only service headers and a bounded signal. */
export function smokeRequest(): Parameters<AppSmokeFetch>[1] {
  return { method: 'GET', headers: { 'x-service-secret': SMOKE_SECRET }, signal: AbortSignal.timeout(5000), redirect: 'manual' };
}
