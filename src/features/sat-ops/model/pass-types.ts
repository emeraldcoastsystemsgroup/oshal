/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | ground-contact prediction types. SGP4 output is TEME —
 *                     |                             | the frame warning on PassWindow is contractual so W3
 *                     |                             | slew-to-track never feeds these into the body-attitude
 *                     |                             | chain without a proper frame conversion.
 */

/** @description A ground station in geodetic coordinates. `altKm` is height above the WGS-84 ellipsoid. */
export interface GroundStation {
  latDeg: number;
  lonDeg: number;
  altKm: number;
}

/**
 * @description One visibility window of a satellite over a ground station.
 *
 * FRAME WARNING (contractual): these times/angles derive from SGP4 positions in the TEME
 * frame rotated to ECEF by GMST — correct for pass geometry (<1 s boundary error), but the
 * underlying vectors are NOT J2000. W3 slew-to-track must convert frames before feeding
 * anything here into the body-attitude chain (scalar-first Hamilton, body→inertial), or it
 * will silently point ~0.3° off.
 *
 * Azimuths are EVALUATED at the refined times, never interpolated — interpolating azimuth
 * across the 0/360 wrap is a known trap.
 */
export interface PassWindow {
  riseUtcMs: number;
  setUtcMs: number;
  culminationUtcMs: number;
  maxElevationDeg: number;
  riseAzimuthDeg: number;
  setAzimuthDeg: number;
  culminationAzimuthDeg: number;
  culminationRangeKm: number;
  durationS: number;
  /** True when the window was already open at the horizon start (no rise crossing found). */
  truncatedStart: boolean;
  /** True when the window ran past the horizon end (no set crossing found). */
  truncatedEnd: boolean;
}

/** @description Options for one pass prediction. `startUtcMs` is REQUIRED — the service never reads the wall clock. */
export interface PassPredictionOptions {
  /** Unix epoch milliseconds, UTC. The route layer is the one place allowed to default this to now. */
  startUtcMs: number;
  horizonHours?: number;
  elevationMaskDeg?: number;
  stepSeconds?: number;
}

/** @description A full prediction result: the inputs mirrored + the ordered, non-overlapping windows. */
export interface PassPrediction {
  satnum: number;
  satName: string | null;
  station: GroundStation;
  startUtcMs: number;
  horizonHours: number;
  elevationMaskDeg: number;
  /** The coarse step actually used after the CPU-bound clamp — may exceed the requested step. */
  effectiveStepSeconds: number;
  passes: PassWindow[];
}
