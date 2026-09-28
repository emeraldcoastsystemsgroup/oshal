/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the posture question behind the career-hunter worker rail (1.24.0, store #299): what does the kernel answer a manifest route declared `auth: service` when the caller is the package's own engine child - a valid X-Service-Secret, X-Oshal-User-Sub-B64 naming a subject that HOLDS the app grant, and the runner-minted X-Career-Run-Token - under the ADR-149 enforce rollout the box runs? Real boundary: the real ManifestRouteMounterImpl over a real HTTP listener, the real ApplicationAuthorizationRuntime in enforce mode, the real ApplicationAuthorizationService (memory store, written through preview/apply), and the REAL createApplicationAuthorizationActorResolver over a database tripwire that throws on any query. The package route is a fixture module mounted from a temp package directory with career-hunter's exact route declaration (auth: service, requiresContext: true, requiresAi: true, no catalog). Answer: 401 {"error":"authorization_identity_required"} before package code; a verified session on the same subject admits the same call; the legacy rollout admits the bare engine-child call, which is the posture the package suites and the 1.23.0 box were built against.
 */
import express, { type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Pool } from 'pg';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { trustedServiceUserHeaders } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const APP = 'career-rail-fixture';
const MOUNT = `/api/${APP}/engine`;
const SECRET = 'example-career-rail-fixture-service-secret';
const ISSUER = 'https://identity.fixture.test';
/** The run owner: the exact subject the engine child asserts through X-Oshal-User-Sub-B64. */
const OWNER = 'auth0|career-rail-owner';
const admin: AuthorizationActor = { sub: 'fixture-administrator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
/** A run token of the length the package's registry accepts (32-128 chars); its value is never checked here. */
const RUN_TOKEN = 'fixture-run-token-'.padEnd(48, '0');

/**
 * The package half, in the shape of career-hunter's compiled routes/career-worker-rail.js: the
 * handler reads the trusted subject (here the one the mounter resolved through the real
 * getTrustedServiceUserSub and handed over as req.oshalCallerSub) and the run token. Whether it
 * RUNS is what this file measures, so it records every invocation on the fixture context.
 */
const RAIL_MODULE = `exports.createCareerWorkerRailRoutes = function (ctx) {
  return function (req, res) {
    const subject = req.oshalCallerSub || null;
    ctx.fixtureHandlerCalls.push({ url: req.url, subject, token: req.headers['x-career-run-token'] || null });
    res.json({ ok: true, subject, callerSub: subject });
  };
};`;

/** career-hunter/oshal-app.yaml's rail declaration: service-only, context-bearing, inference-bearing, no catalog. */
function manifest(): SwarmAppManifest {
  return { name: APP, displayName: 'Career rail fixture', version: '1.24.0', status: 'active', suite: 'ai-productivity',
    routes: [{ module: 'routes/career-worker-rail.js', factory: 'createCareerWorkerRailRoutes', mountPath: MOUNT,
      auth: 'service', requiresContext: true, requiresAi: true }] };
}

let root: string, server: Server, base: string;
let policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore;
let handlerCalls: Array<{ url: string; subject: string | null; token: string | null }>;
let databaseQueries: number;
let record: SwarmApplicationRecord;

function writePackage(): string {
  mkdirSync(join(root, 'routes'), { recursive: true });
  writeFileSync(join(root, 'routes', 'career-worker-rail.js'), RAIL_MODULE);
  const file = join(root, 'oshal-app.yaml'); writeFileSync(file, yaml.dump(manifest())); return file;
}

/** Grant the run owner the only role a catalog-less package has, through the real preview/apply path, once the package is registered. */
async function grantAppAdmin(): Promise<void> {
  const preview = await policy.previewChange(admin, { action: 'grant', app: APP, targetSub: OWNER, targetIssuer: ISSUER,
    role: '@app-admin', reason: 'Career rail posture fixture', expectedRevision: (await store.read()).revision });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
}

/**
 * Mount the fixture package under one runtime. The actor resolver is the REAL one the controller
 * composes (application-authorization-wiring.ts createActorPorts), over a pool that throws on any
 * query: every case below must reach its answer without consulting a database.
 */
async function mountUnder(mode: 'enforce' | 'legacy'): Promise<void> {
  const pool = { query: async () => { databaseQueries += 1; throw new Error('the fixture database must not be consulted'); } } as unknown as Pool;
  const resolveActor = createApplicationAuthorizationActorResolver(pool, { tenantIds: async () => [] });
  const runtime = new ApplicationAuthorizationRuntime(policy, resolveActor, { OSHAL_APPLICATION_AUTHORIZATION_MODE: mode });
  await runtime.start(record); runtime.complete(record);
  await grantAppAdmin();
  const app = express();
  // The controller's authentication rails populate req.oidc before any /api mount; a fixture session
  // cookie stands in for a real login here. No cookie means exactly what the engine child has: nothing.
  app.use((req, _res, next) => {
    const session = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (session) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: session, iss: ISSUER } } });
    next();
  });
  const requiresAuth: RequestHandler = (_req, res) => { res.status(401).json({ error: 'fixture_auth_required' }); };
  const ctx = { pool, fixtureHandlerCalls: handlerCalls } as unknown as AppContext;
  const mounter = new ManifestRouteMounterImpl(app, requiresAuth, ctx, undefined, runtime);
  await mounter.mount(APP, root, record.manifest.routes!);
  app.use((_req, res) => res.status(404).json({ error: 'fixture_not_found' }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Exactly the headers engine/jobhunter/enrich.py _rail_headers sends, minus the body's content type. */
function engineChildHeaders(): Record<string, string> {
  return { ...trustedServiceUserHeaders(OWNER), 'x-career-run-token': RUN_TOKEN };
}

async function complete(headers: Record<string, string>) {
  const response = await fetch(`${base}${MOUNT}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ system: '', prompt: 'Score this posting.', jsonMode: true }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true');
  vi.stubEnv('SWARM_SERVICE_SECRET', SECRET);
  vi.stubEnv('OSHAL_NO_AI', 'false');
  root = mkdtempSync(join(tmpdir(), 'oshal-career-rail-posture-'));
  handlerCalls = []; databaseQueries = 0;
  const manifestPath = writePackage();
  record = { appId: APP, name: APP, displayName: 'Career rail fixture', description: '', version: '1.24.0', status: 'active',
    manifestPath, manifest: manifest(), agentIds: [], toolNames: [], scope: 'public', ownerSub: null, tenantId: null,
    guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
  store = new MemoryAuthorizationStore();
  policy = new ApplicationAuthorizationService(store, { resolveTier: async () => ({ tier: 'admin', explicit: false }) });
});

afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  const withinTemp = relative(resolve(tmpdir()), resolve(root));
  if (!withinTemp || withinTemp.startsWith('..')) throw new Error('Invalid fixture cleanup path');
  rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

describe('career worker rail under application authorization ENFORCE (the box posture)', () => {
  it('refuses the engine child - valid secret, X-Oshal-User-Sub-B64 of a subject holding the app grant, run token - with authorization_identity_required before package code', async () => {
    await mountUnder('enforce');
    expect((await store.read()).assignments).toHaveLength(1);
    const result = await complete(engineChildHeaders());
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'authorization_identity_required' });
    expect(handlerCalls).toEqual([]);
    expect(databaseQueries).toBe(0);
  });

  it('admits the same subject on the same route once a verified session accompanies the secret, and hands the package the trusted subject', async () => {
    await mountUnder('enforce');
    const result = await complete({ ...engineChildHeaders(), cookie: `session=${OWNER}` });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, subject: OWNER, callerSub: OWNER });
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]).toMatchObject({ url: '/complete', subject: OWNER });
  });

  it('refuses a session on a subject WITHOUT the grant even though the secret and asserted subject are valid', async () => {
    await mountUnder('enforce');
    const result = await complete({ ...engineChildHeaders(), cookie: 'session=auth0|someone-else' });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: 'authorization_app_admin_required' });
    expect(handlerCalls).toEqual([]);
  });

  it("answers a caller without the secret from the mounter's own service guard, ahead of the kernel policy", async () => {
    await mountUnder('enforce');
    const result = await complete({ 'x-career-run-token': RUN_TOKEN });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'This route requires a valid service secret' });
    expect(handlerCalls).toEqual([]);
  });
});

describe('the same call under the LEGACY rollout (what the package suites and the 1.23.0 box were built against)', () => {
  it('admits the bare engine-child call, which is why the rail passes its own tests and still cannot run on an enforce box', async () => {
    await mountUnder('legacy');
    const result = await complete(engineChildHeaders());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, subject: OWNER, callerSub: OWNER });
    expect(handlerCalls).toHaveLength(1);
    expect(databaseQueries).toBe(0);
  });
});
