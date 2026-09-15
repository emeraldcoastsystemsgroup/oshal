/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Moved the /api/auth/user auth-state probe and the MOCK_OIDC-gated demo auth mount out of server.ts so both read isMockOidcEnabled(), the one predicate that already decides the MOCK_OIDC auth bypass. server.ts tested MOCK_OIDC === 'true' exactly at both sites, so MOCK_OIDC=1 (or yes/TRUE) got the full bypass while /api/auth/user reported mode 'oidc' and the demo /logout was never mounted. Guard: tests/unit/mock-oidc-one-predicate.spec.ts.
 */

import { Router, type Application, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { isMockOidcEnabled } from '@/shared/middleware/oidc';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { guestCapabilities } from '@/shared/middleware/guest-capability-matrix';
import { isLocalAuthEnabled } from '@/features/local-auth';
import { createDemoAuthRoutes } from './demo-auth-routes';

const logger = createChildLogger({ module: 'auth-state-routes' });

/** @description The auth posture the cockpit profile widget renders for the current request. */
export type AuthStateMode = 'guest' | 'local' | 'demo' | 'oidc';

/**
 * @description Names the auth mode serving this request. 'demo' is decided by the SAME
 * predicate that turns on the MOCK_OIDC bypass, so the mode can never report 'oidc' while
 * every request is being authenticated as the mock user.
 *
 * @param req - The request, already through the global auth/guest middleware.
 * @returns 'guest' for a guest session, else 'local' (LOCAL_AUTH), 'demo' (MOCK_OIDC) or 'oidc'.
 */
export function resolveAuthStateMode(req: Request): AuthStateMode {
  if (isGuestRequest(req)) return 'guest';
  if (isLocalAuthEnabled()) return 'local';
  return isMockOidcEnabled() ? 'demo' : 'oidc';
}

/**
 * @description The UNGATED auth-state probe for the cockpit profile widget: always 200 (never
 * a login redirect), reporting the live session in production and the injected mock session
 * under MOCK_OIDC. Mount it at '/api/auth/user' after the global auth middleware, so req.oidc
 * is populated and the route-auth inventory still sees the path it reviews.
 *
 * @returns Router serving the mount path itself (GET).
 */
export function createAuthStateRoutes(): Router {
  const router = Router();
  router.get('/', (req: Request, res: Response) => {
    const startedAt = Date.now();
    const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: unknown } }).oidc;
    const authenticated = !!(oidc && typeof oidc.isAuthenticated === 'function' && oidc.isAuthenticated());
    const guest = isGuestRequest(req);
    const mode = resolveAuthStateMode(req);
    res.json({
      authenticated,
      user: authenticated ? oidc?.user : null,
      mode,
      guestMode: guest,
      // Capability snapshot so the cockpit can gray the right tiles. Only meaningful
      // for guests; present always so the frontend can read it unconditionally.
      capabilities: guest ? guestCapabilities() : null,
    });
    logger.debug({ mode, authenticated, durationMs: Date.now() - startedAt }, 'GET /api/auth/user');
  });
  return router;
}

/**
 * @description Mounts the demo /login, /logout and /api/auth/user routes ONLY when MOCK_OIDC
 * is enabled, by the same predicate as the bypass itself. In a real OIDC deployment
 * express-openid-connect owns /login and /logout, and the fabricated demo identity must
 * never be reachable.
 *
 * @param app - The Express application; mount order is the caller's (server.ts).
 * @returns true when the demo routes were mounted.
 */
export function mountDemoAuthRoutes(app: Application): boolean {
  if (!isMockOidcEnabled()) return false;
  app.use('/', createDemoAuthRoutes());
  logger.info('Demo auth routes mounted (MOCK_OIDC)');
  return true;
}
