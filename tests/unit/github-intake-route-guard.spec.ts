/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proved private GitHub pull and reconciliation routes are operator-only
 */

import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntakeRoutes } from '@/app/extensions/swarm/routes/intake-routes';
import { createSwarmOrchestrationRoutes } from '@/app/extensions/swarm/routes/swarm-orchestration-routes';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GitHub intake route authorization', () => {
  it('denies private GitHub reads to ordinary users while preserving generic provider pull', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-sub');
    const pullProvider = vi.fn((_req, res) => res.status(200).json({ ok: true }));
    const reconcileProvider = vi.fn((_req, res) => res.status(200).json({ ok: true }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { oidc: { user: { sub: string } } }).oidc = {
        user: { sub: String(req.headers['x-test-sub'] ?? '') },
      };
      next();
    });
    app.use(createIntakeRoutes({
      listProviders: vi.fn(),
      pullProvider,
      reconcileProvider,
    } as never));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const denied = await fetch(`http://127.0.0.1:${port}/providers/github/reconcile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-sub': 'ordinary-user' },
        body: '{}',
      });
      const allowed = await fetch(`http://127.0.0.1:${port}/providers/github/reconcile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-sub': 'operator-sub' },
        body: '{}',
      });
      const plane = await fetch(`http://127.0.0.1:${port}/providers/plane/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-sub': 'ordinary-user' },
        body: '{}',
      });

      expect(denied.status).toBe(403);
      expect(allowed.status).toBe(200);
      expect(reconcileProvider).toHaveBeenCalledTimes(1);
      expect(plane.status).toBe(200);
      expect(pullProvider).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });

  it('denies the GitHub process shortcut to ordinary authenticated users', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-sub');
    const processProvider = vi.fn((_req, res) => res.status(200).json({ ok: true }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { oidc: { user: { sub: string } } }).oidc = {
        user: { sub: String(req.headers['x-test-sub'] ?? '') },
      };
      next();
    });
    app.use(createSwarmOrchestrationRoutes({
      smokeTest: vi.fn(),
      processProvider,
      listRuns: vi.fn(),
      getRun: vi.fn(),
      listWorkItems: vi.fn(),
      listEscalations: vi.fn(),
      submitTickets: vi.fn(),
    } as never));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const denied = await fetch(`http://127.0.0.1:${port}/providers/github/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-sub': 'ordinary-user' },
        body: '{}',
      });
      const plane = await fetch(`http://127.0.0.1:${port}/providers/plane/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-sub': 'ordinary-user' },
        body: '{}',
      });

      expect(denied.status).toBe(403);
      expect(plane.status).toBe(200);
      expect(processProvider).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });
});
