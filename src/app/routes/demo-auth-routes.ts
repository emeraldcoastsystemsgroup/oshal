/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial demo auth routes — /login, /logout, /api/auth/user for MOCK_OIDC operation
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { DemoUser } from '@/features/demo-mode';

const logger = createChildLogger({ module: 'demo-auth-routes' });

const DEMO_USER: DemoUser = {
  sub: 'mock-user-001',
  name: 'Alex Monster (Demo)',
  email: 'alex@demo.local',
  preferredUsername: 'alex',
  roles: ['student', 'demo'],
};

/**
 * @description Registers /login, /logout, and /api/auth/user handlers for
 * the mock-OIDC / demo-mode deployment. In real OIDC mode these paths are
 * owned by express-openid-connect; in mock mode that middleware is not
 * mounted, leaving them unhandled. These routes give the app a coherent
 * "you're logged in as the demo user" experience without requiring a real
 * identity provider.
 *
 *   GET /login         → redirects to the landing page (cockpit)
 *   GET /logout        → clears any session cookie hint, redirects home
 *   GET /api/auth/user → returns the current demo user profile
 *
 * Safe to mount unconditionally — the handlers are inert when the server
 * also has real OIDC wired up because express-openid-connect registers
 * its handlers at app.use('/login') before these reach the router.
 */
export function createDemoAuthRoutes(): Router {
  const router = Router();

  router.get('/login', (req: Request, res: Response) => {
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/cockpit/';
    logger.info({ returnTo, user: DEMO_USER.name }, 'Demo login — redirecting as pre-authenticated demo user');
    res.redirect(302, returnTo);
  });

  router.get('/logout', (_req: Request, res: Response) => {
    logger.info({ user: DEMO_USER.name }, 'Demo logout — redirecting home');
    res.redirect(302, '/');
  });

  router.get('/api/auth/user', (_req: Request, res: Response) => {
    res.json({
      authenticated: true,
      mode: 'demo',
      user: DEMO_USER,
    });
  });

  return router;
}
