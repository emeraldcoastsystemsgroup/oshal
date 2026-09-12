/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the actual Cockpit DOM, theme/settings/Home/ribbon modules and shared Budgets surface with synthetic read-only HTTP data.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise the real compact header disclosure and relocated theme control in the component fixture.
 * =============================================================================
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';

const ROOT = process.cwd();
const BOOTSTRAP = `
import { ThemeManager } from '/cockpit/js/theme-manager.js';
import { initHeaderOptions } from '/cockpit/js/header-options.js';
import { SettingsGlobalTab } from '/cockpit/js/views/SettingsGlobalTab.js';
import { AppsHomeView } from '/cockpit/js/views/AppsHomeView.js';
import { RibbonNav } from '/cockpit/js/components/RibbonNav.js';
const theme = new ThemeManager(), main = document.getElementById('mainContent');
initHeaderOptions();
const home = new AppsHomeView();
async function showHome() { await home.render(main); }
function showSettings() {
  home.destroy();
  main.innerHTML = '<div class="settings-view"><div class="settings-content" id="settingsBody"></div></div>';
  const body = document.getElementById('settingsBody');
  const settings = new SettingsGlobalTab({settings:{},onThemeChange:value=>theme.apply(value)},body);
  body.innerHTML = settings.renderOperatorPreferencesSection(); settings.bindThemePicker();
  body.querySelectorAll('input:not(#settingsApplicationColors)').forEach(input=>input.disabled=true);
}
function showSurface() {
  home.destroy(); main.replaceChildren();
  const frame=document.createElement('iframe'); frame.id='shared-surface';
  frame.title='Synthetic shared Budgets surface'; frame.src='/cockpit/tools/budgets.html';
  frame.style='width:100%;height:100%;border:0'; main.appendChild(frame);
}
const ribbon = new RibbonNav('ribbonContainer',id=>{
  if(id==='settings')showSettings(); else if(id==='tool-budgets')showSurface(); else void showHome();
});
await ribbon.ready;
if(new URLSearchParams(location.search).get('app')==='fixture-studio') {
  theme.setApplicationTheme('fixture-studio','/fixture/packaged.css');
}
document.getElementById('themeToggle').onclick=()=>theme.cycle();
document.getElementById('portalSettingsBtn').onclick=()=>showSettings();
window.workspaceThemeFixture={theme,showHome,showSettings,showSurface};
await showHome(); document.documentElement.dataset.fixtureReady='true';
`;

/** @description Synthetic Home plan with real AppsHomeView rendering, without installed applications or writes. */
function homePlan() {
  return { apps: ['Learning', 'Create', 'Career'].map((label, index) => ({
    name: `example-${index}`, displayName: `Example ${label}`, kind: 'app',
    suite: 'ai-productivity', description: 'Synthetic sample content for a visual skin check.',
    summary: [{ app: `example-${index}`, path: '/fixture/summary', tilesPointer: '/tiles', itemsPointer: '/items' }],
    todos: [], members: [],
  })) };
}

/** @description Serve fixed synthetic read responses; any mutation is refused by the fixture. */
function fixtureReads(app: express.Application) {
  const profile = { name: 'framework-default', defaultView: 'apps-home', ribbon: {
    items: [{ id: 'apps-home', label: 'Home', icon: 'codicon codicon-home', section: 'home' },
      'tickets', 'chat', 'calendar', 'addressbook', 'dashboard', 'logs', 'settings', 'operations', 'connectors'],
    dynamicTools: { allow: [] },
  } };
  const bodies: Record<string, unknown> = {
    '/api/ui/profile': { profile }, '/api/auth/user': { sub: 'theme-fixture', guestMode: false },
    '/api/cli-tokens/whoami': { operator: false }, '/api/tools': { tools: [] }, '/api/tools/dynamic': { tools: [] },
    '/api/swarm/apps/home-plan': homePlan(), '/api/home/preferences': { preferences: { version: 1 }, revision: 0 },
    '/api/jarvis/tasks': { tasks: [] }, '/api/budgets': { budgets: [] },
    '/fixture/summary': { tiles: [{ label: 'Sample items', value: '3', tone: 'neutral' }],
      items: [{ text: 'A small example update, with no connected source.', tone: 'neutral' }] },
  };
  for (const [path, body] of Object.entries(bodies)) app.get(path, (_req, res) => res.json(body));
  app.get('/api/budgets/state', (_req, res) => res.status(403).json({ error: 'operator_required' }));
  app.use('/api', (_req, res) => res.status(405).json({ error: 'fixture_read_only' }));
}

/** @description Use the real static route registrar and source directories; no service, database or provider is started. */
function fixtureAssets(app: express.Application) {
  app.use('/shared/ui/js', express.static(resolve(ROOT, 'src/shared/ui/js')));
  app.get('/shared/ui-debug.js', (_req, res) => res.sendFile(resolve(ROOT, 'src/pages/shared/ui-debug.js')));
  app.get('/fixture/bootstrap.js', (_req, res) => res.type('js').send(BOOTSTRAP));
  app.get('/fixture/packaged.css', (_req, res) => res.type('css').send(
    '[data-theme="fixture-studio"]{--bg-primary:#e9f4eb;--bg-card:#ffffff;--text-primary:#183b25;--accent-primary:#267344}'));
  registerCockpitStaticRoutes({ app, requiresAuth: (_req, _res, next) => next(),
    cockpitDir: resolve(ROOT, 'src/pages/cockpit'), uiEnhancedDir: resolve(ROOT, 'any-bot/ui-enhanced'),
    codiconFontsDir: resolve(ROOT, 'node_modules/@vscode/codicons/dist'),
    sharedUiCssDir: resolve(ROOT, 'src/shared/ui/css'), sharedUiJsDir: resolve(ROOT, 'src/shared/ui/js'),
  });
}

/** @description Start an isolated component-composition browser fixture over current production HTML/CSS/modules. */
export async function startWorkspaceThemeFixture() {
  const app = express();
  // Retain the current Cockpit DOM and stylesheet links. Replace service/CDN boot with
  // the actual components above, so this visual check never opens production APIs or SWs.
  const html = readFileSync(resolve(ROOT, 'src/pages/cockpit/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, script => script.includes('data-theme-once') ? script : '')
    .replace('</body>', '<script type="module" src="/fixture/bootstrap.js"></script></body>');
  app.get('/cockpit/', (_req, res) => res.type('html').send(html));
  fixtureReads(app); fixtureAssets(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolveReady => server.once('listening', resolveReady));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); },
  };
}
