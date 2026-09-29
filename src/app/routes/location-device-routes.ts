/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: the core device ingest route and the credential route of the one /api/location router. POST /devices/:deviceId/presence is mounted BEFORE the browser-session gate and admits exactly one kind of caller: a location credential whose binding the token-auth middleware stamped for this very device (readLocationTokenBinding). The service secret is already 401 at the mount; a browser session, an account PAT, a TV or guest token and a node token all arrive without the binding and are refused with 401 device_credential_required; a credential bound to a different device never reaches the router (its scope refuses the path) and is refused here again if it somehow did. The ingest service then checks the token id against location_devices.credential_id and the token's user against the device's owner or group admins, and writes as 'device:<id>'. POST /devices/:deviceId/credential is a browser-session route behind the step-up proof (operation approve-enrolment, bound to the device id and the precision class); it issues or rotates the credential and returns the plaintext once. Both are declared in LOCATION_ROUTE_POLICY. This file is a machine-authenticated entry point and is inventoried in tests/helpers/machine-write-inventory.ts.
 *
 * @module app/routes/location-device-routes
 */

import type { Request, Router } from 'express';
import type { Pool } from 'pg';
import type { LocationPrincipal } from '@/features/location';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { readLocationTokenBinding } from './cli-token-routes';
import {
  ingestDeviceFix, issueLocationDeviceCredential, normalizeEnrolmentApproval, parseDeviceFix, type DeviceIngestCaller,
} from '../location-device-ingest';
import { LocationRequestError } from '../location-request';
import type { GuardedLocationHandler } from './location-place-routes';
import type { LocationStepUpSpender } from './location-rule-routes';
import { locationContext } from './location-session';

/** @description The route policy rows for this file, merged into LOCATION_ROUTE_POLICY. */
export const LOCATION_DEVICE_ROUTE_POLICY = Object.freeze({
  'POST /devices/:deviceId/presence': {
    stepUp: null,
    why: 'Accepted only under the exact location credential recorded for the device; a browser session, the service secret, a node token and an account token are each refused.',
  },
  'POST /devices/:deviceId/credential': {
    stepUp: 'approve-enrolment' as const, when: 'always' as const,
    why: 'Issuing a device credential starts that device reporting (issuing again rotates it).',
  },
} as const);

/**
 * @description The device ingest's caller: the location credential binding the middleware stamped
 * for this device, and the token's user with their verified issuer. Anything else is refused.
 * @param req - The request.
 * @returns The binding and the user.
 * @throws {LocationRequestError} 401 device_credential_required, 403 device_mismatch or verified_issuer_required.
 */
export function requireLocationDeviceCredential(req: Request): DeviceIngestCaller {
  const binding = readLocationTokenBinding(req);
  if (!binding) {
    throw new LocationRequestError('device_credential_required', 401,
      'A device reports its position under its own location credential; no other sign-in is accepted here.');
  }
  if (binding.deviceId !== String(req.params.deviceId ?? '')) {
    throw new LocationRequestError('device_mismatch', 403, 'This credential is bound to a different device.');
  }
  const sub = getCaller(req).sub;
  const principalIssuer = getAuthenticatedPrincipalIssuer(req);
  if (!sub || !principalIssuer) {
    throw new LocationRequestError('verified_issuer_required', 403, 'This credential carries no verified identity provider.');
  }
  const user: LocationPrincipal = { sub, principalIssuer };
  return { binding, user };
}

/**
 * @description Mount the device ingest on the location router, before its browser-session gate.
 * @param router - The /api/location router (after the service-rail refusal and the JSON parser).
 * @param pool - The pool.
 * @param guarded - The router's error-mapping wrapper.
 * @param minIntervalMs - The minimum interval between two accepted fixes from one device.
 * @returns Nothing.
 */
export function mountLocationDeviceIngestRoute(router: Router, pool: Pool, guarded: GuardedLocationHandler, minIntervalMs: number): void {
  router.post('/devices/:deviceId/presence', guarded(async (req, res) => {
    const caller = requireLocationDeviceCredential(req);
    res.status(201).json(await ingestDeviceFix(pool, caller, parseDeviceFix(req.body), { minIntervalMs }));
  }));
}

/**
 * @description Mount the credential route on the location router, after its browser-session gate.
 * @param router - The /api/location router.
 * @param pool - The pool.
 * @param guarded - The router's error-mapping wrapper.
 * @param spend - The router's step-up spender.
 * @returns Nothing.
 */
export function mountLocationCredentialRoute(router: Router, pool: Pool, guarded: GuardedLocationHandler, spend: LocationStepUpSpender): void {
  router.post('/devices/:deviceId/credential', guarded(async (req, res) => {
    const approval = normalizeEnrolmentApproval({ deviceId: req.params.deviceId, precisionClass: req.body?.precisionClass });
    spend(req, res, 'approve-enrolment', approval);
    res.status(201).json(await issueLocationDeviceCredential(pool, locationContext(res).principal, approval));
  }));
}
