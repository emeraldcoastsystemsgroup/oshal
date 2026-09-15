/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-157 S1: prove the kernel services routes over a real loopback HTTP server and the real activation service — a non-administrator asking for a system service gets 403, an administrator gets it, a person activates only for themselves, and a second person can neither deactivate someone else's activation nor make it disappear.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Deactivation over the wire: a person who holds no activation reads 200 {deactivated:false} and a person who reaches for the system service reads 403 — the two answers a caller must be able to tell apart — while an unknown or contradictory principal class is a 400 and the system activation survives every one of them.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { registerApplicationServiceActivationRoutes } from '@/app/routes/application-service-activation-routes';
import { setApplicationServiceActivations } from '@/app/application-service-activation-wiring';
import {
  ApplicationServiceActivationService, MemoryApplicationServiceActivationStore, MemoryAuthorizationStore,
} from '@/features/application-authorization';
import type { ApplicationServiceDeclaration } from '@/features/application-authorization';
import type { AuthorizationActor } from '@/shared/application-authorization';

const APP = 'metrics-app';
const LOCAL_ID = 'daily-ingest';
const SCHEDULE_ID = `${APP}-${LOCAL_ID}`;
const ISSUER = 'https://identity.fixture.test';

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

beforeEach(() => {
  registered = [];
  declarations = [{
    app: APP, id: LOCAL_ID, scheduleId: SCHEDULE_ID, cron: '15 6 * * *',
    description: 'Pull yesterday\'s channel metrics into the scorecard.', requires: [], queue: APP,
  }];
  activations = new MemoryApplicationServiceActivationStore();
  const service = new ApplicationServiceActivationService({
    activations, policy: new MemoryAuthorizationStore(),
    describeApp: () => ({ source: 'fixture-store', catalogRevision: 'rev-1', catalog: null }),
    declaredServices: async () => declarations,
    authorize: async () => ({ allowed: true, reason: 'authorization_allowed', decisionId: 'fixture', revision: 1, app: APP, grants: [] }),
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
});

describe('ADR-157 scheduled services routes', () => {
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
