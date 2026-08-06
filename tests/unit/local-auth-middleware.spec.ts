/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the LOCAL_AUTH middleware set (ADR-117): fail-closed construction (MOCK_OIDC conflict / missing secret both throw at boot instead of degrading to open auth), the cookie injector resolving a live session into the standard req.oidc shape, revocation via token_version, and requiresAuth's API-401 vs browser-redirect split.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove a verified local session carries the stable local-auth issuer required by derived credentials and issuer-bound applications.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { bustLocalUserSnapshot, createLocalAuthMiddlewareSet } from '@/app/routes/local-auth-routes';
import { mintLocalSession } from '@/features/local-auth';

const ENV_KEYS = ['SESSION_SECRET', 'MOCK_OIDC', 'LOCAL_AUTH'];
let saved: Record<string, string | undefined>;

const USER = { user_sub: 'local-1234567890abcdef', email: 'someone@example.com', display_name: 'Someone', status: 'active', token_version: 1 };

function snapshotPool(row: typeof USER | null) {
  return {
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (sql.includes('SELECT status, token_version')) return { rows: row ? [row] : [] };
      return { rows: [] }; // schema bootstrap probes etc.
    },
  };
}

let server: Server | undefined;
let base = '';

function startApp(pool: unknown): Promise<void> {
  const set = createLocalAuthMiddlewareSet(pool as never);
  const app = express();
  app.use(cookieParser());
  app.use(set.authMiddleware);
  app.get('/whoami', (req, res) => {
    const oidc = (req as {
      oidc?: { isAuthenticated?: () => boolean; user?: { iss?: string; sub: string } };
    }).oidc;
    res.json({
      authenticated: !!oidc?.isAuthenticated?.(),
      issuer: oidc?.user?.iss ?? null,
      sub: oidc?.user?.sub ?? null,
    });
  });
  app.get('/api/private', set.requiresAuth, (_req, res) => res.json({ ok: true }));
  app.get('/private-page', set.requiresAuth, (_req, res) => res.type('html').send('<b>secret</b>'));
  app.get('/login', set.loginHandler);
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      resolve();
    });
  });
}

function sessionCookieFor(tokenVersion = 1): string {
  const minted = mintLocalSession({
    userSub: USER.user_sub, email: USER.email, displayName: USER.display_name, tokenVersion,
  });
  return `oshal_local=${minted!.value}`;
}

beforeAll(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SESSION_SECRET = 'example-session-secret-0000';
  delete process.env.MOCK_OIDC;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(() => {
  bustLocalUserSnapshot();
  return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe('createLocalAuthMiddlewareSet — fail-closed construction', () => {
  it('refuses to construct with MOCK_OIDC also enabled', () => {
    process.env.MOCK_OIDC = 'true';
    expect(() => createLocalAuthMiddlewareSet(snapshotPool(USER) as never)).toThrow(/MOCK_OIDC/);
    delete process.env.MOCK_OIDC;
  });

  it('refuses to construct without a session-signing secret', () => {
    const prior = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    expect(() => createLocalAuthMiddlewareSet(snapshotPool(USER) as never)).toThrow(/SESSION_SECRET/);
    process.env.SESSION_SECRET = prior;
  });
});

describe('local-auth session injector', () => {
  it('authenticates a live cookie into the standard req.oidc shape', async () => {
    await startApp(snapshotPool(USER));
    const anonymous = await (await fetch(`${base}/whoami`)).json();
    expect(anonymous).toEqual({ authenticated: false, issuer: null, sub: null });

    const authed = await (await fetch(`${base}/whoami`, { headers: { Cookie: sessionCookieFor(1) } })).json();
    expect(authed).toEqual({
      authenticated: true,
      issuer: 'urn:oshal:local-auth',
      sub: USER.user_sub,
    });
  });

  it('ends the session when token_version moves (password change / disable revocation)', async () => {
    await startApp(snapshotPool({ ...USER, token_version: 2 }));
    const stale = await (await fetch(`${base}/whoami`, { headers: { Cookie: sessionCookieFor(1) } })).json();
    expect(stale.authenticated).toBe(false);
  });

  it('ignores a cookie for an account the store no longer has', async () => {
    await startApp(snapshotPool(null));
    const ghost = await (await fetch(`${base}/whoami`, { headers: { Cookie: sessionCookieFor(1) } })).json();
    expect(ghost.authenticated).toBe(false);
  });
});

describe('local-auth requiresAuth', () => {
  it('answers unauthenticated API requests 401 JSON and browser documents with a /login redirect', async () => {
    await startApp(snapshotPool(USER));
    const api = await fetch(`${base}/api/private`);
    expect(api.status).toBe(401);
    expect((await api.json()).loginPath).toBe('/login');

    const doc = await fetch(`${base}/private-page`, { redirect: 'manual', headers: { Accept: 'text/html' } });
    expect(doc.status).toBe(302);
    expect(doc.headers.get('location')).toBe(`/login?returnTo=${encodeURIComponent('/private-page')}`);

    const authed = await fetch(`${base}/api/private`, { headers: { Cookie: sessionCookieFor(1) } });
    expect(authed.status).toBe(200);
  });

  it('serves the credential page at /login and bounces an authenticated visitor home', async () => {
    await startApp(snapshotPool(USER));
    const page = await fetch(`${base}/login`, { headers: { Accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Sign in');

    const bounced = await fetch(`${base}/login?returnTo=/cockpit/`, {
      redirect: 'manual', headers: { Cookie: sessionCookieFor(1), Accept: 'text/html' },
    });
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get('location')).toBe('/cockpit/');
  });
});
