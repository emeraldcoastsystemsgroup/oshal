/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2b-ii guards. On an identity-provider deployment the swarm admin's local session and the provider session never mix: /login/admin discards the provider session, a provider sign-in or /logout discards the admin cookie, and a provider session wins when both arrive. Against a disposable PostgreSQL: /api/admin-auth/login admits only the swarm-admin account, its session reaches the app marked as the swarm admin, and an ordinary local session is refused on the admin-only rail.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import cookieParser from 'cookie-parser';
import express, { type RequestHandler } from 'express';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApplicationAuthMiddlewareSet } from '@/app/middleware/application-auth';
import { createLocalSessionInjector, createPasswordLoginHandler } from '@/app/routes/local-auth-routes';
import { createSwarmAdminSignInRoutes, swarmAdminSignInAvailable } from '@/app/routes/swarm-admin-sign-in-routes';
import {
  base32Decode, createSwarmAdmin, currentStep, ensureLocalUserSchema, ensureTotpSchema, hashPassword, localSubForEmail,
  totpCodeForStep,
} from '@/features/local-auth';
import type { OidcMiddlewareSet } from '@/shared/middleware/oidc';

let server: Server | undefined;
let base = '';

async function serve(app: express.Express): Promise<void> {
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function whoami(): RequestHandler {
  return (req, res) => {
    const user = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string } } }).oidc;
    res.json({ sub: user?.isAuthenticated?.() ? user.user?.sub ?? null : null });
  };
}

async function get(path: string, cookie = '') {
  const res = await fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const setCookie = res.headers.getSetCookie();
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() as { sub: string | null } : null;
  return { status: res.status, setCookie, body, location: res.headers.get('location') };
}

const cleared = (setCookie: string[], name: string) => setCookie.some((c) => c.startsWith(`${name}=;`) && /Expires=Thu, 01 Jan 1970/.test(c));

describe('the admin rail on an identity-provider deployment', () => {
  // The provider authenticates whoever carries appSession; the admin injector whoever carries the admin cookie.
  const external: OidcMiddlewareSet = {
    authMiddleware: (req, _res, next) => {
      if ((req as { cookies?: Record<string, string> }).cookies?.appSession) {
        Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: 'google-person' } } });
      }
      next();
    },
    requiresAuth: (_req, _res, next) => next(),
    loginHandler: (_req, res) => { res.json({ sub: 'provider-login' }); },
  };
  const adminInjector: RequestHandler = (req, _res, next) => {
    const already = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.();
    if (!already && (req as { cookies?: Record<string, string> }).cookies?.oshal_local === 'admin-session') {
      Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: 'local-admin' } } });
    }
    next();
  };

  async function start(adminAvailable = true) {
    const set = createApplicationAuthMiddlewareSet({} as Pool, {} as NodeJS.ProcessEnv, {
      createOidc: () => external,
      createAdminInjector: () => (adminAvailable ? adminInjector : null),
    });
    const app = express();
    app.use(cookieParser());
    app.use(set.authMiddleware);
    for (const path of ['/whoami', '/login/admin', '/login', '/login/google', '/logout']) app.get(path, whoami());
    await serve(app);
    return set;
  }

  it('opening /login/admin discards the provider session', async () => {
    await start();
    const res = await get('/login/admin', 'appSession=provider; oshal_local=admin-session');
    expect(cleared(res.setCookie, 'appSession')).toBe(true);
    expect(res.body?.sub).toBe('local-admin');
  });

  it('a provider sign-in or /logout discards the admin cookie', async () => {
    await start();
    for (const path of ['/login', '/login/google', '/logout']) {
      const res = await get(path, 'oshal_local=admin-session');
      expect(cleared(res.setCookie, 'oshal_local'), path).toBe(true);
      expect(res.body?.sub, path).not.toBe('local-admin');
    }
  });

  it('a provider session wins when both arrive, and the admin cookie alone is the admin', async () => {
    await start();
    expect((await get('/whoami', 'appSession=provider; oshal_local=admin-session')).body?.sub).toBe('google-person');
    expect((await get('/whoami', 'oshal_local=admin-session')).body?.sub).toBe('local-admin');
    expect((await get('/whoami')).body?.sub).toBeNull();
  });

  it('/logout/admin clears both sessions and returns to the admin sign-in', async () => {
    await start();
    const res = await get('/logout/admin', 'appSession=provider; oshal_local=admin-session');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login/admin');
    expect(cleared(res.setCookie, 'oshal_local')).toBe(true);
    expect(cleared(res.setCookie, 'appSession')).toBe(true);
  });

  it('leaves the provider set untouched when the admin sign-in is unavailable', async () => {
    const set = await start(false);
    expect(set.authMiddleware).toBe(external.authMiddleware);
  });

  it('is never offered under MOCK_OIDC', () => {
    expect(swarmAdminSignInAvailable({ MOCK_OIDC: 'true', SESSION_SECRET: 'placeholder-session-secret' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('the admin sign-in against a real account store', () => {
  const container = `oshal-admin-rail-${randomUUID().slice(0, 8)}`;
  const dbPassword = `fixture-${randomUUID()}`;
  const ADMIN_PASSWORD = 'placeholder-admin-password-0123456789';
  const PERSON_PASSWORD = 'placeholder-person-password-01';
  let started = false;
  let pool: Pool;

  function docker(args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
  }

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'placeholder-session-secret-0000';
    docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
      '--env', `POSTGRES_PASSWORD=${dbPassword}`, '--env', 'POSTGRES_DB=admin_rail_fixture', 'postgres:16-alpine']);
    started = true;
    const port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password: dbPassword, database: 'admin_rail_fixture', connectionTimeoutMillis: 500 });
    for (let attempt = 0; ; attempt += 1) {
      try { await pool.query('SELECT 1'); break; } catch (err) {
        if (attempt > 60) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await ensureLocalUserSchema(pool);
    await ensureTotpSchema(pool);
    await createSwarmAdmin(pool, { password: ADMIN_PASSWORD });
    await pool.query(`INSERT INTO oshal_local_users (id, email, user_sub, status, password_hash) VALUES ($1, 'person@example.test', $2, 'active', $3)`,
      [randomUUID(), localSubForEmail('person@example.test'), hashPassword(PERSON_PASSWORD)]);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (started) docker(['rm', '--force', container]);
    delete process.env.SESSION_SECRET;
  });

  async function start() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createLocalSessionInjector(pool, { onlyAccountKind: 'swarm-admin' }));
    app.use(createSwarmAdminSignInRoutes(pool));
    // A user's ordinary local login, only to obtain a real non-admin session cookie for the refusal case.
    app.post('/user-login', createPasswordLoginHandler(pool));
    app.get('/whoami', (req, res) => {
      const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string; oshal_account_kind?: string } } }).oidc;
      res.json(oidc?.isAuthenticated?.() ? { sub: oidc.user?.sub, kind: oidc.user?.oshal_account_kind } : { sub: null });
    });
    await serve(app);
  }

  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const cookie = (res.headers.getSetCookie().find((c) => c.startsWith('oshal_local=')) ?? '').split(';')[0];
    return { status: res.status, body: await res.json() as Record<string, unknown>, cookie };
  }

  it('serves the admin sign-in page', async () => {
    await start();
    const res = await fetch(`${base}/login/admin`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Swarm admin');
  });

  it("answers anyone but the swarm admin like a wrong password, even with that person's correct password", async () => {
    await start();
    const res = await post('/api/admin-auth/login', { email: 'person@example.test', password: PERSON_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.cookie).toBe('');
  });

  it('signs the admin in with password and authenticator, and the session reaches the app marked as the swarm admin', async () => {
    await start();
    const first = await post('/api/admin-auth/login', { email: 'admin', password: ADMIN_PASSWORD });
    expect(first.body).toMatchObject({ secondFactor: 'enrol' });
    const code = totpCodeForStep(base32Decode(String(first.body.secret).replace(/\s+/g, '')), currentStep());
    const signedIn = await post('/api/admin-auth/login', { email: 'admin', password: ADMIN_PASSWORD, code });
    expect(signedIn.body).toMatchObject({ ok: true });
    const me = await (await fetch(`${base}/whoami`, { headers: { cookie: signedIn.cookie } })).json();
    expect(me).toEqual({ sub: localSubForEmail('admin'), kind: 'swarm-admin' });
  });

  it("refuses an ordinary local session on the admin-only rail", async () => {
    await start();
    const user = await post('/user-login', { email: 'person@example.test', password: PERSON_PASSWORD });
    expect(user.cookie).toMatch(/^oshal_local=/);
    const me = await (await fetch(`${base}/whoami`, { headers: { cookie: user.cookie } })).json();
    expect(me).toEqual({ sub: null });
  });
});
