/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: the one /api/location router (later slices add their routes here rather than minting a second mount). Browser ingest (POST /presence) and the person's consent over their own location (the Settings, Location tab's reads and changes), behind the service-rail refusal and the browser-session principal of location-session.ts. Every route that raises exposure spends a step-up proof for exactly the parameters it acts on (opt-in always; a precision change only when it raises; accepting a member share always); LOCATION_ROUTE_POLICY declares each route's rule and tests/unit/location-route-policy.spec.ts fails when a route is added without a declaration. Statements run under the person's own owner session (never is_operator); refusals are LocationRequestError codes, never a coordinate or a subject.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: mount the places and device-enrolment routes (location-place-routes.ts) on this router and merge their declarations into LOCATION_ROUTE_POLICY, so the route-policy spec still sees every route; none spends a proof. The error mapper also answers the location kernel's own refusals: LocationInputError 400 and LocationNotFoundError 404.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5: mount the reminder and group-sharing routes (location-rule-routes.ts) and merge their declarations; add the step-up normalisers for creating a guardian share and accepting a restricted invitation; hand every browser fix's claimed fires to an after-commit dispatcher (the production two-rail delivery by default); start the dispatch-recovery sweep when the caller asks for one (the server passes locationDispatchSweepMsFromEnv(): OSHAL_LOCATION_DISPATCH_SWEEP_SEC, default 60 s, 0 off).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: mount the device ingest (location-device-routes.ts) BEFORE the browser-session gate, because its caller is a device under its location credential and not a person in a browser (the service-rail refusal still runs first, and the route itself admits nothing but the stamped credential binding); mount the credential route after the gate and add the approve-enrolment normaliser (device id and precision class), so the challenge and the route digest the same form. Both routes are merged into LOCATION_ROUTE_POLICY.
 *
 * @module app/routes/location-routes
 */

import express, { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { LocationInputError, LocationNotFoundError, LocationPrincipalError, purgeOwnLocationHistory } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { changeDefaultPrecision, changeDevicePrecision, optInBrowserDevice, optOutDevice } from '../location-consent';
import { acceptMemberShare, parseShareRequest, revokeMemberShare } from '../location-member-shares';
import { readLocationOverview } from '../location-overview';
import { normalizeEnrolmentApproval } from '../location-device-ingest';
import { createLocationDispatcher, defaultLocationDeliveryRails, startLocationDispatchSweep, type LocationDeliveryRails } from '../location-fire-dispatch';
import { parseGuardianShareRequest } from '../location-group-shares';
import { ingestBrowserFix, parseBrowserFix } from '../location-presence';
import { LocationRequestError, requireLocationId, requirePrecisionClass } from '../location-request';
import { locationStepUpStore, type LocationStepUpOperation, type LocationStepUpStore } from '../location-step-up';
import { LOCATION_DEVICE_ROUTE_POLICY, mountLocationCredentialRoute, mountLocationDeviceIngestRoute } from './location-device-routes';
import { LOCATION_PLACE_ROUTE_POLICY, mountLocationPlaceRoutes } from './location-place-routes';
import { LOCATION_RULE_ROUTE_POLICY, mountLocationRuleRoutes, normalizeInviteAcceptance } from './location-rule-routes';
import { locationContext, refuseLocationServiceRail, requireLocationBrowserSession } from './location-session';
import {
  LOCATION_STEP_UP_BASE, createLocationStepUpRoutes, spendLocationStepUp, stepUpRequired, type LocationStepUpParamsNormalizer,
} from './location-step-up-routes';

const log = createChildLogger({ module: 'location-routes' });

/** @description The Settings, Location page; the step-up sign-in window lands back on it. */
export const LOCATION_SETTINGS_PAGE = '/cockpit/tools/location.html';

/** @description One route's step-up rule: which proof it spends, and when. */
export interface LocationRoutePolicy {
  /** The operation whose proof the route spends, or null for a route that raises no exposure. */
  stepUp: LocationStepUpOperation | null;
  /** 'always', or 'raising' when only a change to a finer precision needs it. */
  when?: 'always' | 'raising';
  /** Why the rule is what it is. */
  why: string;
}

/** @description Every route of the location router and its step-up rule, keyed "METHOD path". */
export const LOCATION_ROUTE_POLICY: Readonly<Record<string, LocationRoutePolicy>> = Object.freeze({
  'GET /state': { stepUp: null, why: 'Reads the person\'s own settings, devices, current place (no coordinates) and who can see them.' },
  'PUT /settings': { stepUp: 'raise-precision', when: 'raising', why: 'A finer default precision lets finer group places be approved.' },
  'POST /devices/browser/opt-in': { stepUp: 'opt-in', when: 'always', why: 'Turning reporting on starts exposure.' },
  'POST /devices/:deviceId/opt-out': { stepUp: null, why: 'Stopping reporting only reduces exposure.' },
  'PUT /devices/:deviceId/precision': { stepUp: 'raise-precision', when: 'raising', why: 'A finer class stores more of every fix.' },
  'POST /presence': { stepUp: null, why: 'Accepted only for a device the person already opted in with a proof.' },
  'POST /history/purge': { stepUp: null, why: 'Deletes only the person\'s own history (Q4).' },
  'POST /shares': { stepUp: 'accept-share', when: 'always', why: 'Accepting a share lets a group see place transitions.' },
  'POST /shares/:shareId/revoke': { stepUp: null, why: 'Revoking only reduces exposure.' },
  'POST /step-up/': { stepUp: null, why: 'Opens a challenge; it authorises nothing until proven.' },
  'GET /step-up/:id': { stepUp: null, why: 'The person\'s own challenge state.' },
  'DELETE /step-up/:id': { stepUp: null, why: 'Withdraws the person\'s own challenge.' },
  'GET /step-up/:id/start': { stepUp: null, why: 'Begins the fresh sign-in; top-level navigation only.' },
  'GET /step-up/:id/complete': { stepUp: null, why: 'Accepts a fresh sign-in; top-level navigation only.' },
  'POST /step-up/:id/totp': { stepUp: null, why: 'Accepts a second-factor code for a local-auth session.' },
  ...LOCATION_PLACE_ROUTE_POLICY,
  ...LOCATION_RULE_ROUTE_POLICY,
  ...LOCATION_DEVICE_ROUTE_POLICY,
});

/** @description Canonical parameters for each operation a route here performs; the challenge and the route digest the same form. */
export const LOCATION_STEP_UP_NORMALIZERS: Readonly<Partial<Record<LocationStepUpOperation, LocationStepUpParamsNormalizer>>> = Object.freeze({
  'opt-in': (raw: unknown) => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const deviceId = input.deviceId === undefined || input.deviceId === null ? null : requireLocationId(input.deviceId);
    return { deviceId, precisionClass: requirePrecisionClass(input.precisionClass) };
  },
  'raise-precision': (raw: unknown) => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const scope = input.scope === 'default' ? 'default' : requireLocationId(input.scope, 'invalid_scope', 'scope');
    return { scope, precisionClass: requirePrecisionClass(input.precisionClass) };
  },
  'accept-share': (raw: unknown) => parseShareRequest(raw),
  'create-guardian-share': (raw: unknown) => parseGuardianShareRequest(raw),
  'accept-restricted-invite': (raw: unknown) => normalizeInviteAcceptance(raw),
  'approve-enrolment': (raw: unknown) => normalizeEnrolmentApproval(raw),
});

/** @description Options for the location router. */
export interface LocationRoutesOptions {
  /** The app's GUC-wrapped pool. */
  pool: Pool;
  /** The step-up store (the process singleton by default). */
  stepUpStore?: LocationStepUpStore;
  /** Minimum time between two accepted fixes from one browser. */
  ingestMinIntervalMs?: number;
  /** The delivery rails for location fires (the production shelf + notification rails by default). */
  deliveryRails?: LocationDeliveryRails;
  /** The dispatch-recovery sweep interval; absent or 0 starts none (the server passes {@link locationDispatchSweepMsFromEnv}). */
  dispatchSweepMs?: number;
}

/**
 * @description The deployment's minimum ingest interval: OSHAL_LOCATION_INGEST_MIN_INTERVAL_SEC, default 5.
 * @returns Milliseconds.
 */
export function locationIngestMinIntervalFromEnv(): number {
  const raw = Number(process.env.OSHAL_LOCATION_INGEST_MIN_INTERVAL_SEC);
  return Math.round((Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 3600) : 5) * 1000);
}

/**
 * @description The deployment's dispatch-recovery sweep interval: OSHAL_LOCATION_DISPATCH_SWEEP_SEC, default 60; 0 turns it off.
 * @returns Milliseconds (0 = off).
 */
export function locationDispatchSweepMsFromEnv(): number {
  const raw = Number(process.env.OSHAL_LOCATION_DISPATCH_SWEEP_SEC);
  return Math.round((Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 86_400) : 60) * 1000);
}

/**
 * @description Answer a refused or failed location request. Refusals carry their code; anything else
 * is logged through the location-safe error projection and answered with a bare 500.
 * @param res - The response.
 * @param error - What was thrown.
 * @returns Nothing.
 */
function sendLocationError(res: Response, error: unknown): void {
  if (error instanceof LocationRequestError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof LocationPrincipalError) {
    res.status(403).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof LocationInputError || error instanceof LocationNotFoundError) {
    res.status(error instanceof LocationInputError ? 400 : 404).json({ error: error.code, message: error.message });
    return;
  }
  log.error({ op: 'request', outcome: 'failed', err: locationSafeError(error) }, 'location request failed');
  res.status(500).json({ error: 'location_failed' });
}

type LocationHandler = (req: Request, res: Response) => Promise<void>;

/**
 * @description Wrap a handler so every refusal and failure goes through {@link sendLocationError}.
 * @param handler - The work.
 * @returns An Express handler.
 */
function guarded(handler: LocationHandler): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((error: unknown) => sendLocationError(res, error));
  };
}

/**
 * @description Spend the request's proof for one operation, or throw the refusal.
 * @param req - The request.
 * @param res - The response (for the session principal).
 * @param store - The step-up store.
 * @param operation - The operation.
 * @param params - Its canonical parameters, derived from this request.
 * @returns true once spent.
 * @throws {LocationRequestError} 403 step_up_required.
 */
function requireStepUp(req: Request, res: Response, store: LocationStepUpStore, operation: LocationStepUpOperation, params: unknown): true {
  const outcome = spendLocationStepUp(req, store, locationContext(res).principal, operation, params);
  if (!outcome.ok) throw stepUpRequired(operation, outcome);
  return true;
}

/**
 * @description Canonical parameters for an operation, through {@link LOCATION_STEP_UP_NORMALIZERS}.
 * @param operation - The operation.
 * @param raw - The raw parameters.
 * @returns The canonical parameters.
 */
function normalized(operation: LocationStepUpOperation, raw: unknown): Record<string, unknown> {
  const normalize = LOCATION_STEP_UP_NORMALIZERS[operation];
  if (!normalize) throw new Error('no normaliser for a gated location operation');
  return normalize(raw) as Record<string, unknown>;
}

/**
 * @description The consent routes: settings, opt-in and opt-out, precision.
 * @param router - The location router.
 * @param pool - The pool.
 * @param store - The step-up store.
 * @returns Nothing.
 */
function mountConsentRoutes(router: Router, pool: Pool, store: LocationStepUpStore): void {
  router.get('/state', guarded(async (_req, res) => {
    res.json(await readLocationOverview(pool, locationContext(res).principal));
  }));
  router.put('/settings', guarded(async (req, res) => {
    const params = normalized('raise-precision', { scope: 'default', precisionClass: req.body?.defaultPrecisionClass });
    const change = await changeDefaultPrecision(pool, locationContext(res).principal, params.precisionClass,
      () => requireStepUp(req, res, store, 'raise-precision', params));
    res.json(change);
  }));
  router.post('/devices/browser/opt-in', guarded(async (req, res) => {
    const params = normalized('opt-in', req.body);
    requireStepUp(req, res, store, 'opt-in', params);
    const device = await optInBrowserDevice(pool, locationContext(res).principal,
      { deviceId: params.deviceId as string | null, precisionClass: params.precisionClass });
    res.status(201).json({ device });
  }));
  router.post('/devices/:deviceId/opt-out', guarded(async (req, res) => {
    res.json(await optOutDevice(pool, locationContext(res).principal, req.params.deviceId));
  }));
  router.put('/devices/:deviceId/precision', guarded(async (req, res) => {
    const params = normalized('raise-precision', { scope: req.params.deviceId, precisionClass: req.body?.precisionClass });
    const change = await changeDevicePrecision(pool, locationContext(res).principal, params.scope, params.precisionClass,
      () => requireStepUp(req, res, store, 'raise-precision', params));
    res.json(change);
  }));
}

/**
 * @description Ingest, purge and member-share routes.
 * @param router - The location router.
 * @param pool - The pool.
 * @param store - The step-up store.
 * @param minIntervalMs - The minimum ingest interval.
 * @param rails - The delivery rails the after-commit dispatcher uses.
 * @returns Nothing.
 */
function mountDataRoutes(router: Router, pool: Pool, store: LocationStepUpStore, minIntervalMs: number, rails: LocationDeliveryRails): void {
  const onFired = createLocationDispatcher(pool, rails);
  router.post('/presence', guarded(async (req, res) => {
    const fix = parseBrowserFix(req.body);
    res.status(201).json(await ingestBrowserFix(pool, locationContext(res).principal, fix, { minIntervalMs, onFired }));
  }));
  router.post('/history/purge', guarded(async (_req, res) => {
    res.json(await purgeOwnLocationHistory(pool, locationContext(res).principal));
  }));
  router.post('/shares', guarded(async (req, res) => {
    const request = parseShareRequest(req.body);
    requireStepUp(req, res, store, 'accept-share', request);
    res.status(201).json(await acceptMemberShare(pool, locationContext(res).principal, request));
  }));
  router.post('/shares/:shareId/revoke', guarded(async (req, res) => {
    res.json(await revokeMemberShare(pool, locationContext(res).principal, req.params.shareId));
  }));
}

/**
 * @description The /api/location router (ADR-169 L3). Mount it behind requiresAuth; it refuses the
 * service-secret rail itself and admits only an interactive browser session with a verified issuer.
 * @param options - Pool, step-up store, ingest interval, delivery rails and the recovery sweep interval.
 * @returns The router.
 */
export function createLocationRoutes(options: LocationRoutesOptions): Router {
  const store = options.stepUpStore ?? locationStepUpStore;
  const router = Router();
  router.use(refuseLocationServiceRail);
  router.use(express.json({ limit: '16kb' }));
  // The device ingest (ADR-169 L6) sits before the browser gate: its caller is a device under its
  // location credential, which the route itself requires; nothing else is admitted there.
  const minIntervalMs = options.ingestMinIntervalMs ?? locationIngestMinIntervalFromEnv();
  mountLocationDeviceIngestRoute(router, options.pool, guarded, minIntervalMs);
  router.use(requireLocationBrowserSession());
  router.use(LOCATION_STEP_UP_BASE, createLocationStepUpRoutes({
    store, pool: options.pool, normalizers: LOCATION_STEP_UP_NORMALIZERS, donePath: LOCATION_SETTINGS_PAGE,
  }));
  mountConsentRoutes(router, options.pool, store);
  const rails = options.deliveryRails ?? defaultLocationDeliveryRails(options.pool);
  mountDataRoutes(router, options.pool, store, minIntervalMs, rails);
  mountLocationPlaceRoutes(router, options.pool, guarded);
  const spend = (req: Request, res: Response, operation: LocationStepUpOperation, params: unknown): true => requireStepUp(req, res, store, operation, params);
  mountLocationRuleRoutes(router, options.pool, guarded, spend);
  mountLocationCredentialRoute(router, options.pool, guarded, spend);
  if (options.dispatchSweepMs) startLocationDispatchSweep(options.pool, rails, options.dispatchSweepMs);
  log.info({ op: 'mount', outcome: 'ok', count: Object.keys(LOCATION_ROUTE_POLICY).length }, 'location routes ready');
  return router;
}
