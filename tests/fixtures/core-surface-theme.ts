/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve actual core administration and Lab HTML with real theme assets and explicitly refused synthetic business APIs.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

export const CORE_SURFACES = [
  { name: 'Users', path: '/users', file: 'src/pages/users/index.html', panel: '.card' },
  { name: 'Access', path: '/access', file: 'src/pages/access/index.html', panel: '.panel' },
  { name: 'Applications', path: '/applications', file: 'src/pages/applications/index.html', panel: '.admin-bar' },
  { name: 'App Loader', path: '/app-loader', file: 'src/pages/app-loader/index.html', panel: '.card' },
  { name: 'Admin', path: '/admin', file: 'src/pages/admin/index.html', panel: '.panel' },
  { name: 'Config Admin', path: '/config-admin', file: 'src/pages/config-admin/index.html', panel: '.panel' },
  { name: 'AI Test Lab', path: '/api/test-lab/app', file: 'any-bot/server/services/tools/test-lab/test-lab-app.html', panel: '.lab-hero' },
] as const;

/** Additional actual core documents exercise only their own markup, stylesheet and shared theme bootstrap. */
export const ADDITIONAL_CORE_SURFACES = [
  'eval-wall', 'feeds', 'governance', 'haven', 'health-dashboard', 'intelligent-processing',
  'mesh-dashboard', 'ops-dashboard', 'process-lab', 'queue-dashboard', 'queue-manager-admin',
  'rag-center', 'redis-visibility', 'run-trace', 'swarm-control', 'task-explorer', 'user-dashboard', 'workflow-studio', 'jarvis-briefings',
].map(name => ({ name, path: '/' + name, file: `src/pages/${name}/index.html` }));

export const ALL_CORE_SURFACES = [...CORE_SURFACES, ...ADDITIONAL_CORE_SURFACES];

/** Isolate visual compatibility from unrelated business controllers while preserving their real HTML and all CSS. */
function appearanceHtml(file: string): string {
  return readFileSync(resolve(file), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,
    source => source.includes('/shared/ui/js/surface-theme.js') ? source : '');
}

/** Real source assets only; no application server, provider, database or account is started. */
function assets(app: express.Application) {
  app.use('/shared/ui', express.static(resolve('src/shared/ui')));
  app.use('/shared', express.static(resolve('src/pages/shared')));
  app.use('/cockpit', express.static(resolve('src/pages/cockpit')));
  app.use('/fonts', express.static(resolve('node_modules/@vscode/codicons/dist')));
  app.use('/admin', express.static(resolve('src/pages/admin'), { index: false }));
  app.use('/config-admin', express.static(resolve('src/pages/config-admin'), { index: false }));
  for (const surface of ADDITIONAL_CORE_SURFACES) {
    app.use(surface.path, express.static(resolve('src/pages', surface.name), { index: false }));
  }
}

/** The parent supplies only cosmetic theme state and never exports credentials or application data. */
function parent(app: express.Application) {
  app.get('/fixture/parent', (req, res) => {
    const surface = ALL_CORE_SURFACES.find(item => item.path === req.query.surface);
    if (!surface) { res.status(400).end(); return; }
    res.type('html').send(`<!doctype html><html data-theme="workspace"><head>
      <link rel="stylesheet" href="/shared/ui/css/surface-themes.css"></head>
      <body><h1>Synthetic theme parent</h1><input id="parentDraft" aria-label="Synthetic parent draft">
      <iframe title="Actual core surface" src="${surface.path}" style="width:1100px;height:700px"></iframe></body></html>`);
  });
}

/** Seven complete pages use synthetic read dependencies; eighteen more isolate real markup, CSS and theme bootstrap. */
export async function startCoreSurfaceThemeFixture() {
  const app = express(), requests: string[] = [], mutations: string[] = [];
  app.use((req, res, next) => {
    requests.push(`${req.method} ${req.path}`);
    if (!['GET', 'HEAD'].includes(req.method)) {
      mutations.push(`${req.method} ${req.path}`); res.status(405).json({ error: 'synthetic_read_only_fixture' }); return;
    }
    next();
  });
  for (const surface of CORE_SURFACES) app.get(surface.path, (_req, res) => res.sendFile(resolve(surface.file)));
  for (const surface of ADDITIONAL_CORE_SURFACES) app.get(surface.path, (_req, res) => res.type('html').send(appearanceHtml(surface.file)));
  parent(app); assets(app);
  app.get('/api/test-lab/catalog', (_req, res) => res.json({ scenarios: [], installedApps: [], apps: [] }));
  app.get('/api/test-lab/runs', (_req, res) => res.json({ runs: [] }));
  app.get('/api/test-lab/schedules', (_req, res) => res.json({ schedules: [] }));
  app.use('/api', (_req, res) => res.status(403).json({ error: 'synthetic_current_authority_unavailable' }));
  app.use((_req, res) => res.status(404).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, mutations,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); } };
}
