/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real HTTP lifecycle guards; application roles never authorize swarm-wide stop or uninstall.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SwarmAppService } from '../../src/features/swarm-apps';
import { createSwarmAppRoutes } from '../../src/app/routes/swarm-app-routes';

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
  }
});

/** Only the lifecycle collaborator is doubled: Express and operator resolution are production code. */
async function boot() {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'lifecycle-operator'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  const toggleApp = vi.fn().mockResolvedValue({ name: 'learning-fixture', status: 'inactive' });
  const unloadApp = vi.fn().mockResolvedValue({ removed: true });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    // Test-local verified-session seam, never mounted by the production server.
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: req.header('x-test-sub') } } }); next();
  });
  app.use('/apps', createSwarmAppRoutes({ toggleApp, unloadApp } as unknown as SwarmAppService, undefined, {
    authorization: { canDiscover: async () => true, resolveActor: async () => ({
      sub: 'lifecycle-reader', issuer: 'urn:oshal:local-auth', isActive: true, isSwarmAdmin: false,
    }) },
  }));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apps`;
  const request = (sub: string, method: string, path: string, body = {}) => fetch(base + path, {
    method, headers: { 'x-test-sub': sub, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { request, toggleApp, unloadApp };
}

describe('swarm application lifecycle authorization', () => {
  it('refuses ordinary callers before any lifecycle effect, including forced uninstall and claimed app-admin', async () => {
    const { request, toggleApp, unloadApp } = await boot();
    for (const [method, path] of [['PATCH', '/learning-fixture/toggle'], ['DELETE', '/learning-fixture'],
      ['DELETE', '/learning-fixture?force=true'], ['DELETE', '/learning-fixture?dropData=true'], ['DELETE', '/unknown']]) {
      const response = await request('lifecycle-reader', method, path, { active: false, role: '@app-admin', isOperator: true });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'Operator privilege required' });
    }
    expect(toggleApp).not.toHaveBeenCalled(); expect(unloadApp).not.toHaveBeenCalled();
  });
  it('allows current operators and immediately refuses their next request after removal', async () => {
    const { request, toggleApp, unloadApp } = await boot();
    expect((await request('lifecycle-operator', 'PATCH', '/learning-fixture/toggle', { active: false })).status).toBe(200);
    expect(toggleApp).toHaveBeenCalledWith('learning-fixture', false);
    expect((await request('lifecycle-operator', 'DELETE', '/learning-fixture?force=true')).status).toBe(200);
    expect(unloadApp).toHaveBeenCalledWith('learning-fixture', { force: true, dropData: false });
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await request('lifecycle-operator', 'PATCH', '/learning-fixture/toggle')).status).toBe(403);
    expect((await request('lifecycle-operator', 'DELETE', '/learning-fixture')).status).toBe(403);
    expect(toggleApp).toHaveBeenCalledTimes(1); expect(unloadApp).toHaveBeenCalledTimes(1);
  });
  it('preserves the dependency conflict for authorized operators', async () => {
    const { request, unloadApp } = await boot();
    unloadApp.mockResolvedValueOnce({ blocked: true, dependents: ['dependent-fixture'], orphanCandidates: [] });
    const response = await request('lifecycle-operator', 'DELETE', '/learning-fixture');
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ dependents: ['dependent-fixture'] });
  });
});
