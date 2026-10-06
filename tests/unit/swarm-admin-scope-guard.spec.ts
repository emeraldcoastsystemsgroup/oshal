/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2c guard: the swarm admin reaches swarm administration and is refused on every personal surface (403 for APIs, redirect to /admin for pages); prefixes match on path boundaries; ordinary users are untouched; a trusted service call acting as the admin is refused. Kept honest against the real mount table: every operator-only mount is reachable by the admin, and every admin API prefix names a real mount.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The admin's own pages must work: every API an admin-reachable page calls is reachable by the admin, unless it is a named personal call on a mixed page (refused on purpose). The dashboards' GET-only reads are allowed while the same routers' writes stay refused, and /cockpit/tools narrows to the dead-letter and chat-channel tools.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The admin's pages load their assets and link nowhere the gate bounces. The optimizer (/api/token-chase/ui, src/api/token-chase.html) joins the page list. Every script, stylesheet, image, ES-module import and CSS url() or @import an admin page loads is followed through the server's static mounts, resolved against the URL its file is served at (/config and /config-admin both serve src/pages/config-admin), and must pass the gate; this was red on the /config-admin assets, /cockpit/js/theme-manager.js and the cockpit theme stylesheets that surface-themes.css imports. Through the gate itself, those two cockpit files answer GET and HEAD and refuse writes, and the rest of the cockpit (its document, other scripts and stylesheets, nested or encoded theme paths) still redirects to /admin. Every static same-origin href on an admin page (in markup, in markup its scripts build, and .href navigations) must pass the gate too, except sign-in and sign-out links and KNOWN_BOUNCED_LINKS, each kept with its reason; a known entry no page links any more fails as well.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 S02: the connector case uses the real marketplace route (POST /api/connectors/marketplace/:provider/enable, connector-marketplace-routes.ts). The old /api/connectors/github/enable named no route; it only passed because /api/connectors was a broad prefix, which the gate no longer has. The exact reach (never-list, method-aware exact calls, case variants) is pinned in swarm-admin-reach-exact.spec.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverControllerRegistrars } from '@/features/security';
import { localSubForEmail } from '@/features/local-auth';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import {
  SWARM_ADMIN_API_PREFIXES, SWARM_ADMIN_SUB, createSwarmAdminScopeGuard, swarmAdminMayReach,
} from '@/shared/middleware/swarm-admin-scope';
import { extractApiMounts } from '../helpers/controller-api-mounts';

let server: Server | undefined;
let base = '';

beforeEach(async () => {
  vi.stubEnv('SWARM_SERVICE_SECRET', 'placeholder-service-secret');
  const app = express();
  app.use((req, _res, next) => {
    const who = req.get('x-test-who');
    if (who === 'admin') {
      Object.assign(req, { oidc: { isAuthenticated: () => true, user: { iss: LOCAL_AUTH_PRINCIPAL_ISSUER, sub: SWARM_ADMIN_SUB, oshal_account_kind: 'swarm-admin' } } });
    } else if (who === 'person') {
      Object.assign(req, { oidc: { isAuthenticated: () => true, user: { iss: 'https://accounts.google.com', sub: 'google-person' } } });
    }
    next();
  });
  app.use(createSwarmAdminScopeGuard());
  app.use((_req, res) => { res.status(200).json({ reached: true }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

function call(pathname: string, who?: string, method = 'GET', headers: Record<string, string> = {}) {
  return fetch(base + pathname, { method, redirect: 'manual', headers: { ...(who ? { 'x-test-who': who } : {}), ...headers } });
}

describe('the swarm admin is not a user of the swarm', () => {
  it('has the reserved login\'s subject', () => {
    expect(SWARM_ADMIN_SUB).toBe(localSubForEmail('admin'));
  });

  it.each([
    ['GET', '/admin'], ['GET', '/admin/admin.js'], ['GET', '/shared/ui/css/surface-glass.css'], ['GET', '/users'],
    ['GET', '/login/admin'], ['POST', '/api/admin-auth/login'], ['GET', '/api/config'], ['PUT', '/api/capability-providers/voice'],
    ['POST', '/api/swarm/apps/import'], ['GET', '/api/tenants/home-1/members'], ['POST', '/api/connectors/marketplace/github/enable'],
    ['GET', '/api/logs'], ['GET', '/cockpit/tools/dlq.html'], ['GET', '/api/swarm/runs'], ['GET', '/api/tickets/active'],
    ['GET', '/api/v1/metrics/summary'], ['GET', '/api/authorization/catalog'], ['GET', '/api/user-directory'], ['GET', '/api/health'],
  ])('reaches swarm administration: %s %s', async (method, pathname) => {
    expect((await call(pathname, 'admin', method)).status).toBe(200);
  });

  it.each([
    ['GET', '/api/v1/tickets/hierarchy'], ['POST', '/api/cli-tokens'], ['GET', '/api/tasks'], ['POST', '/api/jarvis/ask'],
    ['GET', '/api/connect/google'], ['GET', '/api/calendar/events'], ['POST', '/api/tickets'], ['POST', '/api/tickets/active'],
    ['POST', '/api/v1/agent/schedule-task'], ['POST', '/api/swarm/tickets'], ['POST', '/api/intake/fast'],
    ['GET', '/api/configuration-of-something-else'],
  ])('is refused on a personal API: %s %s', async (method, pathname) => {
    const res = await call(pathname, 'admin', method);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'swarm_admin_not_a_user' });
  });

  it.each(['/', '/cockpit/', '/haven', '/adminx', '/cockpit/tools/devices.html'])('is sent to the admin console from the personal page %s', async (pathname) => {
    const res = await call(pathname, 'admin');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
  });

  it('leaves ordinary users and anonymous requests untouched', async () => {
    for (const pathname of ['/api/v1/tickets/hierarchy', '/cockpit/', '/api/config']) {
      expect((await call(pathname, 'person')).status, pathname).toBe(200);
      expect((await call(pathname)).status, pathname).toBe(200);
    }
  });

  it('refuses a trusted service call acting as the swarm admin', async () => {
    const secret = { 'x-service-secret': 'placeholder-service-secret' };
    expect((await call('/api/tasks', undefined, 'POST', { ...secret, 'x-oshal-user-sub': SWARM_ADMIN_SUB })).status).toBe(403);
    expect((await call('/api/tasks', undefined, 'POST', { ...secret, 'x-oshal-user-sub': 'local-someoneelse01' })).status).toBe(200);
  });
});

describe('the admin reach list stays true to the mount table', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const mounts = discoverControllerRegistrars(ROOT).flatMap(extractApiMounts);
  const mountPaths = mounts.flatMap((mount) => mount.paths);

  it('lets the admin reach every operator-only mount', () => {
    const operatorPaths = mounts.filter((mount) => mount.mode === 'operator').flatMap((mount) => mount.paths);
    expect(operatorPaths.length).toBeGreaterThan(5);
    expect(operatorPaths.filter((p) => !swarmAdminMayReach(p))).toEqual([]);
  });

  it('names only real mounts', () => {
    // Routers mounted at the app root (their /api paths are declared inside the router).
    const rootMounted = new Set(['/api/local-auth']);
    const dead = SWARM_ADMIN_API_PREFIXES.filter((prefix) => !rootMounted.has(prefix)
      && !mountPaths.some((p) => p === prefix || p.startsWith(`${prefix}/`) || prefix.startsWith(`${p}/`)));
    expect(dead).toEqual([]);
  });
});

describe("the admin's own pages work under the gate", () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  // Admin-reachable pages and where their code lives.
  const PAGES: Record<string, string> = {
    '/admin': 'src/pages/admin', '/users': 'src/pages/users', '/access': 'src/pages/access', '/access-review': 'src/pages/access-review',
    '/app-loader': 'src/pages/app-loader', '/applications': 'src/pages/applications', '/config': 'src/pages/config-admin',
    '/data-model': 'src/pages/data-model', '/utilities': 'src/api/utilities.html', '/governance': 'src/pages/governance',
    '/eval-wall': 'src/pages/eval-wall', '/process-lab': 'src/pages/process-lab', '/workflow-studio': 'src/pages/workflow-studio',
    '/health-dashboard': 'src/pages/health-dashboard', '/system-health': 'src/api/system-health.html',
    '/redis-visibility': 'src/pages/redis-visibility', '/queue-dashboard': 'src/pages/queue-dashboard',
    '/queue-manager-admin': 'src/pages/queue-manager-admin', '/mesh-dashboard': 'src/pages/mesh-dashboard',
    '/ops-dashboard': 'src/pages/ops-dashboard', '/swarm-control': 'src/pages/swarm-control',
    '/alert-pipeline-admin': 'src/api/alert-pipeline-admin.html', '/rag-center': 'src/pages/rag-center',
    '/cockpit/tools/dlq.html': 'src/pages/cockpit/tools/dlq.html', '/cockpit/tools/channels.html': 'src/pages/cockpit/tools/channels.html',
    // The optimizer (Token Chase), served by its router inside the admin's /api/token-chase reach.
    '/api/token-chase/ui': 'src/api/token-chase.html',
  };
  // Personal calls on mixed pages, refused on purpose: the admin has no connections, default brain or voice of its own.
  const PERSONAL_ON_MIXED_PAGES = ['/api/connect', '/api/settings/llm-default', '/api/travel/app', '/api/voice/synthesize', '/api/send-message'];
  // Links on admin pages that the gate still bounces, matched on the path without its query or trailing slash. Each
  // stays for the reason given, and goes when its last link goes: an entry no admin page uses any more fails the test.
  const KNOWN_BOUNCED_LINKS = [
    // "Open Cockpit" and "Back to the cockpit" on pages operators also reach from the cockpit, and the app store's open
    // and focus controls. They stay until the Swarm Admin screens (ADR-174 rollout 3) give the admin its own
    // navigation; later slices remove them.
    '/cockpit',
    // RAG Center's "Open Upload Workspace" opens the chat workspace. Chat is personal: the admin has no chats (ADR-174 D1).
    '/chat',
    // The app store's "Build a swarm" opens a chat with the codex-packer bot. Chat is personal.
    '/swarmbot/chat',
    // Utilities' "Full walkthrough" connects your own free AI accounts. The admin has no AI accounts of its own (D1).
    '/free-models',
    // Utilities' "Open Slack Feed" and "Open Travel" launchers, shown only under a connected Slack or Duffel account.
    // Connections are personal and the admin has none (ADR-174 D2), so it never sees them.
    '/feeds', '/api/travel/app',
  ];
  // Where the server answers static files, longest prefix first; a miss falls through to the next match, as
  // express.static does. /shared/ui/css and /shared/ui/js: server.ts (before sign-in) and cockpit-static-routes.
  // /shared: ui-surface-routes (src/pages/shared). /cockpit and /fonts (the codicon package): cockpit-static-routes.
  // Each page directory answers at its route and, when its folder name differs, under the folder name too
  // (ui-surface-routes inferAssetAliases): src/pages/config-admin answers at /config and /config-admin.
  const STATIC_MOUNTS: Array<[string, string]> = [
    ['/shared/ui/css', 'src/shared/ui/css'], ['/shared/ui/js', 'src/shared/ui/js'], ['/shared', 'src/pages/shared'],
    ['/cockpit', 'src/pages/cockpit'], ['/fonts', 'node_modules/@vscode/codicons/dist'],
    ...Object.entries(PAGES).filter(([, target]) => !target.endsWith('.html')).flatMap(([route, dir]): Array<[string, string]> =>
      (path.posix.basename(route) === path.basename(dir) ? [[route, dir]] : [[route, dir], [`/${path.basename(dir)}`, dir]])),
  ];
  STATIC_MOUNTS.sort(([a], [b]) => b.length - a.length);
  const ORIGIN = 'http://oshal.invalid';

  function sources(target: string): string[] {
    const full = path.join(ROOT, target);
    if (fs.statSync(full).isFile()) return [full];
    return fs.readdirSync(full, { recursive: true }).map(String).filter((f) => /\.(html|js|mjs)$/.test(f)).map((f) => path.join(full, f));
  }

  /** The local file the server answers a same-origin path with, when a static mount holds one. */
  function servedFile(urlPath: string): string | undefined {
    for (const [mount, dir] of STATIC_MOUNTS) {
      if (urlPath !== mount && !urlPath.startsWith(`${mount}/`)) continue;
      const file = path.join(ROOT, dir, decodeURIComponent(urlPath.slice(mount.length)));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
    return undefined;
  }

  /** Static import and export-from specifiers, plus import('...') with a literal specifier. */
  function moduleSpecifiers(code: string): string[] {
    const source = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return [...source.matchAll(/(?:^|[;}])\s*(?:import|export)\s*(?:[\w$*{},\s]+?\s*from\s*)?(["'])([^"'\n]+)\1|\bimport\(\s*(["'])([^"'\n]+)\3\s*\)/gm)]
      .map((match) => match[2] ?? match[4]);
  }

  /** url() values and @import targets in a stylesheet. */
  function cssReferences(css: string): string[] {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...source.matchAll(/url\(\s*(["']?)([^"')\s]+)\1\s*\)|@import\s+(["'])([^"']+)\3/g)].map((match) => match[2] ?? match[4]);
  }

  /** One attribute's value from a tag's attribute text, quoted or bare. */
  function attribute(attrs: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
    return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
  }

  /** Script sources, stylesheet and preload links, images, inline module imports and inline styles of a page. */
  function htmlReferences(html: string): string[] {
    const markup = html.replace(/<!--[\s\S]*?-->/g, '');
    const refs: Array<string | undefined> = [];
    for (const [, attrs, body] of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const src = attribute(attrs, 'src');
      refs.push(...(src === undefined ? moduleSpecifiers(body) : [src]));
    }
    for (const [, attrs] of markup.matchAll(/<link\b([^>]*)>/gi)) {
      if (/\b(stylesheet|preload|modulepreload|icon)\b/i.test(attribute(attrs, 'rel') ?? '')) refs.push(attribute(attrs, 'href'));
    }
    for (const [, attrs] of markup.matchAll(/<img\b([^>]*)>/gi)) refs.push(attribute(attrs, 'src'));
    for (const [, css] of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) refs.push(...cssReferences(css));
    return refs.filter((ref): ref is string => Boolean(ref));
  }

  /**
   * Every same-origin path one admin page loads, mapped to the file that loads it. The walk starts at the page as the
   * browser gets it and follows each script, module and stylesheet the static mounts serve, resolving every specifier
   * against the URL that file is served at. Specifiers built at run time are not static and are skipped.
   */
  function loadedAssets(page: string, target: string): Map<string, string> {
    const entry = path.join(ROOT, target.endsWith('.html') ? target : path.join(target, 'index.html'));
    // A page directory's index.html answers at its route with and without the trailing slash.
    const queue = (target.endsWith('.html') ? [page] : [page, `${page}/`]).map((url) => ({ url, file: entry }));
    const loaded = new Map<string, string>();
    for (let next = queue.shift(); next; next = queue.shift()) {
      const code = fs.readFileSync(next.file, 'utf8');
      const refs = next.file.endsWith('.html') ? htmlReferences(code) : next.file.endsWith('.css') ? cssReferences(code) : moduleSpecifiers(code);
      for (const ref of refs) {
        if (ref.startsWith('#') || ref.includes('${')) continue;
        const url = new URL(ref, ORIGIN + next.url);
        if (url.origin !== ORIGIN || loaded.has(url.pathname)) continue;
        loaded.set(url.pathname, path.relative(ROOT, next.file));
        const file = servedFile(url.pathname);
        if (file && /\.(m?js|css)$/.test(file)) queue.push({ url: url.pathname, file });
      }
    }
    return loaded;
  }

  it('lets the admin page through the gate', () => {
    expect(Object.keys(PAGES).filter((page) => !swarmAdminMayReach(page))).toEqual([]);
  });

  it('reaches every API the admin pages call, except the named personal calls', () => {
    const unreachable = new Set<string>();
    for (const [page, target] of Object.entries(PAGES)) {
      for (const file of sources(target)) {
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/['"`](\/api\/[A-Za-z0-9_./-]+)/g)) {
          const api = match[1].replace(/\/+$/, '');
          const personal = PERSONAL_ON_MIXED_PAGES.some((p) => api === p || api.startsWith(`${p}/`));
          if (!personal && !swarmAdminMayReach(api, 'GET')) unreachable.add(`${api} (${page})`);
        }
      }
    }
    expect([...unreachable].sort()).toEqual([]);
  });

  it('every asset an admin page loads passes the gate', () => {
    const loaded = new Map<string, string>();
    for (const [page, target] of Object.entries(PAGES)) {
      for (const [asset, file] of loadedAssets(page, target)) if (!loaded.has(asset)) loaded.set(asset, `${page} via ${file}`);
    }
    // The walk follows the graph (through the /config-admin alias, relative imports and CSS @import), and the two
    // cockpit files the gate opens are still loaded: when no admin page loads one any more, drop its read from the gate.
    expect([...loaded.keys()]).toEqual(expect.arrayContaining([
      '/config-admin/config-admin-agent-panel.js', '/shared/ui-debug.js', '/cockpit/js/theme-manager.js', '/cockpit/css/themes/midnight.css',
    ]));
    const refused = [...loaded].filter(([asset]) => !swarmAdminMayReach(asset, 'GET')).map(([asset, from]) => `${asset} (${from})`);
    expect(refused.sort()).toEqual([]);
  });

  it('opens only the two cockpit files those pages load, and only to read them', async () => {
    for (const asset of ['/cockpit/js/theme-manager.js', '/cockpit/css/themes/midnight.css', '/cockpit/css/themes/light-blue.css']) {
      const statuses: number[] = [];
      for (const method of ['GET', 'HEAD', 'POST', 'PUT']) statuses.push((await call(asset, 'admin', method)).status);
      expect(statuses, asset).toEqual([200, 200, 403, 403]);
    }
    for (const pathname of [
      '/cockpit', '/cockpit/', '/cockpit/index.html', '/cockpit/js/app.js', '/cockpit/js/theme-manager.js.map', '/cockpit/css/base.css',
      '/cockpit/css/themes/', '/cockpit/css/themes/nested/midnight.css', '/cockpit/css/themes/%2e%2e%2findex.css', '/config-adminx',
    ]) {
      const res = await call(pathname, 'admin');
      expect([res.status, res.headers.get('location')], pathname).toEqual([302, '/admin']);
    }
  });

  it('links nothing the gate bounces', () => {
    const bounced = new Set<string>();
    const knownInUse = new Set<string>();
    for (const [page, target] of Object.entries(PAGES)) {
      for (const file of sources(target)) {
        // href="/..." and href='/...' in markup and in markup scripts build, and .href = '/...' navigations. A value
        // concatenated at run time, or interpolated before its query string, is not a static link and is skipped.
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bhref\s*=\s*(["'`])(\/(?!\/)[^"'`]*)\1(?!\s*\+)/g)) {
          const [fixed, ...interpolated] = match[2].split('${');
          if (interpolated.length > 0 && !/[?#]/.test(fixed)) continue;
          const link = new URL(fixed, ORIGIN).pathname;
          if (swarmAdminMayReach(link, 'GET') || /^\/log(?:in|out)(?:\/|$)/.test(link)) continue;
          const known = link.replace(/(.)\/+$/, '$1');
          if (KNOWN_BOUNCED_LINKS.includes(known)) knownInUse.add(known);
          else bounced.add(`${match[2]} (${page})`);
        }
      }
    }
    expect([...bounced].sort()).toEqual([]);
    expect(KNOWN_BOUNCED_LINKS.filter((link) => !knownInUse.has(link)), 'no admin page links these any more: drop them').toEqual([]);
  });
});

