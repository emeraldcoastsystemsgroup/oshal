/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — pure normalization of an
 *                     |                             | untrusted mission draft (LLM concierge output or surface
 *                     |                             | JSON) into a typed MissionPlan (ADR-098). Coercion only —
 *                     |                             | geofence checking stays in mission-validator so drafts and
 *                     |                             | hand-built missions face the identical safety gate.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Waypoints may carry a camera arrival
 *                     |                             | action — coerced through normalizeCameraAction so the node
 *                     |                             | hop (which re-normalizes missions defensively) can never
 *                     |                             | strip it (the 76b01f20 LED lesson, one layer down).
 */

import type { MissionPlan, MissionWaypoint } from '../model/drone-types';
import { isLedColor, normalizeCameraAction } from './mission-validator';

const DEFAULT_SPEED_MPS = 8;
const DEFAULT_NAME = 'Drafted mission';

/** The outcome of normalizing an untrusted draft: a typed plan, or the reasons there isn't one. */
export interface MissionDraftResult {
  plan: MissionPlan | null;
  errors: string[];
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * @description Normalize an untrusted mission-shaped object (the drone-operator concierge's
 * JSON, or raw surface input) into a typed {@link MissionPlan}. Structural coercion only:
 * numbers are coerced, defaults filled (name, speed, rtlAfterMission), malformed waypoints
 * reported. It never checks the geofence — callers run the result through validateMission
 * so LLM-drafted and human-built missions pass the exact same safety gate.
 * @param raw - The candidate object (already JSON-parsed).
 * @returns The typed plan, or null plus per-field errors.
 */
export function normalizeMissionDraft(raw: unknown): MissionDraftResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { plan: null, errors: ['mission draft is not an object'] };
  }
  const o = raw as Record<string, unknown>;
  const wpsRaw = o.waypoints;
  if (!Array.isArray(wpsRaw) || wpsRaw.length === 0) {
    return { plan: null, errors: ['mission draft has no waypoints array'] };
  }
  const waypoints: MissionWaypoint[] = [];
  wpsRaw.forEach((w, i) => {
    if (!w || typeof w !== 'object') {
      errors.push(`waypoint ${i + 1} is not an object`);
      return;
    }
    const wp = w as Record<string, unknown>;
    const lat = num(wp.lat);
    const lon = num(wp.lon);
    const alt = num(wp.alt);
    if (lat === null || lon === null || alt === null) {
      errors.push(`waypoint ${i + 1} is missing a numeric lat/lon/alt`);
      return;
    }
    const out: MissionWaypoint = { lat, lon, alt };
    const hold = num(wp.holdSeconds);
    if (hold !== null && hold > 0) out.holdSeconds = hold;
    const heading = num(wp.headingDeg);
    if (heading !== null) out.headingDeg = ((heading % 360) + 360) % 360;
    if (wp.led !== undefined) {
      const led = String(wp.led).toLowerCase();
      if (led !== 'off' && !isLedColor(led)) { errors.push(`waypoint ${i + 1}: invalid LED color "${led}"`); return; }
      out.led = led;
    }
    if (wp.camera !== undefined) {
      const { action, errors: camErrors } = normalizeCameraAction(wp.camera);
      if (!action) { camErrors.forEach((e) => errors.push(`waypoint ${i + 1}: ${e}`)); return; }
      out.camera = action;
    }
    waypoints.push(out);
  });
  if (errors.length) return { plan: null, errors };

  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : DEFAULT_NAME;
  const speed = num(o.speedMps);
  return {
    plan: {
      name,
      waypoints,
      speedMps: speed !== null ? speed : DEFAULT_SPEED_MPS,
      rtlAfterMission: o.rtlAfterMission === undefined ? true : Boolean(o.rtlAfterMission),
    },
    errors: [],
  };
}
