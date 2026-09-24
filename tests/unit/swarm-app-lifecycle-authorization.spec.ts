/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real HTTP lifecycle guards; application roles never authorize swarm-wide stop or uninstall.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | POST /load and POST /import require swarm operator authority; ordinary callers receive 403 before any manifest file is written to disk or loaded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { SwarmAppService } from '../../src/features/swarm-apps';
import { createSwarmAppRoutes } from '../../src/app/routes/swarm-app-routes';

const servers: Server[] = [];
const testArtifacts: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
  }
  for (const file of testArtifacts.splice(0)) {
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

/** Only the lifecycle collaborator is doubled: Express and operator resolution are production code. */
async function boot() {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'lifecycle-operator'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  const toggleApp = vi.fn().mockResolvedValue({ name: 'learning-fixture', status: 'inactive' });
  const unloadApp = vi.fn().mockResolvedValue({ removed: true });
  const loadApp = vi.fn().mockResolvedValue({ name: 'learning-fixture', status: 'active' });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    // Test-local verified-session seam, never mounted by the production server.
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: req.header('x-test-sub') } } }); next();
  });
  app.use('/apps', createSwarmAppRoutes({ toggleApp, unloadApp, loadApp } as unknown as SwarmAppService, undefined, {
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
  const requestMultipart = (sub: string, path: string, filename: string, content: string) => {
    const boundary = '----WebKitFormBoundaryLifecycle';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="manifest"; filename="${filename}"\r\nContent-Type: application/x-yaml\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return fetch(base + path, {
      method: 'POST',
      headers: {
        'x-test-sub': sub,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  };
  return { request, requestMultipart, toggleApp, unloadApp, loadApp };
}

describe('swarm application lifecycle authorization', () => {
  it('refuses ordinary callers before any lifecycle effect, including forced uninstall and claimed app-admin', async () => {
    const { request, requestMultipart, toggleApp, unloadApp, loadApp } = await boot();
    for (const [method, path] of [['PATCH', '/learning-fixture/toggle'], ['DELETE', '/learning-fixture'],
      ['DELETE', '/learning-fixture?force=true'], ['DELETE', '/learning-fixture?dropData=true'], ['DELETE', '/unknown']]) {
      const response = await request('lifecycle-reader', method, path, { active: false, role: '@app-admin', isOperator: true });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'Operator privilege required' });
    }
    const loadRes = await request('lifecycle-reader', 'POST', '/load', { path: 'swarm-apps/learning-fixture.yaml' });
    expect(loadRes.status).toBe(403);
    expect(await loadRes.json()).toEqual({ error: 'Operator privilege required' });

    const unauthFile = join(process.cwd(), 'swarm-apps', 'unauthorized-probe.yaml');
    testArtifacts.push(unauthFile);
    const importRes = await requestMultipart('lifecycle-reader', '/import', 'unauthorized-probe.yaml', 'name: unauthorized-probe\n');
    expect(importRes.status).toBe(403);
    expect(await importRes.json()).toEqual({ error: 'Operator privilege required' });
    expect(existsSync(unauthFile)).toBe(false);

    expect(toggleApp).not.toHaveBeenCalled(); expect(unloadApp).not.toHaveBeenCalled(); expect(loadApp).not.toHaveBeenCalled();
  });

  it('allows current operators and immediately refuses their next request after removal', async () => {
    const { request, requestMultipart, toggleApp, unloadApp, loadApp } = await boot();
    expect((await request('lifecycle-operator', 'PATCH', '/learning-fixture/toggle', { active: false })).status).toBe(200);
    expect(toggleApp).toHaveBeenCalledWith('learning-fixture', false);
    expect((await request('lifecycle-operator', 'DELETE', '/learning-fixture?force=true')).status).toBe(200);
    expect(unloadApp).toHaveBeenCalledWith('learning-fixture', { force: true, dropData: false });

    const opLoadRes = await request('lifecycle-operator', 'POST', '/load', { path: 'swarm-apps/learning-fixture.yaml' });
    expect(opLoadRes.status).toBe(201);
    expect(loadApp).toHaveBeenCalledWith(expect.stringContaining('learning-fixture.yaml'), { ownerSub: 'lifecycle-operator' });

    const opFile = join(process.cwd(), 'swarm-apps', 'lifecycle-op-probe.yaml');
    testArtifacts.push(opFile);
    const opImportRes = await requestMultipart('lifecycle-operator', '/import', 'lifecycle-op-probe.yaml', 'name: lifecycle-op-probe\n');
    expect(opImportRes.status).toBe(201);
    expect(loadApp).toHaveBeenCalledWith(expect.stringContaining('lifecycle-op-probe.yaml'), { ownerSub: 'lifecycle-operator' });

    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await request('lifecycle-operator', 'PATCH', '/learning-fixture/toggle')).status).toBe(403);
    expect((await request('lifecycle-operator', 'DELETE', '/learning-fixture')).status).toBe(403);
    expect((await request('lifecycle-operator', 'POST', '/load', { path: 'swarm-apps/learning-fixture.yaml' })).status).toBe(403);
    expect((await requestMultipart('lifecycle-operator', '/import', 'lifecycle-op-probe.yaml', 'name: lifecycle-op-probe\n')).status).toBe(403);

    expect(toggleApp).toHaveBeenCalledTimes(1); expect(unloadApp).toHaveBeenCalledTimes(1); expect(loadApp).toHaveBeenCalledTimes(2);
  });

  it('preserves the dependency conflict for authorized operators', async () => {
    const { request, unloadApp } = await boot();
    unloadApp.mockResolvedValueOnce({ blocked: true, dependents: ['dependent-fixture'], orphanCandidates: [] });
    const response = await request('lifecycle-operator', 'DELETE', '/learning-fixture');
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ dependents: ['dependent-fixture'] });
  });

  it('refuses manifest import for non-operators attempting to land public- or tenant-scoped apps', async () => {
    const { requestMultipart, loadApp } = await boot();
    const publicFile = join(process.cwd(), 'swarm-apps', 'public-app.yaml');
    testArtifacts.push(publicFile);
    const res = await requestMultipart('lifecycle-reader', '/import', 'public-app.yaml', 'name: public-app\nscope: public\n');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Operator privilege required' });
    expect(existsSync(publicFile)).toBe(false);
    expect(loadApp).not.toHaveBeenCalled();
  });
});
