/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: the location credential's scope, two ways. The pure matrix: a credential bound to a location device is admitted on exactly POST /api/location/devices/<its id>/presence and refused on another device's presence path, on every other location route, on the worker plane (including /api/remote-clients/register and the node handshake), on account routes, on any other method, and on a blank binding; encoded ids, trailing slashes and repeated separators do not smuggle a different device past it. Then the REAL createCliTokenAuthMiddleware over HTTP on the statement-matching token-pool stand-in: a location credential authenticates the request on its own presence path and stamps the binding the ingest route reads, is refused everywhere else (the request stays unauthenticated), a node token and an account PAT are unchanged by the new column (the node token still reaches its own plane and nothing else, the PAT still reaches an account route), a node token never reaches the presence path, and a row carrying both bindings is refused outright. insertCliToken refuses a mint that names both bindings and records a location binding when asked.
 */

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decideLocationTokenScope, locationDevicePresencePath } from '@/features/location';
import { createCliTokenAuthMiddleware, insertCliToken, readLocationTokenBinding, readNodeTokenBinding } from '@/app/routes/cli-token-routes';
import { getCaller } from '@/shared/middleware/authz';
import { FakeCliTokenPool } from '../helpers/fake-cli-token-pool';

const DEVICE = 'aaaaaaaa-2222-4333-8444-5555555555ee';
const OTHER = '99999999-2222-4333-8444-555555555555';
const OWNER = 'loc-l6-admin';
const ISSUER = 'https://login.oshal.example.com';

describe('decideLocationTokenScope: the pure matrix', () => {
  const decide = (path: string, method = 'POST', bound = DEVICE) => decideLocationTokenScope({ boundDeviceId: bound, method, path });

  it('admits exactly the bound device\'s presence path', () => {
    expect(decide(`/api/location/devices/${DEVICE}/presence`)).toEqual({ allowed: true, reason: 'own-device-presence' });
    expect(decide(locationDevicePresencePath(DEVICE))).toEqual({ allowed: true, reason: 'own-device-presence' });
    expect(decide(`/api/location/devices/${DEVICE}/presence/`)).toEqual({ allowed: true, reason: 'own-device-presence' });
    expect(decide(`/api//location/devices/${encodeURIComponent(DEVICE)}/presence`)).toEqual({ allowed: true, reason: 'own-device-presence' });
    expect(decide(`/api/location/devices/${DEVICE}/presence`, 'post')).toEqual({ allowed: true, reason: 'own-device-presence' });
  });

  it('refuses another device\'s presence path', () => {
    expect(decide(`/api/location/devices/${OTHER}/presence`)).toEqual({ allowed: false, reason: 'foreign-device' });
    expect(decide(`/api/location/devices/${DEVICE}x/presence`)).toEqual({ allowed: false, reason: 'foreign-device' });
    expect(decide(`/api/location/devices/${DEVICE.toUpperCase()}/presence`)).toEqual({ allowed: false, reason: 'foreign-device' });
  });

  it('refuses every other location route, the worker plane, the handshake and account routes', () => {
    for (const path of [
      '/api/location/state', '/api/location/presence', `/api/location/devices/${DEVICE}/credential`,
      `/api/location/devices/${DEVICE}/opt-out`, `/api/location/devices/${DEVICE}`, `/api/location/devices/${DEVICE}/presence/extra`,
      '/api/location/devices', '/api/remote-clients/register', `/api/remote-clients/${DEVICE}/heartbeat`,
      '/api/cli-tokens/whoami', '/api/cli-tokens', '/api/content', '/api/me', '/', '',
    ]) {
      expect(decide(path), path).toEqual({ allowed: false, reason: 'off-plane' });
    }
  });

  it('refuses any method but POST on the admitted path', () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', '']) {
      expect(decide(`/api/location/devices/${DEVICE}/presence`, method), method).toEqual({ allowed: false, reason: 'method' });
    }
  });

  it('fails closed on a blank binding', () => {
    expect(decide(`/api/location/devices/${DEVICE}/presence`, 'POST', '')).toEqual({ allowed: false, reason: 'off-plane' });
    expect(decide(`/api/location/devices//presence`, 'POST', '   ')).toEqual({ allowed: false, reason: 'off-plane' });
  });
});

describe('the real token-auth middleware over HTTP', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
    servers.length = 0;
  });

  /** A server with the real middleware and probe routes that report what the middleware stamped. */
  async function serve(pool: FakeCliTokenPool): Promise<string> {
    const app = express();
    app.use(createCliTokenAuthMiddleware(pool.asPool()));
    const report = (req: Request, res: Response): void => {
      res.json({ sub: getCaller(req).sub ?? null, location: readLocationTokenBinding(req), node: readNodeTokenBinding(req) });
    };
    app.post('/api/location/devices/:deviceId/presence', report);
    app.get('/api/location/state', report);
    app.post('/api/remote-clients/register', report);
    app.get('/api/remote-clients/:clientId/heartbeat', report);
    app.get('/api/cli-tokens/whoami', report);
    app.get('/api/content', report);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function call(base: string, method: string, path: string, token: string) {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    return await res.json() as { sub: string | null; location: { deviceId: string; tokenId: string } | null; node: { clientId: string } | null };
  }

  it('a location credential authenticates only its own presence path and stamps the binding there', async () => {
    const pool = new FakeCliTokenPool();
    const token = pool.seed({ sub: OWNER, locationDeviceId: DEVICE, principalIssuer: ISSUER, id: 'tok-loc' });
    const base = await serve(pool);
    expect(await call(base, 'POST', `/api/location/devices/${DEVICE}/presence`, token))
      .toEqual({ sub: OWNER, location: { deviceId: DEVICE, tokenId: 'tok-loc' }, node: null });
    for (const [method, path] of [
      ['POST', `/api/location/devices/${OTHER}/presence`], ['GET', '/api/location/state'], ['POST', '/api/remote-clients/register'],
      ['GET', `/api/remote-clients/${DEVICE}/heartbeat`], ['GET', '/api/cli-tokens/whoami'], ['GET', '/api/content'],
    ] as const) {
      expect(await call(base, method, path, token), `${method} ${path}`).toEqual({ sub: null, location: null, node: null });
    }
  });

  it('a node token and an account PAT are unchanged by the new column, and a node token never reaches the presence path', async () => {
    const pool = new FakeCliTokenPool();
    const node = pool.seed({ sub: OWNER, nodeClientId: 'my-laptop', principalIssuer: ISSUER });
    const pat = pool.seed({ sub: OWNER, principalIssuer: ISSUER });
    const base = await serve(pool);
    const onPlane = await call(base, 'GET', '/api/remote-clients/my-laptop/heartbeat', node);
    expect(onPlane.sub).toBe(OWNER);
    expect(onPlane.node).toMatchObject({ clientId: 'my-laptop' });
    expect(onPlane.location).toBeNull();
    expect(await call(base, 'POST', `/api/location/devices/${DEVICE}/presence`, node)).toEqual({ sub: null, location: null, node: null });
    expect(await call(base, 'POST', `/api/location/devices/my-laptop/presence`, node)).toEqual({ sub: null, location: null, node: null });
    expect(await call(base, 'GET', '/api/content', node)).toEqual({ sub: null, location: null, node: null });
    expect(await call(base, 'GET', '/api/content', pat)).toEqual({ sub: OWNER, location: null, node: null });
    expect(await call(base, 'POST', `/api/location/devices/${DEVICE}/presence`, pat)).toEqual({ sub: OWNER, location: null, node: null });
  });

  it('a row carrying both bindings is refused everywhere, and the mint refuses to create one', async () => {
    const pool = new FakeCliTokenPool();
    const both = pool.seed({ sub: OWNER, nodeClientId: 'my-laptop', locationDeviceId: DEVICE, principalIssuer: ISSUER });
    const base = await serve(pool);
    expect(await call(base, 'POST', `/api/location/devices/${DEVICE}/presence`, both)).toEqual({ sub: null, location: null, node: null });
    expect(await call(base, 'GET', '/api/remote-clients/my-laptop/heartbeat', both)).toEqual({ sub: null, location: null, node: null });
    await expect(insertCliToken(pool.asPool(), { sub: OWNER, nodeClientId: 'my-laptop', locationDeviceId: DEVICE }))
      .rejects.toThrow(/never both/);
    const minted = await insertCliToken(pool.asPool(), { sub: OWNER, locationDeviceId: DEVICE, principalIssuer: ISSUER });
    expect(minted.locationDeviceId).toBe(DEVICE);
    expect(minted.nodeClientId).toBeNull();
    expect(pool.rows.find((r) => r.id === minted.id)).toMatchObject({ location_device_id: DEVICE, node_client_id: null, principal_issuer: ISSUER });
  });
});
