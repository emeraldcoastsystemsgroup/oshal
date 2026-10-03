/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Cross the real manifest loader, package module loader, HTTP mounter and enforce policy for exact anonymous reads.
 */
import express, { type Request, type Response, type RequestHandler, type NextFunction } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';
import type { SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import { getApplicationAuthorizationActor, runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { getCaller, getTrustedServiceUserSub, hasAuthenticatedUserIdentity } from '@/shared/middleware/authz';
import { appAccessCallerSub, appAccessCallerIssuer } from '@/app/middleware/app-access-policy';

// Persistence/publication is an explicit fixture port. Loader, module resolution, policy,
// HTTP, per-module fallthrough, filesystem bytes and teardown are real; no database proof claimed.
const TOKEN = 'a'.repeat(64);
const BYTES = Buffer.from('fixture immutable published video bytes');
const MODULE = `
exports.createRoutes = ctx => (req, res, next) => {
  ctx.fixtureObserve(req, res);
  const path = req.url.split('?')[0];
  if (path === '/sync-error/video.mp4') throw new Error('fixture synchronous failure');
  if (path === '/restore-failure/video.mp4') {
    Object.defineProperty(req, 'oidc', { configurable: false, value: undefined }); next(); return;
  }
  if (path.startsWith('/async-')) return Promise.resolve().then(() => {
    ctx.fixtureObserve(req, res);
    if (path === '/async-error/video.mp4') throw new Error('fixture asynchronous failure');
    if (path === '/async-restore-failure/video.mp4') {
      Object.defineProperty(req, 'oidc', { configurable: false, value: undefined });
    }
    next();
    if (path === '/async-late-error/video.mp4') throw new Error('fixture failure after next');
  });
  if (path === '/fallthrough/video.mp4') { next(); return; }
  const match = /^\\/([^/]+)\\/video\\.mp4$/.exec(path);
  if (match) {
    const bytes = ctx.fixtureRead(match[1]);
    res.setHeader('Cache-Control', 'private, no-store');
    if (!bytes) { res.status(404).end(); return; }
    res.type('video/mp4').send(bytes); return;
  }
  res.json({ private: true });
};
exports.createSibling = ctx => (req, res) => { ctx.fixtureObserve(req, res); res.json({ sibling: true }); };
exports.createSeeder = ctx => (req, res, next) => { ctx.fixtureSeed(req, res); next(); };
exports.createDelayer = ctx => async (req, res, next) => { await ctx.fixturePause(); next(); };
`;
let root: string, server: Server, base: string, runtime: ApplicationAuthorizationRuntime, mounter: ManifestRouteMounterImpl;
let revoked: boolean, actorCalls: number, handlers: Array<{ sub: unknown; identity: unknown; actor: unknown }>;
let requestViews: ReturnType<typeof requestView>[], resumedViews: ReturnType<typeof requestView>[];
let errorViews: Array<{ message: string; view: ReturnType<typeof requestView> }>;
let delayedReached: Promise<void>, releaseDelayed: () => void;
function requestView(req: Request & { oshalCallerSub?: string }, res: Response) {
  return { url: req.url, originalUrl: req.originalUrl,
    caller: getCaller(req), authenticated: hasAuthenticatedUserIdentity(req), carried: req.oshalCallerSub,
    trusted: getTrustedServiceUserSub(req), accessSub: appAccessCallerSub(req), issuer: appAccessCallerIssuer(req),
    locals: { app: res.locals.oshalAppAccess, auth: res.locals.applicationAuthorization },
    identity: getRequestIdentity(), actor: getApplicationAuthorizationActor(),
    authorization: req.get('authorization'), cookie: req.get('cookie'), service: req.get('x-service-secret'),
    rawService: req.rawHeaders.some(value => value.toLowerCase() === 'x-service-secret'),
  };
}
function seedRequestIdentity(req: Request, res: Response) {
  Object.assign(req, { oshalCallerSub: 'carried-fixture', oidc: { isAuthenticated: () => true,
    user: { sub: 'session-fixture', iss: 'https://fixture.test', email: 'user@example.test' },
    idTokenClaims: { iss: 'https://fixture.test' } } });
  res.locals.oshalAppAccess = { tier: 'admin' }; res.locals.applicationAuthorization = { allowed: true };
}
const route = () => ({ module: 'route.cjs', factory: 'createRoutes', mountPath: '/api/public-fixture', auth: 'public' as const,
  anonymousRoutes: [{ method: 'GET' as const, path: '/:token/video.mp4' }, { method: 'HEAD' as const, path: '/:token/video.mp4' }] });
function manifest(overrides: Partial<SwarmAppManifest> = {}): SwarmAppManifest {
  return { name: 'public-fixture', displayName: 'Public read fixture', suite: 'ai-creative', version: '1.0.0',
    uses: ['package-anonymous-routes'], routes: [route()], ...overrides };
}
async function install(input = manifest(), complete = true) {
  const dir = join(root, input.name); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'oshal-app.yaml'); writeFileSync(file, yaml.dump(input));
  writeFileSync(join(dir, 'route.cjs'), MODULE);
  const loaded = readManifest(file);
  const record = { name: loaded.name, manifest: loaded, manifestPath: file } as SwarmApplicationRecord;
  await runtime.prepare(loaded, file); await runtime.start(record);
  await mounter.mount(loaded.name, dir, loaded.routes!, loaded.access);
  if (complete) runtime.complete(record);
  return { loaded, record, dir };
}
const fetchPath = (suffix: string, init?: RequestInit) => fetch(base + suffix, init);
const published = () => '/api/public-fixture/' + TOKEN + '/video.mp4';

beforeEach(async () => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', '1');
  vi.stubEnv('OSHAL_APPLICATION_AUTHORIZATION_MODE', 'enforce');
  vi.stubEnv('SWARM_SERVICE_SECRET', 'example-anonymous-read-secret');
  root = mkdtempSync(join(tmpdir(), 'oshal-anonymous-http-'));
  writeFileSync(join(root, 'video.mp4'), BYTES);
  revoked = false; actorCalls = 0; handlers = []; requestViews = []; resumedViews = []; errorViews = [];
  let markDelayed!: () => void, pauseOnce = true;
  delayedReached = new Promise<void>(resolve => { markDelayed = resolve; });
  const service = new ApplicationAuthorizationService(new MemoryAuthorizationStore());
  runtime = new ApplicationAuthorizationRuntime(service, async (req: Request) => {
    actorCalls++;
    if (req.get('x-fixture-identity') === 'signed-in') return { sub: 'session-fixture', issuer: 'https://fixture.test',
      isActive: true, isSwarmAdmin: true };
    throw Object.assign(new Error('No authenticated fixture principal'), { status: 401 });
  }, { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' });
  const app = express();
  // Even an upstream privileged context cannot become the anonymous reader's database identity.
  app.use((_req, _res, next) => runWithRequestIdentity({ sub: 'upstream-fixture', isOperator: true },
    () => runWithApplicationAuthorizationActor({ sub: 'upstream-fixture', issuer: 'https://fixture.test',
      isActive: true, isSwarmAdmin: true }, next)));
  app.use((req, res, next) => { if (req.get('x-fixture-identity')) seedRequestIdentity(req, res); next(); });
  const ctx = {
    fixtureRead: (token: string) => token === TOKEN && !revoked ? readFileSync(join(root, 'video.mp4')) : undefined,
    fixtureObserve: (req: Request & { oshalCallerSub?: string }, res: Response) => {
      handlers.push({ sub: req.oshalCallerSub, identity: getRequestIdentity(), actor: getApplicationAuthorizationActor() });
      requestViews.push(requestView(req, res));
    },
    fixtureSeed: seedRequestIdentity,
    fixturePause: () => {
      if (!pauseOnce) return Promise.resolve();
      pauseOnce = false;
      const pause = new Promise<void>(resolve => { releaseDelayed = resolve; });
      markDelayed(); return pause;
    },
  } as unknown as AppContext;
  const requiresAuth: RequestHandler = (_req, res) => { res.status(401).json({ error: 'sign_in_required' }); };
  mounter = new ManifestRouteMounterImpl(app, requiresAuth, ctx, undefined, runtime);
  app.use((req, res) => { resumedViews.push(requestView(req, res)); res.status(404).end(); });
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    errorViews.push({ message: error.message, view: requestView(req, res) });
    res.status(500).json({ error: 'fixture_handler_failed' });
  });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  if (root) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

describe('exact anonymous route through enforce', () => {
  it('serves declared GET bytes and HEAD without resolving or manufacturing an identity', async () => {
    await install();
    const response = await fetchPath(published() + '?download=1');
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const head = await fetchPath(published(), { method: 'HEAD' });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(BYTES.length));
    expect(actorCalls).toBe(0); expect(handlers).toHaveLength(2);
    for (const observation of handlers) expect(observation).toEqual({
      sub: undefined, actor: undefined, identity: { sub: null, principalIssuer: null, isOperator: false },
    });
  });
  it('does not attach a service-secret subject to the anonymous reader', async () => {
    await install();
    expect((await fetchPath(published(), { headers: { 'x-service-secret': 'example-anonymous-read-secret',
      'x-oshal-user-sub-b64': Buffer.from('forged-owner').toString('base64url') } })).status).toBe(200);
    expect(handlers[0].sub).toBeUndefined(); expect(actorCalls).toBe(0);
    expect(requestViews[0].trusted).toBeNull(); expect(requestViews[0].service).toBeUndefined();
  });
  it('masks prepopulated session, carried identity, service headers and prior access decisions only inside the anonymous handler', async () => {
    await install();
    const response = await fetchPath('/api/public-fixture/fallthrough/video.mp4', { headers: {
      'x-fixture-identity': 'signed-in', authorization: 'Bearer fixture-authority', cookie: 'fixture=session',
      'x-service-secret': 'example-anonymous-read-secret', 'x-oshal-user-sub-b64': Buffer.from('carried-fixture').toString('base64url'),
    } });
    expect(response.status).toBe(404); expect(actorCalls).toBe(0);
    expect(requestViews[0]).toMatchObject({ caller: { sub: null, email: null }, authenticated: false, carried: undefined,
      trusted: null, accessSub: null, issuer: null, locals: { app: undefined, auth: undefined },
      authorization: undefined, cookie: undefined, service: undefined, rawService: false,
      identity: { sub: null, isOperator: false }, actor: undefined });
    expect(resumedViews[0]).toMatchObject({ caller: { sub: 'session-fixture' }, authenticated: true, carried: 'carried-fixture',
      trusted: 'carried-fixture', locals: { app: { tier: 'admin' }, auth: { allowed: true } },
      authorization: 'Bearer fixture-authority', cookie: 'fixture=session', service: 'example-anonymous-read-secret', rawService: true,
      identity: { sub: 'upstream-fixture', isOperator: true }, actor: { sub: 'upstream-fixture' } });
  });
  it('masks caller and locals populated by an earlier authorized same-mount handler', async () => {
    await install(manifest({ routes: [{ ...route(), factory: 'createSeeder', anonymousRoutes: undefined }, route()] }));
    const installer = { sub: 'installer-fixture', issuer: 'https://fixture.test', isActive: true, isSwarmAdmin: true };
    const preview = await runtime.service.previewChange(installer, { action: 'grant', app: 'public-fixture',
      targetSub: 'session-fixture', targetIssuer: 'https://fixture.test', role: '@app-admin',
      reason: 'Permit the exact earlier fixture handler before the anonymous reader', expectedRevision: 0 });
    await runtime.service.applyChange(installer, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
    expect((await fetchPath(published(), { headers: { 'x-fixture-identity': 'signed-in' } })).status).toBe(200);
    expect(actorCalls).toBe(1);
    expect(requestViews).toHaveLength(1);
    expect(requestViews[0]).toMatchObject({ caller: { sub: null }, carried: undefined, accessSub: null,
      locals: { app: undefined, auth: undefined }, identity: { sub: null, isOperator: false }, actor: undefined });
  });
  it.each(['sync-error', 'async-error'])('restores URL, request identity and async context before handling %s', async token => {
    await install();
    const path = '/api/public-fixture/' + token + '/video.mp4?download=1';
    const response = await fetchPath(path, { signal: AbortSignal.timeout(3000), headers: {
      'x-fixture-identity': 'signed-in', authorization: 'Bearer fixture-authority', cookie: 'fixture=session',
      'x-service-secret': 'example-anonymous-read-secret', 'x-oshal-user-sub-b64': Buffer.from('carried-fixture').toString('base64url'),
    } });
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'fixture_handler_failed' });
    expect(errorViews).toHaveLength(1); expect(resumedViews).toHaveLength(0); expect(actorCalls).toBe(0);
    expect(errorViews[0].message).toBe(token === 'sync-error' ? 'fixture synchronous failure' : 'fixture asynchronous failure');
    expect(errorViews[0].view).toMatchObject({ url: path, originalUrl: path,
      caller: { sub: 'session-fixture' }, authenticated: true, carried: 'carried-fixture', trusted: 'carried-fixture',
      locals: { app: { tier: 'admin' }, auth: { allowed: true } },
      authorization: 'Bearer fixture-authority', cookie: 'fixture=session', service: 'example-anonymous-read-secret', rawService: true,
      identity: { sub: 'upstream-fixture', isOperator: true }, actor: { sub: 'upstream-fixture' } });
    expect(requestViews).toHaveLength(token === 'sync-error' ? 1 : 2);
    for (const view of requestViews) expect(view).toMatchObject({ authenticated: false, carried: undefined,
      locals: { app: undefined, auth: undefined }, identity: { sub: null, isOperator: false }, actor: undefined });
  });
  it.each(['async-fallthrough', 'async-late-error'])('restores before %s without continuing twice', async token => {
    await install();
    const path = '/api/public-fixture/' + token + '/video.mp4?download=1';
    expect((await fetchPath(path, { headers: { 'x-fixture-identity': 'signed-in' } })).status).toBe(404);
    expect(resumedViews).toHaveLength(1); expect(errorViews).toHaveLength(0); expect(actorCalls).toBe(0);
    expect(resumedViews[0]).toMatchObject({ url: path, originalUrl: path, authenticated: true, carried: 'carried-fixture',
      locals: { app: { tier: 'admin' }, auth: { allowed: true } },
      identity: { sub: 'upstream-fixture', isOperator: true }, actor: { sub: 'upstream-fixture' } });
    expect(requestViews).toHaveLength(2);
    expect(requestViews[1]).toMatchObject({ authenticated: false, carried: undefined,
      locals: { app: undefined, auth: undefined }, identity: { sub: null, isOperator: false }, actor: undefined });
  });
  it.each(['restore-failure', 'async-restore-failure'])('fails closed if %s prevents scope restoration', async token => {
    await install();
    const response = await fetchPath('/api/public-fixture/' + token + '/video.mp4', {
      headers: { 'x-fixture-identity': 'signed-in' }, signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'anonymous_request_scope_unavailable' });
    expect(resumedViews).toHaveLength(0); expect(errorViews).toHaveLength(0); expect(actorCalls).toBe(0);
  });
  it('returns 404 for malformed, unpublished and revoked tokens without acquiring an owner', async () => {
    await install();
    expect((await fetchPath('/api/public-fixture/not-a-token/video.mp4')).status).toBe(404);
    expect((await fetchPath('/api/public-fixture/' + 'b'.repeat(64) + '/video.mp4')).status).toBe(404);
    expect((await fetchPath(published())).status).toBe(200);
    revoked = true; expect((await fetchPath(published())).status).toBe(404); expect(actorCalls).toBe(0);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('does not exempt the %s method', async method => {
    await install(); const response = await fetchPath(published(), { method });
    expect(response.status).toBe(401); expect((await response.json()).error).toBe('authorization_identity_required');
    expect(handlers).toHaveLength(0);
  });
  it('keeps undeclared controls, listings, similar paths and public mounts behind enforce', async () => {
    await install();
    for (const name of ['world', 'trading-charts']) {
      await install(manifest({ name, routes: [{ ...route(), mountPath: '/api/' + name, anonymousRoutes: undefined }] }));
    }
    for (const path of ['/api/public-fixture/jobs', published() + '/', published() + '/control',
      published().replace('/video.mp4', '/VIDEO.mp4'), '/api/public-fixture/a%2Fb/video.mp4',
      '/api/world/list', '/api/trading-charts/list']) {
      expect((await fetchPath(path)).status, path).toBe(401);
    }
    expect(handlers).toHaveLength(0);
  });
  it('does not infer HEAD from a GET opt-in', async () => {
    await install(manifest({ routes: [{ ...route(), anonymousRoutes: [route().anonymousRoutes[0]] }] }));
    expect((await fetchPath(published(), { method: 'HEAD' })).status).toBe(401);
  });
  it('does not carry an exception across handler fallthrough to another module on the same mount', async () => {
    await install(manifest({ routes: [route(), { ...route(), factory: 'createSibling', anonymousRoutes: undefined }] }));
    expect((await fetchPath('/api/public-fixture/fallthrough/video.mp4')).status).toBe(401);
    expect(handlers).toHaveLength(1);
  });
  it.each(['reload', 'unmount'])('fences an old captured anonymous entry after delayed fallthrough across %s', async action => {
    const input = manifest({ routes: [{ ...route(), factory: 'createDelayer', anonymousRoutes: undefined }, route()] });
    await install(input);
    const installer = { sub: 'installer-fixture', issuer: 'https://fixture.test', isActive: true, isSwarmAdmin: true };
    const preview = await runtime.service.previewChange(installer, { action: 'grant', app: 'public-fixture',
      targetSub: 'session-fixture', targetIssuer: 'https://fixture.test', role: '@app-admin',
      reason: 'Permit a bounded earlier handler while its anonymous successor is retired', expectedRevision: 0 });
    await runtime.service.applyChange(installer, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
    const pending = fetchPath(published(), { headers: { 'x-fixture-identity': 'signed-in' }, signal: AbortSignal.timeout(3000) });
    await delayedReached;
    if (action === 'reload') await install(input); // Exact same declaration, different active handler objects.
    else mounter.unmount(input.name);
    releaseDelayed();
    expect((await pending).status).toBe(503); expect(handlers).toHaveLength(0);
    const fresh = await fetchPath(published(), { headers: { 'x-fixture-identity': 'signed-in' } });
    expect(fresh.status).toBe(action === 'reload' ? 200 : 404);
    expect(handlers).toHaveLength(action === 'reload' ? 1 : 0);
  });
  it('does not carry an exception onto a different factory that was never declared anonymous', async () => {
    const { dir } = await install();
    await mounter.mount('public-fixture', dir, [{ ...route(), factory: 'createSibling' }]);
    expect((await fetchPath(published())).status).toBe(401); expect(handlers).toHaveLength(0);
  });
  it('requires agreement between the mounted declaration and the active policy snapshot', async () => {
    const { dir } = await install();
    await mounter.mount('public-fixture', dir, [{ ...route(), anonymousRoutes: undefined }]);
    expect((await fetchPath(published())).status).toBe(401); expect(handlers).toHaveLength(0);
  });
  it('fails closed before activation completes and after retirement, then removes routes on unmount', async () => {
    const { record } = await install(manifest(), false);
    expect((await fetchPath(published())).status).toBe(503); expect(handlers).toHaveLength(0);
    runtime.complete(record); expect((await fetchPath(published())).status).toBe(200);
    runtime.unregister(record.name); expect((await fetchPath(published())).status).toBe(503);
    mounter.unmount(record.name); expect((await fetchPath(published())).status).toBe(404);
  });
  it('snapshots opt-ins: editing a parsed manifest is not a live authorization change', async () => {
    const { loaded } = await install();
    loaded.routes![0].anonymousRoutes!.push({ method: 'GET', path: '/jobs' });
    expect((await fetchPath('/api/public-fixture/jobs')).status).toBe(401);
  });
  it('removing the opt-in on reload re-protects the exact formerly public route', async () => {
    await install(); expect((await fetchPath(published())).status).toBe(200);
    await install(manifest({ routes: [{ ...route(), anonymousRoutes: undefined }] }));
    expect((await fetchPath(published())).status).toBe(401);
  });
});
