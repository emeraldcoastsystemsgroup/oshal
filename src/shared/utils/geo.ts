/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation (ADR-169 L1). GeoPoint, haversineM and the metres-per-degree constant live here so the location slice never imports the drone slice; the drone copies stay where they are (ADR-169 D3). Adds circle containment for places, the four precision classes of D3 (exact 5 decimals, block 3, city 2, place-only none) with the rounding applied before a fix is persisted, and the distanceBand labels of the D3 kernel operation. Every function refuses a non-finite or out-of-range coordinate with a RangeError instead of answering, so a malformed fix can never read as "inside" a place.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L7: precisionSlackM, how far a stored (rounded) point can lie from the full-precision point it was minimised from. mapsNear adds it to its reach, so a map anchored at block or city precision is still found from where it was captured although its stored origin moved by the rounding.
 */

/**
 * @description Shared WGS-84 geometry for the location capability (ADR-169 D3, slice L1): the
 * great-circle distance, circle containment for places, the precision classes a stored fix is
 * rounded to, and the distance bands the model-safe reads report. Pure functions, no I/O.
 * @module shared/utils/geo
 */

/** @description A WGS-84 position in decimal degrees. `alt` is metres and never used by the 2-D maths here. */
export interface GeoPoint {
  lat: number;
  lon: number;
  alt?: number;
}

/** @description A place's geometry: a circle on the Earth's surface, centre plus radius in metres (ADR-169 D3). */
export interface GeoCircle {
  center: GeoPoint;
  radiusM: number;
}

/** @description Mean Earth radius in metres (the same value the drone slice uses). */
export const EARTH_RADIUS_M = 6_371_000;

/**
 * @description Metres per degree of latitude. The value every core copy already declares
 * (drone services, spatial capture plan); a degree of longitude is this times cos(latitude).
 */
export const METRES_PER_DEGREE_LAT = 111_320;

/** @description The precision classes a device reports at (ADR-169 D3 "Precision minimisation"). */
export type LocationPrecisionClass = 'exact' | 'block' | 'city' | 'place-only';

/**
 * @description Decimal places kept when a fix is persisted, per precision class. `exact` keeps
 * 5 (about 1 m), `block` 3 (about 110 m, the default for people), `city` 2 (about 1 km) and
 * `place-only` keeps no coordinates at all: only the transition is persisted.
 */
export const LOCATION_PRECISION_DECIMALS: Readonly<Record<LocationPrecisionClass, number | null>> = Object.freeze({
  exact: 5,
  block: 3,
  city: 2,
  'place-only': null,
});

/** @description The labels the model-safe `distanceBand` read returns (ADR-169 D3 kernel operations). */
export type DistanceBand = 'at' | '<1 km' | '<10 km' | 'farther' | 'unknown';

const DEG_TO_RAD = Math.PI / 180;
const NEAR_BAND_M = 1_000;
const REGION_BAND_M = 10_000;

/**
 * @description Refuse a value that is not a usable WGS-84 position. Called by every function
 * here so a NaN, an Infinity or a swapped lat/lon pair throws instead of producing a distance.
 * @param point - The candidate position.
 * @param label - Names the argument in the error (never the value, which may be a real fix).
 * @returns Nothing; throws RangeError when the point is unusable.
 */
export function assertGeoPoint(point: GeoPoint, label = 'point'): void {
  const { lat, lon, alt } = point ?? ({} as GeoPoint);
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`${label}: latitude must be a finite number in [-90, 90]`);
  }
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`${label}: longitude must be a finite number in [-180, 180]`);
  }
  if (alt !== undefined && (typeof alt !== 'number' || !Number.isFinite(alt))) {
    throw new RangeError(`${label}: altitude, when present, must be a finite number`);
  }
}

/**
 * @description Refuse a circle whose centre is unusable or whose radius is negative or not finite.
 * @param circle - The place geometry.
 * @returns Nothing; throws RangeError when the circle is unusable.
 */
function assertGeoCircle(circle: GeoCircle): void {
  if (!circle || typeof circle !== 'object') throw new RangeError('circle: expected { center, radiusM }');
  assertGeoPoint(circle.center, 'circle.center');
  if (typeof circle.radiusM !== 'number' || !Number.isFinite(circle.radiusM) || circle.radiusM < 0) {
    throw new RangeError('circle.radiusM must be a finite number of metres, zero or more');
  }
}

/**
 * @description Great-circle (haversine) distance between two points, ignoring altitude. The
 * intermediate term is clamped to [0, 1] so two near-antipodal points return about half the
 * Earth's circumference instead of NaN from floating-point overshoot.
 * @param a - First point.
 * @param b - Second point.
 * @returns Horizontal distance in metres.
 */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  assertGeoPoint(a, 'a');
  assertGeoPoint(b, 'b');
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * DEG_TO_RAD) * Math.cos(b.lat * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(Math.max(0, s))));
}

/**
 * @description Whether a point lies inside a place's circle. A point exactly on the edge counts
 * as inside. This is geometry only: the accuracy floor, hysteresis and freshness of ADR-169 D4
 * are the evaluator's job and are not applied here.
 * @param circle - The place geometry.
 * @param point - The position to test.
 * @returns true when the great-circle distance to the centre is at most the radius.
 */
export function circleContains(circle: GeoCircle, point: GeoPoint): boolean {
  assertGeoCircle(circle);
  return haversineM(circle.center, point) <= circle.radiusM;
}

/**
 * @description Whether a value names one of the four precision classes.
 * @param value - Anything, typically a stored setting or a request field.
 * @returns true for 'exact', 'block', 'city' or 'place-only'.
 */
export function isLocationPrecisionClass(value: unknown): value is LocationPrecisionClass {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCATION_PRECISION_DECIMALS, value);
}

/**
 * @description Round one coordinate to a number of decimals, normalising negative zero.
 * @param value - Degrees.
 * @param decimals - Decimal places to keep.
 * @returns The rounded degrees.
 */
function roundDegrees(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * @description Minimise a full-precision fix to what may be persisted for a precision class
 * (ADR-169 D3). Evaluation runs on the full fix in memory first; only the returned value is
 * stored. Altitude is never carried: a stored fix is latitude and longitude only.
 * @param point - The full-precision fix.
 * @param precision - The class its owner chose.
 * @returns The rounded { lat, lon }, or null for `place-only`, which stores no coordinates.
 */
export function minimiseGeoPoint(point: GeoPoint, precision: LocationPrecisionClass): { lat: number; lon: number } | null {
  assertGeoPoint(point);
  if (!isLocationPrecisionClass(precision)) throw new RangeError('precision must be exact, block, city or place-only');
  const decimals = LOCATION_PRECISION_DECIMALS[precision];
  if (decimals === null) return null;
  return { lat: roundDegrees(point.lat, decimals), lon: roundDegrees(point.lon, decimals) };
}

/**
 * @description How far a stored point can lie from the full-precision point it was minimised from:
 * half a rounding cell in latitude and in longitude, combined. About 1 m for `exact`, 79 m for
 * `block` and 787 m for `city` at the equator, less towards the poles. A search over stored points
 * adds this to its reach so rounding never hides what is really within range. It is an upper
 * bound whichever of the two points is passed: the longitude term is taken at the latitude half
 * a cell nearer the equator, where a degree of longitude is longest.
 * @param point - The stored point or the full-precision point it came from.
 * @param precision - The class the stored point was minimised to.
 * @returns The slack in metres; 0 for `place-only`, which stores no point to be displaced.
 */
export function precisionSlackM(point: GeoPoint, precision: LocationPrecisionClass): number {
  assertGeoPoint(point);
  if (!isLocationPrecisionClass(precision)) throw new RangeError('precision must be exact, block, city or place-only');
  const decimals = LOCATION_PRECISION_DECIMALS[precision];
  if (decimals === null) return 0;
  const halfCellDeg = 0.5 / 10 ** decimals;
  const northM = halfCellDeg * METRES_PER_DEGREE_LAT;
  const eastM = northM * Math.cos(Math.max(0, Math.abs(point.lat) - halfCellDeg) * DEG_TO_RAD);
  return Math.hypot(northM, eastM);
}

/**
 * @description The distance band between a subject's position and a place, measured from the
 * place's edge: `at` inside the circle (edge included), `<1 km` and `<10 km` for less than that
 * distance beyond the edge, `farther` otherwise. A missing position is `unknown`; the caller
 * passes null for a stale or absent fix, since freshness is not geometry.
 * @param point - The subject's position, or null/undefined when there is none to use.
 * @param circle - The place geometry.
 * @returns The band label; never a distance or a coordinate.
 */
export function distanceBand(point: GeoPoint | null | undefined, circle: GeoCircle): DistanceBand {
  assertGeoCircle(circle);
  if (point === null || point === undefined) return 'unknown';
  const beyondEdgeM = haversineM(circle.center, point) - circle.radiusM;
  if (beyondEdgeM <= 0) return 'at';
  if (beyondEdgeM < NEAR_BAND_M) return '<1 km';
  if (beyondEdgeM < REGION_BAND_M) return '<10 km';
  return 'farther';
}
