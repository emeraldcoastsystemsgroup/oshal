/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: the /api/location route policy, enumerated from the REAL routers. Every route the location router or its step-up ceremony registers must be declared in LOCATION_ROUTE_POLICY (and every declaration must still exist), so a later slice cannot add an arm, enrolment or guardian-share route without saying which proof it spends. Every route declared 'always' is then driven over HTTP without a proof, with a handle that does not exist and with a pending (unproven) handle: each answers 403 step_up_required before the database is touched (the pool here throws on use). The session gate is driven with the exact req.oidc shapes the PAT, TV-token, guest and mock rails set: each is refused, as is a session without a verified issuer, and the service secret is refused with 401 even alongside a valid session. The start and complete endpoints refuse anything but a top-level navigation.
 */

import express, { type RequestHandler, type Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocationStepUpStore } from '@/app/location-step-up';
import { LOCATION_ROUTE_POLICY, LOCATION_STEP_UP_NORMALIZERS, createLocationRoutes } from '@/app/routes/location-routes';
import { createLocationStepUpRoutes } from '@/app/routes/location-step-up-routes';

const ISSUER = 'https://login.oshal.example.com';
const SECRET = 'fixture-service-secret-value';
const store = new LocationStepUpStore();
let poolTouches = 0;
const pool = { connect: async () => { poolTouches += 1; throw new Error('the pool must not be reached'); } } as unknown as Pool;
let server: Server;
let base = '';

/** The req.oidc shapes the kernel's authentication rails set, selected by a loopback header. */
const RAILS: Record<string, Record<string, unknown>> = {
  oidc: { idToken: 'eyJhbGciOiJSUzI1NiJ9.fixture.sig', idTokenClaims: { iss: ISSUER, sub: 'person-a' }, user: { sub: 'person-a' } },
  'oidc-no-issuer': { idToken: 'eyJhbGciOiJSUzI1NiJ9.fixture.sig', idTokenClaims: { sub: 'person-a' }, user: { sub: 'person-a' } },
  pat: { idToken: 'cli-token', user: { iss: ISSUER, sub: 'person-a' } },
  tv: { idToken: 'tv-token', user: { iss: ISSUER, sub: 'person-a' } },
  guest: { idToken: 'guest-token', user: { iss: 'urn:oshal:guest', sub: 'guest-1' } },
  'mock-without-mock-mode': { idToken: 'mock-id-token', user: { iss: 'urn:oshal:mock-oidc', sub: 'person-a' } },
};

const fixtureAuth: RequestHandler = (req, _res, next) => {
  const shape = RAILS[req.get('x-fixture-rail') ?? ''];
  if (shape) Object.assign(req, { oidc: { isAuthenticated: () => true, ...shape } });
  next();
};

type RouteKey = string;

/** Every route layer registered directly on a router, as "METHOD path". */
function routesOf(router: Router, prefix = ''): RouteKey[] {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
  return stack.flatMap((layer) => (layer.route
    ? Object.keys(layer.route.methods).filter((m) => m !== '_all').map((m) => `${m.toUpperCase()} ${prefix}${layer.route!.path}`)
    : []));
}

async function call(method: string, path: string, rail: string | null, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}/api/location${path}`, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(rail ? { 'x-fixture-rail': rail } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

beforeAll(async () => {
  vi.stubEnv('SWARM_SERVICE_SECRET', SECRET);
  vi.stubEnv('MOCK_OIDC', 'false');
  const app = express();
  app.use(fixtureAuth);
  app.use('/api/location', createLocationRoutes({ pool, stepUpStore: store, ingestMinIntervalMs: 0 }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  vi.unstubAllEnvs();
});

describe('location route policy: every route is declared', () => {
  it('the routers register exactly the declared routes', () => {
    const main = routesOf(createLocationRoutes({ pool, stepUpStore: store }));
    const ceremony = routesOf(createLocationStepUpRoutes({ store, pool, normalizers: LOCATION_STEP_UP_NORMALIZERS, donePath: '/x' }), '/step-up');
    expect([...main, ...ceremony].sort()).toEqual(Object.keys(LOCATION_ROUTE_POLICY).sort());
  });

  it('every gated rule names an operation with a normaliser, and every ungated mutation says why', () => {
    for (const [route, policy] of Object.entries(LOCATION_ROUTE_POLICY)) {
      expect(policy.why.length, route).toBeGreaterThan(10);
      if (policy.stepUp) {
        expect(LOCATION_STEP_UP_NORMALIZERS[policy.stepUp], route).toBeTypeOf('function');
        expect(['always', 'raising'], route).toContain(policy.when);
      }
    }
  });
});

describe('location route policy: an always-gated route refuses without a proof', () => {
  const bodies: Record<string, unknown> = {
    'POST /devices/browser/opt-in': { precisionClass: 'block' },
    'POST /shares': { tenantId: '11111111-1111-4111-8111-111111111111', placeIds: ['22222222-2222-4222-8222-222222222222'] },
  };

  it('covers every route declared always', () => {
    const always = Object.entries(LOCATION_ROUTE_POLICY).filter(([, p]) => p.when === 'always').map(([k]) => k).sort();
    expect(Object.keys(bodies).sort()).toEqual(always);
  });

  for (const [route, body] of Object.entries(bodies)) {
    it(`${route}: no proof, an unknown handle and a pending handle each get 403 before the database`, async () => {
      const [method, path] = route.split(' ');
      const policy = LOCATION_ROUTE_POLICY[route];
      const pending = store.create({ sub: 'person-a', principalIssuer: ISSUER }, policy.stepUp!, LOCATION_STEP_UP_NORMALIZERS[policy.stepUp!]!(body), 'oidc-max-age');
      const before = poolTouches;
      const variants: Array<Record<string, string>> = [{}, { 'x-oshal-location-step-up': 'no-such-handle' }, { 'x-oshal-location-step-up': pending.challengeId }];
      for (const headers of variants) {
        const res = await call(method, path, 'oidc', headers, body);
        expect(res.status, JSON.stringify(headers)).toBe(403);
        expect(res.json.error).toBe('step_up_required');
      }
      expect(poolTouches).toBe(before);
    });
  }
});

describe('location route policy: who may call at all', () => {
  it('refuses the service secret with 401, even alongside a valid browser session', async () => {
    for (const rail of [null, 'oidc']) {
      const res = await call('POST', '/presence', rail, { 'x-service-secret': SECRET, 'x-oshal-user-sub': 'person-a' }, { deviceId: 'x' });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe('service_secret_refused');
    }
    expect((await call('GET', '/state', 'oidc', { 'x-oshal-user-sub-b64': 'cGVyc29uLWE' })).status).toBe(401);
  });

  it('refuses a personal access token, a TV token, a guest and a mock session outside mock mode', async () => {
    for (const rail of ['pat', 'tv', 'guest', 'mock-without-mock-mode']) {
      const res = await call('GET', '/state', rail);
      expect(res.status, rail).toBe(403);
      expect(res.json.error, rail).toBe('browser_session_required');
    }
  });

  it('refuses a browser session with no verified issuer', async () => {
    const res = await call('GET', '/state', 'oidc-no-issuer');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('verified_issuer_required');
  });

  it('the step-up start and complete endpoints answer only a top-level navigation', async () => {
    const pending = store.create({ sub: 'person-a', principalIssuer: ISSUER }, 'opt-in', { deviceId: null, precisionClass: 'city' }, 'oidc-max-age');
    for (const step of ['start', 'complete']) {
      const res = await call('GET', `/step-up/${pending.challengeId}/${step}`, 'oidc', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });
      expect(res.status, step).toBe(403);
      expect(res.json.error, step).toBe('navigation_required');
    }
    expect(store.view(pending.challengeId, { sub: 'person-a', principalIssuer: ISSUER })?.state).toBe('pending');
  });

  it('an operation no route here performs cannot be challenged', async () => {
    for (const operation of ['arm-rule', 'create-guardian-share', 'approve-enrolment', 'nonsense']) {
      const res = await call('POST', '/step-up', 'oidc', {}, { operation, params: {} });
      expect(res.status, operation).toBe(400);
      expect(res.json.error, operation).toBe('operation_not_available');
    }
  });
});
