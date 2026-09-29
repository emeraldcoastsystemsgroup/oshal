/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: the places and device-enrolment routes of the one /api/location router (mounted by createLocationRoutes, behind its service-rail refusal and browser-session principal; declared in LOCATION_ROUTE_POLICY). Places: list (no centre, no address text), create, change and delete, a person's own or, for a group admin, the group's. Devices: list the placed devices and the nodes the person owns, enrol an existing node, camera, drone, TV or hub device, set or clear its assigned place and room, and remove its location record. None of these spends a step-up proof: they create no reporting and expose no person's position (D3 lists the routes that raise exposure; these are not among them). Every service runs as the session person with is_operator off, so row-level security and migration 176's identity fence decide; the services turn a refusal into a coded answer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The exported GuardedLocationHandler type's doc comment carries @description, as every exported member's must.
 *
 * @module app/routes/location-place-routes
 */

import type { Request, Response, Router } from 'express';
import type { Pool } from 'pg';
import { enrolPlacedDevice, listPlacedDevices, parseEnrolInput, setPlacedDevicePlace, unenrolPlacedDevice } from '../location-devices';
import {
  createLocationPlace, deleteLocationPlace, listLocationPlaces, parsePlaceInput, updateLocationPlace,
} from '../location-places';
import { locationContext } from './location-session';

/** @description A location handler wrapped so every refusal and failure is answered by the router's one error mapper. */
export type GuardedLocationHandler = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => void;

/** @description The route policy rows for this file, merged into LOCATION_ROUTE_POLICY. */
export const LOCATION_PLACE_ROUTE_POLICY = Object.freeze({
  'GET /places': { stepUp: null, why: 'Lists the person\'s and their groups\' places by name, label and radius; no centre and no address.' },
  'POST /places': { stepUp: null, why: 'Creates a place; it starts no reporting and names no one\'s position. A group place needs its admin.' },
  'PUT /places/:placeId': { stepUp: null, why: 'Changes a place the person owns or administers; a group share over it must be re-accepted when its geometry changes.' },
  'DELETE /places/:placeId': { stepUp: null, why: 'Deleting a place only reduces what can be evaluated.' },
  'GET /devices': { stepUp: null, why: 'Lists placed devices the person or their groups own, and the nodes the person owns.' },
  'POST /devices': { stepUp: null, why: 'Records who owns an existing device\'s location data; reporting stays off and no control right is granted.' },
  'PUT /devices/:deviceId/place': { stepUp: null, why: 'Sets a stationary device\'s place; only its owner or a group admin may.' },
  'DELETE /devices/:deviceId': { stepUp: null, why: 'Removing a location record only reduces exposure.' },
} as const);

/**
 * @description Mount the places and device-enrolment routes on the location router.
 * @param router - The /api/location router (after its session gate).
 * @param pool - The pool.
 * @param guarded - The router's error-mapping wrapper.
 * @returns Nothing.
 */
export function mountLocationPlaceRoutes(router: Router, pool: Pool, guarded: GuardedLocationHandler): void {
  router.get('/places', guarded(async (_req, res) => {
    res.json(await listLocationPlaces(pool, locationContext(res).principal));
  }));
  router.post('/places', guarded(async (req, res) => {
    res.status(201).json({ place: await createLocationPlace(pool, locationContext(res).principal, parsePlaceInput(req.body, 'create')) });
  }));
  router.put('/places/:placeId', guarded(async (req, res) => {
    const input = parsePlaceInput(req.body, 'update');
    res.json({ place: await updateLocationPlace(pool, locationContext(res).principal, req.params.placeId, input) });
  }));
  router.delete('/places/:placeId', guarded(async (req, res) => {
    res.json(await deleteLocationPlace(pool, locationContext(res).principal, req.params.placeId));
  }));
  router.get('/devices', guarded(async (_req, res) => {
    res.json(await listPlacedDevices(pool, locationContext(res).principal));
  }));
  router.post('/devices', guarded(async (req, res) => {
    const principal = locationContext(res).principal;
    res.status(201).json({ device: await enrolPlacedDevice(pool, principal, parseEnrolInput(req.body, principal)) });
  }));
  router.put('/devices/:deviceId/place', guarded(async (req, res) => {
    res.json({ device: await setPlacedDevicePlace(pool, locationContext(res).principal, req.params.deviceId, req.body) });
  }));
  router.delete('/devices/:deviceId', guarded(async (req, res) => {
    res.json(await unenrolPlacedDevice(pool, locationContext(res).principal, req.params.deviceId));
  }));
}
