/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Fleet Show patterns:
 *                     |                             | deterministic multi-drone choreography generators (box-split
 *                     |                             | survey, orbit carousel, delta transit). Pure code, no LLM:
 *                     |                             | plans are altitude-layered and separation-safe by
 *                     |                             | construction, then STILL pass the normal fleet gate
 *                     |                             | (fence per drone + separation validator) and land as
 *                     |                             | ordinary drafts — the human Execute rail is unchanged.
 */

import type { GeoPoint, MissionWaypoint } from '../model/drone-types';
import type { FleetMissionPlan } from './fleet-mission';
import { MIN_VERTICAL_SEPARATION_M, MAX_FLEET_ASSIGNMENTS } from './fleet-mission';

/** Highest altitude a generated layer may use — just under the default 120m fence ceiling. */
const ALT_CEILING_M = 118;
const MIN_SIZE_M = 20;
const MAX_SIZE_M = 800;
const DELTA_WING_SPACING_M = 25;
const ORBIT_POINTS = 8;
const M_PER_DEG_LAT = 111320;

/** One choreography the surface can offer. Bounds are per pattern, then fleet-capped. */
export interface FleetPatternSpec {
  id: string;
  name: string;
  description: string;
  minDrones: number;
  maxDrones: number;
}

/** The catalog the surface renders. Order = display order. */
export const FLEET_PATTERNS: FleetPatternSpec[] = [
  {
    id: 'box-split',
    name: 'Box-split survey',
    description: 'One square survey area split into horizontal bands — each drone sweeps its own band at its own altitude layer.',
    minDrones: 2,
    maxDrones: MAX_FLEET_ASSIGNMENTS,
  },
  {
    id: 'orbit-carousel',
    name: 'Orbit carousel',
    description: 'All drones ride one circle at evenly spaced phases, stacked in altitude — a rotating carousel over the launch area.',
    minDrones: 2,
    maxDrones: MAX_FLEET_ASSIGNMENTS,
  },
  {
    id: 'delta-transit',
    name: 'Delta transit',
    description: 'A V formation flies out and back — leader in the middle, wings staggered wider and higher.',
    minDrones: 2,
    maxDrones: MAX_FLEET_ASSIGNMENTS,
  },
];

/** Inputs for one generation. `drones` come from the LIVE fleet (id + that drone's home). */
export interface FleetPatternOptions {
  patternId: string;
  drones: Array<{ droneId: string; home: GeoPoint }>;
  /** Pattern footprint: square side (box), circle diameter (orbit), leg length (delta). */
  sizeM?: number;
  /** Lowest altitude layer, meters AGL. */
  altBaseM?: number;
  /** Vertical gap between layers; auto-shrunk to fit the ceiling, never below separation minimum. */
  altStepM?: number;
  speedMps?: number;
}

/** The outcome of generating a pattern: a fleet plan, or the reasons there isn't one. */
export interface FleetPatternResult {
  plan: FleetMissionPlan | null;
  errors: string[];
}

/**
 * @description Generate a coordinated fleet plan from a pattern id — deterministic
 * choreography with altitude layering baked in, centered on the participating drones'
 * centroid. The result is a plain {@link FleetMissionPlan}: callers run it through the
 * standard fleet gate (fence per drone + separation validator) and store it as a DRAFT, so
 * a generated show follows the exact draft → human-approve → execute doctrine as any other
 * mission. Nothing here actuates.
 * @param opts - Pattern id, participating drones (with their homes), and dimensions.
 * @returns The generated plan, or null plus every input problem found.
 */
export function generateFleetPattern(opts: FleetPatternOptions): FleetPatternResult {
  const spec = FLEET_PATTERNS.find((p) => p.id === opts.patternId);
  if (!spec) return { plan: null, errors: [`unknown fleet pattern "${opts.patternId}"`] };
  const n = opts.drones.length;
  const errors: string[] = [];
  if (n < spec.minDrones || n > spec.maxDrones) {
    errors.push(`${spec.name} needs ${spec.minDrones}–${spec.maxDrones} drones — got ${n}`);
  }
  const sizeM = opts.sizeM ?? 160;
  if (!Number.isFinite(sizeM) || sizeM < MIN_SIZE_M || sizeM > MAX_SIZE_M) {
    errors.push(`sizeM ${opts.sizeM} is outside ${MIN_SIZE_M}–${MAX_SIZE_M}m`);
  }
  const altBaseM = opts.altBaseM ?? 30;
  if (!Number.isFinite(altBaseM) || altBaseM < 2 || altBaseM > ALT_CEILING_M) {
    errors.push(`altBaseM ${opts.altBaseM} is outside 2–${ALT_CEILING_M}m`);
  }
  if (errors.length) return { plan: null, errors };

  // Fit the layers under the ceiling; refuse a stack tighter than the separation minimum
  // (the separation validator would reject it anyway — fail here with a better message).
  let altStepM = opts.altStepM ?? 12;
  if (n > 1 && altBaseM + (n - 1) * altStepM > ALT_CEILING_M) {
    altStepM = Math.floor((ALT_CEILING_M - altBaseM) / (n - 1));
  }
  if (n > 1 && altStepM < MIN_VERTICAL_SEPARATION_M) {
    return {
      plan: null,
      errors: [`${n} drones cannot stack ≥${MIN_VERTICAL_SEPARATION_M}m apart between ${altBaseM}m and ${ALT_CEILING_M}m — fewer drones or a lower base altitude`],
    };
  }

  const speedMps = opts.speedMps ?? 8;
  const center = centroid(opts.drones.map((d) => d.home));
  const layerAlt = (i: number): number => altBaseM + i * altStepM;
  const generators: Record<string, (i: number) => MissionWaypoint[]> = {
    'box-split': (i) => boxBand(center, sizeM, n, i, layerAlt(i)),
    'orbit-carousel': (i) => orbitRing(center, sizeM / 2, n, i, layerAlt(i)),
    'delta-transit': (i) => deltaLeg(center, sizeM, i, layerAlt(i)),
  };
  const gen = generators[spec.id];
  return {
    plan: {
      name: `Fleet show — ${spec.name} (${n} drones)`,
      assignments: opts.drones.map((d, i) => ({
        droneId: d.droneId,
        plan: {
          name: `${spec.name} · ${d.droneId}`,
          waypoints: gen(i),
          speedMps,
          rtlAfterMission: true,
        },
      })),
    },
    errors: [],
  };
}

function centroid(points: GeoPoint[]): GeoPoint {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon, alt: 0 };
}

/** A point at metric east/north offsets from `center`, at `alt` meters AGL. */
function offset(center: GeoPoint, eastM: number, northM: number, alt: number): MissionWaypoint {
  return {
    lat: center.lat + northM / M_PER_DEG_LAT,
    lon: center.lon + eastM / (M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180)),
    alt,
  };
}

/** Drone i's horizontal band of an N-way split square: a west→east→west sweep loop. */
function boxBand(center: GeoPoint, sideM: number, n: number, i: number, alt: number): MissionWaypoint[] {
  const half = sideM / 2;
  const bandH = sideM / n;
  const yTop = half - i * bandH;
  const yBot = yTop - bandH;
  return [
    offset(center, -half, yTop, alt),
    offset(center, half, yTop, alt),
    offset(center, half, yBot, alt),
    offset(center, -half, yBot, alt),
  ];
}

/** Drone i's lap of the carousel: the same circle, phase-shifted by i/n of a turn. */
function orbitRing(center: GeoPoint, radiusM: number, n: number, i: number, alt: number): MissionWaypoint[] {
  const phase = (i / n) * 2 * Math.PI;
  const points: MissionWaypoint[] = [];
  for (let k = 0; k <= ORBIT_POINTS; k++) {
    const a = phase + (k / ORBIT_POINTS) * 2 * Math.PI;
    points.push(offset(center, Math.cos(a) * radiusM, Math.sin(a) * radiusM, alt));
  }
  return points;
}

/** Drone i's slot of the V: leader center, wings staggered ±25m, ±50m… out and back. */
function deltaLeg(center: GeoPoint, legM: number, i: number, alt: number): MissionWaypoint[] {
  const east = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * DELTA_WING_SPACING_M;
  // Wings trail the leader slightly so the V reads as a V on the map.
  const trail = -Math.ceil(i / 2) * (DELTA_WING_SPACING_M / 2);
  return [
    offset(center, east, trail, alt),
    offset(center, east, trail + legM, alt),
    offset(center, east, trail, alt),
  ];
}
