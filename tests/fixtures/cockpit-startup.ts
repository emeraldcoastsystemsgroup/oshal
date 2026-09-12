/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Retain the complete Cockpit document and boot scripts while reusing isolated navigation responses for startup resilience tests.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';
import { startWorkspaceNavigationFixture } from './workspace-navigation';

/** @description Start the actual shell, including its unmodified script loading and service-worker registration.
 * @returns Ephemeral local fixture with synthetic data and no installed-account connections.
 */
export async function startCockpitStartupFixture() {
  const startup = { previousWorker: false };
  const fixture = await startWorkspaceNavigationFixture(app => {
    app.get('/cockpit/service-worker.js', (_req, res) => {
      const source = readFileSync(resolve('src/pages/cockpit/service-worker.js'), 'utf8');
      res.set('Cache-Control', 'no-store').type('js').send(startup.previousWorker
        ? source.replace(/oshal-cockpit-v\d+/, 'oshal-cockpit-fixture-previous') : source);
    });
    app.get(['/cockpit/', '/cockpit/index.html'], (_req, res) =>
      res.sendFile(resolve('src/pages/cockpit/index.html')));
    app.get('/api/providers/access', (_req, res) => res.json({ providers: [{ id: 'fixture', active: true }] }));
    app.get('/api/cli-tokens/whoami', (_req, res) => res.json({ operator: true }));
    app.get('/api/mesh/channels', (_req, res) => res.json({ channels: [{
      mesh_id: 'synthetic-channel', topic: 'Synthetic topology', status: 'active', scope: 'ticket',
      ticket_id: 'synthetic-ticket', members: ['Synthetic specialist'],
    }] }));
    app.get('/api/tickets/active', (_req, res) => res.json({ tickets: [{ id: 'synthetic-ticket', name: 'Synthetic work', status: 'started' }] }));
    app.get('/api/swarm/work-items', (_req, res) => res.json({ workItems: [] }));
    app.get('/api/v1/agent/scheduler/status', (_req, res) => res.json({ isRunning: true }));
    app.get('/api/swarm/runs', (_req, res) => res.json({ runs: [] }));
    app.use('/mesh-dashboard', express.static(resolve('src/pages/mesh-dashboard')));
    app.get('/shared/ui-debug.js', (_req, res) => res.sendFile(resolve('src/pages/shared/ui-debug.js')));
  });
  // The normal profile contract also admits a built-in view object without toolUi.
  Object.assign(fixture.state.profiles, { '': { name: 'startup-fixture', displayName: 'Synthetic Cockpit',
    defaultView: 'tool-fixture-editor', hideChatPanel: false, hideAssistant: false, hideStatusBar: false,
    ribbon: { items: [{ id: 'tool-fixture-editor', label: 'Editor', section: 'home',
      toolUi: { iframeUrl: '/fixture/editor?mode=edit' } }, { id: 'advanced', label: 'Engineering', section: 'top' }, 'settings'], dynamicTools: { allow: [] } } } });
  return { ...fixture, startup };
}

/** @description Exercise the real route registrar with an isolated session gate; no production accounts or policy are involved. */
export async function startCockpitVendorFixture() {
  const app = express();
  registerCockpitStaticRoutes({ app, requiresAuth: (req, res, next) => {
    if (req.headers['x-fixture-session'] === 'signed-in') next(); else res.sendStatus(401);
  }, cockpitDir: resolve('src/pages/cockpit'), uiEnhancedDir: resolve('any-bot/ui-enhanced'),
  codiconFontsDir: resolve('node_modules/@vscode/codicons/dist'), sharedUiCssDir: resolve('src/shared/ui/css'),
  sharedUiJsDir: resolve('src/shared/ui/js') });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done, reject) =>
      server.close(error => error ? reject(error) : done())); } };
}
