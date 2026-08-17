/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the CRM Entra/local pilot composition: flag-off behavior is the historical wholesale mode, hybrid construction selects Microsoft secondary-shaped OIDC, bare /login remains the combined invited-user page, middleware ordering maps external identity before local fallback, explicit door switches clear sibling cookies, and logout cannot resurrect the other session.
 */

import cookieParser from 'cookie-parser';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApplicationAuthMiddlewareSet,
  type ApplicationAuthDependencies,
} from '@/app/middleware/application-auth';
import type { OidcMiddlewareSet } from '@/shared/middleware/oidc';

const BASE_ENV = {
  LOCAL_AUTH: 'true',
  MOCK_OIDC: 'false',
  MICROSOFT_LOGIN: 'true',
  MICROSOFT_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  MICROSOFT_OIDC_CLIENT_ID: 'client',
  MICROSOFT_OIDC_CLIENT_SECRET: 'secret',
  ENTRA_LOCAL_AUTH_HYBRID: 'true',
  ENTRA_LOCAL_IDENTITY_EMAILS: 'pilot@example.com',
} as NodeJS.ProcessEnv;

function setOf(
  label: string,
  events: string[],
  auth?: RequestHandler,
  login?: RequestHandler,
  guard?: RequestHandler,
): OidcMiddlewareSet {
  return {
    authMiddleware: auth ?? ((_req, _res, next) => { events.push(`${label}:auth`); next(); }),
    requiresAuth: guard ?? ((_req, _res, next) => { events.push(`${label}:requires`); next(); }),
    loginHandler: login ?? ((_req, res) => { events.push(`${label}:login`); res.status(200).send(label); }),
  };
}

function hybridHarness(events: string[]): {
  set: ReturnType<typeof createApplicationAuthMiddlewareSet>;
  oidcOptions: unknown[];
} {
  const oidcOptions: unknown[] = [];
  const external = setOf('external', events, (req, res, next) => {
    events.push('external:auth');
    if (req.path === '/logout') {
      events.push('external:logout');
      res.redirect(302, '/');
      return;
    }
    const authenticated = Boolean((req as any).cookies?.appSession_microsoft);
    (req as any).oidc = {
      isAuthenticated: () => authenticated,
      ...(authenticated ? { user: { sub: 'entra-user' } } : {}),
    };
    next();
  });
  const local = setOf(
    'local',
    events,
    (req, _res, next) => {
      events.push('local:auth');
      if ((req as any).oidc?.isAuthenticated?.()) return next();
      if ((req as any).cookies?.oshal_local) {
        (req as any).oidc = { isAuthenticated: () => true, user: { sub: 'local-user' } };
      }
      next();
    },
    (req, res) => {
      events.push('local:login');
      if ((req as any).oidc?.isAuthenticated?.()) {
        res.redirect(302, typeof req.query.returnTo === 'string' ? req.query.returnTo : '/');
        return;
      }
      res.status(200).send('local');
    },
    (req, res, next) => {
      events.push('local:requires');
      if ((req as any).oidc?.isAuthenticated?.()) return next();
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ authenticated: false, error: 'unauthorized', loginPath: '/login' });
        return;
      }
      res.redirect(302, `/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    },
  );
  const dependencies: ApplicationAuthDependencies = {
    createOidc: (options) => { oidcOptions.push(options); return external; },
    createLocal: () => local,
    createBridge: () => (req, _res, next) => {
      events.push('bridge');
      if ((req as any).oidc?.isAuthenticated?.() && (req as any).oidc?.user?.sub === 'entra-user') {
        (req as any).oidc.user.sub = 'canonical-from-entra';
      }
      next();
    },
  };
  return {
    set: createApplicationAuthMiddlewareSet({} as never, { ...BASE_ENV }, dependencies),
    oidcOptions,
  };
}

function appFor(set: ReturnType<typeof createApplicationAuthMiddlewareSet>) {
  const app = express();
  app.use(cookieParser());
  app.use(set.authMiddleware);
  app.get('/login', set.loginHandler);
  if (set.localLoginHandler) app.get('/login/local', set.localLoginHandler);
  if (set.microsoftLoginHandler) app.get('/login/microsoft', set.microsoftLoginHandler);
  app.get('/protected', (_req, res) => res.status(200).send('ok'));
  app.get('/principal', (req, res) => res.json({ sub: (req as any).oidc?.user?.sub ?? null }));
  app.get('/guarded', set.requiresAuth, (_req, res) => res.status(200).send('guarded'));
  app.get('/api/guarded', set.requiresAuth, (_req, res) => res.status(200).send('guarded-api'));
  return app;
}

async function callApp(
  set: ReturnType<typeof createApplicationAuthMiddlewareSet>,
  pathname: string,
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; location: string | null; setCookie: string }> {
  const server = appFor(set).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      redirect: 'manual',
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    return {
      status: response.status,
      body: await response.text(),
      location: response.headers.get('location'),
      setCookie: response.headers.get('set-cookie') ?? '',
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

afterEach(() => {
  delete process.env.SESSION_COOKIE_DOMAIN;
});

describe('createApplicationAuthMiddlewareSet', () => {
  it('preserves wholesale LOCAL_AUTH selection when the hybrid flag is off', () => {
    const events: string[] = [];
    const local = setOf('local', events);
    const external = setOf('external', events);
    const selected = createApplicationAuthMiddlewareSet({} as never, { LOCAL_AUTH: 'true' }, {
      createLocal: () => local,
      createOidc: () => external,
    });
    expect(selected).toBe(local);
    expect(selected.localLoginHandler).toBeUndefined();
  });

  it('preserves wholesale OIDC selection when local, bridge, and hybrid are off', () => {
    const events: string[] = [];
    const external = setOf('external', events);
    const selected = createApplicationAuthMiddlewareSet({} as never, { LOCAL_AUTH: 'false' }, {
      createLocal: () => { throw new Error('local must not construct'); },
      createOidc: () => external,
    });
    expect(selected).toBe(external);
  });

  it('never leaves the standalone identity-bridge flag inert during full OIDC cutover', async () => {
    const events: string[] = [];
    const external = setOf('external', events);
    const selected = createApplicationAuthMiddlewareSet({} as never, {
      LOCAL_AUTH: 'false',
      MOCK_OIDC: 'false',
      ENTRA_LOCAL_IDENTITY_BRIDGE: 'true',
      MICROSOFT_TENANT_ID: BASE_ENV.MICROSOFT_TENANT_ID,
      ENTRA_LOCAL_IDENTITY_EMAILS: BASE_ENV.ENTRA_LOCAL_IDENTITY_EMAILS,
    }, {
      createLocal: () => { throw new Error('local must not construct'); },
      createOidc: () => external,
      createBridge: () => (_req, _res, next) => { events.push('bridge'); next(); },
    });
    const response = await callApp(selected, '/protected');
    expect(response).toMatchObject({ status: 200, body: 'ok' });
    expect(events).toEqual(['external:auth', 'bridge']);
    expect(selected.localLoginHandler).toBeUndefined();
  });

  it('fails closed unless hybrid keeps real Microsoft and LOCAL_AUTH enabled', () => {
    const never = () => { throw new Error('factory must not run'); };
    const deps = { createLocal: never as never, createOidc: never as never, createBridge: never as never };
    expect(() => createApplicationAuthMiddlewareSet({} as never, {
      ...BASE_ENV, LOCAL_AUTH: 'false',
    }, deps)).toThrow(/LOCAL_AUTH=true/);
    expect(() => createApplicationAuthMiddlewareSet({} as never, {
      ...BASE_ENV, MOCK_OIDC: 'true',
    }, deps)).toThrow(/MOCK_OIDC/);
    expect(() => createApplicationAuthMiddlewareSet({} as never, {
      ...BASE_ENV, MICROSOFT_LOGIN: 'false',
    }, deps)).toThrow(/MICROSOFT_LOGIN=true/);
  });

  it('constructs exactly the Microsoft secondary-shaped OIDC set and exposes both explicit doors', () => {
    const events: string[] = [];
    const { set, oidcOptions } = hybridHarness(events);
    expect(oidcOptions).toEqual([{ providerMode: 'microsoft-secondary-only' }]);
    expect(set.localLoginHandler).toBeTypeOf('function');
    expect(set.microsoftLoginHandler).toBeTypeOf('function');
    expect(set.microsoftLoginEnabled).toBe(true);
  });

  it('runs external validation, canonical bridge, then local fallback on ordinary requests', async () => {
    const events: string[] = [];
    const { set } = hybridHarness(events);
    const response = await callApp(set, '/protected');
    expect(response).toMatchObject({ status: 200, body: 'ok' });
    expect(events).toEqual(['external:auth', 'bridge', 'local:auth']);
  });

  it('uses local fallback for a local-only cookie but never lets it override a bridged external session', async () => {
    const localEvents: string[] = [];
    const { set: localSet } = hybridHarness(localEvents);
    const local = await callApp(localSet, '/principal', 'oshal_local=local-session');
    expect(JSON.parse(local.body)).toEqual({ sub: 'local-user' });
    expect(localEvents).toEqual(['external:auth', 'bridge', 'local:auth']);

    const bothEvents: string[] = [];
    const { set: bothSet } = hybridHarness(bothEvents);
    const both = await callApp(
      bothSet,
      '/principal',
      'appSession_microsoft=external-session; oshal_local=local-session',
    );
    expect(JSON.parse(both.body)).toEqual({ sub: 'canonical-from-entra' });
    expect(bothEvents).toEqual(['external:auth', 'bridge', 'local:auth']);
  });

  it('guards routes through the combined login instead of auto-starting Microsoft', async () => {
    const anonymousEvents: string[] = [];
    const { set: anonymousSet } = hybridHarness(anonymousEvents);
    const document = await callApp(anonymousSet, '/guarded', undefined, { Accept: 'text/html' });
    expect(document.status).toBe(302);
    expect(document.location).toBe(`/login?returnTo=${encodeURIComponent('/guarded')}`);
    expect(anonymousEvents).toEqual(['external:auth', 'bridge', 'local:auth', 'local:requires']);

    const apiEvents: string[] = [];
    const { set: apiSet } = hybridHarness(apiEvents);
    const api = await callApp(apiSet, '/api/guarded', undefined, { Accept: 'application/json' });
    expect(api.status).toBe(401);
    expect(JSON.parse(api.body)).toEqual({ authenticated: false, error: 'unauthorized', loginPath: '/login' });
    expect(apiEvents).toEqual(['external:auth', 'bridge', 'local:auth', 'local:requires']);

    for (const cookie of ['oshal_local=local-session', 'appSession_microsoft=external-session']) {
      const authenticatedEvents: string[] = [];
      const { set } = hybridHarness(authenticatedEvents);
      const response = await callApp(set, '/guarded', cookie, { Accept: 'text/html' });
      expect(response).toMatchObject({ status: 200, body: 'guarded' });
      expect(authenticatedEvents).toEqual(['external:auth', 'bridge', 'local:auth', 'local:requires']);
    }
  });

  it('keeps unauthenticated /login on the invited-user page without expiring local state', async () => {
    const events: string[] = [];
    const { set } = hybridHarness(events);
    const response = await callApp(set, '/login?returnTo=%2Fcockpit%2F%3Fapp%3Dintelligent-sales');
    expect(response).toMatchObject({ status: 200, body: 'local' });
    expect(events).toEqual(['external:auth', 'bridge', 'local:auth', 'local:login']);
    expect(response.setCookie).not.toMatch(/oshal_local=;/);
  });

  it('maps an existing external session on /login and preserves the deep-link redirect', async () => {
    const events: string[] = [];
    const { set } = hybridHarness(events);
    const response = await callApp(
      set,
      '/login?returnTo=%2Fcockpit%2F%3Fapp%3Dintelligent-sales',
      'appSession_microsoft=external',
    );
    expect(response.status).toBe(302);
    expect(response.location).toBe('/cockpit/?app=intelligent-sales');
    expect(events).toEqual(['external:auth', 'bridge', 'local:auth', 'local:login']);
  });

  it('starts Microsoft only at /login/microsoft and expires a sibling local session', async () => {
    const events: string[] = [];
    const { set } = hybridHarness(events);
    const response = await callApp(
      set,
      '/login/microsoft?returnTo=%2Fcockpit%2F%3Fapp%3Dintelligent-sales',
      'oshal_local=legacy',
    );
    expect(response).toMatchObject({ status: 200, body: 'external' });
    expect(events).toEqual(['external:auth', 'external:login']);
    expect(response.setCookie).toMatch(/oshal_local=;/);
  });

  it('makes /login/local reachable by clearing and bypassing an external session', async () => {
    const events: string[] = [];
    const { set } = hybridHarness(events);
    const response = await callApp(set, '/login/local', 'appSession_microsoft=external');
    expect(response).toMatchObject({ status: 200, body: 'local' });
    expect(events).toEqual(['local:auth', 'local:login']);
    expect(response.setCookie).toMatch(/appSession_microsoft=;/);
  });

  it('logs out a local-only session locally without entering Entra logout', async () => {
    const events: string[] = [];
    const { set } = hybridHarness(events);
    const response = await callApp(set, '/logout', 'oshal_local=legacy');
    expect(response.status).toBe(302);
    expect(response.location).toBe('/login');
    expect(events).toEqual([]);
    expect(response.setCookie).toMatch(/oshal_local=;/);
  });

  it('logs out an external session through Entra and clears any local sibling first', async () => {
    const events: string[] = [];
    const { set } = hybridHarness(events);
    const response = await callApp(set, '/logout', 'appSession_microsoft=external; oshal_local=legacy');
    expect(response.status).toBe(302);
    expect(response.location).toBe('/');
    expect(events).toEqual(['external:auth', 'external:logout']);
    expect(response.setCookie).toMatch(/oshal_local=;/);
  });
});
