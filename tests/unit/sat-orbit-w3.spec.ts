/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W3:
 *                     |                             | orbit-track sampler (bounds, determinism, geometry
 *                     |                             | sanity), conjunction screening (co-orbital control
 *                     |                             | pair: tiny phase offset → event, large offset → none),
 *                     |                             | TLE catalog contract, and the new /api/sat orbit route
 *                     |                             | boundaries over HTTP loopback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 sat-ops carve:
 *                     |                             | the ROUTE-boundary describes (orbit routes + concierge
 *                     |                             | chat) moved into the sat-ops app package with the carved
 *                     |                             | /api/sat router (sat-orbit-w3-routes.spec.ts there); the
 *                     |                             | ENGINE describes stay here (movies-envelope precedent).
 *                     |                             | The SatFleet liveness/offline-rejection engine case moves
 *                     |                             | IN from the departing sat-ops-node-fleet spec so kernel
 *                     |                             | coverage of the kernel-resident fleet plane is not dropped.
 */

import { describe, expect, it } from 'vitest';
import {
  CatalogError,
  SCREEN_LIMITS,
  SatCommandError,
  SatFleet,
  TRACK_LIMITS,
  TleCatalog,
  TleParseError,
  computeOrbitTrack,
  parseTle,
  screenConjunctions,
} from '@/features/sat-ops';

const START = Date.UTC(2026, 0, 18, 12, 0, 0);

/** TLE line checksum append (standard mod-10). */
function checksum(line68: string): string {
  const s = line68.slice(0, 68).split('').map((c) => (c === '-' ? 1 : /\d/.test(c) ? Number(c) : 0)).reduce((a, b) => a + b, 0) % 10;
  return line68 + String(s);
}

/** ISS-class TLE with a configurable mean anomaly + satnum (checksums recomputed). */
function makeTle(satnum: string, maDeg: number): string {
  const ma = maDeg.toFixed(4).padStart(8, ' ');
  return [
    checksum(`1 ${satnum}U 26001A   26018.50000000  .00000000  00000-0  00000-0 0    1`),
    checksum(`2 ${satnum}  51.6400 247.4627 0003000 130.5360 ${ma} 15.50000000  100`),
  ].join('\n');
}

describe('sat-ops W3 orbit track', () => {
  it('samples deterministically with sane geometry (radius, lat bounds, lon wrap)', () => {
    const tle = parseTle(makeTle('90001', 10.4117));
    const a = computeOrbitTrack(tle, { startUtcMs: START, durationMinutes: 95, stepSeconds: 30 });
    const b = computeOrbitTrack(tle, { startUtcMs: START, durationMinutes: 95, stepSeconds: 30 });
    expect(a).toEqual(b); // deterministic — no wall clock in the service
    expect(a.points.length).toBeGreaterThan(150);
    for (const p of a.points) {
      const r = Math.hypot(p.eciKm.x, p.eciKm.y, p.eciKm.z);
      expect(r).toBeGreaterThan(6371 + 300); // LEO, above the atmosphere
      expect(r).toBeLessThan(6371 + 600);
      expect(Math.abs(p.latDeg)).toBeLessThanOrEqual(51.7 + 0.1); // |lat| ≤ inclination
      expect(p.lonDeg).toBeGreaterThanOrEqual(-180);
      expect(p.lonDeg).toBeLessThan(180);
      expect(p.altKm).toBeGreaterThan(300);
    }
    // one ~92-min period at 51.6° inclination must cross the equator twice
    const signFlips = a.points.slice(1).filter((p, i) => Math.sign(p.latDeg) !== Math.sign(a.points[i].latDeg)).length;
    expect(signFlips).toBeGreaterThanOrEqual(2);
  });

  it('enforces TRACK_LIMITS (duration, step, sample cap)', () => {
    const tle = parseTle(makeTle('90001', 10.4117));
    expect(() => computeOrbitTrack(tle, { startUtcMs: START, durationMinutes: 0 })).toThrow(/durationMinutes/);
    expect(() => computeOrbitTrack(tle, { startUtcMs: START, durationMinutes: TRACK_LIMITS.durationMinutesMax + 1 })).toThrow(/durationMinutes/);
    expect(() => computeOrbitTrack(tle, { startUtcMs: START, stepSeconds: 0.5 })).toThrow(/stepSeconds/);
    expect(() => computeOrbitTrack(tle, { startUtcMs: NaN })).toThrow(/startUtcMs/);
    // sample cap: 24h at 1s would be 86400 samples — the effective step must stretch to the cap
    const capped = computeOrbitTrack(tle, { startUtcMs: START, durationMinutes: 24 * 60, stepSeconds: 1 });
    expect(capped.points.length).toBeLessThanOrEqual(TRACK_LIMITS.maxSamples + 2);
    expect(capped.stepSeconds).toBeGreaterThan(1);
  });
});

describe('sat-ops W3 conjunction screening', () => {
  it('finds the co-orbital close pair and ignores the far pair (control experiment)', () => {
    // sat A and sat B share the orbit with a 0.05° mean-anomaly offset → ~5.9 km along-track
    // separation (2·a·sin(Δ/2), a ≈ 6768 km) — inside the 25 km threshold at every epoch.
    // sat C trails by 5° → ~590 km — never an event. B/C pair is also far.
    const entries = [
      { id: 'sat-a', tle: parseTle(makeTle('90001', 10.0)) },
      { id: 'sat-b', tle: parseTle(makeTle('90002', 10.05)) },
      { id: 'sat-c', tle: parseTle(makeTle('90003', 15.0)) },
    ];
    const report = screenConjunctions(entries, { startUtcMs: START, horizonHours: 3, stepSeconds: 60 });
    expect(report.screenedIds).toEqual(['sat-a', 'sat-b', 'sat-c']);
    expect(report.events.length).toBeGreaterThan(0);
    for (const e of report.events) {
      expect([e.aId, e.bId].sort()).toEqual(['sat-a', 'sat-b']); // ONLY the close pair
      expect(e.missKm).toBeLessThan(25);
      expect(e.missKm).toBeGreaterThan(1); // and not spuriously zero
      expect(e.tcaUtcMs).toBeGreaterThanOrEqual(START);
      expect(e.tcaUtcMs).toBeLessThanOrEqual(START + 3 * 3600_000);
    }
    // events are capped per pair and sorted ascending by miss
    expect(report.events.length).toBeLessThanOrEqual(SCREEN_LIMITS.maxEventsPerPair);
    const misses = report.events.map((e) => e.missKm);
    expect([...misses].sort((x, y) => x - y)).toEqual(misses);
  });

  it('is deterministic and enforces entry guards', () => {
    const a = { id: 'a', tle: parseTle(makeTle('90001', 10.0)) };
    const b = { id: 'b', tle: parseTle(makeTle('90002', 10.05)) };
    const r1 = screenConjunctions([a, b], { startUtcMs: START, horizonHours: 2 });
    const r2 = screenConjunctions([a, b], { startUtcMs: START, horizonHours: 2 });
    expect(r1).toEqual(r2);
    expect(() => screenConjunctions([a], { startUtcMs: START })).toThrow(/at least 2/);
    expect(() => screenConjunctions([a, { ...b, id: 'a' }], { startUtcMs: START })).toThrow(/duplicate/);
    const many = Array.from({ length: SCREEN_LIMITS.maxEntries + 1 }, (_, i) => ({ id: `s${i}`, tle: a.tle }));
    expect(() => screenConjunctions(many, { startUtcMs: START })).toThrow(/at most/);
  });
});

describe('sat-ops W3 TLE catalog', () => {
  it('upserts, lists, joins by satId, and removes', () => {
    const cat = new TleCatalog();
    const entry = cat.upsert('sat-a', makeTle('90001', 10.0), 'Alpha', 1000);
    expect(entry).toMatchObject({ satId: 'sat-a', name: 'Alpha', satnum: 90001, updatedUtcMs: 1000 });
    expect(cat.tleOf('sat-a')?.satnum).toBe(90001);
    expect(cat.list()).toHaveLength(1);
    cat.upsert('sat-a', makeTle('90009', 11.0), null, 2000); // replace
    expect(cat.tleOf('sat-a')?.satnum).toBe(90009);
    expect(cat.list()).toHaveLength(1);
    expect(cat.remove('sat-a')).toBe(true);
    expect(cat.remove('sat-a')).toBe(false);
    expect(cat.tleOf('sat-a')).toBeNull();
  });

  it('rejects bad ids and bad element sets; screenEntries validates subsets', () => {
    const cat = new TleCatalog();
    expect(() => cat.upsert('bad id!', makeTle('90001', 10), null, 0)).toThrow(CatalogError);
    expect(() => cat.upsert('ok', 'not a tle\nat all', null, 0)).toThrow(TleParseError);
    cat.upsert('a', makeTle('90001', 10.0), null, 0);
    cat.upsert('b', makeTle('90002', 10.05), null, 0);
    expect(cat.screenEntries().map((e) => e.id)).toEqual(['a', 'b']);
    expect(cat.screenEntries(['b']).map((e) => e.id)).toEqual(['b']);
    expect(() => cat.screenEntries(['ghost'])).toThrow(CatalogError);
  });
});

describe('sat-ops SatFleet liveness (engine — kernel-resident fleet plane)', () => {
  it('rejects commands to offline sats before any network I/O', async () => {
    let now = 1_000_000;
    const cold = new SatFleet({
      clock: () => now,
      fetchImpl: async () => { throw new Error('must not dial an offline node'); },
    });
    cold.ingestHeartbeat({
      satId: 'sat-stale',
      endpointUrl: 'http://127.0.0.1:59999',
      engine: 'rk4',
      telemetry: { state: { t: 0, q: { w: 1, x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, wheelMomentum: { x: 0, y: 0, z: 0 } }, mode: 'SAFE', pointingErrorDeg: null, attitudeCalibrated: true },
    });
    expect(cold.isOnline('sat-stale')).toBe(true);
    now += 60_000;
    expect(cold.isOnline('sat-stale')).toBe(false);
    await expect(cold.command('sat-stale', 'point', {})).rejects.toThrow(SatCommandError);
  });
});
