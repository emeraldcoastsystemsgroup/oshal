/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Guard gated mock identity overrides and the stable mock issuer namespace delegated to issuer-bound applications
 * -----------------------------------------------------------------------------
 */

import express, { type Request, type Response } from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOidcMiddleware, isMockOidcHeaderOverrideEnabled } from '../../src/shared/middleware/oidc';

const ENV_KEYS = [
  'MOCK_OIDC',
  'MOCK_OIDC_ALLOW_HEADER',
  'MOCK_OIDC_SUB',
  'MOCK_OIDC_EMAIL',
  'MOCK_OIDC_NAME',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('MOCK_OIDC header identity override', () => {
  it('ignores x-mock-oidc-* headers unless the override gate is enabled', async () => {
    process.env.MOCK_OIDC = 'true';
    process.env.MOCK_OIDC_SUB = 'default-mock-user';
    process.env.MOCK_OIDC_EMAIL = 'default@example.test';

    const server = await startWhoamiServer();
    try {
      const res = await fetch(`${server.baseUrl}/whoami`, {
        headers: {
          'x-mock-oidc-sub': 'auth0|user-a',
          'x-mock-oidc-email': 'a@example.test',
        },
      });
      const user = await res.json() as { iss: string; sub: string; email: string };

      expect(isMockOidcHeaderOverrideEnabled()).toBe(false);
      expect(res.status).toBe(200);
      expect(user.sub).toBe('default-mock-user');
      expect(user.email).toBe('default@example.test');
      expect(user.iss).toBe('urn:oshal:mock-oidc');
    } finally {
      await server.close();
    }
  });

  it('uses x-mock-oidc-* headers when MOCK_OIDC_ALLOW_HEADER is enabled', async () => {
    process.env.MOCK_OIDC = 'true';
    process.env.MOCK_OIDC_ALLOW_HEADER = 'true';
    process.env.MOCK_OIDC_SUB = 'default-mock-user';
    process.env.MOCK_OIDC_EMAIL = 'default@example.test';

    const server = await startWhoamiServer();
    try {
      const res = await fetch(`${server.baseUrl}/whoami`, {
        headers: {
          'x-mock-oidc-sub': 'auth0|user-b',
          'x-mock-oidc-email': 'b@example.test',
          'x-mock-oidc-name': 'User B',
        },
      });
      const user = await res.json() as { iss: string; sub: string; email: string; name: string };

      expect(isMockOidcHeaderOverrideEnabled()).toBe(true);
      expect(res.status).toBe(200);
      expect(user.sub).toBe('auth0|user-b');
      expect(user.email).toBe('b@example.test');
      expect(user.name).toBe('User B');
      expect(user.iss).toBe('urn:oshal:mock-oidc');
    } finally {
      await server.close();
    }
  });
});

async function startWhoamiServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  const { authMiddleware, requiresAuth } = createOidcMiddleware();
  app.use(authMiddleware);
  app.get('/whoami', requiresAuth, (req: Request, res: Response) => {
    res.json((req as { oidc?: { user?: unknown } }).oidc?.user ?? null);
  });

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('mock OIDC test server did not bind to a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
