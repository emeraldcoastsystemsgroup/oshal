/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | SGP4 pass-window predictor over satellite.js ^5 (CJS —
 *                     |                             | v7 is ESM-only, verified; same trap as arangojs v10).
 *                     |                             | Deterministic: caller supplies startUtcMs, Date.now is
 *                     |                             | FORBIDDEN here. Coarse elevation scan (25k-sample CPU
 *                     |                             | bound) → bisection rise/set → golden-section culmination.
 *                     |                             | Azimuths evaluated at refined times, never interpolated
 *                     |                             | (0/360 wrap trap). satrec.error / position===false are
 *                     |                             | both checked — SGP4 signals decay, it does not throw.
 */

import * as satellite from 'satellite.js';
import { createChildLogger } from '@/shared/logger';
import type { GroundStation, PassPrediction, PassPredictionOptions, PassWindow } from '../model/pass-types';
import type { ParsedTle } from './tle-parse';

const logger = createChildLogger({ module: 'sat-ops:passes' });

/** @description Thrown when SGP4 cannot propagate the element set (decayed/invalid orbit) — HTTP 422 at the route. */
export class PropagationError extends Error {}

/** Defaults applied when {@link PassPredictionOptions} omit a field. */
export const PASS_DEFAULTS = { horizonHours: 24, elevationMaskDeg: 10, stepSeconds: 30 } as const;

/** Hard input limits — the whole CPU-DoS defense. Relaxing any of these is a reviewed change. */
export const PASS_LIMITS = {
  horizonHoursMax: 72,
  stepSecondsMin: 1,
  stepSecondsMax: 120,
  maxCoarseSamples: 25_000,
  maskDegMax: 85,
} as const;

const REFINE_TOL_S = 0.5;
const GOLDEN = (Math.sqrt(5) - 1) / 2;
const DEG = 180 / Math.PI;
const MAX_UTC_MS = 4_102_444_800_000; // year-2100 guard

interface LookSample {
  elDeg: number;
  azDeg: number;
  rangeKm: number;
}

/** One elevation/azimuth/range evaluation at `tS` seconds past start. Throws PropagationError on SGP4 failure. */
function lookAt(satrec: satellite.SatRec, observer: satellite.GeodeticLocation, startUtcMs: number, tS: number): LookSample {
  const d = new Date(startUtcMs + tS * 1000);
  const pv = satellite.propagate(satrec, d);
  if (!pv || pv.position === false || typeof pv.position === 'boolean' || satrec.error !== 0) {
    throw new PropagationError(`SGP4 propagation failed at t=+${tS.toFixed(1)}s (satrec.error=${satrec.error})`);
  }
  const gmst = satellite.gstime(d);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observer, ecf);
  return {
    elDeg: look.elevation * DEG,
    azDeg: ((look.azimuth * DEG) % 360 + 360) % 360,
    rangeKm: look.rangeSat,
  };
}

/** Bisect an elevation-mask crossing inside [loS, hiS] down to {@link REFINE_TOL_S}; returns the midpoint. */
function bisectCrossing(el: (t: number) => number, maskDeg: number, loS: number, hiS: number, risingEdge: boolean): number {
  let lo = loS;
  let hi = hiS;
  while (hi - lo > REFINE_TOL_S) {
    const mid = (lo + hi) / 2;
    const above = el(mid) >= maskDeg;
    if (above === risingEdge) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Golden-section maximize elevation on [loS, hiS] down to {@link REFINE_TOL_S}; returns the argmax. */
function refineCulmination(el: (t: number) => number, loS: number, hiS: number): number {
  let a = loS;
  let b = hiS;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = el(c);
  let fd = el(d);
  while (b - a > REFINE_TOL_S) {
    if (fc >= fd) {
      b = d; d = c; fd = fc;
      c = b - GOLDEN * (b - a); fc = el(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + GOLDEN * (b - a); fd = el(d);
    }
  }
  return (a + b) / 2;
}

/** Validate station + options; returns the resolved numbers. Throws plain Error → 400 at the route. */
function resolveOptions(station: GroundStation, opts: PassPredictionOptions): { horizonS: number; maskDeg: number; stepS: number; horizonHours: number } {
  const { latDeg, lonDeg, altKm } = station;
  if (!(latDeg >= -90 && latDeg <= 90)) throw new Error(`station.latDeg out of range: ${latDeg}`);
  if (!(lonDeg >= -180 && lonDeg <= 180)) throw new Error(`station.lonDeg out of range: ${lonDeg}`);
  if (!(altKm >= -0.5 && altKm <= 10)) throw new Error(`station.altKm out of range: ${altKm}`);
  if (!(Number.isFinite(opts.startUtcMs) && opts.startUtcMs >= 0 && opts.startUtcMs <= MAX_UTC_MS)) {
    throw new Error(`startUtcMs out of range: ${opts.startUtcMs}`);
  }
  const horizonHours = opts.horizonHours ?? PASS_DEFAULTS.horizonHours;
  if (!(horizonHours > 0 && horizonHours <= PASS_LIMITS.horizonHoursMax)) {
    throw new Error(`horizonHours must be in (0, ${PASS_LIMITS.horizonHoursMax}], got ${horizonHours}`);
  }
  const maskDeg = opts.elevationMaskDeg ?? PASS_DEFAULTS.elevationMaskDeg;
  if (!(maskDeg >= 0 && maskDeg <= PASS_LIMITS.maskDegMax)) {
    throw new Error(`elevationMaskDeg must be in [0, ${PASS_LIMITS.maskDegMax}], got ${maskDeg}`);
  }
  const reqStep = opts.stepSeconds ?? PASS_DEFAULTS.stepSeconds;
  if (!(reqStep >= PASS_LIMITS.stepSecondsMin && reqStep <= PASS_LIMITS.stepSecondsMax)) {
    throw new Error(`stepSeconds must be in [${PASS_LIMITS.stepSecondsMin}, ${PASS_LIMITS.stepSecondsMax}], got ${reqStep}`);
  }
  const horizonS = horizonHours * 3600;
  const stepS = Math.max(reqStep, horizonS / PASS_LIMITS.maxCoarseSamples);
  return { horizonS, maskDeg, stepS, horizonHours };
}

/** Build one refined window from a bracketed [rise, set] region. */
function buildWindow(
  look: (t: number) => LookSample, el: (t: number) => number, maskDeg: number, startUtcMs: number,
  riseS: number, setS: number, truncatedStart: boolean, truncatedEnd: boolean,
): PassWindow {
  const culmS = refineCulmination(el, riseS, setS);
  const rise = look(riseS);
  const set = look(setS);
  const culm = look(culmS);
  return {
    riseUtcMs: startUtcMs + riseS * 1000,
    setUtcMs: startUtcMs + setS * 1000,
    culminationUtcMs: startUtcMs + culmS * 1000,
    maxElevationDeg: culm.elDeg,
    riseAzimuthDeg: rise.azDeg,
    setAzimuthDeg: set.azDeg,
    culminationAzimuthDeg: culm.azDeg,
    culminationRangeKm: culm.rangeKm,
    durationS: setS - riseS,
    truncatedStart,
    truncatedEnd,
  };
}

/**
 * @description Compute the ordered, non-overlapping pass windows of one satellite over one
 * ground station. Deterministic (no wall clock, no randomness, no I/O in the hot path);
 * bounded (≤ {@link PASS_LIMITS}.maxCoarseSamples coarse samples regardless of inputs —
 * grazing passes shorter than the effective step can be missed, which is documented
 * behavior). SGP4 output is TEME — see the PassWindow frame warning.
 * @param tle - A validated element set from parseTle.
 * @param station - Geodetic ground station.
 * @param opts - Prediction options; `startUtcMs` is required.
 * @returns The prediction with every input mirrored and the effective step reported.
 */
export function computePassWindows(tle: ParsedTle, station: GroundStation, opts: PassPredictionOptions): PassPrediction {
  const { horizonS, maskDeg, stepS, horizonHours } = resolveOptions(station, opts);
  const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  if (satrec.error !== 0) throw new PropagationError(`satellite.js rejected the element set (satrec.error=${satrec.error})`);
  const observer: satellite.GeodeticLocation = {
    latitude: station.latDeg / DEG,
    longitude: station.lonDeg / DEG,
    height: station.altKm,
  };
  const look = (t: number): LookSample => lookAt(satrec, observer, opts.startUtcMs, t);
  const el = (t: number): number => look(t).elDeg;

  const passes: PassWindow[] = [];
  let inPass = el(0) >= maskDeg;
  let riseS = 0;
  let riseTruncated = inPass;
  for (let t = stepS; t <= horizonS + 1e-9; t += stepS) {
    const tClamped = Math.min(t, horizonS);
    const above = el(tClamped) >= maskDeg;
    if (!inPass && above) {
      riseS = bisectCrossing(el, maskDeg, tClamped - stepS, tClamped, true);
      riseTruncated = false;
      inPass = true;
    } else if (inPass && !above) {
      const setS = bisectCrossing(el, maskDeg, tClamped - stepS, tClamped, false);
      passes.push(buildWindow(look, el, maskDeg, opts.startUtcMs, riseS, setS, riseTruncated, false));
      inPass = false;
    }
    if (tClamped >= horizonS) break;
  }
  if (inPass) passes.push(buildWindow(look, el, maskDeg, opts.startUtcMs, riseS, horizonS, riseTruncated, true));

  const prediction: PassPrediction = {
    satnum: tle.satnum,
    satName: tle.name,
    station,
    startUtcMs: opts.startUtcMs,
    horizonHours,
    elevationMaskDeg: maskDeg,
    effectiveStepSeconds: stepS,
    passes,
  };
  // No Date.now here — the slice is deterministic by rule; the route logs timing.
  logger.info({ satnum: tle.satnum, horizonHours, maskDeg, passCount: passes.length }, 'pass windows computed');
  return prediction;
}
