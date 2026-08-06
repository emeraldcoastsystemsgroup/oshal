/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | End-to-end guard that TV pairing delegates and restores the approving session's verified issuer namespace
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'http';
import {
  createTvPairingRoutes,
  createTvTokenAuthMiddleware,
} from '@/app/routes/tv-pairing-routes';

const TEST_ISSUER = 'https://issuer.example.test/realms/families';
const TEST_SUB = 'tv-owner-subject';
const SAVED_SESSION_SECRET = process.env.SESSION_SECRET;
let server: Server | undefined;

afterEach(async () => {
  if (SAVED_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = SAVED_SESSION_SECRET;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function requiresAuth(req: Request, res: Response, next: NextFunction): void {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
  if (oidc?.isAuthenticated?.()) next();
  else res.status(401).json({ error: 'unauthorized' });
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header('x-test-session') === 'true') {
      (req as { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { iss: TEST_ISSUER, sub: TEST_SUB, email: 'family@example.test' },
      };
    }
    next();
  });
  app.use(createTvTokenAuthMiddleware());
  app.use(createTvPairingRoutes(requiresAuth));
  app.get('/whoami', requiresAuth, (req, res) => {
    res.json((req as { oidc?: { user?: unknown } }).oidc?.user ?? null);
  });
  return app;
}

async function startApp(): Promise<string> {
  server = await new Promise<Server>((resolve) => {
    const listening = buildApp().listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TV issuer spec did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function pair(base: string): Promise<string> {
  const started = await fetch(`${base}/api/tv/pair/start`, { method: 'POST' });
  const codes = await started.json() as { user_code: string; device_code: string };
  const approved = await fetch(`${base}/api/tv/pair/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-session': 'true' },
    body: JSON.stringify({ user_code: codes.user_code }),
  });
  expect(approved.status).toBe(200);
  const polled = await fetch(`${base}/api/tv/pair/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: codes.device_code }),
  });
  return ((await polled.json()) as { token: string }).token;
}

describe('TV principal issuer delegation', () => {
  it('restores the exact issuer and subject signed at approval', async () => {
    process.env.SESSION_SECRET = 'tv-principal-issuer-spec-secret';
    const base = await startApp();
    const token = await pair(base);
    const response = await fetch(`${base}/whoami`, {
      headers: { 'x-oshal-tv-token': token },
    });
    const user = await response.json() as { iss: string; sub: string };
    expect(response.status).toBe(200);
    expect(user).toMatchObject({ iss: TEST_ISSUER, sub: TEST_SUB });
  });
});
