/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — pure geofence + mission
 *                     |                             | validation for the Drone Ops app (ADR-098). Every flight
 *                     |                             | command passes through here BEFORE it reaches a provider,
 *                     |                             | so the same checks guard the sim today and MAVLink later.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | normalizeCameraAction — the one shared
 *                     |                             | coercion+validation gate for camera-equipment actions, so
 *                     |                             | drafts, manual commands, and the node hop all face the
 *                     |                             | same shape rules (isLedColor precedent).
 */

import type { CameraAction, CameraCapture, GeoPoint, Geofence, MissionPlan, MissionWaypoint } from '../model/drone-types';

/** Hard command limits, independent of the configurable geofence. */
export const MIN_SPEED_MPS = 0.5;
export const MAX_SPEED_MPS = 15;
export const MAX_WAYPOINTS = 50;
export const MAX_HOLD_SECONDS = 300;

/**
 * @description Whether a string is an acceptable LED equipment color: '#rrggbb', a plain
 * CSS color name, or 'off' (clears the light). One validator shared by drafts and the
 * manual LED command so no path accepts markup-capable strings.
 * @param color - The candidate color.
 * @returns True when safe to store and render.
 */
export function isLedColor(color: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(color) || /^[a-z]{3,20}$/i.test(color);
}

const CAMERA_OPS = ['photo', 'record', 'stop', 'aim'] as const;
export const CAMERA_PAN_LIMIT_DEG = 180;
export const CAMERA_TILT_MIN_DEG = -90;
export const CAMERA_TILT_MAX_DEG = 30;

/**
 * @description Normalize an untrusted camera-action object into a typed {@link CameraAction}.
 * The single gate every path shares — mission drafts, show slots, the manual camera command,
 * and the drone-node hop — so no layer can smuggle an unknown op or an out-of-range gimbal
 * angle to an engine. Rejects rather than clamps: a validator reports, it never guesses.
 * @param raw - The candidate object.
 * @returns The typed action, or null plus every shape problem found.
 */
export function normalizeCameraAction(raw: unknown): { action: CameraAction | null; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { action: null, errors: ['camera action is not an object'] };
  }
  const o = raw as Record<string, unknown>;
  const op = String(o.op ?? '');
  if (!(CAMERA_OPS as readonly string[]).includes(op)) {
    return { action: null, errors: [`camera op "${op}" is not one of ${CAMERA_OPS.join('/')}`] };
  }
  const errors: string[] = [];
  const action: CameraAction = { op: op as CameraAction['op'] };
  if (o.panDeg !== undefined) {
    const pan = Number(o.panDeg);
    if (!Number.isFinite(pan) || pan < -CAMERA_PAN_LIMIT_DEG || pan > CAMERA_PAN_LIMIT_DEG) {
      errors.push(`camera panDeg ${String(o.panDeg)} is outside ±${CAMERA_PAN_LIMIT_DEG}`);
    } else {
      action.panDeg = pan;
    }
  }
  if (o.tiltDeg !== undefined) {
    const tilt = Number(o.tiltDeg);
    if (!Number.isFinite(tilt) || tilt < CAMERA_TILT_MIN_DEG || tilt > CAMERA_TILT_MAX_DEG) {
      errors.push(`camera tiltDeg ${String(o.tiltDeg)} is outside ${CAMERA_TILT_MIN_DEG}..${CAMERA_TILT_MAX_DEG}`);
    } else {
      action.tiltDeg = tilt;
    }
  }
  return errors.length ? { action: null, errors } : { action, errors: [] };
}

/**
 * @description Coerce an untrusted camera-capture record (arriving from a REMOTE drone node's
 * heartbeat) into a strictly-typed {@link CameraCapture} with every field forced to a number
 * or a whitelisted string. The surface renders capture fields, so a compromised or hostile
 * node must not be able to smuggle markup (or any non-numeric value) through them — this is
 * the ingest-side gate that makes the whole captures path injection-proof regardless of what
 * the client does with the values. Returns null for anything that can't be made a valid record.
 * @param raw - The candidate object from the heartbeat.
 * @returns The clean capture, or null if it is unusable.
 */
export function normalizeCameraCapture(raw: unknown): CameraCapture | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind === 'video' ? 'video' : o.kind === 'photo' ? 'photo' : null;
  const seq = Number(o.seq);
  const ts = Number(o.ts);
  if (!kind || !Number.isFinite(seq) || seq <= 0 || !Number.isFinite(ts)) return null;
  const pos = (o.position || {}) as Record<string, unknown>;
  const lat = Number(pos.lat), lon = Number(pos.lon), alt = Number(pos.alt);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) return null;
  const numOr = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const capture: CameraCapture = {
    seq, ts, kind,
    position: { lat, lon, alt },
    headingDeg: numOr(o.headingDeg),
    panDeg: numOr(o.panDeg),
    tiltDeg: numOr(o.tiltDeg),
  };
  if (o.durationS !== undefined && Number.isFinite(Number(o.durationS))) capture.durationS = Number(o.durationS);
  return capture;
}

const EARTH_RADIUS_M = 6371000;

/**
 * @description Great-circle distance between two points, ignoring altitude.
 * @param a - First point.
 * @param b - Second point.
 * @returns Horizontal distance in meters.
 */
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

/**
 * @description Validate a single target point against the geofence cylinder around home.
 * @param pt - The commanded point (alt in meters AGL).
 * @param fence - The active geofence.
 * @param home - The launch point the fence is centered on.
 * @returns Human-readable violations; empty means the point is flyable.
 */
export function validatePoint(pt: GeoPoint, fence: Geofence, home: GeoPoint): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(pt.lat) || pt.lat < -90 || pt.lat > 90) errors.push(`latitude ${pt.lat} is not a valid coordinate`);
  if (!Number.isFinite(pt.lon) || pt.lon < -180 || pt.lon > 180) errors.push(`longitude ${pt.lon} is not a valid coordinate`);
  if (!Number.isFinite(pt.alt)) errors.push('altitude is not a number');
  if (errors.length) return errors;
  if (pt.alt > fence.maxAltM) errors.push(`altitude ${pt.alt}m exceeds the ${fence.maxAltM}m geofence ceiling`);
  if (pt.alt < fence.minAltM) errors.push(`altitude ${pt.alt}m is below the ${fence.minAltM}m geofence floor`);
  const dist = haversineM(pt, home);
  if (dist > fence.maxRadiusM) {
    errors.push(`point is ${Math.round(dist)}m from home — beyond the ${fence.maxRadiusM}m geofence radius`);
  }
  return errors;
}

/**
 * @description Validate a commanded cruise speed against the hard platform limits.
 * @param speedMps - Requested ground speed.
 * @returns Violations; empty means acceptable.
 */
export function validateSpeed(speedMps: number): string[] {
  if (!Number.isFinite(speedMps) || speedMps < MIN_SPEED_MPS || speedMps > MAX_SPEED_MPS) {
    return [`speed ${speedMps} m/s is outside the allowed ${MIN_SPEED_MPS}–${MAX_SPEED_MPS} m/s range`];
  }
  return [];
}

/**
 * @description Validate a full mission plan: shape, waypoint count, per-waypoint geofence
 * compliance, hold times, and speed. This is the single gate both the map editor and the
 * concierge-drafted missions pass through before execution.
 * @param plan - The candidate mission.
 * @param fence - The active geofence.
 * @param home - The launch point.
 * @returns Violations; empty means the mission is executable.
 */
export function validateMission(plan: MissionPlan, fence: Geofence, home: GeoPoint): string[] {
  const errors: string[] = [];
  if (!plan.name || !plan.name.trim()) errors.push('mission name is required');
  if (!Array.isArray(plan.waypoints) || plan.waypoints.length === 0) {
    errors.push('mission has no waypoints');
    return errors;
  }
  if (plan.waypoints.length > MAX_WAYPOINTS) {
    errors.push(`mission has ${plan.waypoints.length} waypoints — the limit is ${MAX_WAYPOINTS}`);
  }
  errors.push(...validateSpeed(plan.speedMps));
  plan.waypoints.forEach((wp: MissionWaypoint, i: number) => {
    validatePoint(wp, fence, home).forEach((e) => errors.push(`waypoint ${i + 1}: ${e}`));
    if (wp.holdSeconds !== undefined && (!Number.isFinite(wp.holdSeconds) || wp.holdSeconds < 0 || wp.holdSeconds > MAX_HOLD_SECONDS)) {
      errors.push(`waypoint ${i + 1}: hold of ${wp.holdSeconds}s is outside 0–${MAX_HOLD_SECONDS}s`);
    }
  });
  return errors;
}
