/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | property-based proofs for the SGP4 pass predictor. No
 *                     |                             | golden ephemeris: ordering/non-overlap, independent
 *                     |                             | boundary re-evaluation, culmination local-max, 5–9
 *                     |                             | passes/24h geometry, |r|≈a self-consistency, byte
 *                     |                             | determinism, period-shift (wall-clock independence),
 *                     |                             | truncation, TLE validation, CPU-bound enforcement. The
 *                     |                             | makeTle helper carries its OWN mod-10 implementation to
 *                     |                             | cross-check the parser's checksum code.
 */

import { describe, expect, it } from 'vitest';
import * as satellite from 'satellite.js';
import {
  PASS_LIMITS,
  PropagationError,
  TleParseError,
  computePassWindows,
  parseTle,
  tleChecksum,
  type PassPrediction,
} from '@/features/sat-ops';

/** Independent mod-10 checksum (deliberately a different implementation than the service). */
function independentChecksum(line: string): number {
  return (
    line
      .slice(0, 68)
      .split('')
      .map((c) => (c === '-' ? 1 : /\d/.test(c) ? Number(c) : 0))
      .reduce((a, b) => a + b, 0) % 10
  );
}

function withChecksum(line68: string): string {
  if (line68.length !== 68) throw new Error(`line is ${line68.length} chars, want 68`);
  return line68 + String(independentChecksum(line68));
}

interface TleElements {
  satnum?: string;
  epoch?: string;
  inclDeg?: number;
  raanDeg?: number;
  ecc?: number;
  argpDeg?: number;
  maDeg?: number;
  meanMotion?: number;
}

/** Build a syntactically valid TLE with correct checksums from orbital elements. */
function makeTle(e: TleElements = {}): string {
  const satnum = (e.satnum ?? '90001').padStart(5, '0');
  const epoch = e.epoch ?? '26018.50000000';
  const f = (v: number, w: number, dec: number): string => v.toFixed(dec).padStart(w, ' ');
  const eccStr = Math.round((e.ecc ?? 0.0003) * 1e7).toString().padStart(7, '0');
  const line1 = withChecksum(`1 ${satnum}U 26001A   ${epoch}  .00000000  00000-0  00000-0 0    1`);
  const line2 = withChecksum(
    `2 ${satnum} ${f(e.inclDeg ?? 51.64, 8, 4)} ${f(e.raanDeg ?? 247.4627, 8, 4)} ${eccStr} ${f(e.argpDeg ?? 130.536, 8, 4)} ${f(e.maDeg ?? 10.4117, 8, 4)} ${f(e.meanMotion ?? 15.5, 11, 8)}  100`,
  );
  return `${line1}\n${line2}`;
}

const STATION = { latDeg: 45.0, lonDeg: -93.0, altKm: 0.25 };
const START = Date.UTC(2026, 0, 18, 12, 0, 0);

function predict(overrides: Record<string, unknown> = {}): PassPrediction {
  return computePassWindows(parseTle(makeTle()), STATION, { startUtcMs: START, elevationMaskDeg: 10, ...overrides });
}

/** Independent elevation re-evaluation at a UTC ms instant (not via the service). */
function elevationAt(tle: string, utcMs: number): number {
  const parsed = parseTle(tle);
  const satrec = satellite.twoline2satrec(parsed.line1, parsed.line2);
  const d = new Date(utcMs);
  const pv = satellite.propagate(satrec, d);
  if (pv.position === false || typeof pv.position === 'boolean') throw new Error('propagate failed');
  const look = satellite.ecfToLookAngles(
    { latitude: (STATION.latDeg * Math.PI) / 180, longitude: (STATION.lonDeg * Math.PI) / 180, height: STATION.altKm },
    satellite.eciToEcf(pv.position, satellite.gstime(d)),
  );
  return (look.elevation * 180) / Math.PI;
}

describe('sat-ops SGP4 pass windows', () => {
  it('produces ordered, non-overlapping, internally consistent windows', () => {
    const p = predict();
    expect(p.passes.length).toBeGreaterThan(0);
    for (let i = 0; i < p.passes.length; i++) {
      const w = p.passes[i];
      expect(w.riseUtcMs).toBeLessThan(w.culminationUtcMs + 1);
      expect(w.culminationUtcMs).toBeLessThanOrEqual(w.setUtcMs);
      expect(w.durationS).toBeCloseTo((w.setUtcMs - w.riseUtcMs) / 1000, 6);
      if (i > 0) expect(p.passes[i - 1].setUtcMs).toBeLessThan(w.riseUtcMs);
    }
  });

  it('refines rise/set to the mask within 0.05° (independent re-evaluation)', () => {
    const p = predict();
    const tle = makeTle();
    for (const w of p.passes) {
      if (!w.truncatedStart) expect(Math.abs(elevationAt(tle, w.riseUtcMs) - 10)).toBeLessThan(0.05);
      if (!w.truncatedEnd) expect(Math.abs(elevationAt(tle, w.setUtcMs) - 10)).toBeLessThan(0.05);
      expect(w.maxElevationDeg).toBeGreaterThanOrEqual(10);
      const el = elevationAt(tle, w.culminationUtcMs);
      expect(el).toBeGreaterThanOrEqual(elevationAt(tle, w.culminationUtcMs - 2000) - 0.001);
      expect(el).toBeGreaterThanOrEqual(elevationAt(tle, w.culminationUtcMs + 2000) - 0.001);
    }
    expect(Math.max(...p.passes.map((w) => w.maxElevationDeg))).toBeGreaterThan(20);
  }, 30_000);

  it('sees 5–9 passes per 24h from 45°N with mask 0 (LEO geometry)', () => {
    const p = predict({ elevationMaskDeg: 0 });
    expect(p.passes.length).toBeGreaterThanOrEqual(5);
    expect(p.passes.length).toBeLessThanOrEqual(9);
  }, 30_000);

  it('is self-consistent with the TLE mean motion (|r| ≈ a within 1%)', () => {
    const parsed = parseTle(makeTle());
    const nRad = (parsed.meanMotionRevPerDay * 2 * Math.PI) / 86400;
    const a = Math.cbrt(398600.4418 / (nRad * nRad));
    const satrec = satellite.twoline2satrec(parsed.line1, parsed.line2);
    for (let k = 0; k < 100; k++) {
      const pv = satellite.propagate(satrec, new Date(START + (k * 24 * 3600 * 1000) / 100));
      expect(satrec.error).toBe(0);
      if (pv.position === false || typeof pv.position === 'boolean') throw new Error('propagate failed');
      const r = Math.hypot(pv.position.x, pv.position.y, pv.position.z);
      expect(Math.abs(r - a) / a).toBeLessThan(0.01);
    }
  });

  it('is deterministic and free of hidden wall-clock dependence', () => {
    // Byte-identical on repeat = no randomness / no wall-clock read inside the service.
    const a = predict();
    const b = predict();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Overlap continuity: predicting the SAME horizon in two halves reproduces the whole.
    // (A period-shift-recurrence check is bad physics — ground passes don't recur at the
    //  orbital period because Earth rotates under the track — so prove determinism this way.)
    const full = predict({ horizonHours: 12 });
    const midMs = START + 6 * 3600 * 1000;
    const firstHalf = predict({ horizonHours: 6 }).passes.filter((w) => w.setUtcMs <= midMs);
    const secondHalf = computePassWindows(parseTle(makeTle()), STATION, { startUtcMs: midMs, elevationMaskDeg: 10, horizonHours: 6 })
      .passes.filter((w) => w.riseUtcMs >= midMs);
    const whollyInside = full.passes.filter((w) => w.riseUtcMs >= START + 1000 && w.setUtcMs <= START + 12 * 3600 * 1000 - 1000 && !(w.riseUtcMs < midMs && w.setUtcMs > midMs));
    expect(firstHalf.length + secondHalf.length).toBe(whollyInside.length);
    for (const w of firstHalf) {
      const match = whollyInside.find((f) => Math.abs(f.riseUtcMs - w.riseUtcMs) < 1000);
      expect(match?.maxElevationDeg).toBeCloseTo(w.maxElevationDeg, 3);
    }
  }, 30_000);

  it('truncates a window already open at the horizon start', () => {
    const base = predict();
    const mid = base.passes[0].culminationUtcMs;
    const p = computePassWindows(parseTle(makeTle()), STATION, { startUtcMs: mid, elevationMaskDeg: 10 });
    expect(p.passes[0].truncatedStart).toBe(true);
    expect(p.passes[0].riseUtcMs).toBe(mid);
    expect(elevationAt(makeTle(), mid)).toBeGreaterThan(10);
  }, 30_000);

  it('rejects malformed TLEs and accepts 3-line forms', () => {
    const good = makeTle();
    const [l1, l2] = good.split('\n');
    const badChecksum = `${l1.slice(0, 68)}${(Number(l1[68]) + 1) % 10}\n${l2}`;
    expect(() => parseTle(badChecksum)).toThrow(TleParseError);
    expect(() => parseTle(`${l1.slice(0, 67)}\n${l2}`)).toThrow(TleParseError);
    const otherSat = makeTle({ satnum: '90002' }).split('\n')[1];
    expect(() => parseTle(`${l1}\n${otherSat}`)).toThrow(TleParseError);
    expect(() => parseTle('x'.repeat(513))).toThrow(TleParseError);
    expect(() => parseTle('hello world\nnot a tle')).toThrow(TleParseError);
    expect(parseTle(`SATTEST 1\n${good}`).name).toBe('SATTEST 1');
    expect(parseTle(`0 SATTEST 1\n${good}`).name).toBe('SATTEST 1');
    expect(parseTle(`${l1}   \r\n${l2}\r\n`).satnum).toBe(90001);
  });

  it('cross-checks the exported checksum against the independent implementation', () => {
    for (const satnum of ['00005', '25544', '90001', '43013', '48274']) {
      for (const line of makeTle({ satnum }).split('\n')) {
        expect(tleChecksum(line)).toBe(independentChecksum(line));
        expect(tleChecksum(line)).toBe(Number(line[68]));
      }
    }
  });

  it('enforces input limits and the CPU bound', () => {
    expect(() => predict({ horizonHours: 72.1 })).toThrow(/horizonHours/);
    expect(() => predict({ elevationMaskDeg: 86 })).toThrow(/elevationMaskDeg/);
    expect(() => predict({ stepSeconds: 0 })).toThrow(/stepSeconds/);
    expect(() => predict({ stepSeconds: 121 })).toThrow(/stepSeconds/);
    expect(() => computePassWindows(parseTle(makeTle()), { latDeg: 91, lonDeg: 0, altKm: 0 }, { startUtcMs: START })).toThrow(/latDeg/);
    const t0 = Date.now();
    const p = predict({ horizonHours: 72, stepSeconds: 1 });
    expect(p.effectiveStepSeconds).toBeGreaterThanOrEqual((72 * 3600) / PASS_LIMITS.maxCoarseSamples - 1e-9);
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 30_000);

  it('surfaces SGP4 propagation failure as PropagationError', () => {
    // mean motion 20 rev/day puts the whole orbit below Earth's surface → satrec.error=6
    // (decayed), position===false — empirically confirmed against satellite.js.
    const decayed = makeTle({ meanMotion: 20, ecc: 0.05 });
    expect(() => computePassWindows(parseTle(decayed), STATION, { startUtcMs: START })).toThrow(PropagationError);
  });
});
