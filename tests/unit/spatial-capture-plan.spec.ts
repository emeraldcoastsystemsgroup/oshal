/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 2/3 first-increment guards — the capture-plan engine is real: every target's plan carries prep -> scale-marker -> capture steps -> loop closure; the drone scan pattern's waypoint count derives from the FOV+overlap math, every waypoint sits on the orbit radius facing the center, the default pattern validates as a flyable MissionPlan under MAX_WAYPOINTS, and a virtual-clock SimDroneProvider flies it to completion producing one photo capture per waypoint (the BACKLOG Phase 3 sim-first done-when, exercised end-to-end with zero hardware).
 */

import { describe, expect, it } from 'vitest';
import {
  generateCapturePlan, droneScanPattern, type CaptureTarget,
  sanitizeCaptureTelemetry, CAPTURE_SESSION_ID_RE, captureTelemetryPath, subHash,
} from '@/features/spatial-mapping';
import {
  SimDroneProvider,
  haversineM,
  validateMission,
  MAX_WAYPOINTS,
  type MissionPlan,
} from '@/features/drone';

const HOME = { lat: 30.4213, lon: -87.2169 };

describe('capture-plan: guided walk steps', () => {
  const targets: CaptureTarget[] = ['room', 'large-room', 'object', 'facade'];

  it.each(targets)('%s plan is ordered prep -> scale -> capture -> closure', (target) => {
    const plan = generateCapturePlan(target);
    expect(plan.steps.length).toBeGreaterThanOrEqual(5);
    expect(plan.steps[0].kind).toBe('prep');
    expect(plan.steps[1].kind).toBe('scale');
    expect(plan.steps[plan.steps.length - 1].kind).toBe('closure');
    expect(plan.steps.filter((s) => s.kind === 'capture').length).toBeGreaterThanOrEqual(3);
    expect(plan.tips.length).toBeGreaterThan(0);
    expect(plan.scaleNote).toMatch(/ArUco|known size/i);
  });

  it('is deterministic (same target -> same plan)', () => {
    expect(generateCapturePlan('room')).toEqual(generateCapturePlan('room'));
  });
});

describe('capture-plan: drone scan pattern math', () => {
  it('derives waypoints-per-ring from FOV + overlap (theta = (1-o)*2*tan(fov/2))', () => {
    const p = droneScanPattern({ home: HOME, radiusM: 4, altitudesM: [2.5], overlapPct: 0.75, fovDeg: 70 });
    const theta = 0.25 * 2 * Math.tan((70 * Math.PI) / 360);
    expect(p.perRing).toBe(Math.ceil((2 * Math.PI) / theta));
    expect(p.waypoints).toHaveLength(p.perRing);
    // Tighter overlap must mean MORE shots.
    const tighter = droneScanPattern({ home: HOME, radiusM: 4, altitudesM: [2.5], overlapPct: 0.85, fovDeg: 70 });
    expect(tighter.perRing).toBeGreaterThan(p.perRing);
  });

  it('places every waypoint on the orbit radius at its ring altitude', () => {
    const p = droneScanPattern({ home: HOME, radiusM: 4, altitudesM: [2.5, 4.5], overlapPct: 0.75, fovDeg: 70 });
    expect(p.waypoints).toHaveLength(p.perRing * 2);
    for (const w of p.waypoints) {
      expect(Math.abs(haversineM(HOME, w) - 4)).toBeLessThan(0.1);
      expect([2.5, 4.5]).toContain(w.alt);
      expect(w.camera.op).toBe('photo');
    }
    // The upper ring looks DOWN into the scene; the base ring shoots level.
    const upper = p.waypoints.filter((w) => w.alt === 4.5);
    expect(upper.every((w) => w.camera.tiltDeg < 0)).toBe(true);
    expect(p.waypoints.filter((w) => w.alt === 2.5).every((w) => w.camera.tiltDeg === 0)).toBe(true);
  });

  it('default pattern fits under MAX_WAYPOINTS and validates as a mission', () => {
    const p = droneScanPattern({ home: HOME, radiusM: 4, altitudesM: [2.5, 4.5], overlapPct: 0.75, fovDeg: 70 });
    expect(p.waypoints.length).toBeLessThanOrEqual(MAX_WAYPOINTS);
    const plan: MissionPlan = {
      name: 'spaces-scan-orbit',
      speedMps: 2,
      rtlAfterMission: true,
      waypoints: p.waypoints.map((w) => ({
        lat: w.lat, lon: w.lon, alt: w.alt, headingDeg: w.headingDeg,
        camera: { op: 'photo' as const, tiltDeg: w.camera.tiltDeg },
      })),
    };
    const errors = validateMission(plan, { maxRadiusM: 100, maxAltM: 120, minAltM: 1 }, { ...HOME, alt: 0 });
    expect(errors).toEqual([]);
  });
});

describe('capture-telemetry: live-guide sensor readings are validated before touching disk', () => {
  const SID = '12345678-1234-1234-1234-123456789abc';
  const good = { sessionId: SID, step: 2, ts: 1_784_560_000_000, headingDeg: 271.5, sweepDeg: 120, steps: 14, gps: null };

  it('accepts a well-formed record and preserves its fields', () => {
    expect(sanitizeCaptureTelemetry(good)).toEqual(good);
  });

  it('rejects non-UUID session ids (the id becomes a filename)', () => {
    for (const bad of ['../../etc/passwd', 'abc', `${SID}x`, 'ABCDEF12-1234-1234-1234-123456789abc', '', 42]) {
      expect(sanitizeCaptureTelemetry({ ...good, sessionId: bad })).toBeNull();
      if (typeof bad === 'string') expect(CAPTURE_SESSION_ID_RE.test(bad)).toBe(false);
    }
  });

  it('nulls out non-finite / out-of-range sensor fields instead of persisting them', () => {
    const r = sanitizeCaptureTelemetry({
      ...good, headingDeg: Number.NaN, sweepDeg: -5, steps: 2.5,
      gps: { lat: 999, lon: 0, accuracyM: 3 },
    });
    expect(r).not.toBeNull();
    expect(r!.headingDeg).toBeNull();
    expect(r!.sweepDeg).toBeNull();
    expect(r!.steps).toBeNull();
    expect(r!.gps).toBeNull();
  });

  it('rejects records missing the required envelope (step/ts)', () => {
    expect(sanitizeCaptureTelemetry({ ...good, step: -1 })).toBeNull();
    expect(sanitizeCaptureTelemetry({ ...good, ts: 0 })).toBeNull();
    expect(sanitizeCaptureTelemetry(null)).toBeNull();
    expect(sanitizeCaptureTelemetry('x')).toBeNull();
  });

  it('telemetry sidecar path is owner-scoped (hashed sub, session-keyed)', () => {
    const p = captureTelemetryPath('u|1', SID);
    expect(p.includes(subHash('u|1'))).toBe(true);
    expect(p.endsWith(`${SID}.jsonl`)).toBe(true);
    expect(p.includes('u|1')).toBe(false); // never the raw sub on disk
  });
});

describe('capture-plan: sim drone flies the pattern (virtual clock, Phase 3 sim-first)', () => {
  it('completes the mission and fires one photo per waypoint', async () => {
    const p = droneScanPattern({ home: HOME, radiusM: 4, altitudesM: [2.5, 4.5], overlapPct: 0.75, fovDeg: 70 });
    const plan: MissionPlan = {
      name: 'spaces-scan-orbit',
      speedMps: 2,
      rtlAfterMission: true,
      waypoints: p.waypoints.map((w) => ({
        lat: w.lat, lon: w.lon, alt: w.alt, headingDeg: w.headingDeg,
        camera: { op: 'photo' as const, tiltDeg: w.camera.tiltDeg },
      })),
    };
    let virtualNow = 0;
    const drone = new SimDroneProvider({ droneId: 'scan-guard', home: HOME, clock: () => virtualNow });
    await drone.arm();
    await drone.startMission(plan);
    let t = drone.getTelemetry();
    for (let s = 0; s < 3600 && t.status !== 'disarmed'; s++) {
      virtualNow += 1000;
      t = drone.getTelemetry();
    }
    expect(t.status).toBe('disarmed'); // flew the mission, RTL'd, landed
    const captures = drone.getCaptures(0);
    expect(captures.length).toBe(plan.waypoints.length);
    expect(captures.every((c) => c.kind === 'photo')).toBe(true);
  }, 20_000);
});
