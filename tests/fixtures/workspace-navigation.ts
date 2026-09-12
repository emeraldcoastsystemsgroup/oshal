/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the real Cockpit boot, navigation and iframe controller over isolated synthetic application responses.
 * =============================================================================
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';

const ROOT = process.cwd();
const NAMES = ['little-monsters', 'create', 'intelligent-career', 'fixture-studio'];
const LABELS = ['Little Monsters', 'Create', 'Career workspace', 'Synthetic Studio'];

/** @description Shape only synthetic destination data; production policy admission is covered by the route suite. */
function destinations() {
  return NAMES.map((name, index) => ({ name, displayName: LABELS[index],
    href: `/cockpit/?app=${name}`, kind: 'app' }));
}

/** @description Generate an admitted synthetic profile consumed by the unmodified real RibbonNav. */
function profile(name: string) {
  const immersive = name === 'little-monsters';
  return { name: name || 'framework-default', displayName: LABELS[NAMES.indexOf(name)] || 'Synthetic Cockpit',
    defaultView: 'tool-fixture-editor', hideChatPanel: immersive, hideAssistant: immersive, hideStatusBar: immersive,
    ...(name === 'fixture-studio' ? { theme: 'fixture-studio', themeCssUrl: '/fixture/studio.css' } : {}),
    ribbon: { items: [
      { id: 'tool-fixture-editor', label: 'Editor', section: 'home', toolUi: { iframeUrl: '/fixture/editor?mode=edit' } },
      { id: 'tool-fixture-detail', label: 'Details', section: 'top', toolUi: { iframeUrl: '/fixture/detail?mode=inspect' } },
      'settings'], dynamicTools: { allow: [] } },
  };
}

/** @description An inert custom app exercises normal forms, dialogs, downloads and the existing navigation message contract. */
function customSurface(detail: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="/shared/ui/css/surface-themes.css">
  <script src="/shared/ui/js/surface-theme.js"></script>
  <style>body{margin:0;padding:20px;background:var(--bg-primary);color:var(--text-primary);font:16px sans-serif}
  button,input{font:inherit;padding:8px;margin:4px}input{max-width:80%}</style></head><body>
  <h1>${detail ? 'Synthetic details' : 'Synthetic editor'}</h1>
  <form id="fixtureForm"><label>Draft <input id="draft" name="draft"></label><button>Save locally</button></form>
  <output id="saved"></output><button id="openDetails">Open details</button>
  <button id="confirmLocal">Confirm local action</button><output id="confirmed"></output>
  <button id="fullscreen">Full screen</button><a id="download" href="/fixture/download" download>Download sample</a>
  <script>
  document.documentElement.dataset.documentId=crypto.randomUUID();
  document.getElementById('fixtureForm').onsubmit=async event=>{event.preventDefault();
    const response=await fetch('/fixture/save',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({draft:document.getElementById('draft').value})});
    document.getElementById('saved').textContent=response.ok?'Saved in isolated fixture':'Refused';};
  document.getElementById('openDetails').onclick=()=>parent.postMessage({type:'app-navigate',tool:'fixture-detail',
    query:'kind=docx&starter=resume'},location.origin);
  document.getElementById('confirmLocal').onclick=()=>{if(confirm('Apply synthetic action?'))document.getElementById('confirmed').textContent='Confirmed';};
  document.getElementById('fullscreen').onclick=()=>document.documentElement.requestFullscreen();
  </script></body></html>`;
}

/** @description Synthetic HTTP state never refers to accounts, providers or installed application data. */
function state() {
  return { workspaces: destinations(), workspaceStatus: 200, requests: [] as string[], saves: 0, allowSave: true };
}

/** @description Supply inert boot/Settings data while recording every request made by the real shell. */
function readResponses(app: express.Application, current: ReturnType<typeof state>) {
  app.use((req, _res, next) => { current.requests.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/ui/profile', (req, res) => res.json({ profile: profile(String(req.query.name || '')) }));
  app.get('/api/ui/workspaces', (_req, res) => res.status(current.workspaceStatus).json({ workspaces: current.workspaces }));
  const reads: Record<string, unknown> = {
    '/api/auth/user': { sub: 'synthetic-navigation-user', guestMode: false },
    '/api/cli-tokens/whoami': { operator: false }, '/api/tools': { tools: [] }, '/api/tools/dynamic': { tools: [] },
    '/api/agents': { agents: [] }, '/api/swarm/bots/registry': { bots: [] }, '/api/providers': [],
    '/api/config': {}, '/api/config/ownership': null, '/api/config/rag': { config: {} },
    '/api/v1/metrics/summary': {}, '/api/dev-console/access': { superAdmin: false },
    '/api/swarm/apps/home-plan': { apps: [] }, '/api/home/preferences': { preferences: { version: 1 }, revision: 0 },
    '/api/jarvis/tasks': { tasks: [] },
  };
  for (const [path, body] of Object.entries(reads)) app.get(path, (_req, res) => res.json(body));
  app.use('/api', (_req, res) => res.status(403).json({ error: 'Synthetic fixture endpoint unavailable' }));
}

/** @description Local-only custom surface effects test the existing iframe sandbox; no business action is executed. */
function surfaceResponses(app: express.Application, current: ReturnType<typeof state>) {
  app.get('/fixture/editor', (_req, res) => res.type('html').send(customSurface(false)));
  app.get('/fixture/detail', (_req, res) => res.type('html').send(customSurface(true)));
  app.post('/fixture/save', express.json(), (_req, res) => {
    if (!current.allowSave) { res.status(403).json({ error: 'Synthetic permission revoked' }); return; }
    current.saves += 1; res.json({ saved: true });
  });
  app.get('/fixture/download', (_req, res) => res.attachment('synthetic.txt').send('Isolated navigation fixture'));
  app.get('/fixture/studio.css', (_req, res) => res.type('css').send(
    '[data-theme="fixture-studio"]{--bg-primary:#e9f4eb;--bg-card:#fff;--text-primary:#183b25;--accent-primary:#267344}'));
  app.get('/swarmbot/chat', (_req, res) => res.type('html').send('<!doctype html><title>Inert fixture chat</title>'));
}

/** @description Keep actual HTML and app.js initialization; omit unrelated CDN, service worker and onboarding scripts. */
function assets(app: express.Application) {
  app.use('/shared/ui/js', express.static(resolve(ROOT, 'src/shared/ui/js')));
  const html = readFileSync(resolve(ROOT, 'src/pages/cockpit/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, script =>
      script.includes('data-theme-once') || /src="js\/app\.js"/.test(script) ? script : '');
  app.get(['/cockpit/', '/cockpit/index.html'], (_req, res) => res.type('html').send(html));
  app.get('/shared/ui-debug.js', (_req, res) => res.sendFile(resolve(ROOT, 'src/pages/shared/ui-debug.js')));
  registerCockpitStaticRoutes({ app, requiresAuth: (_req, _res, next) => next(),
    cockpitDir: resolve(ROOT, 'src/pages/cockpit'), uiEnhancedDir: resolve(ROOT, 'any-bot/ui-enhanced'),
    codiconFontsDir: resolve(ROOT, 'node_modules/@vscode/codicons/dist'),
    sharedUiCssDir: resolve(ROOT, 'src/shared/ui/css'), sharedUiJsDir: resolve(ROOT, 'src/shared/ui/js') });
}

/**
 * @description Start a real Cockpit browser fixture on an ephemeral local HTTP port with synthetic responses only.
 * @param configure Optional synthetic routes registered before the default fixture responses.
 * @returns Local origin, controlled synthetic responses and complete server cleanup.
 */
export async function startWorkspaceNavigationFixture(configure?: (app: express.Application) => void) {
  const app = express(), current = state();
  configure?.(app);
  readResponses(app, current); surfaceResponses(app, current); assets(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state: current,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done, reject) =>
      server.close(error => error ? reject(error) : done())); } };
}
