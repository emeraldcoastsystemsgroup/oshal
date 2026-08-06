/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the rides estimate after it stopped being a fake. The old pseudoKm() SHA-256-hashed the pickup+dropoff STRINGS into a 2-19.9 km pseudo-distance and every fare derived from it, so the same trip typed two ways quoted two prices and neither meant anything — while buildRideLinks() in the same file already geocoded both ends for the Uber pins. Three things have to stay true or the fake is back: (1) DISTANCE IS MEASURED — haversine matches hand-derived known values and is symmetric; (2) FARES ARE A FUNCTION OF DISTANCE ONLY — never of the address text, asserted by monotonicity + the absence of any string-hash distance in the source; (3) UNRESOLVED IS NULL, NOT A GUESS — an address that does not geocode yields null fares, because showing a rider "$32-41" for a trip we could not locate is the exact lie the hash told.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';

const CLI_PATH = path.resolve(__dirname, '../../scripts/oshal-uber-rides.js');
const requireCjs = createRequire(__filename);
const cli = requireCjs(CLI_PATH) as {
  haversineKm: (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => number;
  buildRideOptions: (distanceKm: number | null, pickupEtaMin: number | null) => Array<{
    type: string; fareLow: number | null; fareHigh: number | null; tripMin: number | null; estimate: boolean;
  }>;
  geoCandidates: (address: string) => string[];
  ROAD_FACTOR: number;
  AVG_SPEED_KMH: number;
  RIDE_TYPES: Array<{ key: string; base: number; perKm: number }>;
};

const uberx = (opts: ReturnType<typeof cli.buildRideOptions>) => opts.find((o) => o.type === 'uberx')!;

describe('distance is measured, not invented', () => {
  it('matches hand-derived great-circle values', () => {
    // One degree of longitude at the equator is 2*PI*6371/360 = 111.195 km.
    expect(cli.haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111.19, 1);
    // One degree of latitude anywhere is the same 111.195 km.
    expect(cli.haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111.19, 1);
    // At 60 degrees N a degree of longitude is halved (cos 60 = 0.5).
    expect(cli.haversineKm({ lat: 60, lon: 0 }, { lat: 60, lon: 1 })).toBeCloseTo(55.6, 1);
    // A published long-haul check: JFK -> LAX is ~3974 km.
    const jfk = { lat: 40.6413, lon: -73.7781 };
    const lax = { lat: 33.9416, lon: -118.4085 };
    expect(cli.haversineKm(jfk, lax)).toBeGreaterThan(3960);
    expect(cli.haversineKm(jfk, lax)).toBeLessThan(3990);
  });

  it('is zero for a point against itself and symmetric between two points', () => {
    const a = { lat: 30.3935, lon: -86.4958 };
    const b = { lat: 30.4058, lon: -86.6188 };
    expect(cli.haversineKm(a, a)).toBe(0);
    expect(cli.haversineKm(a, b)).toBeCloseTo(cli.haversineKm(b, a), 10);
  });

  it('applies a road factor above 1 — streets are not great circles', () => {
    expect(cli.ROAD_FACTOR).toBeGreaterThan(1);
    expect(cli.ROAD_FACTOR).toBeLessThan(2);
  });
});

describe('fares are a function of distance', () => {
  it('rises with distance', () => {
    const near = uberx(cli.buildRideOptions(2, null));
    const mid = uberx(cli.buildRideOptions(10, null));
    const far = uberx(cli.buildRideOptions(40, null));
    expect(near.fareLow!).toBeLessThan(mid.fareLow!);
    expect(mid.fareLow!).toBeLessThan(far.fareLow!);
    expect(near.fareHigh!).toBeLessThan(far.fareHigh!);
  });

  it('keeps the low end below the high end for every ride type', () => {
    for (const o of cli.buildRideOptions(12, null)) {
      expect(o.fareLow!).toBeLessThanOrEqual(o.fareHigh!);
    }
  });

  it('prices the tiers in order at the same distance', () => {
    const byType = Object.fromEntries(cli.buildRideOptions(15, null).map((o) => [o.type, o.fareLow!]));
    expect(byType.uberx).toBeLessThan(byType.comfort);
    expect(byType.comfort).toBeLessThan(byType.xl);
    expect(byType.xl).toBeLessThan(byType.black);
  });

  it('derives trip minutes from distance and never returns an instant trip', () => {
    const long = uberx(cli.buildRideOptions(60, null)).tripMin!;
    const short = uberx(cli.buildRideOptions(1, null)).tripMin!;
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThanOrEqual(4);
    // 60 km at AVG_SPEED_KMH plus the fixed few minutes of pickup/turn overhead.
    expect(long).toBe(Math.round((60 / cli.AVG_SPEED_KMH) * 60 + 3));
  });

  it('labels every row as an estimate — this path has no live pricing API', () => {
    for (const o of cli.buildRideOptions(9, null)) expect(o.estimate).toBe(true);
  });
});

describe('an address we could not place is priced at null, not at a guess', () => {
  it('returns null fares and null trip time when distance is unknown', () => {
    const opts = cli.buildRideOptions(null, null);
    expect(opts.length).toBe(cli.RIDE_TYPES.length);
    for (const o of opts) {
      expect(o.fareLow).toBeNull();
      expect(o.fareHigh).toBeNull();
      expect(o.tripMin).toBeNull();
    }
  });

  it('still returns the ride types so the handoff stays offerable without a price', () => {
    const types = cli.buildRideOptions(null, null).map((o) => o.type);
    expect(types).toContain('uberx');
    expect(types).toContain('black');
  });

  it('treats a non-finite distance as unknown rather than pricing NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const o = uberx(cli.buildRideOptions(bad, null));
      expect(o.fareLow).toBeNull();
      expect(o.fareHigh).toBeNull();
    }
  });
});

describe('the string-hash distance is gone and must not come back', () => {
  const raw = fs.readFileSync(CLI_PATH, 'utf8');
  // Scan CODE, not prose. The change log explains what pseudoKm was and why it died — that
  // history is worth keeping, and a scan that cannot tell a comment from a call would force
  // us to delete it. Strip block comments and comment-only lines, keep everything else.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  it('has no string-hashed distance function', () => {
    expect(source).not.toMatch(/pseudoKm/);
  });

  it('hashes nothing itself — key derivation lives in the one shared codec', () => {
    // Originally: createHash survives exactly ONCE here, deriving the AES key from SESSION_SECRET;
    // a second occurrence means something is being hashed again, and last time that was the fare.
    // The CLI now delegates to scripts/lib/connector-token-crypto, so the correct count HERE is
    // zero and the property is asserted where the derivation actually lives. Keeping the old
    // count would have pinned the copy this refactor deliberately removed.
    expect(source.match(/createHash\(/g) ?? []).toEqual([]);
    expect(source).toMatch(/require\(['"]\.\/lib\/connector-token-crypto['"]\)/);

    const shared = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'lib', 'connector-token-crypto.js'),
      'utf8',
    );
    expect(shared.match(/createHash\(/g) ?? []).toHaveLength(1);
    expect(shared).toMatch(/createHash\('sha256'\)\.update\(sessionSecret\(env\)\)/);
  });

  it('geocodes both endpoints in the estimate path, not only in the link builder', () => {
    const estimateFn = source.slice(source.indexOf('async function estimateRides'));
    expect(estimateFn.slice(0, 900)).toMatch(/geocode\(pickup\)/);
    expect(estimateFn.slice(0, 900)).toMatch(/geocode\(dropoff\)/);
  });
});

describe('the geocode fallback ladder', () => {
  it('tries the full address first', () => {
    expect(cli.geoCandidates('34876 Emerald Coast Pkwy, Destin, FL')[0])
      .toBe('34876 Emerald Coast Pkwy, Destin, FL');
  });

  it('drops a leading business-name segment Nominatim chokes on', () => {
    const cands = cli.geoCandidates('Hurricane Lanes, 34876 Emerald Coast Pkwy, Destin, FL');
    expect(cands).toContain('34876 Emerald Coast Pkwy, Destin, FL');
  });

  it('falls back to the street without the house number', () => {
    const cands = cli.geoCandidates('Hurricane Lanes, 34876 Emerald Coast Pkwy, Destin, FL');
    expect(cands).toContain('Emerald Coast Pkwy, Destin, FL');
  });

  it('never repeats a candidate', () => {
    const cands = cli.geoCandidates('Destin, FL');
    expect(new Set(cands).size).toBe(cands.length);
  });
});
