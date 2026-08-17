/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add the opt-in Entra/local hybrid pilot composition: the established invited-user page remains at /login and offers Microsoft explicitly at /login/microsoft on the already-registered provider-suffixed callback; /login/local remains the recovery door. Door switches and logout clear sibling sessions so one browser principal is authoritative at a time.
 */

import type { Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { LOCAL_SESSION_COOKIE } from '@/features/local-auth';
import {
  createEntraLocalIdentityBridgeMiddleware,
  isEntraLocalAuthHybridEnabled,
  isEntraLocalIdentityBridgeEnabled,
} from '@/app/middleware/entra-local-identity-bridge';
import { createLocalAuthMiddlewareSet } from '@/app/routes/local-auth-routes';
import {
  createOidcMiddleware,
  resolveCookieDomainForHost,
  type OidcMiddlewareSet,
} from '@/shared/middleware/oidc';

/** Middleware-set extension consumed only by server route wiring. */
export type ApplicationAuthMiddlewareSet = OidcMiddlewareSet & {
  /** Present only in the explicit hybrid pilot. */
  localLoginHandler?: RequestHandler;
  /** Present only in the explicit hybrid pilot; mounted at the exact Microsoft path. */
  microsoftLoginHandler?: RequestHandler;
  /** Enables the Microsoft option in the otherwise shared local login page/state route. */
  microsoftLoginEnabled?: true;
};

/** Injectable factories keep routing/session behavior unit-testable without OIDC discovery. */
export type ApplicationAuthDependencies = {
  createOidc?: (options?: Parameters<typeof createOidcMiddleware>[0]) => OidcMiddlewareSet;
  createLocal?: (pool: Pool) => OidcMiddlewareSet;
  createBridge?: (pool: Pool, env: NodeJS.ProcessEnv) => RequestHandler;
};

const EXTERNAL_SESSION_COOKIE_BASES = [
  'appSession',
  'appSession_microsoft',
  'appSession_outlook',
  'appSession_google',
] as const;

const LOCAL_SURFACE_PATHS = new Set(['/login/local', '/invite', '/2fa']);

function flag(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function cookieNames(base: string): string[] {
  return [base, `${base}.0`, `${base}.1`, `${base}.2`, `${base}.3`, `${base}.4`];
}

function requestCookies(req: Request): Record<string, string> {
  return (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
}

function hasExternalSession(req: Request): boolean {
  const cookies = requestCookies(req);
  return EXTERNAL_SESSION_COOKIE_BASES.some((base) => cookieNames(base).some((name) => typeof cookies[name] === 'string'));
}

function clearCookieOnHostAndConfiguredDomain(req: Request, res: Response, name: string): void {
  res.clearCookie(name, { path: '/' });
  const domain = resolveCookieDomainForHost(process.env.SESSION_COOKIE_DOMAIN, `https://${req.hostname}`);
  if (domain) res.clearCookie(name, { path: '/', domain });
}

function clearExternalSessions(req: Request, res: Response): void {
  for (const base of EXTERNAL_SESSION_COOKIE_BASES) {
    for (const name of cookieNames(base)) clearCookieOnHostAndConfiguredDomain(req, res, name);
  }
  for (const transient of ['auth_verification', 'oidc_login_retry']) {
    clearCookieOnHostAndConfiguredDomain(req, res, transient);
  }
}

function clearLocalSession(req: Request, res: Response): void {
  clearCookieOnHostAndConfiguredDomain(req, res, LOCAL_SESSION_COOKIE);
}

function isExternalLoginPath(pathname: string): boolean {
  return pathname === '/login/microsoft';
}

function validateHybridConfiguration(env: NodeJS.ProcessEnv): void {
  if (!flag(env.LOCAL_AUTH)) {
    throw new Error('ENTRA_LOCAL_AUTH_HYBRID=true requires LOCAL_AUTH=true so /login/local remains available.');
  }
  if (flag(env.MOCK_OIDC)) {
    throw new Error('ENTRA_LOCAL_AUTH_HYBRID refuses MOCK_OIDC; Microsoft sessions must be cryptographically verified.');
  }
  if (!flag(env.MICROSOFT_LOGIN)) {
    throw new Error('ENTRA_LOCAL_AUTH_HYBRID=true requires MICROSOFT_LOGIN=true.');
  }
}

/** Run middleware A then B without weakening Express error propagation or response ownership. */
function then(first: RequestHandler, second: RequestHandler): RequestHandler {
  return (req, res, next) => first(req, res, (error?: unknown) => {
    if (error) return next(error);
    return second(req, res, next);
  });
}

/**
 * Compose the pilot's trust boundaries in their load-bearing order:
 * Microsoft session validation -> durable Entra/local identity bridge -> local-cookie fallback.
 * An explicit local surface bypasses Microsoft and clears its app cookies first, making the
 * fallback reachable even when an unprovisioned/stale external session is present.
 */
function createHybridAuthMiddleware(
  external: OidcMiddlewareSet,
  local: OidcMiddlewareSet,
  bridge: RequestHandler,
): RequestHandler {
  const externalThenBridgeThenLocal = then(external.authMiddleware, then(bridge, local.authMiddleware));

  return (req, res, next) => {
    const pathname = req.path;

    if (req.method === 'GET' && LOCAL_SURFACE_PATHS.has(pathname)) {
      clearExternalSessions(req, res);
      return local.authMiddleware(req, res, next);
    }

    if (req.method === 'GET' && pathname === '/logout/local') {
      clearExternalSessions(req, res);
      clearLocalSession(req, res);
      res.redirect(302, '/login/local');
      return;
    }

    if (req.method === 'GET' && pathname === '/logout') {
      const externalSession = hasExternalSession(req);
      const localSession = typeof requestCookies(req)[LOCAL_SESSION_COOKIE] === 'string';
      // Never let an older local cookie resurrect after Entra completes RP-initiated logout.
      clearLocalSession(req, res);
      if (localSession && !externalSession) {
        res.redirect(302, '/login');
        return;
      }
      return external.authMiddleware(req, res, next);
    }

    if (req.method === 'GET' && isExternalLoginPath(pathname)) {
      // Selecting Microsoft is an explicit principal switch; discard the local sibling first.
      clearLocalSession(req, res);
      return external.authMiddleware(req, res, next);
    }

    return externalThenBridgeThenLocal(req, res, next);
  };
}

/**
 * @description Selects the deployment auth set. With the hybrid flag off this is exactly the
 * historical LOCAL_AUTH-or-OIDC choice. With it on, LOCAL_AUTH stays enabled and owns bare
 * `/login`; Microsoft is mounted as a single secondary-shaped OIDC provider at
 * `/login/microsoft`, with `/callback/microsoft` and `appSession_microsoft` kept distinct.
 */
export function createApplicationAuthMiddlewareSet(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ApplicationAuthDependencies = {},
): ApplicationAuthMiddlewareSet {
  const createOidc = dependencies.createOidc ?? createOidcMiddleware;
  const createLocal = dependencies.createLocal ?? createLocalAuthMiddlewareSet;
  const createBridge = dependencies.createBridge ?? createEntraLocalIdentityBridgeMiddleware;

  if (isEntraLocalAuthHybridEnabled(env)) {
    validateHybridConfiguration(env);
    const external = createOidc({ providerMode: 'microsoft-secondary-only' });
    const local = createLocal(pool);
    const bridge = createBridge(pool, env);

    return {
      authMiddleware: createHybridAuthMiddleware(external, local, bridge),
      // The global chain above has already established either a bridged Entra principal or
      // a local principal. Use the local guard's neutral req.oidc check so an unauthenticated
      // document returns to the combined `/login` page instead of auto-starting Microsoft.
      requiresAuth: local.requiresAuth,
      loginHandler: local.loginHandler,
      localLoginHandler: local.loginHandler,
      microsoftLoginHandler: external.loginHandler,
      microsoftLoginEnabled: true,
    };
  }

  // Full cutover: keep the ordinary OIDC provider contract, but never leave an explicitly
  // enabled identity bridge inert. There is no local-cookie fallback in this posture.
  if (isEntraLocalIdentityBridgeEnabled(env)) {
    const external = createOidc();
    const bridge = createBridge(pool, env);
    return {
      ...external,
      authMiddleware: then(external.authMiddleware, bridge),
    };
  }

  return flag(env.LOCAL_AUTH) ? createLocal(pool) : createOidc();
}
