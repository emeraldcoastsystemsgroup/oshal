/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Fleet Show pattern
 *                     |                             | generators: every pattern × fleet size must clear the SAME
 *                     |                             | gates real missions face (per-drone fence + pairwise
 *                     |                             | separation), the altitude stack must auto-fit under the
 *                     |                             | ceiling or refuse with a clear reason, and the orbit
 *                     |                             | geometry must actually ride the requested circle.
 */

import { describe, expect, it } from 'vitest';
import {
  FLEET_PATTERNS,
  generateFleetPattern,
  validateFleetSeparation,
  validateMission,
  haversineM,
  type Geofence,
  type GeoPoint,
} from '@/features/drone';

const FENCE: Geofence = { maxRadiusM: 500, maxAltM: 120, minAltM: 2 };
const BASE = { lat: 30.3935, lon: -86.4958, alt: 0 };
const M_PER_DEG_LAT = 111320;

/** N drones with launch pads 8m apart eastward — the embedded-sim layout. */
function mkDrones(n: number): Array<{ droneId: string; home: GeoPoint }> {
  return Array.from({ length: n }, (_, i) => ({
    droneId: i === 0 ? 'alpha' : `sim-${i}`,
    home: { lat: BASE.lat, lon: BASE.lon + (i * 8) / (M_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180)), alt: 0 },
  }));
}

describe('Fleet Show pattern catalog', () => {
  it('offers the three choreographies, each fleet-bounded', () => {
    expect(FLEET_PATTERNS.map((p) => p.id)).toEqual(['box-split', 'orbit-carousel', 'delta-transit']);
    for (const p of FLEET_PATTERNS) {
      expect(p.minDrones).toBe(2);
      expect(p.maxDrones).toBe(8);
    }
  });
});

describe('generateFleetPattern — every pattern clears the real mission gates', () => {
  for (const spec of FLEET_PATTERNS) {
    for (const n of [2, 3, 8]) {
      it(`${spec.id} × ${n} drones: separation-safe and inside every drone's fence`, () => {
        const drones = mkDrones(n);
        const { plan, errors } = generateFleetPattern({ patternId: spec.id, drones });
        expect(errors).toEqual([]);
        expect(plan).not.toBeNull();
        expect(plan!.assignments).toHaveLength(n);
        expect(validateFleetSeparation(plan!.assignments)).toEqual([]);
        plan!.assignments.forEach((a, i) => {
          expect(validateMission(a.plan, FENCE, drones[i].home)).toEqual([]);
        });
      });
    }
  }

  it('orbit-carousel actually rides the requested circle', () => {
    const drones = mkDrones(2);
    const { plan } = generateFleetPattern({ patternId: 'orbit-carousel', drones, sizeM: 160 });
    const center = {
      lat: (drones[0].home.lat + drones[1].home.lat) / 2,
      lon: (drones[0].home.lon + drones[1].home.lon) / 2,
    };
    for (const wp of plan!.assignments[0].plan.waypoints) {
      expect(Math.abs(haversineM(wp, center) - 80)).toBeLessThan(1);
    }
  });

  it('auto-shrinks the altitude stack to fit the ceiling, keeping separation', () => {
    // base 40 + 7×12 = 124 > 118 → step shrinks to 11 (still ≥ the 10m separation minimum).
    const { plan, errors } = generateFleetPattern({ patternId: 'box-split', drones: mkDrones(8), altBaseM: 40, altStepM: 12 });
    expect(errors).toEqual([]);
    const alts = plan!.assignments.map((a) => a.plan.waypoints[0].alt);
    expect(alts[1] - alts[0]).toBe(11);
    expect(Math.max(...alts)).toBeLessThanOrEqual(118);
    expect(validateFleetSeparation(plan!.assignments)).toEqual([]);
  });

  it('refuses a stack that cannot keep vertical separation under the ceiling', () => {
    const { plan, errors } = generateFleetPattern({ patternId: 'orbit-carousel', drones: mkDrones(3), altBaseM: 100 });
    expect(plan).toBeNull();
    expect(errors[0]).toMatch(/cannot stack/);
  });

  it('rejects unknown patterns, undersized fleets, and out-of-range sizes', () => {
    expect(generateFleetPattern({ patternId: 'nope', drones: mkDrones(2) }).errors[0]).toMatch(/unknown fleet pattern/);
    expect(generateFleetPattern({ patternId: 'box-split', drones: mkDrones(1) }).errors[0]).toMatch(/needs 2–8 drones/);
    expect(generateFleetPattern({ patternId: 'box-split', drones: mkDrones(2), sizeM: 5000 }).errors[0]).toMatch(/outside/);
  });
});
