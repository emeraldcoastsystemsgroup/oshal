/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L1 shared geo maths (src/shared/utils/geo.ts). Haversine against independent reference distances (meridian degree, antimeridian, pole, antipode without NaN); circle containment at its edges (just inside, just outside, exactly on, east-west at 60 degrees, across the antimeridian, zero radius); the four precision classes with their stored decimals, their resolution in metres as the ADR tables them, altitude dropped, negative zero normalised and a deterministic sweep proving no stored value keeps more decimals than its class; distance bands measured from the place's edge at every threshold; and every function refusing a non-finite or out-of-range input with a RangeError that does not echo the coordinate. Synthetic coordinates only.
 */

import { describe, expect, it } from 'vitest';
import {
  circleContains,
  distanceBand,
  EARTH_RADIUS_M,
  haversineM,
  isLocationPrecisionClass,
  LOCATION_PRECISION_DECIMALS,
  METRES_PER_DEGREE_LAT,
  minimiseGeoPoint,
  type GeoCircle,
  type GeoPoint,
} from '@/shared/utils/geo';

/** Metres along a meridian per degree, on the sphere haversineM uses. */
const METRES_PER_DEGREE_ON_SPHERE = (EARTH_RADIUS_M * Math.PI) / 180;
/** A synthetic place centre in the open South Atlantic (no address, no person). */
const CENTRE: GeoPoint = { lat: -12.5, lon: -31.25 };

/** A point `metres` due north of `from`. */
function north(from: GeoPoint, metres: number): GeoPoint {
  return { lat: from.lat + metres / METRES_PER_DEGREE_ON_SPHERE, lon: from.lon };
}

/** Decimal places in the shortest printed form of a number. */
function decimalsOf(value: number): number {
  const [, fraction = ''] = String(value).split('.');
  return fraction.length;
}

describe('haversineM', () => {
  it('matches independent reference distances', () => {
    expect(EARTH_RADIUS_M).toBe(6_371_000);
    expect(haversineM(CENTRE, CENTRE)).toBe(0);
    expect(haversineM({ lat: 10, lon: 20 }, { lat: 11, lon: 20 })).toBeCloseTo(METRES_PER_DEGREE_ON_SPHERE, 6);
    expect(haversineM({ lat: 0, lon: 179.9995 }, { lat: 0, lon: -179.9995 })).toBeCloseTo(0.001 * METRES_PER_DEGREE_ON_SPHERE, 3);
    expect(haversineM({ lat: 90, lon: 0 }, { lat: 90, lon: 120 })).toBeCloseTo(0, 6);
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 3);
  });

  it('is symmetric and ignores altitude', () => {
    const a: GeoPoint = { lat: -12.49, lon: -31.26, alt: 120 };
    const b: GeoPoint = { lat: -12.51, lon: -31.21 };
    expect(haversineM(a, b)).toBe(haversineM(b, a));
    expect(haversineM(a, b)).toBe(haversineM({ lat: a.lat, lon: a.lon }, b));
  });

  it('keeps the metres-per-degree constant every core copy declares', () => {
    expect(METRES_PER_DEGREE_LAT).toBe(111_320);
  });
});

describe('circleContains', () => {
  const place: GeoCircle = { center: CENTRE, radiusM: 100 };

  it('is inside just within the edge and outside just beyond it', () => {
    expect(circleContains(place, CENTRE)).toBe(true);
    expect(circleContains(place, north(CENTRE, 99.99))).toBe(true);
    expect(circleContains(place, north(CENTRE, 100.01))).toBe(false);
  });

  it('counts a point exactly on the edge as inside', () => {
    const edge = north(CENTRE, 250);
    expect(circleContains({ center: CENTRE, radiusM: haversineM(CENTRE, edge) }, edge)).toBe(true);
  });

  it('measures east-west on the sphere, not in raw degrees', () => {
    const at60: GeoPoint = { lat: 60, lon: 10 };
    const east100 = { lat: 60, lon: 10 + 100 / (METRES_PER_DEGREE_ON_SPHERE * Math.cos((60 * Math.PI) / 180)) };
    expect(circleContains({ center: at60, radiusM: 100.5 }, east100)).toBe(true);
    expect(circleContains({ center: at60, radiusM: 99.5 }, east100)).toBe(false);
  });

  it('works across the antimeridian and with a zero radius', () => {
    expect(circleContains({ center: { lat: 10, lon: 179.9999 }, radiusM: 50 }, { lat: 10, lon: -179.9999 })).toBe(true);
    expect(circleContains({ center: CENTRE, radiusM: 0 }, CENTRE)).toBe(true);
    expect(circleContains({ center: CENTRE, radiusM: 0 }, north(CENTRE, 0.01))).toBe(false);
  });
});

describe('precision classes', () => {
  const fix: GeoPoint = { lat: -12.123456789, lon: -31.987654321, alt: 12 };

  it('stores 5, 3, 2 or no decimals and never the altitude', () => {
    expect(LOCATION_PRECISION_DECIMALS).toEqual({ exact: 5, block: 3, city: 2, 'place-only': null });
    expect(Object.isFrozen(LOCATION_PRECISION_DECIMALS)).toBe(true);
    expect(minimiseGeoPoint(fix, 'exact')).toEqual({ lat: -12.12346, lon: -31.98765 });
    expect(minimiseGeoPoint(fix, 'block')).toEqual({ lat: -12.123, lon: -31.988 });
    expect(minimiseGeoPoint(fix, 'city')).toEqual({ lat: -12.12, lon: -31.99 });
    expect(minimiseGeoPoint(fix, 'place-only')).toBeNull();
  });

  it('keeps the resolution the ADR tables: about 1 m, 110 m and 1 km', () => {
    const resolutionM = (d: number): number => 10 ** -d * METRES_PER_DEGREE_LAT;
    expect(Math.round(resolutionM(LOCATION_PRECISION_DECIMALS.exact!))).toBe(1);
    expect(Math.round(resolutionM(LOCATION_PRECISION_DECIMALS.block!))).toBe(111);
    expect(Math.round(resolutionM(LOCATION_PRECISION_DECIMALS.city!) / 100) / 10).toBe(1.1);
  });

  it('never stores more decimals than the class, and never moves a fix more than half a unit', () => {
    let seed = 7;
    const next = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    for (let i = 0; i < 2_000; i += 1) {
      const point: GeoPoint = { lat: next() * 180 - 90, lon: next() * 360 - 180 };
      for (const precision of ['exact', 'block', 'city'] as const) {
        const d = LOCATION_PRECISION_DECIMALS[precision]!;
        const stored = minimiseGeoPoint(point, precision)!;
        expect(decimalsOf(stored.lat)).toBeLessThanOrEqual(d);
        expect(decimalsOf(stored.lon)).toBeLessThanOrEqual(d);
        expect(Math.abs(stored.lat - point.lat)).toBeLessThanOrEqual(0.5 * 10 ** -d + 1e-12);
        expect(Math.abs(stored.lon - point.lon)).toBeLessThanOrEqual(0.5 * 10 ** -d + 1e-12);
      }
    }
  });

  it('normalises negative zero and refuses an unknown class', () => {
    const stored = minimiseGeoPoint({ lat: -0.0001, lon: 0.0004 }, 'block')!;
    expect(Object.is(stored.lat, 0)).toBe(true);
    expect(() => minimiseGeoPoint(fix, 'street' as never)).toThrow(RangeError);
    expect(isLocationPrecisionClass('block')).toBe(true);
    expect(isLocationPrecisionClass('toString')).toBe(false);
    expect(isLocationPrecisionClass(undefined)).toBe(false);
  });
});

describe('distanceBand', () => {
  const place: GeoCircle = { center: CENTRE, radiusM: 150 };
  const beyondEdge = (metres: number): GeoPoint => north(CENTRE, place.radiusM + metres);

  it('is unknown without a position and at inside the circle, edge included', () => {
    expect(distanceBand(null, place)).toBe('unknown');
    expect(distanceBand(undefined, place)).toBe('unknown');
    expect(distanceBand(CENTRE, place)).toBe('at');
    const edge = north(CENTRE, 400);
    expect(distanceBand(edge, { center: CENTRE, radiusM: haversineM(CENTRE, edge) })).toBe('at');
  });

  it('bands the distance beyond the edge at 1 km and 10 km', () => {
    expect(distanceBand(beyondEdge(1), place)).toBe('<1 km');
    expect(distanceBand(beyondEdge(999), place)).toBe('<1 km');
    expect(distanceBand(beyondEdge(1_001), place)).toBe('<10 km');
    expect(distanceBand(beyondEdge(9_999), place)).toBe('<10 km');
    expect(distanceBand(beyondEdge(10_001), place)).toBe('farther');
  });

  it('measures from the edge, not the centre', () => {
    expect(distanceBand(north(CENTRE, 2_500), { center: CENTRE, radiusM: 2_000 })).toBe('<1 km');
  });
});

describe('malformed input is refused, never answered', () => {
  const place: GeoCircle = { center: CENTRE, radiusM: 100 };

  it('refuses non-finite and out-of-range coordinates without echoing them', () => {
    const bad: GeoPoint[] = [
      { lat: Number.NaN, lon: 0 }, { lat: 90.5, lon: 0 }, { lat: 0, lon: -180.25 },
      { lat: Number.POSITIVE_INFINITY, lon: 0 }, { lat: 0, lon: 0, alt: Number.NaN },
      { lat: '-12.5' as unknown as number, lon: 0 },
    ];
    for (const point of bad) {
      expect(() => haversineM(point, CENTRE)).toThrow(RangeError);
      expect(() => circleContains(place, point)).toThrow(RangeError);
      expect(() => distanceBand(point, place)).toThrow(RangeError);
      expect(() => minimiseGeoPoint(point, 'block')).toThrow(RangeError);
    }
    expect(() => haversineM({ lat: 95.123456, lon: 0 }, CENTRE)).toThrow(/^a: latitude must be/);
    try { haversineM({ lat: 95.123456, lon: 0 }, CENTRE); } catch (error) { expect(String(error)).not.toContain('95.123456'); }
  });

  it('refuses an unusable circle even when there is no position to compare', () => {
    expect(() => circleContains({ center: CENTRE, radiusM: -1 }, CENTRE)).toThrow(RangeError);
    expect(() => circleContains({ center: CENTRE, radiusM: Number.NaN }, CENTRE)).toThrow(RangeError);
    expect(() => distanceBand(null, { center: { lat: 91, lon: 0 }, radiusM: 10 })).toThrow(RangeError);
    expect(() => distanceBand(null, undefined as unknown as GeoCircle)).toThrow(RangeError);
  });
});
