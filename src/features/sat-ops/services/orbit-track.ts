/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W3:
 *                     |                             | SGP4 orbit-track sampler for the fleet plane. One
 *                     |                             | propagation loop yields BOTH the TEME/ECI vector (3D
 *                     |                             | console) and the geodetic subpoint (ground-track map).
 *                     |                             | Deterministic (caller supplies startUtcMs) and bounded
 *                     |                             | (TRACK_LIMITS caps the sample count — CPU-DoS defense,
 *                     |                             | same doctrine as PASS_LIMITS).
 */

import * as satellite from 'satellite.js';
import type { OrbitTrack, OrbitTrackOptions, OrbitTrackPoint } from '../model/orbit-types';
import type { ParsedTle } from './tle-parse';
import { PropagationError } from './pass-windows';

const DEG = 180 / Math.PI;
const MAX_UTC_MS = 4_102_444_800_000; // year-2100 guard (same as pass-windows)

/** Defaults applied when {@link OrbitTrackOptions} omit a field. */
export const TRACK_DEFAULTS = { durationMinutes: 95, stepSeconds: 30 } as const;

/** Hard input limits — the CPU-DoS defense. Relaxing any of these is a reviewed change. */
export const TRACK_LIMITS = {
  durationMinutesMax: 24 * 60,
  stepSecondsMin: 1,
  stepSecondsMax: 300,
  maxSamples: 10_000,
} as const;

/** Validate + resolve options. Throws plain Error → 400 at the route. */
function resolveTrackOptions(opts: OrbitTrackOptions): { durationMinutes: number; stepS: number } {
  if (!(Number.isFinite(opts.startUtcMs) && opts.startUtcMs >= 0 && opts.startUtcMs <= MAX_UTC_MS)) {
    throw new Error(`startUtcMs out of range: ${opts.startUtcMs}`);
  }
  const durationMinutes = opts.durationMinutes ?? TRACK_DEFAULTS.durationMinutes;
  if (!(durationMinutes > 0 && durationMinutes <= TRACK_LIMITS.durationMinutesMax)) {
    throw new Error(`durationMinutes must be in (0, ${TRACK_LIMITS.durationMinutesMax}], got ${durationMinutes}`);
  }
  const reqStep = opts.stepSeconds ?? TRACK_DEFAULTS.stepSeconds;
  if (!(reqStep >= TRACK_LIMITS.stepSecondsMin && reqStep <= TRACK_LIMITS.stepSecondsMax)) {
    throw new Error(`stepSeconds must be in [${TRACK_LIMITS.stepSecondsMin}, ${TRACK_LIMITS.stepSecondsMax}], got ${reqStep}`);
  }
  const stepS = Math.max(reqStep, (durationMinutes * 60) / TRACK_LIMITS.maxSamples);
  return { durationMinutes, stepS };
}

/** Propagate one epoch; throws {@link PropagationError} on SGP4 failure. */
function sampleAt(satrec: satellite.SatRec, tUtcMs: number): OrbitTrackPoint {
  const d = new Date(tUtcMs);
  const pv = satellite.propagate(satrec, d);
  if (!pv || pv.position === false || typeof pv.position === 'boolean' || satrec.error !== 0) {
    throw new PropagationError(`SGP4 propagation failed at ${new Date(tUtcMs).toISOString()} (satrec.error=${satrec.error})`);
  }
  const gmst = satellite.gstime(d);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  return {
    tUtcMs,
    eciKm: { x: pv.position.x, y: pv.position.y, z: pv.position.z },
    latDeg: geo.latitude * DEG,
    lonDeg: ((geo.longitude * DEG + 540) % 360) - 180, // normalize to [-180, 180)
    altKm: geo.height,
  };
}

/**
 * @description Sample one satellite's orbit over a window: TEME/ECI position for the 3D
 * console plus the geodetic subpoint for the ground-track map, from a single SGP4 loop.
 * Deterministic (no wall clock — `startUtcMs` is the caller's) and bounded by
 * {@link TRACK_LIMITS} regardless of inputs.
 * @param tle - A validated element set from parseTle.
 * @param opts - Window + cadence; `startUtcMs` is required.
 * @returns The sampled track with the effective cadence reported.
 */
export function computeOrbitTrack(tle: ParsedTle, opts: OrbitTrackOptions): OrbitTrack {
  const { durationMinutes, stepS } = resolveTrackOptions(opts);
  const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  if (satrec.error !== 0) throw new PropagationError(`satellite.js rejected the element set (satrec.error=${satrec.error})`);
  const points: OrbitTrackPoint[] = [];
  const endMs = opts.startUtcMs + durationMinutes * 60_000;
  for (let t = opts.startUtcMs; t <= endMs + 1e-6; t += stepS * 1000) {
    points.push(sampleAt(satrec, Math.min(t, endMs)));
    if (t >= endMs) break;
  }
  return {
    satnum: tle.satnum,
    satName: tle.name,
    startUtcMs: opts.startUtcMs,
    durationMinutes,
    stepSeconds: stepS,
    points,
  };
}
