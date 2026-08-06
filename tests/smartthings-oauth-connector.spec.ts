/**
 * SmartThings OAuth connector route contract.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documented the existing OAuth start/callback regression and pinned its storage-only fake pool to legacy connector crypto; default-on DEK behavior is covered by the dedicated crypto suite.
 * -----------------------------------------------------------------------------
 */

import express from 'express';
import { test, expect } from '@playwright/test';
import { createConnectorsRoutes } from '@/app/routes/connectors-routes';

type StoredConnection = {
  provider: string;
  account_email: string | null;
  account_id: string | null;
  scopes: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expiry: Date | null;
  status: string;
};

function fakePool() {
  const connections = new Map<string, StoredConnection>();

  return {
    connections,
    async query(text: string, params: unknown[] = []) {
      if (/CREATE TABLE/i.test(text) || /ALTER TABLE/i.test(text)) return { rows: [] };

      if (/SELECT provider, account_email, scopes, status, updated_at FROM oshal_connections/i.test(text)) {
        return {
          rows: Array.from(connections.values()).map((row) => ({
            provider: row.provider,
            account_email: row.account_email,
            scopes: row.scopes,
            status: row.status,
            updated_at: new Date(),
          })),
        };
      }

      if (/INSERT INTO oshal_connections/i.test(text)) {
        const [
          _userSub,
          _userEmail,
          provider,
          accountEmail,
          accountId,
          scopes,
          accessToken,
          refreshToken,
          expiry,
        ] = params as unknown[];
        connections.set(String(provider), {
          provider: String(provider),
          account_email: accountEmail == null ? null : String(accountEmail),
          account_id: accountId == null ? null : String(accountId),
          scopes: scopes == null ? null : String(scopes),
          access_token: accessToken == null ? null : String(accessToken),
          refresh_token: refreshToken == null ? null : String(refreshToken),
          expiry: expiry instanceof Date ? expiry : null,
          status: 'connected',
        });
        return { rows: [] };
      }

      return { rows: [] };
    },
  };
}

function attachMockOidc(app: express.Application) {
  app.use((req, _res, next) => {
    (req as any).oidc = {
      isAuthenticated: () => true,
      user: { sub: 'user-smartthings-001', email: 'owner@example.com' },
    };
    next();
  });
}

test.describe('SmartThings OAuth connector', () => {
  test('starts OAuth-In authorization and stores returned access and refresh tokens', async () => {
    const originalFetch = global.fetch;
    const originalEnv = {
      APP_URL: process.env.APP_URL,
      SESSION_SECRET: process.env.SESSION_SECRET,
      SMARTTHINGS_CLIENT_ID: process.env.SMARTTHINGS_CLIENT_ID,
      SMARTTHINGS_CLIENT_SECRET: process.env.SMARTTHINGS_CLIENT_SECRET,
      SMARTTHINGS_SCOPES: process.env.SMARTTHINGS_SCOPES,
      SMARTTHINGS_REDIRECT_URI: process.env.SMARTTHINGS_REDIRECT_URI,
      OSHAL_ENVELOPE_CRYPTO: process.env.OSHAL_ENVELOPE_CRYPTO,
    };
    const pool = fakePool();
    const tokenRequests: Array<{ auth: string | null; body: string }> = [];
    let server: import('http').Server | null = null;

    try {
      process.env.APP_URL = 'https://oshal.example.test';
      process.env.SESSION_SECRET = 'smartthings-oauth-test-secret';
      process.env.SMARTTHINGS_CLIENT_ID = 'st-client-id';
      process.env.SMARTTHINGS_CLIENT_SECRET = 'st-client-secret';
      process.env.SMARTTHINGS_SCOPES = 'r:devices:* x:devices:* r:locations:*';
      delete process.env.SMARTTHINGS_REDIRECT_URI;
      // This spec owns OAuth request/response behavior, while its fake pool intentionally has no
      // oshal_user_deks implementation. Keep crypto posture in the dedicated crypto/DEK suites.
      process.env.OSHAL_ENVELOPE_CRYPTO = 'false';

      global.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://api.smartthings.com/oauth/token') {
          tokenRequests.push({
            auth: init?.headers instanceof Headers
              ? init.headers.get('authorization')
              : (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
            body: String(init?.body ?? ''),
          });
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                access_token: 'st-access-token',
                refresh_token: 'st-refresh-token',
                expires_in: 86400,
                token_type: 'bearer',
              };
            },
          } as Response;
        }

        if (url === 'https://api.smartthings.com/v1/locations') {
          expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer st-access-token');
          return {
            ok: true,
            status: 200,
            async json() {
              return { items: [{ locationId: 'loc-123', name: 'Home' }] };
            },
          } as Response;
        }

        if (!originalFetch) throw new Error(`Unexpected fetch: ${url}`);
        return originalFetch(input, init);
      };

      const app = express();
      app.use(express.json());
      attachMockOidc(app);
      app.use('/api/connect', createConnectorsRoutes({ pool } as any));

      server = await new Promise<import('http').Server>((resolve) => {
        const listeningServer = app.listen(0, () => resolve(listeningServer));
      });
      const address = server.address();
      expect(address).not.toBeNull();
      const port = typeof address === 'object' && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const listResponse = await fetch(`${baseUrl}/api/connect/list`);
      expect(listResponse.ok).toBe(true);
      const listPayload = await listResponse.json() as { providers: Array<{ id: string; configured: boolean; auth: string }> };
      const smartthings = listPayload.providers.find((provider) => provider.id === 'smartthings');
      expect(smartthings).toMatchObject({ configured: true, auth: 'oauth' });

      const startResponse = await fetch(`${baseUrl}/api/connect/smartthings/start`, { redirect: 'manual' });
      expect(startResponse.status).toBe(302);
      const authLocation = startResponse.headers.get('location');
      expect(authLocation).toBeTruthy();
      const authUrl = new URL(authLocation || '');
      expect(authUrl.origin + authUrl.pathname).toBe('https://api.smartthings.com/oauth/authorize');
      expect(authUrl.searchParams.get('client_id')).toBe('st-client-id');
      expect(authUrl.searchParams.get('redirect_uri')).toBe('https://oshal.example.test/api/connect/smartthings/callback');
      const requestedScope = authUrl.searchParams.get('scope') || '';
      expect(requestedScope).toContain('r:devices:*');
      expect(requestedScope).toContain('x:devices:*');
      expect(requestedScope).toContain('r:locations:*');
      const state = authUrl.searchParams.get('state');
      expect(state).toBeTruthy();

      const callbackResponse = await fetch(
        `${baseUrl}/api/connect/smartthings/callback?state=${encodeURIComponent(state || '')}&code=auth-code-123`,
        { redirect: 'manual' },
      );
      expect(callbackResponse.status).toBe(302);
      expect(callbackResponse.headers.get('location')).toBe('/utilities?connected=smartthings');
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0].auth).toBe(`Basic ${Buffer.from('st-client-id:st-client-secret').toString('base64')}`);
      expect(tokenRequests[0].body).toContain('grant_type=authorization_code');
      expect(tokenRequests[0].body).toContain('client_id=st-client-id');
      expect(tokenRequests[0].body).not.toContain('client_secret=st-client-secret');

      const stored = pool.connections.get('smartthings');
      expect(stored).toBeDefined();
      expect(stored?.account_email).toContain('Home');
      expect(stored?.account_id).toBe('loc-123');
      expect(stored?.access_token).not.toBe('st-access-token');
      expect(stored?.refresh_token).not.toBe('st-refresh-token');
      expect(stored?.expiry).toBeInstanceOf(Date);
    } finally {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  });
});
