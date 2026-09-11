/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the installed-case catalog scenario is registered and detects broken app/version associations over HTTP.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '@/app/composition/app-context';
import { createTestLabRoutes } from '@/app/routes/test-lab-routes';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { InstalledAppTestCatalog } from '@/features/swarm-apps/services/installed-app-test-catalog';

let server: Server;
let base: string;
let mode: 'normal' | 'unavailable' | 'broken' = 'normal';
let reads = 0;
const oldPort = process.env.PORT;
const ownerCookie = 'lab-owner=alice';

beforeAll(async () => {
  const catalog = new InstalledAppTestCatalog();
  catalog.register({
    name: 'lab-fixture', version: '1.0.0', status: 'active', manifestPath: path.join(process.cwd(), 'oshal-app.yaml'),
    manifest: { name: 'lab-fixture', version: '1.0.0', smoke: [{ name: 'ready', method: 'GET',
      path: '/api/lab-fixture/ready', auth: 'public', expect: { status: 200 } }] },
  } as Parameters<InstalledAppTestCatalog['register']>[0]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.cookie !== ownerCookie) { res.status(401).json({ error: 'sign in' }); return; }
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: 'alice' } } });
    next();
  });
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [] }));
  app.get('/api/lab-fixture/ready', (_req, res) => { reads++; res.json({ ready: true }); });
  app.get('/api/test-lab/catalog', (_req, res, next) => {
    if (mode === 'unavailable') { res.status(503).json({ error: 'unavailable' }); return; }
    if (mode === 'broken') {
      res.json({ installedApps: [], scenarios: [{ id: 'app:lab-fixture:smoke:ready', installedTest: {
        id: 'app:lab-fixture:smoke:ready', appName: 'lab-fixture', appVersion: '1.0.0',
        revision: 'a'.repeat(64), runnable: true,
      } }] });
      return;
    }
    next();
  });
  app.use('/api/test-lab', createTestLabRoutes({} as AppContext, {
    installedTests: catalog, visibleApps: async () => new Map([['lab-fixture', 'Lab fixture']]),
  }));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PORT = String((server.address() as AddressInfo).port);
  base = `http://127.0.0.1:${process.env.PORT}`;
});

beforeEach(() => { mode = 'normal'; reads = 0; });
afterAll(async () => {
  if (oldPort === undefined) delete process.env.PORT;
  else process.env.PORT = oldPort;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('platform Test Lab registrations', () => {
  it('exposes the core registration check and the installed package case in the real catalog', async () => {
    const response = await fetch(`${base}/api/test-lab/catalog`, { headers: { cookie: ownerCookie } });
    expect(response.status).toBe(200);
    const catalog = await response.json() as { scenarios: Array<{ id: string }> };
    expect(catalog.scenarios.map(s => s.id)).toEqual(expect.arrayContaining([
      'installed-app-tests', 'app:lab-fixture:smoke:ready', 'connector-oauth-boundary', 'multi-store-discovery',
    ]));
    const command = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).scripts['test:platform-readiness'];
    for (const id of ['installed-app-tests', 'connector-oauth-boundary', 'multi-store-discovery']) {
      const scenario = SCENARIOS.find(s => s.id === id)!;
      for (const suite of scenario.regressionTests!) {
        expect(fs.existsSync(path.resolve(suite.path)), suite.path).toBe(true);
        expect(command, suite.path).toContain(suite.path);
      }
    }
  });

  it('runs discovery through the Lab without executing the registered app smoke', async () => {
    const response = await fetch(`${base}/api/test-lab/run`, { method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'installed-app-tests' }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { results: Array<{ state: string; steps: Array<{ detail: string }> }> };
    expect(result.results[0].state).toBe('pass');
    expect(result.results[0].steps[0].detail).toContain('1 visible installed smoke cases');
    expect(reads).toBe(0);
  });

  it('fails the live assertion when a case loses its installed app association', async () => {
    mode = 'broken';
    const scenario = SCENARIOS.find(s => s.id === 'installed-app-tests')!;
    expect((await scenario.steps[0].run(ownerCookie, {})).state).toBe('fail');
  });

  it('reports unavailable or unauthenticated discovery without claiming a pass', async () => {
    const scenario = SCENARIOS.find(s => s.id === 'installed-app-tests')!;
    expect((await scenario.steps[0].run('', {})).state).toBe('degraded');
    mode = 'unavailable';
    expect((await scenario.steps[0].run(ownerCookie, {})).state).toBe('degraded');
  });
});
