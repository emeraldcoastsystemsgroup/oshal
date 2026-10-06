/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2c guard: the swarm admin reaches swarm administration and is refused on every personal surface (403 for APIs, redirect to /admin for pages); prefixes match on path boundaries; ordinary users are untouched; a trusted service call acting as the admin is refused. Kept honest against the real mount table: every operator-only mount is reachable by the admin, and every admin API prefix names a real mount.
 */

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
    ['GET', '/api/logs'], ['GET', '/cockpit/tools/dlq.html'],
  ])('reaches swarm administration: %s %s', async (method, pathname) => {
    expect((await call(pathname, 'admin', method)).status).toBe(200);
  });

  it.each([
    ['GET', '/api/v1/tickets/hierarchy'], ['POST', '/api/cli-tokens'], ['GET', '/api/tasks'], ['POST', '/api/jarvis/ask'],
    ['GET', '/api/connect/google'], ['GET', '/api/calendar/events'], ['POST', '/api/tickets'], ['GET', '/api/swarm/runs'],
    ['POST', '/api/intake/fast'], ['GET', '/api/configuration-of-something-else'],
  ])('is refused on a personal API: %s %s', async (method, pathname) => {
    const res = await call(pathname, 'admin', method);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'swarm_admin_not_a_user' });
  });

  it.each(['/', '/cockpit/', '/haven', '/adminx'])('is sent to the admin console from the personal page %s', async (pathname) => {
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
