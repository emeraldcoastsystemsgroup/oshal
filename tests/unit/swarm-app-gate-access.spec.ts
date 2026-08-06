/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: prove the global app gate enforces tiers on hard-mounted kernel routes while preserving inactive precedence, legacy manifests, and anonymous guest-matrix ownership.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { AppAccessResolver, ResolvedAppAccess, SwarmAppService } from '../../src/features/swarm-apps';
import { createSwarmAppGateMiddleware } from '../../src/app/middleware/swarm-app-gate-middleware';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';

const ACCESS = { supported: ['deny', 'viewer', 'editor', 'admin'] as const, defaultTier: 'viewer' as const };

async function boot(input: {
  owner: ReturnType<SwarmAppService['ownerOf']>;
  decision?: ResolvedAppAccess;
  subject?: string;
}): Promise<{ server: Server; base: string; resolve: ReturnType<typeof vi.fn> }> {
  const ownerOf = vi.fn().mockReturnValue(input.owner);
  const service = { ownerOf } as unknown as SwarmAppService;
  const resolve = vi.fn().mockResolvedValue(input.decision);
  const resolver = { resolve } as unknown as AppAccessResolver;
  const app = express();
  if (input.subject) {
    app.use((_req, _res, next) => runWithRequestIdentity(
      { sub: input.subject!, isOperator: false }, () => next(),
    ));
  }
  app.use(createSwarmAppGateMiddleware(service, resolver));
  app.all('/api/kernel/*rest', (req, res) => res.json({ reached: true, method: req.method }));
  const server = createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, resolve };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('hard-mounted kernel app access gate', () => {
  afterEach(() => { delete process.env.OSHAL_APP_ACCESS_MODE; });

  it('blocks a signed-in explicitly denied user on the hard-mounted route', async () => {
    const { server, base } = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
      subject: 'user-a',
      decision: { appName: 'kernel-app', userSub: 'user-a', tier: 'deny', bundle: null, source: 'explicit' },
    });
    try {
      const response = await fetch(`${base}/api/kernel/read`);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'app_access_denied', app: 'kernel-app' });
    } finally { await stop(server); }
  });

  it('applies viewer method lockdown before the hard-mounted handler', async () => {
    const { server, base } = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
      subject: 'user-a',
      decision: { appName: 'kernel-app', userSub: 'user-a', tier: 'viewer', bundle: null, source: 'explicit' },
    });
    try {
      expect((await fetch(`${base}/api/kernel/read`)).status).toBe(200);
      const write = await fetch(`${base}/api/kernel/write`, { method: 'POST' });
      expect(write.status).toBe(403);
      await expect(write.json()).resolves.toMatchObject({ error: 'app_readonly' });
    } finally { await stop(server); }
  });

  it('keeps legacy manifests and truly anonymous callers under their existing policies', async () => {
    const legacy = await boot({ owner: { appName: 'kernel-app', status: 'active' }, subject: 'user-a' });
    try {
      expect((await fetch(`${legacy.base}/api/kernel/write`, { method: 'POST' })).status).toBe(200);
      expect(legacy.resolve).not.toHaveBeenCalled();
    } finally { await stop(legacy.server); }

    const anonymous = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
    });
    try {
      expect((await fetch(`${anonymous.base}/api/kernel/write`, { method: 'POST' })).status).toBe(200);
      expect(anonymous.resolve).not.toHaveBeenCalled();
    } finally { await stop(anonymous.server); }
  });

  it('keeps inactive-app 503 precedence and never resolves an assignment', async () => {
    const { server, base, resolve } = await boot({
      owner: { appName: 'kernel-app', status: 'inactive', access: { ...ACCESS, supported: [...ACCESS.supported] } },
      subject: 'user-a',
    });
    try {
      expect((await fetch(`${base}/api/kernel/read`)).status).toBe(503);
      expect(resolve).not.toHaveBeenCalled();
    } finally { await stop(server); }
  });
});
