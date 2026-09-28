/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3 (D3 "Routes and step-up"): the step-up ceremony under /api/location/step-up. The page opens a challenge for one operation and its exact parameters (normalised here by the same function the gated route uses, so the digests meet). How it is proven follows the session: a real OIDC session is sent through a fresh interactive sign-in (max_age=0) and the callback's auth_time and iat must be no older than the challenge, so an identity provider that silently reuses its session proves nothing; a local-auth session proves it with a TOTP or recovery code (verifySecondFactor, which refuses a replayed step); MOCK_OIDC issues the fresh authentication on a top-level navigation, so localhost works without an identity provider. The start and complete endpoints answer only a top-level document navigation (Sec-Fetch-Mode navigate, Sec-Fetch-Dest document), which a fetch or a framed page cannot produce. spendLocationStepUp is what a gated route calls: it reads the proof handle from the X-Oshal-Location-Step-Up header and spends it for exactly the operation and parameters the route is about to act on.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: the TOTP route is also bounded per person. The store's admission (noteAttempt) now refuses with 429 too-many-failures once the person (subject AND issuer) has spent the failed-code budget, before verifySecondFactor runs and whichever challenge the request names, so opening fresh challenges no longer buys more guesses. A code that verifies, or an account with no second factor, has its admission charge refunded, so the budget counts failures only.
 *
 * @module app/routes/location-step-up-routes
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { verifySecondFactor } from '@/features/local-auth';
import type { LocationPrincipal } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { isMockOidcEnabled } from '@/shared/middleware/principal-issuer';
import {
  isLocationStepUpOperation, type LocationStepUpMethod, type LocationStepUpOperation, type LocationStepUpOutcome,
  type LocationStepUpStore,
} from '../location-step-up';
import { LocationRequestError } from '../location-request';
import { locationContext, type LocationSessionRail } from './location-session';

const log = createChildLogger({ module: 'location-step-up-routes' });

/** @description The request header a gated route reads the proof handle from. */
export const LOCATION_STEP_UP_HEADER = 'x-oshal-location-step-up';

/** @description The path, under the location router, of the step-up ceremony. */
export const LOCATION_STEP_UP_BASE = '/step-up';

/**
 * @description Turns an operation's raw parameters into the canonical form both the challenge and
 * the gated route digest. Throws a LocationRequestError for malformed input.
 */
export type LocationStepUpParamsNormalizer = (raw: unknown) => unknown;

/** @description Options for the step-up routes. */
export interface LocationStepUpRoutesOptions {
  /** The challenge store. */
  store: LocationStepUpStore;
  /** The pool, for the local-auth second-factor check. */
  pool: Pool;
  /** One normaliser per operation a route in this build performs; other operations cannot be challenged. */
  normalizers: Partial<Record<LocationStepUpOperation, LocationStepUpParamsNormalizer>>;
  /** Where the sign-in window lands when the ceremony ends (same-origin path). */
  donePath: string;
}

const METHOD_FOR_RAIL: Record<LocationSessionRail, LocationStepUpMethod> = {
  oidc: 'oidc-max-age',
  'mock-oidc': 'mock-oidc',
  'local-auth': 'local-totp',
};

/**
 * @description Whether a request is a top-level document navigation, the only way the start and
 * complete endpoints may be reached. Browsers set these headers themselves; script cannot.
 * @param req - The request.
 * @returns true for a top-level navigation.
 */
export function isTopLevelNavigation(req: Request): boolean {
  return req.get('sec-fetch-mode') === 'navigate' && req.get('sec-fetch-dest') === 'document';
}

/**
 * @description The challenge handle a step-up path names.
 * @param req - The request.
 * @returns The :id parameter as a string (empty when absent).
 */
function challengeParam(req: Request): string {
  const value = req.params.id;
  return typeof value === 'string' ? value : '';
}

/**
 * @description Spend the request's step-up proof on one operation (what every gated route calls).
 * @param req - The request carrying {@link LOCATION_STEP_UP_HEADER}.
 * @param store - The challenge store.
 * @param principal - The signed-in person.
 * @param operation - The operation the route is about to perform.
 * @param params - Its canonical parameters, derived from this request.
 * @returns ok, or why not.
 */
export function spendLocationStepUp(
  req: Request, store: LocationStepUpStore, principal: LocationPrincipal, operation: LocationStepUpOperation, params: unknown,
): LocationStepUpOutcome {
  const handle = req.get(LOCATION_STEP_UP_HEADER);
  if (!handle) return { ok: false, reason: 'unknown' };
  return store.consume(handle, principal, operation, params);
}

/**
 * @description The refusal a gated route sends when the proof is missing or does not fit.
 * @param operation - The operation that needed it.
 * @param outcome - Why it was refused.
 * @returns The error to throw.
 */
export function stepUpRequired(operation: LocationStepUpOperation, outcome: LocationStepUpOutcome): LocationRequestError {
  const reason = outcome.ok ? 'unknown' : outcome.reason;
  return new LocationRequestError('step_up_required', 403,
    `This change (${operation}) needs a fresh sign-in first; the proof was ${reason === 'unknown' ? 'missing' : reason}.`);
}

/**
 * @description Send the sign-in window back to the done page with the ceremony's outcome.
 * @param res - The response.
 * @param donePath - The page.
 * @param outcome - What happened.
 * @returns Nothing.
 */
function finish(res: Response, donePath: string, outcome: LocationStepUpOutcome): void {
  const query = outcome.ok ? 'stepUpDone=1&ok=1' : `stepUpDone=1&ok=0&reason=${encodeURIComponent(outcome.reason)}`;
  res.redirect(303, `${donePath}?${query}`);
}

/**
 * @description POST / : open a challenge for one operation and its parameters.
 * @param options - Route options.
 * @returns The handler.
 */
function openChallenge(options: LocationStepUpRoutesOptions) {
  return (req: Request, res: Response): void => {
    const { principal, rail } = locationContext(res);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const operation = body.operation;
    const normalize = isLocationStepUpOperation(operation) ? options.normalizers[operation] : undefined;
    if (!isLocationStepUpOperation(operation) || !normalize) {
      res.status(400).json({ error: 'operation_not_available', message: 'That operation cannot be confirmed here.' });
      return;
    }
    let params: unknown;
    try {
      params = normalize(body.params);
    } catch (error) {
      const status = error instanceof LocationRequestError ? error.status : 400;
      res.status(status).json({ error: error instanceof LocationRequestError ? error.code : 'invalid_params', message: 'The parameters are not valid.' });
      return;
    }
    const view = options.store.create(principal, operation, params, METHOD_FOR_RAIL[rail]);
    const base = `/api/location${LOCATION_STEP_UP_BASE}/${encodeURIComponent(view.challengeId)}`;
    res.status(201).json({ ...view, startUrl: view.method === 'local-totp' ? null : `${base}/start`,
      totpUrl: view.method === 'local-totp' ? `${base}/totp` : null });
  };
}

/**
 * @description GET /:id/start : begin the fresh authentication, from a top-level navigation only.
 * @param options - Route options.
 * @returns The handler.
 */
function startChallenge(options: LocationStepUpRoutesOptions) {
  return (req: Request, res: Response): void => {
    if (!isTopLevelNavigation(req)) { res.status(403).json({ error: 'navigation_required' }); return; }
    const { principal } = locationContext(res);
    const view = options.store.view(challengeParam(req), principal);
    if (!view || view.state !== 'pending') { finish(res, options.donePath, { ok: false, reason: view ? 'already-proven' : 'unknown' }); return; }
    if (view.method === 'mock-oidc' && isMockOidcEnabled()) {
      finish(res, options.donePath, options.store.prove(view.challengeId, { method: 'mock-oidc', principal, authTimeMs: options.store.clock() }));
      return;
    }
    const oidcRes = res as Response & { oidc?: { login?: (opts: Record<string, unknown>) => Promise<void> } };
    if (view.method !== 'oidc-max-age' || typeof oidcRes.oidc?.login !== 'function') {
      res.status(409).json({ error: 'step_up_unavailable', message: 'This sign-in cannot be refreshed here.' });
      return;
    }
    log.info({ op: 'step-up-start', outcome: 'redirected' }, 'location step-up sent to a fresh sign-in');
    const returnTo = `/api/location${LOCATION_STEP_UP_BASE}/${encodeURIComponent(view.challengeId)}/complete`;
    void oidcRes.oidc.login({ returnTo, authorizationParams: { max_age: 0 } });
  };
}

/**
 * @description Read the fresh authentication an OIDC callback established.
 * @param req - The request after the callback's session was set.
 * @returns auth_time and iat in epoch ms (NaN when absent).
 */
function oidcAuthTimes(req: Request): { authTimeMs: number; issuedAtMs: number } {
  const claims = (req as Request & { oidc?: { idTokenClaims?: Record<string, unknown> } }).oidc?.idTokenClaims ?? {};
  const seconds = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : Number.NaN);
  return { authTimeMs: seconds(claims.auth_time), issuedAtMs: seconds(claims.iat) };
}

/**
 * @description GET /:id/complete : the OIDC sign-in came back; accept it only if it is fresh and
 * it is the same account.
 * @param options - Route options.
 * @returns The handler.
 */
function completeChallenge(options: LocationStepUpRoutesOptions) {
  return (req: Request, res: Response): void => {
    const { principal, rail } = locationContext(res);
    if (!isTopLevelNavigation(req)) { res.status(403).json({ error: 'navigation_required' }); return; }
    if (rail !== 'oidc') { finish(res, options.donePath, { ok: false, reason: 'method-mismatch' }); return; }
    const { authTimeMs, issuedAtMs } = oidcAuthTimes(req);
    const outcome = options.store.prove(challengeParam(req), { method: 'oidc-max-age', principal, authTimeMs, issuedAtMs });
    log.info({ op: 'step-up-complete', outcome: outcome.ok ? 'proven' : 'refused' }, 'location step-up sign-in returned');
    finish(res, options.donePath, outcome);
  };
}

/**
 * @description POST /:id/totp : a local-auth session proves the challenge with a second-factor code.
 * The store admits the check first (429 once the person's failed-code budget is spent, whichever
 * challenge is named, or once this challenge used its attempts), so no code reaches
 * verifySecondFactor past the budget; a check that did not fail has its charge refunded.
 * @param options - Route options.
 * @returns The handler.
 */
function totpChallenge(options: LocationStepUpRoutesOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    const { principal, rail } = locationContext(res);
    const view = options.store.view(challengeParam(req), principal);
    if (!view || view.method !== 'local-totp' || rail !== 'local-auth') { res.status(404).json({ error: 'step_up_not_found' }); return; }
    const attempt = options.store.noteAttempt(view.challengeId, principal);
    if (!attempt.ok) { res.status(429).json({ error: 'step_up_refused', reason: attempt.reason }); return; }
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    try {
      const factor = await verifySecondFactor(options.pool, principal.sub, code);
      if (factor !== 'invalid') options.store.refundTotpAttempt(principal);
      if (factor === 'not-enrolled') { res.status(409).json({ error: 'totp_not_enrolled', message: 'Turn on two-factor sign-in at /2fa first.' }); return; }
      if (factor !== 'ok') { res.status(403).json({ error: 'totp_invalid' }); return; }
      const outcome = options.store.prove(view.challengeId, { method: 'local-totp', principal, authTimeMs: options.store.clock() });
      res.status(outcome.ok ? 200 : 403).json(outcome.ok ? { state: 'proven' } : { error: 'step_up_refused', reason: outcome.reason });
    } catch (error) {
      log.error({ op: 'step-up-totp', outcome: 'failed', err: locationSafeError(error) }, 'location step-up code check failed');
      res.status(500).json({ error: 'step_up_failed' });
    }
  };
}

/**
 * @description The step-up ceremony routes, mounted by the location router at {@link LOCATION_STEP_UP_BASE}
 * after its session middleware.
 * @param options - Store, pool, normalisers and the done page.
 * @returns The router.
 */
export function createLocationStepUpRoutes(options: LocationStepUpRoutesOptions): Router {
  const router = Router();
  router.post('/', openChallenge(options));
  router.get('/:id', (req, res) => {
    const view = options.store.view(challengeParam(req), locationContext(res).principal);
    if (!view) { res.status(404).json({ error: 'step_up_not_found' }); return; }
    res.json(view);
  });
  router.delete('/:id', (req, res) => {
    const removed = options.store.cancel(challengeParam(req), locationContext(res).principal);
    res.status(removed ? 200 : 404).json(removed ? { cancelled: true } : { error: 'step_up_not_found' });
  });
  router.get('/:id/start', startChallenge(options));
  router.get('/:id/complete', completeChallenge(options));
  router.post('/:id/totp', totpChallenge(options));
  return router;
}
