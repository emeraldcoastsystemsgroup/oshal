/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the real first-run page and progress routes against disposable storage and explicit deterministic installer fixtures.
 */
import express, { type RequestHandler } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createOnboardingRoutes } from '../../src/app/routes/onboarding-routes';
import type { AppContext } from '../../src/app/composition/app-context';

const authenticated: RequestHandler = (req, _res, next) => {
  const sub = /fixture-user=(alice|bob)/.exec(req.get('cookie') || '')?.[1];
  Object.assign(req, { oidc: { isAuthenticated: () => Boolean(sub), user: sub ? { sub } : undefined } }); next();
};

/** @description Start isolated HTTP boundaries; registry operations are deterministic fixtures, never live installers.
 * @param pool Disposable database. @returns Fixture state, base URL and cleanup. */
export async function createOnboardingFixture(pool: Pool) {
  const app = express(); app.use(express.json()); app.use(authenticated);
  const state = { installs: [] as string[], failures: new Set<string>(), active: new Set<string>(),
    previews: [] as string[], replacement: false, revoked: false };
  app.use('/api', createOnboardingRoutes({ pool } as AppContext));
  app.get('/api/providers/access', (_req, res) => res.json({ hasActive: true, providers: [] }));
  app.get('/api/ui/profile', (_req, res) => res.json({ source: 'swarm-app', profile: { displayName: 'Focused fixture', connectors: [] } }));
  app.get('/api/swarm/roles/me', (req, res) => res.json({ isOperator: req.oidc?.user?.sub === 'alice' }));
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [...state.active].map(name => ({ name, status: 'active' })) }));
  app.use('/api/swarm/registries', (req, res, next) => {
    if (req.oidc?.user?.sub !== 'alice') { res.status(403).json({ error: 'Administrator required' }); return; } next();
  });
  installRegistryFixtures(app, state);
  app.use('/welcome', express.static(resolve('src/pages/welcome')));
  app.get('/cockpit', (_req, res) => res.send('Fixture cockpit'));
  const server = http.createServer(app);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { state, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done, reject) => { server.closeIdleConnections(); server.close(error => error ? reject(error) : done()); }) };
}

function installRegistryFixtures(app: express.Express, state: {
  installs: string[]; failures: Set<string>; active: Set<string>; previews: string[]; replacement: boolean; revoked: boolean;
}) {
  app.get('/api/swarm/registries', (_req, res) => res.json({ registries: [
    { slug: 'official', displayName: 'Official fixture source', enabled: true, trustState: 'trusted' },
    { slug: 'untrusted', displayName: 'Untrusted fixture', enabled: true, trustState: 'pending' },
  ] }));
  app.get('/api/swarm/registries/catalog', (_req, res) => res.json({ sources: [{ slug: 'official', ok: !state.revoked }],
    apps: ['alpha', 'beta'].map(name => ({ name, registry: 'official', displayName: name === 'alpha' ? '<img src=x onerror=alert(1)>' : name })) }));
  app.get('/api/swarm/registries/official/preview/:name', (req, res) => {
    state.previews.push(String(req.params.name));
    res.json({ name: req.params.name, version: '1.0.0', install: { allowed: !state.revoked, note: 'Fixture review' },
      impact: { routes: { count: 1 }, migrations: { count: 0 }, bots: { count: 1 }, schedules: { count: 0 } },
      source: { url: 'https://fixture.invalid/official' },
      replacement: state.replacement ? { source: 'another-fixture-source' } : null });
  });
  app.post('/api/swarm/registries/install', (req, res) => {
    if (state.revoked) { res.status(409).json({ error: 'Source trust revoked' }); return; }
    state.installs.push(req.body.name);
    if (state.failures.has(req.body.name)) { res.status(503).json({ error: 'Fixture package cannot start' }); return; }
    state.active.add(req.body.name); res.status(201).json({ installed: true, name: req.body.name, registry: 'official' });
  });
}
