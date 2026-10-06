/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-175 guard: a package node rail (`auth: node`) admits a device-bound node credential for its owner and nothing else. The pure scope matrix, then the REAL createCliTokenAuthMiddleware in front of the REAL ManifestRouteMounter and application authorization runtime in enforce mode: the bound device reaches the handler as its owner with its binding stamped; the shared service secret (the refused B20 path), an unbound PAT, the same device on a non-rail route of the same app, and a device whose owner holds no grant are all refused; unmount closes the rail.
 */
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { createCliTokenAuthMiddleware } from '@/app/routes/cli-token-routes';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { decideNodeTokenScope, isPackageNodeRailPath, registerPackageNodeRail, unregisterPackageNodeRails } from '@/features/remote-client';
import type { SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { trustedServiceUserHeaders } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import { FakeCliTokenPool } from '../helpers/fake-cli-token-pool';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const APP = 'node-rail-fixture';
const RAIL = `/api/${APP}/nodes`;
const SURFACE = `/api/${APP}/world`;
const SECRET = 'example-node-rail-fixture-service-secret';
const ISSUER = 'https://identity.fixture.test';
const OWNER = 'auth0|node-rail-owner';
const STRANGER = 'auth0|node-rail-stranger';
const DEVICE = 'embodied-plant';
const admin: AuthorizationActor = { sub: 'fixture-administrator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };

/** The package's two mounts: the node rail and an ordinary browser surface. */
const ROUTE_MODULE = `exports.createRail = function (ctx) {
  return function (req, res) {
    ctx.calls.push({ kind: 'rail', url: req.url, node: (req.oshalNodeToken || {}).clientId || null,
      sub: (req.oidc && req.oidc.user && req.oidc.user.sub) || null });
    res.json({ ok: true });
  };
};
exports.createSurface = function (ctx) {
  return function (req, res) { ctx.calls.push({ kind: 'surface', url: req.url }); res.json({ ok: true }); };
};`;

/** @description The fixture manifest: an `auth: node` rail beside an `auth: oidc` surface. */
function manifest(): SwarmAppManifest {
  return { name: APP, displayName: 'Node rail fixture', version: '0.1.0', status: 'active', suite: 'ai-home',
    routes: [
      { module: 'routes/fixture.js', factory: 'createRail', mountPath: RAIL, auth: 'node', requiresContext: true },
      { module: 'routes/fixture.js', factory: 'createSurface', mountPath: SURFACE, auth: 'oidc', requiresContext: true },
    ] };
}

let root: string, server: Server | undefined, base: string;
let tokens: FakeCliTokenPool, calls: Array<Record<string, unknown>>;
let mounter: ManifestRouteMounterImpl;

/**
 * @description Boot the real chain: PAT middleware, then the mounter's guards and the enforce-mode
 * application authorization runtime, with OWNER granted the app and STRANGER granted nothing.
 */
async function boot(): Promise<void> {
  mkdirSync(join(root, 'routes'), { recursive: true });
  writeFileSync(join(root, 'routes', 'fixture.js'), ROUTE_MODULE);
  const manifestPath = join(root, 'oshal-app.yaml');
  writeFileSync(manifestPath, yaml.dump(manifest()));
  const record: SwarmApplicationRecord = { appId: APP, name: APP, displayName: 'Node rail fixture', description: '', version: '0.1.0',
    status: 'active', manifestPath, manifest: manifest(), agentIds: [], toolNames: [], scope: 'public', ownerSub: null, tenantId: null,
    guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
  const store = new MemoryAuthorizationStore();
  const policy = new ApplicationAuthorizationService(store, { resolveTier: async () => ({ tier: 'admin', explicit: false }) });
  const pool = { query: async () => { throw new Error('the fixture database must not be consulted'); } } as unknown as Pool;
  const runtime = new ApplicationAuthorizationRuntime(policy, createApplicationAuthorizationActorResolver(pool, { tenantIds: async () => [] }),
    { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' });
  await runtime.start(record); runtime.complete(record);
  const preview = await policy.previewChange(admin, { action: 'grant', app: APP, targetSub: OWNER, targetIssuer: ISSUER,
    role: '@app-admin', reason: 'node rail fixture', expectedRevision: (await store.read()).revision });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });

  const app = express();
  app.use(createCliTokenAuthMiddleware(tokens.asPool()));
  const requiresAuth: RequestHandler = (req, res, next) => {
    const oidc = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
    if (oidc?.isAuthenticated?.()) { next(); return; }
    res.status(401).json({ error: 'fixture_auth_required' });
  };
  mounter = new ManifestRouteMounterImpl(app, requiresAuth, { pool, calls } as unknown as AppContext, undefined, runtime);
  await mounter.mount(APP, root, record.manifest.routes!);
  app.use((_req, res) => res.status(404).json({ error: 'fixture_not_found' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server!.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** @description POST a heartbeat-shaped body with the given headers. */
async function heartbeat(headers: Record<string, string>, path = `${RAIL}/heartbeat`): Promise<number> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id: DEVICE, kind: 'drone' }) });
  return res.status;
}

beforeEach(() => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true');
  vi.stubEnv('SWARM_SERVICE_SECRET', SECRET);
  root = mkdtempSync(join(tmpdir(), 'oshal-node-rail-'));
  tokens = new FakeCliTokenPool();
  calls = [];
});

afterEach(async () => {
  unregisterPackageNodeRails(APP);
  unregisterPackageNodeRails('scope-fixture');
  server?.closeAllConnections();
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('package node rails - the scope matrix', () => {
  it('admits a bound token beneath a registered rail only, on whole segments', () => {
    registerPackageNodeRail('scope-fixture', '/api/scope-fixture/nodes');
    const at = (path: string) => decideNodeTokenScope({ boundClientId: DEVICE, path });
    expect(at('/api/scope-fixture/nodes/heartbeat')).toEqual({ allowed: true, reason: 'package-node-rail' });
    expect(at('/api/scope-fixture/nodes')).toEqual({ allowed: true, reason: 'package-node-rail' });
    expect(at('/api/scope-fixture/nodesX/heartbeat').allowed).toBe(false);
    expect(at('/api/scope-fixture/world/reset').allowed).toBe(false);
    expect(at('/api/other-app/nodes/heartbeat').allowed).toBe(false);
    unregisterPackageNodeRails('scope-fixture');
    expect(at('/api/scope-fixture/nodes/heartbeat').allowed).toBe(false);
  });

  it('never registers a bare /api or root rail', () => {
    registerPackageNodeRail('scope-fixture', '/api');
    registerPackageNodeRail('scope-fixture', '/');
    expect(isPackageNodeRailPath('/api/content')).toBe(false);
  });

  it('an empty binding is still refused on a rail', () => {
    registerPackageNodeRail('scope-fixture', '/api/scope-fixture/nodes');
    expect(decideNodeTokenScope({ boundClientId: '', path: '/api/scope-fixture/nodes/heartbeat' }).allowed).toBe(false);
  });
});

describe('package node rails - the real PAT middleware, mounter and authorization runtime', () => {
  it("the owner's bound device reaches the rail as its owner, with the binding stamped", async () => {
    const token = tokens.seed({ sub: OWNER, nodeClientId: DEVICE, principalIssuer: ISSUER });
    await boot();
    expect(await heartbeat({ authorization: `Bearer ${token}` })).toBe(200);
    expect(calls).toEqual([{ kind: 'rail', url: '/heartbeat', node: DEVICE, sub: OWNER }]);
  }, 20_000);

  it('the shared service secret with a trusted owner header is refused on a node rail (the old B20 path)', async () => {
    await boot();
    expect(await heartbeat({ 'x-service-secret': SECRET, ...trustedServiceUserHeaders(OWNER) })).toBe(401);
    expect(calls).toEqual([]);
  }, 20_000);

  it("an UNBOUND PAT of the same owner is refused: a rail needs a device credential, not the owner's account", async () => {
    const token = tokens.seed({ sub: OWNER, principalIssuer: ISSUER });
    await boot();
    expect(await heartbeat({ authorization: `Bearer ${token}` })).toBe(401);
    expect(calls).toEqual([]);
  }, 20_000);

  it("the bound device is refused on the same app's browser surface", async () => {
    const token = tokens.seed({ sub: OWNER, nodeClientId: DEVICE, principalIssuer: ISSUER });
    await boot();
    expect(await heartbeat({ authorization: `Bearer ${token}` }, `${SURFACE}/reset`)).toBe(401);
    expect(calls).toEqual([]);
  }, 20_000);

  it('a device whose owner holds no grant on the app is refused by the authorization guard', async () => {
    const token = tokens.seed({ sub: STRANGER, nodeClientId: DEVICE, principalIssuer: ISSUER });
    await boot();
    const status = await heartbeat({ authorization: `Bearer ${token}` });
    expect([401, 403]).toContain(status);
    expect(calls).toEqual([]);
  }, 20_000);

  it('unmount closes the rail: the same device credential no longer authenticates there', async () => {
    const token = tokens.seed({ sub: OWNER, nodeClientId: DEVICE, principalIssuer: ISSUER });
    await boot();
    expect(isPackageNodeRailPath(`${RAIL}/heartbeat`)).toBe(true);
    mounter.unmount(APP);
    expect(isPackageNodeRailPath(`${RAIL}/heartbeat`)).toBe(false);
    expect(decideNodeTokenScope({ boundClientId: DEVICE, path: `${RAIL}/heartbeat` }).allowed).toBe(false);
    expect(await heartbeat({ authorization: `Bearer ${token}` })).not.toBe(200);
  }, 20_000);
});
