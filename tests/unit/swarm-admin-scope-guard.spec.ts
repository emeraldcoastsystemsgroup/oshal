/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2c guard: the swarm admin reaches swarm administration and is refused on every personal surface (403 for APIs, redirect to /admin for pages); prefixes match on path boundaries; ordinary users are untouched; a trusted service call acting as the admin is refused. Kept honest against the real mount table: every operator-only mount is reachable by the admin, and every admin API prefix names a real mount.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The admin's own pages must work: every API an admin-reachable page calls is reachable by the admin, unless it is a named personal call on a mixed page (refused on purpose). The dashboards' GET-only reads are allowed while the same routers' writes stay refused, and /cockpit/tools narrows to the dead-letter and chat-channel tools.
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
    ['POST', '/api/swarm/apps/import'], ['GET', '/api/tenants/home-1/members'], ['POST', '/api/connectors/github/enable'],
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
  };
  // Personal calls on mixed pages, refused on purpose: the admin has no connections, default brain or voice of its own.
  const PERSONAL_ON_MIXED_PAGES = ['/api/connect', '/api/settings/llm-default', '/api/travel/app', '/api/voice/synthesize', '/api/send-message'];

  function sources(target: string): string[] {
    const full = path.join(ROOT, target);
    if (fs.statSync(full).isFile()) return [full];
    return fs.readdirSync(full, { recursive: true }).map(String).filter((f) => /\.(html|js|mjs)$/.test(f)).map((f) => path.join(full, f));
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
});

