/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2b-ii: the local swarm admin signs in at /login/admin in every auth mode except MOCK_OIDC, including a Google/identity-provider deployment where no other local login exists. The page posts to /api/admin-auth/login, which admits only the swarm-admin account (anyone else gets the wrong-password answer) and enforces its authenticator. /logout/admin clears the admin session.
 */

import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { isMockOidcEnabled } from '@/shared/middleware/principal-issuer';
import { sanitizeLoginReturnTo } from '@/shared/middleware/oidc';
import { ensureLocalUserSchema, ensureTotpSchema, localAuthSigningSecret } from '@/features/local-auth';
import { clearLocalSessionCookie, createPasswordLoginHandler, servePage } from './local-auth-routes';

const logger = createChildLogger({ module: 'swarm-admin-sign-in-routes' });

/**
 * @description Whether this deployment can offer the swarm admin's sign-in: it needs a session
 * signing secret, and MOCK_OIDC (an open test posture with no real sign-in) never gets it.
 *
 * @param env - Process environment.
 * @returns True when /login/admin should be mounted.
 */
export function swarmAdminSignInAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isMockOidcEnabled(env) && Boolean(localAuthSigningSecret());
}

/** True when the request already carries the swarm admin's local session. */
function isSwarmAdminSession(req: Request): boolean {
  const user = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { oshal_account_kind?: string } } }).oidc;
  return Boolean(user?.isAuthenticated?.()) && user?.user?.oshal_account_kind === 'swarm-admin';
}

/**
 * @description The swarm admin's sign-in routes (ADR-174 D1): the page, its login endpoint and its
 * sign-out. Mounted in every auth mode where {@link swarmAdminSignInAvailable} holds, before the
 * generic `/login/:provider` route.
 *
 * @param pool - Postgres pool backing the local account store.
 * @returns Express router.
 */
export function createSwarmAdminSignInRoutes(pool: Pool): Router {
  void ensureLocalUserSchema(pool)
    .then(() => ensureTotpSchema(pool))
    .catch((err) => logger.error({ err }, 'swarm admin sign-in schema unavailable; /login/admin cannot sign anyone in until it exists'));
  const router = Router();

  router.get('/login/admin', (req, res) => {
    if (isSwarmAdminSession(req)) {
      res.redirect(302, sanitizeLoginReturnTo(req.query.returnTo) ?? '/');
      return;
    }
    servePage(res, 'admin-login.html');
  });

  router.post('/api/admin-auth/login', createPasswordLoginHandler(pool, { onlyAccountKind: 'swarm-admin' }));

  router.get('/logout/admin', (_req, res) => {
    clearLocalSessionCookie(res);
    res.redirect(302, '/login/admin');
  });

  return router;
}
