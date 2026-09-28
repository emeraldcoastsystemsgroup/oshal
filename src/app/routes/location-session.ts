/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3 (D3 "Ingest and machine identity"): who may call /api/location. The service-secret rail is REFUSED with 401 before anything else runs, whether or not a session rides along: that rail can speak as any user (X-Oshal-User-Sub) and arrives operator-stamped, so no location route accepts it. What remains must be an interactive browser session (a real OIDC session, the MOCK_OIDC session, or a local-auth session) with a verified issuer; personal access tokens, TV pairing tokens and guest cookies authenticate a person but are not a browser the person is holding, and cannot complete the step-up, so they are refused with 403. The principal every location service acts for is taken from that session here and nowhere else; a body, query or header never names it.
 *
 * @module app/routes/location-session
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { LocationPrincipal } from '@/features/location';
import { createChildLogger } from '@/shared/logger';
import { getCaller, hasValidServiceSecret } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer, isMockOidcEnabled } from '@/shared/middleware/principal-issuer';

const log = createChildLogger({ module: 'location-session' });

/** @description The interactive session rails a location route accepts. */
export type LocationSessionRail = 'oidc' | 'mock-oidc' | 'local-auth';

/** @description What every location handler reads from res.locals.location. */
export interface LocationRequestContext {
  /** The signed-in person: session subject and verified issuer. */
  principal: LocationPrincipal;
  /** How they are signed in, which decides how they prove a fresh authentication. */
  rail: LocationSessionRail;
}

/** The id-token markers the non-browser rails set on req.oidc (PAT, TV pairing, guest). */
const NON_BROWSER_MARKERS = new Set(['cli-token', 'tv-token', 'guest-token']);

/** The headers that carry the shared service secret or a subject asserted under it. */
const SERVICE_RAIL_HEADERS = ['x-service-secret', 'x-oshal-user-sub', 'x-oshal-user-sub-b64'];

type OidcShape = { isAuthenticated?: () => boolean; idToken?: unknown; idTokenClaims?: unknown };

/**
 * @description Which interactive browser rail authenticated the request, if any.
 * @param req - The request after the authentication middleware.
 * @returns The rail, or null for no session or a non-browser credential.
 */
export function locationSessionRail(req: Request): LocationSessionRail | null {
  const oidc = (req as Request & { oidc?: OidcShape }).oidc;
  if (oidc?.isAuthenticated?.() !== true) return null;
  const marker = typeof oidc.idToken === 'string' ? oidc.idToken : '';
  if (marker === 'mock-id-token') return isMockOidcEnabled() ? 'mock-oidc' : null;
  if (marker === 'local-session') return 'local-auth';
  if (!marker || NON_BROWSER_MARKERS.has(marker)) return null;
  return oidc.idTokenClaims !== null && typeof oidc.idTokenClaims === 'object' ? 'oidc' : null;
}

/**
 * @description Whether a request presents the shared service secret, or a subject asserted under it.
 * Any such header refuses the request, valid secret or not: a machine has no business here.
 * @param req - The request.
 * @returns true when a service-rail header is present.
 */
export function presentsServiceRail(req: Request): boolean {
  return hasValidServiceSecret(req) || SERVICE_RAIL_HEADERS.some((name) => req.headers[name] !== undefined);
}

/**
 * @description Middleware: refuse the service-secret rail with 401 (ADR-169 D3).
 * @param req - The request.
 * @param res - The response.
 * @param next - Continues for every other request.
 * @returns Nothing.
 */
export function refuseLocationServiceRail(req: Request, res: Response, next: NextFunction): void {
  if (!presentsServiceRail(req)) {
    next();
    return;
  }
  log.warn({ op: 'service-rail', outcome: 'refused' }, 'location route refused the service-secret rail');
  res.status(401).json({ error: 'service_secret_refused',
    message: 'Location routes accept only a signed-in person in a browser; the service secret is refused.' });
}

/**
 * @description Middleware: establish the signed-in person from their browser session, or refuse.
 * Sets res.locals.location for every handler after it.
 * @returns The middleware.
 */
export function requireLocationBrowserSession(): RequestHandler {
  return (req, res, next) => {
    const rail = locationSessionRail(req);
    const sub = getCaller(req).sub;
    if (!rail || !sub) {
      log.warn({ op: 'session', outcome: 'refused', reason: 'not-a-browser-session' }, 'location route needs a browser session');
      res.status(403).json({ error: 'browser_session_required',
        message: 'Location settings are changed from a signed-in browser, not with a token.' });
      return;
    }
    const principalIssuer = getAuthenticatedPrincipalIssuer(req);
    if (!principalIssuer) {
      log.warn({ op: 'session', outcome: 'refused', reason: 'no-verified-issuer' }, 'location route needs a verified issuer');
      res.status(403).json({ error: 'verified_issuer_required', message: 'Sign in again: this session has no verified identity provider.' });
      return;
    }
    const context: LocationRequestContext = { principal: { sub, principalIssuer }, rail };
    res.locals.location = context;
    next();
  };
}

/**
 * @description The context {@link requireLocationBrowserSession} established.
 * @param res - The response.
 * @returns The context.
 * @throws {Error} When the middleware did not run (a wiring fault, never a caller's doing).
 */
export function locationContext(res: Response): LocationRequestContext {
  const context = res.locals.location as LocationRequestContext | undefined;
  if (!context) throw new Error('location route reached without a location session');
  return context;
}
