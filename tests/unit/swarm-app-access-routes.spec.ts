/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: real Express proof that the framework-owned access matrix and assignment API are operator-only, validate app declarations/tiers, and support restoring defaults.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { AppAccessService, SwarmAppService } from '../../src/features/swarm-apps';
import { createSwarmAppRoutes } from '../../src/app/routes/swarm-app-routes';

const APP_RECORD = {
  name: 'test-access',
  displayName: 'Test Access',
  status: 'active',
  manifest: {
    name: 'test-access',
    displayName: 'Test Access',
    access: { supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier: 'viewer' },
  },
};

async function boot(overrides: { app?: typeof APP_RECORD | null } = {}): Promise<{
  server: Server;
  base: string;
  assign: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}> {
  const appRecord = overrides.app === undefined ? APP_RECORD : overrides.app;
  const service = {
    listApps: vi.fn().mockResolvedValue(appRecord ? [{ name: appRecord.name }] : []),
    getApp: vi.fn().mockResolvedValue(appRecord),
    loadApp: vi.fn(),
  } as unknown as SwarmAppService;
  const assign = vi.fn().mockImplementation(async (input) => ({
    ...input, createdAt: new Date('2026-08-05T12:00:00Z'), updatedAt: new Date('2026-08-05T12:00:00Z'),
  }));
  const clear = vi.fn().mockResolvedValue(true);
  const appAccess = {
    listAssignments: vi.fn().mockResolvedValue([]),
    assign,
    clear,
  } as unknown as AppAccessService;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.header('x-test-sub') || '';
    (req as typeof req & { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use('/api/swarm/apps', createSwarmAppRoutes(service, appAccess));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, assign, clear };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function request(base: string, sub: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { 'x-test-sub': sub, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('swarm app access management routes', () => {
  afterEach(() => { delete process.env.OSHAL_OPERATOR_SUBS; });

  it('keeps the matrix and assignments operator-only', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'operator-sub';
    const { server, base } = await boot();
    try {
      expect((await request(base, 'ordinary-user', '/api/swarm/apps/access-matrix')).status).toBe(403);
      const matrix = await request(base, 'operator-sub', '/api/swarm/apps/access-matrix');
      expect(matrix.status).toBe(200);
      await expect(matrix.json()).resolves.toMatchObject({
        tiers: ['deny', 'viewer', 'editor', 'admin'],
        apps: [{ name: 'test-access', access: { defaultTier: 'viewer' } }],
      });
    } finally {
      await stop(server);
    }
  });

  it('assigns only a tier the current manifest supports', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'operator-sub';
    const { server, base, assign } = await boot();
    try {
      const accepted = await request(base, 'operator-sub', '/api/swarm/apps/test-access/access', {
        userSub: 'Exact-User', tier: 'editor', reason: 'Content operator',
      });
      expect(accepted.status).toBe(200);
      expect(assign).toHaveBeenCalledWith({
        userSub: 'Exact-User', appName: 'test-access', tier: 'editor', assignedBySub: 'operator-sub', reason: 'Content operator',
      });

      const rejected = await request(base, 'operator-sub', '/api/swarm/apps/test-access/access', {
        userSub: 'Exact-User', tier: 'owner', reason: 'Bad vocabulary',
      });
      expect(rejected.status).toBe(400);
      expect(assign).toHaveBeenCalledTimes(1);
    } finally {
      await stop(server);
    }
  });

  it('clears an explicit assignment to restore the manifest default', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'operator-sub';
    const { server, base, clear } = await boot();
    try {
      const response = await request(base, 'operator-sub', '/api/swarm/apps/test-access/access', {
        userSub: 'Exact-User', tier: null, reason: 'Temporary assignment ended',
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ cleared: true, effectiveTier: 'viewer' });
      expect(clear).toHaveBeenCalledWith({
        userSub: 'Exact-User', appName: 'test-access', assignedBySub: 'operator-sub', reason: 'Temporary assignment ended',
      });
    } finally {
      await stop(server);
    }
  });

  it('refuses assignments for a legacy app whose behavior is intentionally unchanged', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'operator-sub';
    const legacy = { ...APP_RECORD, manifest: { name: 'test-access', displayName: 'Test Access' } } as typeof APP_RECORD;
    const { server, base, assign } = await boot({ app: legacy });
    try {
      const response = await request(base, 'operator-sub', '/api/swarm/apps/test-access/access', {
        userSub: 'Exact-User', tier: 'deny', reason: 'Would only look enforced',
      });
      expect(response.status).toBe(409);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      await stop(server);
    }
  });
});
