/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — coordinated fleet
 *                     |                             | missions (ADR-099 decision #2): pure normalization of an
 *                     |                             | untrusted fleet draft ({droneId → plan} assignments) plus
 *                     |                             | the deterministic pairwise separation validator. Like the
 *                     |                             | single-drone gate, this runs controller-side BEFORE any
 *                     |                             | vehicle sees a command — LLM-drafted and hand-built fleet
 *                     |                             | plans face the identical check.
 */

import type { GeoPoint, MissionPlan } from '../model/drone-types';
import { normalizeMissionDraft } from './mission-draft';
import { DRONE_ID_RE } from './drone-fleet';

/** Minimum vertical gap between two drones' altitude bands when their paths come close. */
export const MIN_VERTICAL_SEPARATION_M = 10;
/** Minimum horizontal gap between two drones' cruise polylines when altitude bands overlap. */
export const MIN_HORIZONTAL_SEPARATION_M = 20;
/** Hard cap on drones per fleet mission — bounded fan-out, matching the fleet-size spirit. */
export const MAX_FLEET_ASSIGNMENTS = 8;

const M_PER_DEG_LAT = 111320;

/** One drone's share of a fleet mission: which vehicle flies which validated plan. */
export interface FleetAssignment {
  droneId: string;
  plan: MissionPlan;
}

/**
 * @description A coordinated multi-drone mission: one named order, one plan per drone.
 * Stored in `drone_missions.plan` as-is; the `assignments` array is what distinguishes a
 * fleet plan from a single {@link MissionPlan} at every branch point.
 */
export interface FleetMissionPlan {
  name: string;
  assignments: FleetAssignment[];
}

/** The outcome of normalizing an untrusted fleet draft: a typed plan, or the reasons not. */
export interface FleetMissionDraftResult {
  plan: FleetMissionPlan | null;
  errors: string[];
}

/**
 * @description Whether an untrusted mission-shaped object is a FLEET plan (has an
 * `assignments` array) rather than a single-drone plan. The single branch predicate used by
 * the routes so stored fleet and single missions share one table and one execute endpoint.
 * @param raw - The candidate object (already JSON-parsed).
 * @returns True when the object should normalize via {@link normalizeFleetMissionDraft}.
 */
export function isFleetMissionShape(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).assignments);
}

/**
 * @description Normalize an untrusted fleet draft (concierge JSON or surface input) into a
 * typed {@link FleetMissionPlan}. Structural coercion only — each assignment's plan goes
 * through the same {@link normalizeMissionDraft} as a single mission, droneIds are
 * shape-checked and deduplicated, and the assignment count is bounded. Geofence and
 * separation checking stay in the validators so every path faces the identical safety gate.
 * @param raw - The candidate object (already JSON-parsed).
 * @returns The typed fleet plan, or null plus per-assignment errors.
 */
export function normalizeFleetMissionDraft(raw: unknown): FleetMissionDraftResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { plan: null, errors: ['fleet mission draft is not an object'] };
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.assignments) || o.assignments.length === 0) {
    return { plan: null, errors: ['fleet mission draft has no assignments array'] };
  }
  if (o.assignments.length > MAX_FLEET_ASSIGNMENTS) {
    return { plan: null, errors: [`fleet mission has ${o.assignments.length} assignments — the limit is ${MAX_FLEET_ASSIGNMENTS}`] };
  }
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : 'Fleet mission';
  const errors: string[] = [];
  const assignments: FleetAssignment[] = [];
  const seen = new Set<string>();
  o.assignments.forEach((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      errors.push(`assignment ${i + 1} is not an object`);
      return;
    }
    const rec = a as Record<string, unknown>;
    const droneId = typeof rec.droneId === 'string' ? rec.droneId.trim() : '';
    if (!DRONE_ID_RE.test(droneId)) {
      errors.push(`assignment ${i + 1} is missing a valid droneId`);
      return;
    }
    if (seen.has(droneId)) {
      errors.push(`drone "${droneId}" appears in more than one assignment`);
      return;
    }
    seen.add(droneId);
    // Accept BOTH assignment shapes so normalization is idempotent: the concierge drafts
    // waypoints inline on the assignment; a STORED FleetAssignment nests them under `plan`.
    // Execute-time re-validation runs stored rows back through this exact function.
    const source = rec.plan && typeof rec.plan === 'object' && !Array.isArray(rec.plan)
      ? (rec.plan as Record<string, unknown>)
      : rec;
    const { plan, errors: planErrors } = normalizeMissionDraft(source);
    if (!plan) {
      planErrors.forEach((e) => errors.push(`assignment ${i + 1} (${droneId}): ${e}`));
      return;
    }
    // An unnamed member plan inherits the fleet name so audit rows and telemetry read well.
    if (!(typeof source.name === 'string' && source.name.trim())) plan.name = `${name} · ${droneId}`;
    assignments.push({ droneId, plan });
  });
  if (errors.length) return { plan: null, errors };
  return { plan: { name, assignments }, errors: [] };
}

/**
 * @description Deterministic pairwise deconfliction for a fleet plan. Two assignments are
 * compatible when their altitude bands are vertically separated by at least
 * {@link MIN_VERTICAL_SEPARATION_M}, OR their cruise polylines never come within
 * {@link MIN_HORIZONTAL_SEPARATION_M} horizontally. Honesty boundary: separation is
 * evaluated over the waypoint legs (cruise phase) — takeoff, landing, and RTL are NOT
 * deconflicted here, so co-located launch pads should use altitude-layered plans or
 * staggered launches for those phases.
 * @param assignments - The normalized fleet assignments.
 * @returns Human-readable violations; empty means the fleet is separated.
 */
export function validateFleetSeparation(assignments: FleetAssignment[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < assignments.length; i++) {
    for (let j = i + 1; j < assignments.length; j++) {
      const a = assignments[i];
      const b = assignments[j];
      const vSep = verticalBandSeparationM(a.plan.waypoints, b.plan.waypoints);
      if (vSep >= MIN_VERTICAL_SEPARATION_M) continue;
      const hSep = minPolylineDistanceM(a.plan.waypoints, b.plan.waypoints);
      if (hSep >= MIN_HORIZONTAL_SEPARATION_M) continue;
      errors.push(
        `drones "${a.droneId}" and "${b.droneId}" come within ${Math.round(hSep)}m horizontally with only ` +
        `${Math.round(vSep)}m vertical separation — plans need ≥${MIN_HORIZONTAL_SEPARATION_M}m horizontal or ` +
        `≥${MIN_VERTICAL_SEPARATION_M}m vertical separation`,
      );
    }
  }
  return errors;
}

/** @returns The vertical gap between two waypoint sets' altitude bands (0 when they overlap). */
function verticalBandSeparationM(a: GeoPoint[], b: GeoPoint[]): number {
  const bandA = altitudeBand(a);
  const bandB = altitudeBand(b);
  if (bandA.min > bandB.max) return bandA.min - bandB.max;
  if (bandB.min > bandA.max) return bandB.min - bandA.max;
  return 0;
}

function altitudeBand(wps: GeoPoint[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const wp of wps) {
    if (wp.alt < min) min = wp.alt;
    if (wp.alt > max) max = wp.alt;
  }
  return { min, max };
}

/**
 * @description Minimum horizontal distance between two waypoint polylines, in meters.
 * Computed segment-to-segment in a local ENU frame (single-waypoint plans degrade to
 * points) so crossings BETWEEN waypoints are caught, not just close waypoints.
 * @param a - First polyline (lat/lon used; alt ignored).
 * @param b - Second polyline.
 * @returns Meters of closest horizontal approach.
 */
export function minPolylineDistanceM(a: GeoPoint[], b: GeoPoint[]): number {
  const ref = a[0];
  const toXy = (p: GeoPoint): { x: number; y: number } => ({
    x: (p.lon - ref.lon) * M_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180),
    y: (p.lat - ref.lat) * M_PER_DEG_LAT,
  });
  const pa = a.map(toXy);
  const pb = b.map(toXy);
  let min = Infinity;
  for (let i = 0; i < Math.max(1, pa.length - 1); i++) {
    const a1 = pa[i];
    const a2 = pa[Math.min(i + 1, pa.length - 1)];
    for (let j = 0; j < Math.max(1, pb.length - 1); j++) {
      const b1 = pb[j];
      const b2 = pb[Math.min(j + 1, pb.length - 1)];
      min = Math.min(min, segmentDistance(a1, a2, b1, b2));
      if (min === 0) return 0;
    }
  }
  return min;
}

type Xy = { x: number; y: number };

/** @returns The minimum distance between two 2D segments (0 when they intersect). */
function segmentDistance(a1: Xy, a2: Xy, b1: Xy, b2: Xy): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2),
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2),
  );
}

function pointSegmentDistance(p: Xy, s1: Xy, s2: Xy): number {
  const dx = s2.x - s1.x;
  const dy = s2.y - s1.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s1.x) * dx + (p.y - s1.y) * dy) / lenSq));
  const cx = s1.x + t * dx;
  const cy = s1.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function segmentsIntersect(a1: Xy, a2: Xy, b1: Xy, b2: Xy): boolean {
  const cross = (o: Xy, p: Xy, q: Xy): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  // Proper crossing only — collinear/degenerate overlaps fall through to the endpoint
  // distances in segmentDistance, which are exact for those cases.
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
