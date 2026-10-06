/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (B4, step B5-2): the /swarm-admin home and its assets are served to the operator role only (a signed-in user gets 403 and a signed-out caller is sent to sign in), through the real surface registration with the real page definitions; the navigation API refuses a user and answers an operator with the home and grouped items, every one of which is a registered standalone surface, so the list never names a page that does not exist; the real mount line in server-auxiliary-routes and the page's fetch path are pinned (review); the page's styles load before the shared glass; the page bundle exists, is named like its route (so no asset alias is mounted), and inserts values as text only. Each fails on the tree before the fix.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-3): the AI defaults screen is guarded like the home (200 operator, 403 user on the page and its script, 302 signed out), listed in the navigation, hosts the two unchanged /config panel modules (every absolute import fetched through the real registration, review) in the containers they expect, and keeps the style order the glass spec requires.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-4): the swarm logins screen is guarded like the home, listed in the navigation, carries the card template and containers its script fills, inserts values as text only, and keeps the style order the glass spec requires.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type Request, type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireAdminConsoleAccess } from '@/features/governance/rbac/policy';
import { registerUiSurfaceRoutes } from '@/app/routes/ui-surface-routes';
import { resolveUiSurfacePages, sendHtmlResponse } from '@/app/server-ui-assets';
import { SWARM_ADMIN_NAVIGATION, createSwarmAdminNavigationRoutes } from '@/app/routes/swarm-admin-navigation';
import { requiresOperator } from '@/shared/middleware/authz';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

const OPERATOR = { sub: 'idp-operator', email: 'operator@example.test', iss: 'https://login.example.test/tenant' };
const USER = { sub: 'idp-user', email: 'user@example.test', iss: 'https://login.example.test/tenant' };

/** A sign-in stub shaped like the real rail: the x-fixture-user header names the principal, or nobody. */
const signIn: RequestHandler = (req, _res, next) => {
  const raw = req.headers['x-fixture-user'];
  const user = typeof raw === 'string' && raw ? JSON.parse(raw) as Record<string, string> : null;
  if (user) Object.assign(req, { oidc: { isAuthenticated: () => true, user } });
  next();
};
/** requiresAuth as the OIDC rail behaves: a signed-out caller is sent to sign in. */
const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next();
  else res.redirect(302, '/login');
};

async function serve(mount: (app: express.Express) => void) {
  const app = express();
  app.use(signIn);
  mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (route: string, user: Record<string, string> | null) => fetch(base + route, {
      redirect: 'manual', headers: user ? { 'x-fixture-user': JSON.stringify(user) } : {},
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeEach(() => {
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  setPrivilegedIdentities([{ sub: OPERATOR.sub, email: OPERATOR.email, role: 'admin' }]);
});
afterEach(() => { clearPrivilegedIdentities(); vi.restoreAllMocks(); });

describe('the /swarm-admin surface', () => {
  const pages = () => resolveUiSurfacePages([requireAdminConsoleAccess()]);

  it('is registered with the operator role as its guard, named like its directory, and loads its styles before the shared glass', () => {
    const page = pages().find((p) => p.routePath === '/swarm-admin');
    expect(page).toBeDefined();
    expect(page?.extraGuards).toEqual([requiresOperator]);
    expect(Object.isFrozen(SWARM_ADMIN_NAVIGATION[0])).toBe(true);
    const html = fs.readFileSync(path.join(page!.pageDir, 'index.html'), 'utf8');
    expect(html.indexOf('/swarm-admin/swarm-admin.css')).toBeLessThan(html.indexOf('surface-glass.css'));
    expect(path.basename(page!.pageDir)).toBe('swarm-admin');
    for (const file of ['index.html', 'swarm-admin.css', 'swarm-admin.js']) expect(fs.existsSync(path.join(page!.pageDir, file)), file).toBe(true);
  });

  it('serves the home and its assets to an operator, refuses a user with 403, and sends a signed-out caller to sign in', async () => {
    const app = await serve((a) => registerUiSurfaceRoutes({ app: a, requiresAuth, serveHtml: sendHtmlResponse, pages: pages() }));
    try {
      const home = await app.get('/swarm-admin', OPERATOR);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('Swarm Admin');
      expect((await app.get('/swarm-admin/swarm-admin.js', OPERATOR)).status).toBe(200);
      expect((await app.get('/swarm-admin', USER)).status).toBe(403);
      expect((await app.get('/swarm-admin/swarm-admin.js', USER)).status).toBe(403);
      expect((await app.get('/swarm-admin/swarm-admin.css', USER)).status).toBe(403);
      const signedOut = await app.get('/swarm-admin', null);
      expect(signedOut.status).toBe(302);
      expect(signedOut.headers.get('location')).toBe('/login');
      // Granting the role admits the same user on the next request, without a restart.
      setPrivilegedIdentities([{ sub: USER.sub, email: USER.email, role: 'admin' }]);
      expect((await app.get('/swarm-admin', USER)).status).toBe(200);
    } finally { await app.close(); }
  });

  it('serves the AI defaults screen under the same guard, hosting the unchanged /config panels', async () => {
    const page = pages().find((p) => p.routePath === '/swarm-admin/ai-defaults');
    expect(page?.extraGuards).toEqual([requiresOperator]);
    expect(path.basename(page!.pageDir)).toBe('ai-defaults');
    const html = fs.readFileSync(path.join(page!.pageDir, 'index.html'), 'utf8');
    for (const id of ['fleetDefaultPanel', 'capabilityProvidersPanel', 'statusBanner']) expect(html).toContain(`id="${id}"`);
    expect(html.indexOf('/swarm-admin/ai-defaults/ai-defaults.css')).toBeLessThan(html.indexOf('surface-glass.css'));
    const script = fs.readFileSync(path.join(page!.pageDir, 'ai-defaults.js'), 'utf8');
    expect(script).toContain("from '/config-admin/config-admin-fleet-default.js'");
    expect(script).toContain("from '/config-admin/config-admin-capability-providers.js'");
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(SWARM_ADMIN_NAVIGATION.some((item) => item.path === '/swarm-admin/ai-defaults' && item.group === 'swarm-admin')).toBe(true);

    const app = await serve((a) => registerUiSurfaceRoutes({ app: a, requiresAuth, serveHtml: sendHtmlResponse, pages: pages() }));
    try {
      const screen = await app.get('/swarm-admin/ai-defaults', OPERATOR);
      expect(screen.status).toBe(200);
      expect(await screen.text()).toContain('AI defaults');
      expect((await app.get('/swarm-admin/ai-defaults/ai-defaults.js', OPERATOR)).status).toBe(200);
      expect((await app.get('/swarm-admin/ai-defaults', USER)).status).toBe(403);
      expect((await app.get('/swarm-admin/ai-defaults/ai-defaults.js', USER)).status).toBe(403);
      expect((await app.get('/swarm-admin/ai-defaults/', null)).status).toBe(302);
      // The nested route's shared-helper mount stays behind sign-in too.
      expect((await app.get('/swarm-admin/shared/ui-debug.js', null)).status).toBe(302);
      // Every absolute module the page imports is really served through the registered surfaces (the /config
      // page's alias mount for the panel modules, the shared helpers they import), so a moved file cannot break it silently.
      const imports = Array.from(script.matchAll(/from '(\/[^']+)'/g), (m) => m[1]);
      expect(imports.length).toBeGreaterThanOrEqual(3);
      for (const url of [...imports, '/shared/ui-debug.js', '/config-admin/config-admin.css']) {
        expect((await app.get(url, OPERATOR)).status, url).toBe(200);
      }
    } finally { await app.close(); }
  });

  it('serves the swarm logins screen under the same guard, with its card template and text-only script', async () => {
    const page = pages().find((p) => p.routePath === '/swarm-admin/logins');
    expect(page?.extraGuards).toEqual([requiresOperator]);
    expect(path.basename(page!.pageDir)).toBe('logins');
    const html = fs.readFileSync(path.join(page!.pageDir, 'index.html'), 'utf8');
    for (const id of ['loginCards', 'loginCardTemplate', 'statusBanner', 'adoptionNote']) expect(html).toContain(`id="${id}"`);
    expect(html.indexOf('/swarm-admin/logins/logins.css')).toBeLessThan(html.indexOf('surface-glass.css'));
    const script = fs.readFileSync(path.join(page!.pageDir, 'logins.js'), 'utf8');
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(script).toMatch(/window\.confirm\(/);
    expect(SWARM_ADMIN_NAVIGATION.some((item) => item.path === '/swarm-admin/logins' && item.group === 'swarm-admin')).toBe(true);
    const app = await serve((a) => registerUiSurfaceRoutes({ app: a, requiresAuth, serveHtml: sendHtmlResponse, pages: pages() }));
    try {
      const screen = await app.get('/swarm-admin/logins', OPERATOR);
      expect(screen.status).toBe(200);
      expect(await screen.text()).toContain('Swarm logins');
      expect((await app.get('/swarm-admin/logins/logins.js', USER)).status).toBe(403);
      expect((await app.get('/swarm-admin/logins', null)).status).toBe(302);
    } finally { await app.close(); }
  });

  it('inserts server values as text only', () => {
    const script = fs.readFileSync(path.join(pages().find((p) => p.routePath === '/swarm-admin')!.pageDir, 'swarm-admin.js'), 'utf8');
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(script).toMatch(/textContent/);
  });
});

describe('GET /api/admin/navigation', () => {
  it('refuses a user and answers an operator with the home and grouped items', async () => {
    const app = await serve((a) => a.use('/api/admin/navigation', requiresAuth, requiresOperator, createSwarmAdminNavigationRoutes()));
    try {
      expect((await app.get('/api/admin/navigation', USER)).status).toBe(403);
      expect((await app.get('/api/admin/navigation', null)).status).toBe(302);
      const res = await app.get('/api/admin/navigation', OPERATOR);
      expect(res.status).toBe(200);
      const body = await res.json() as { home: string; items: typeof SWARM_ADMIN_NAVIGATION };
      expect(body.home).toBe('/swarm-admin');
      expect(body.items).toEqual(SWARM_ADMIN_NAVIGATION);
      expect(body.items[0]).toMatchObject({ path: '/swarm-admin', group: 'swarm-admin' });
    } finally { await app.close(); }
  });

  it('is mounted in server-auxiliary-routes behind requiresAuth and requiresOperator, and the page fetches that path', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/app/server-auxiliary-routes.ts'), 'utf8');
    expect(source).toContain("app.use('/api/admin/navigation', requiresAuth, requiresOperator, createSwarmAdminNavigationRoutes());");
    const script = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/swarm-admin/swarm-admin.js'), 'utf8');
    expect(script).toContain("fetch('/api/admin/navigation'");
  });

  it('names only registered standalone surfaces, each once, with a title and a description', () => {
    const registered = new Set(resolveUiSurfacePages([requireAdminConsoleAccess()]).map((p) => p.routePath));
    const seen = new Set<string>();
    for (const item of SWARM_ADMIN_NAVIGATION) {
      expect(registered.has(item.path), `${item.path} is not a registered surface`).toBe(true);
      expect(seen.has(item.path), `${item.path} listed twice`).toBe(false);
      seen.add(item.path);
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
      expect(['swarm-admin', 'people', 'operations']).toContain(item.group);
    }
  });
});
