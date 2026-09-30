/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-157 S1: prove the kernel services routes over a real loopback HTTP server and the real activation service — a non-administrator asking for a system service gets 403, an administrator gets it, a person activates only for themselves, and a second person can neither deactivate someone else's activation nor make it disappear.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Deactivation over the wire: a person who holds no activation reads 200 {deactivated:false} and a person who reaches for the system service reads 403 — the two answers a caller must be able to tell apart — while an unknown or contradictory principal class is a 400 and the system activation survives every one of them.
 * 3   | maintainer@emeraldcoastsystemsgroup.com     | Exercise catalog-less protected activation refusal through real HTTP, activation and authorization policy with memory stores; preserve legacy/user paths and prove catalog-backed system grants remain exact.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { registerApplicationServiceActivationRoutes } from '@/app/routes/application-service-activation-routes';
import { setApplicationServiceActivations } from '@/app/application-service-activation-wiring';
import {
  ApplicationServiceActivationService, ApplicationAuthorizationService,
  APPLICATION_SERVICE_PRINCIPAL_ISSUER, applicationServicePrincipalSub,
  MemoryApplicationServiceActivationStore, MemoryAuthorizationStore,
} from '@/features/application-authorization';
import type { ApplicationServiceDeclaration } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';

const APP = 'metrics-app';
const LOCAL_ID = 'daily-ingest';
const SCHEDULE_ID = `${APP}-${LOCAL_ID}`;
const ISSUER = 'https://identity.fixture.test';
const CATALOG: AuthorizationCatalog = {
  version: 1, resources: { metrics: { scopes: ['own'] } },
  permissions: {
    'metrics.write': { resource: 'metrics', effect: 'write', minimumTier: 'editor' },
    'metrics.review': { resource: 'metrics', effect: 'administer', minimumTier: 'admin' },
  },
  roles: { contributor: { tier: 'editor', grants: [{ permission: 'metrics.write', scope: 'own' }] } },
  bindings: { jobs: [
    { id: SCHEDULE_ID, allOf: ['metrics.write'] },
    { id: `${APP}-review`, allOf: ['metrics.review'] },
  ] },
};
const servicePrincipal: AuthorizationActor = {
  sub: applicationServicePrincipalSub(APP), issuer: APPLICATION_SERVICE_PRINCIPAL_ISSUER,
  isActive: true, isSwarmAdmin: false,
};

const actors: Record<string, AuthorizationActor> = {
  admin: { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true },
  alice: { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
  bob: { sub: 'bob', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
};

let server: Server;
let base: string;
let activations: MemoryApplicationServiceActivationStore;
let registered: string[];
let declarations: ApplicationServiceDeclaration[];
let policy: MemoryAuthorizationStore;
let authorization: ApplicationAuthorizationService;

/** @description Install fixture posture through the real policy registration path, never HTTP input. */
async function registerPosture(catalog: AuthorizationCatalog | null, mode: 'legacy' | 'enforce'): Promise<void> {
  await authorization.registerApp({
    app: APP, source: 'fixture-store', version: '1.0.0', catalog, mode,
    adapters: { metrics: { authorize: async () => true } },
  });
}

/** @description Call the routes as one fixture identity; an unknown one is refused at the mount. */
async function call(method: string, path: string, user: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/swarm/apps${path}`, {
    method, headers: { 'x-fixture-user': user, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // The real mount carries requiresAuth; this fixture stands in for it with the same posture.
  const router = express.Router();
  router.use((req, res, next) => {
    if (!actors[String(req.get('x-fixture-user') || '')]) { res.status(401).json({ error: 'authentication_required' }); return; }
    next();
  });
  registerApplicationServiceActivationRoutes(router);
  app.use('/api/swarm/apps', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
});

beforeEach(async () => {
  registered = [];
  declarations = [{
    app: APP, id: LOCAL_ID, scheduleId: SCHEDULE_ID, cron: '15 6 * * *',
    description: 'Pull yesterday\'s channel metrics into the scorecard.', requires: [], queue: APP,
  }];
  activations = new MemoryApplicationServiceActivationStore();
  policy = new MemoryAuthorizationStore();
  authorization = new ApplicationAuthorizationService(policy);
  await registerPosture(CATALOG, 'enforce');
  const service = new ApplicationServiceActivationService({
    activations, policy,
    describeApp: app => authorization.getApp(app),
    declaredServices: async () => declarations,
    authorize: (actor, operation) => authorization.authorize(actor, operation),
    registerUserInstance: async input => { registered.push(input.userSub); },
    removeUserInstance: async input => { registered = registered.filter(sub => sub !== input.userSub); },
  });
  setApplicationServiceActivations({
    service,
    resolveActor: async (req: Request) => structuredClone(actors[String(req.get('x-fixture-user'))]),
  });
});

afterEach(() => {
  setApplicationServiceActivations(undefined);
  vi.restoreAllMocks();
});

describe('ADR-157 scheduled services routes', () => {
  it('refuses a protected catalog-less system activation before any activation or grant is written', async () => {
    await registerPosture(null, 'enforce');
    const before = await policy.read();
    const find = vi.spyOn(activations, 'findLive');
    const insert = vi.spyOn(activations, 'insert');
    const revoke = vi.spyOn(activations, 'revoke');
    const transaction = vi.spyOn(policy, 'transaction');
    const refused = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin',
      { runsAs: 'system', mode: 'legacy', catalog: CATALOG });
    expect(refused).toEqual({ status: 409, body: { error: 'authorization_service_catalog_required' } });
    expect(await activations.listByApp(APP)).toEqual([]);
    expect(await policy.read()).toEqual(before);
    expect(registered).toEqual([]);
    for (const untouched of [find, insert, revoke, transaction]) expect(untouched).not.toHaveBeenCalled();
    expect(await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: SCHEDULE_ID }))
      .toMatchObject({ allowed: false, reason: 'authorization_app_admin_required' });
  });

  it('retains the administrator refusal before disclosing the missing catalog', async () => {
    await registerPosture(null, 'enforce');
    const refused = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'alice', { runsAs: 'system' });
    expect(refused).toEqual({ status: 403, body: { error: 'authorization_service_admin_required' } });
    expect(await activations.listByApp(APP)).toEqual([]);
  });

  it('does not reuse or revoke an old system activation after catalog-less posture becomes enforce', async () => {
    await registerPosture(null, 'legacy');
    expect((await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', { runsAs: 'system' })).status).toBe(200);
    const existing = await activations.listByApp(APP);
    await registerPosture(null, 'enforce');
    const before = await policy.read();
    const refused = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', { runsAs: 'system' });
    expect(refused).toEqual({ status: 409, body: { error: 'authorization_service_catalog_required' } });
    expect(await activations.listByApp(APP)).toEqual(existing);
    expect(await policy.read()).toEqual(before);
  });

  it.each([
    { mode: 'legacy' as const, catalog: null, expected: 200 },
    { mode: 'enforce' as const, catalog: null, expected: 409 },
    { mode: 'legacy' as const, catalog: CATALOG, expected: 200 },
    { mode: 'enforce' as const, catalog: CATALOG, expected: 200 },
  ])('uses registered posture for mode=$mode catalog=$catalog', async ({ mode, catalog, expected }) => {
    await registerPosture(catalog, mode);
    const before = await policy.read();
    const response = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', { runsAs: 'system' });
    expect(response.status).toBe(expected);
    expect(authorization.getApp(APP)?.mode).toBe(catalog ? 'enforce' : mode);
    expect(await policy.read()).toEqual(before);
    if (expected === 409) expect(response.body).toEqual({ error: 'authorization_service_catalog_required' });
    if (!catalog && mode === 'legacy') {
      expect(await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: SCHEDULE_ID }))
        .toMatchObject({ allowed: true, reason: 'authorization_legacy' });
    }
  });

  it('grants a catalog-backed system principal exactly its declared job permission', async () => {
    declarations[0].requires = ['metrics.write'];
    expect((await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', { runsAs: 'system' })).status).toBe(200);
    expect(await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: SCHEDULE_ID }))
      .toMatchObject({ allowed: true, grants: [{ permission: 'metrics.write', scope: 'own' }] });
    expect((await authorization.authorize(servicePrincipal, { app: APP, kind: 'jobs', operation: `${APP}-review` })).allowed).toBe(false);
    expect((await policy.read()).assignments).toMatchObject([{ permission: 'metrics.write', targetSub: servicePrincipal.sub }]);
    expect(registered).toEqual([]);
  });

  it('preserves a catalog-less user activation under that user\'s explicit app-admin grant', async () => {
    await registerPosture(null, 'enforce');
    const preview = await authorization.previewChange(actors.admin, {
      action: 'grant', app: APP, targetSub: actors.alice.sub, targetIssuer: ISSUER, role: '@app-admin',
      reason: 'Fixture user service authorization', expectedRevision: (await policy.read()).revision,
    });
    await authorization.applyChange(actors.admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
    expect((await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'alice', { runsAs: 'user' })).status).toBe(200);
    expect(registered).toEqual(['alice']);
    expect(await authorization.authorize(actors.alice, { app: APP, kind: 'jobs', operation: SCHEDULE_ID }))
      .toMatchObject({ allowed: true, reason: 'authorization_app_admin' });
  });

  it('refuses an anonymous caller at the mount', async () => {
    const response = await fetch(`${base}/api/swarm/apps/${APP}/services`);
    expect(response.status).toBe(401);
  });

  it('lists the declared services as a to-do until one is activated', async () => {
    const listed = await call('GET', `/${APP}/services`, 'alice');
    expect(listed.status).toBe(200);
    expect(listed.body.services).toHaveLength(1);
    expect(listed.body.services[0]).toMatchObject({ id: LOCAL_ID, state: 'not-activated', userCount: 0, activeForCaller: false });
    // The kernel's own ADR-145 to-do: a path a setup dashboard probes in the viewer's own session.
    expect(listed.body.readiness).toEqual({
      app: APP, label: 'Scheduled services', path: `/api/swarm/apps/${APP}/services`,
      readyPointer: '/ready', detailPointer: '/readyDetail',
    });
  });

  it('reports an unactivated system service as an ADR-145 readiness to-do', async () => {
    declarations = [{ ...declarations[0], runsAs: 'system' }];
    const waiting = await call('GET', `/${APP}/services`, 'admin');
    expect(waiting.body).toMatchObject({ ready: false, awaitingActivation: 1 });
    expect(waiting.body.readyDetail).toContain('await activation');
    await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', { runsAs: 'system' });
    const settled = await call('GET', `/${APP}/services`, 'admin');
    expect(settled.body).toMatchObject({ ready: true, awaitingActivation: 0 });
  });

  it('gives a non-administrator 403 for a system service and an administrator the activation', async () => {
    const refused = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'alice', { runsAs: 'system' });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'authorization_service_admin_required' });
    expect(await activations.listByApp(APP)).toEqual([]);
    const allowed = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', { runsAs: 'system' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.activation).toMatchObject({ runsAs: 'system' });
    const listed = await call('GET', `/${APP}/services`, 'alice');
    expect(listed.body).toMatchObject({ ready: true, awaitingActivation: 0 });
    expect(listed.body.services[0]).toMatchObject({ state: 'active', runsAs: 'system' });
  });

  it('refuses an activation with no named principal class', async () => {
    const response = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', {});
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'authorization_service_class_required' });
  });

  it('activates a user service for the caller only, and no one else can deactivate it', async () => {
    const activated = await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'alice', { runsAs: 'user' });
    expect(activated.status).toBe(200);
    expect(registered).toEqual(['alice']);
    const forAlice = await call('GET', `/${APP}/services`, 'alice');
    expect(forAlice.body.services[0]).toMatchObject({ activeForCaller: true, userCount: 1 });
    const forBob = await call('GET', `/${APP}/services`, 'bob');
    expect(forBob.body.services[0]).toMatchObject({ activeForCaller: false, userCount: 1 });

    const bobTakesAim = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?targetSub=alice`, 'bob');
    expect(bobTakesAim.status).toBe(403);
    expect(bobTakesAim.body).toEqual({ error: 'authorization_service_owner_required' });
    const bobsOwn = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation`, 'bob');
    expect(bobsOwn.body).toEqual({ deactivated: false });
    expect(registered).toEqual(['alice']);

    const aliceCloses = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation`, 'alice');
    expect(aliceCloses.body).toEqual({ deactivated: true });
    expect(registered).toEqual([]);
    expect(await activations.listByApp(APP)).toEqual([]);
  });

  it('lets a swarm administrator close an activation made by a person', async () => {
    await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'alice', { runsAs: 'user' });
    const closed = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?targetSub=alice&targetIssuer=${encodeURIComponent(ISSUER)}`, 'admin');
    expect(closed.body).toEqual({ deactivated: true });
    expect(registered).toEqual([]);
  });

  // The schedule below is unclassified, so a system activation and a person's activation of the
  // SAME schedule are both live — which is every service-route schedule on a box until a package
  // declares runsAs, and the shape in which a deactivation could reach the wrong principal.
  describe('with the application\'s system service and one person\'s both live', () => {
    beforeEach(async () => {
      await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'admin', { runsAs: 'system' });
      await call('POST', `/${APP}/services/${SCHEDULE_ID}/activate`, 'alice', { runsAs: 'user' });
    });

    /** @description The live activations of the fixture schedule, by class, read from the store. */
    async function liveClasses(): Promise<string[]> {
      return (await activations.listByApp(APP)).map(row => row.runsAs).sort();
    }

    it('tells a person who holds no activation apart from one who lacks permission', async () => {
      const mine = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?targetSub=bob`, 'bob');
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual({ deactivated: false });

      const untargeted = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation`, 'bob');
      expect(untargeted.status).toBe(200);
      expect(untargeted.body).toEqual({ deactivated: false });

      const reachingForTheSystemOne = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?runsAs=system`, 'bob');
      expect(reachingForTheSystemOne.status).toBe(403);
      expect(reachingForTheSystemOne.body).toEqual({ error: 'authorization_service_admin_required' });

      expect(await liveClasses()).toEqual(['system', 'user']);
      expect(registered).toEqual(['alice']);
    });

    it('answers a named principal that never activated with not-found, leaving every other activation live', async () => {
      const stray = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?targetSub=never-activated`, 'admin');
      expect(stray.body).toEqual({ deactivated: false });
      expect(await liveClasses()).toEqual(['system', 'user']);

      const hers = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?targetSub=alice`, 'admin');
      expect(hers.body).toEqual({ deactivated: true });
      expect(await liveClasses()).toEqual(['system']);
      expect(registered).toEqual([]);
    });

    it('closes the system service only when a swarm administrator names that class', async () => {
      const closed = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?runsAs=system`, 'admin');
      expect(closed.body).toEqual({ deactivated: true });
      expect(await liveClasses()).toEqual(['user']);
      expect(registered).toEqual(['alice']);
    });

    it('refuses a class it does not know and a class that contradicts the named person', async () => {
      const unknown = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?runsAs=whatever`, 'admin');
      expect(unknown.status).toBe(400);
      expect(unknown.body).toEqual({ error: 'authorization_service_class_required' });

      const contradiction = await call('DELETE', `/${APP}/services/${SCHEDULE_ID}/activation?runsAs=system&targetSub=alice`, 'admin');
      expect(contradiction.status).toBe(400);
      expect(contradiction.body).toEqual({ error: 'authorization_service_class_mismatch' });

      expect(await liveClasses()).toEqual(['system', 'user']);
    });
  });
});
