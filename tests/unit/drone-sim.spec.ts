/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Drone Ops (ADR-098)
 *                     |                             | unit coverage: sim state machine + kinematics under an
 *                     |                             | injected clock, geofence gate in DroneService, mission
 *                     |                             | lifecycle incl. auto-RTL, battery failsafe, validator
 *                     |                             | rules, and untrusted mission-draft normalization.
 */

import { describe, expect, it } from 'vitest';
import {
  DroneService,
  DroneCommandError,
  DroneValidationError,
  SimDroneProvider,
  normalizeMissionDraft,
  validateMission,
  type Geofence,
  type MissionPlan,
} from '@/features/drone';

const HOME = { lat: 30.0, lon: -86.0 };
const FENCE: Geofence = { maxRadiusM: 500, maxAltM: 120, minAltM: 2 };
const M_PER_DEG_LAT = 111320;

/** Offsets from HOME in meters, as absolute coordinates. */
function at(northM: number, eastM: number, alt: number): { lat: number; lon: number; alt: number } {
  return {
    lat: HOME.lat + northM / M_PER_DEG_LAT,
    lon: HOME.lon + eastM / (M_PER_DEG_LAT * Math.cos((HOME.lat * Math.PI) / 180)),
    alt,
  };
}

/** A sim + service pair on a controllable clock. Advance in ≤600s chunks (sim caps catch-up at 900s). */
function rig(): { drone: DroneService; sim: SimDroneProvider; advance: (s: number) => void } {
  let t = 0;
  const sim = new SimDroneProvider({ home: HOME, clock: () => t });
  const drone = new DroneService({ provider: sim, fence: FENCE });
  const advance = (s: number): void => {
    let left = s;
    while (left > 0) {
      const chunk = Math.min(left, 600);
      t += chunk * 1000;
      sim.getTelemetry(); // observe → lazy-integrate this chunk
      left -= chunk;
    }
  };
  return { drone, sim, advance };
}

describe('sim drone state machine + kinematics', () => {
  it('arms, climbs to the commanded altitude, and holds', async () => {
    const { drone, advance } = rig();
    await drone.arm();
    await drone.takeoff(30);
    advance(15); // 2.5 m/s climb → 12s to 30m
    const t = drone.getState().telemetry;
    expect(t.status).toBe('hold');
    expect(t.position.alt).toBe(30);
  });

  it('rejects out-of-order commands with DroneCommandError', async () => {
    const { drone } = rig();
    await expect(drone.takeoff(30)).rejects.toBeInstanceOf(DroneCommandError);
    await expect(drone.land()).rejects.toBeInstanceOf(DroneCommandError);
    await drone.arm();
    await expect(drone.goto(at(10, 0, 30))).rejects.toBeInstanceOf(DroneCommandError); // must take off first
    await expect(drone.arm()).rejects.toBeInstanceOf(DroneCommandError);
  });

  it('flies to a commanded point and holds there', async () => {
    const { drone, advance } = rig();
    await drone.arm();
    await drone.takeoff(30);
    advance(15);
    const target = at(0, 100, 30);
    await drone.goto(target, 8);
    advance(20); // 100m at 8 m/s = 12.5s
    const t = drone.getState().telemetry;
    expect(t.status).toBe('hold');
    expect(t.position.lon).toBeCloseTo(target.lon, 6);
    expect(t.distanceFromHomeM).toBeGreaterThan(90);
  });

  it('flies a mission from the ground (auto-takeoff), then auto-RTLs home and disarms', async () => {
    const { drone, advance } = rig();
    const plan: MissionPlan = {
      name: 'box test',
      waypoints: [at(50, 0, 20), at(50, 50, 20)],
      speedMps: 10,
      rtlAfterMission: true,
    };
    await drone.arm();
    await drone.startMission(plan);
    expect(drone.getState().telemetry.status).toBe('takeoff');
    advance(120);
    const t = drone.getState().telemetry;
    expect(t.status).toBe('disarmed');
    expect(t.position.alt).toBe(0);
    expect(t.distanceFromHomeM).toBeLessThan(2);
    const messages = drone.getEvents(0).map((e) => e.message).join(' | ');
    expect(messages).toContain('Reached waypoint 1/2');
    expect(messages).toContain('Reached waypoint 2/2');
    expect(messages).toContain('Mission "box test" complete');
    expect(messages).toContain('Landed and disarmed');
  });

  it('loiters at a waypoint with holdSeconds before continuing', async () => {
    const { drone, advance } = rig();
    const plan: MissionPlan = {
      name: 'hold test',
      waypoints: [{ ...at(40, 0, 20), holdSeconds: 30 }, at(80, 0, 20)],
      speedMps: 10,
      rtlAfterMission: false,
    };
    await drone.arm();
    await drone.startMission(plan);
    advance(8 + 4 + 10); // takeoff (8s) + 40m leg (4s) + 10s into the 30s hold
    const mid = drone.getState().telemetry;
    expect(mid.status).toBe('mission');
    expect(mid.mission?.index).toBe(0); // still on wp1, loitering
    advance(30 + 10); // finish hold + fly leg 2
    expect(drone.getState().telemetry.status).toBe('hold'); // no RTL — holds at final waypoint
  });

  it('abort stops the mission and holds position', async () => {
    const { drone, advance } = rig();
    await drone.arm();
    await drone.startMission({ name: 'abort test', waypoints: [at(200, 0, 30)], speedMps: 5, rtlAfterMission: true });
    advance(20);
    expect(drone.getState().telemetry.status).toBe('mission');
    await drone.abortMission();
    const t = drone.getState().telemetry;
    expect(t.status).toBe('hold');
    expect(t.mission).toBeNull();
    await expect(drone.abortMission()).rejects.toBeInstanceOf(DroneCommandError);
  });

  it('low battery triggers the RTL failsafe, and arming is battery-gated until a swap', async () => {
    const { drone, advance } = rig();
    await drone.arm();
    await drone.takeoff(10);
    advance(1400); // flight drain 0.06%/s → below the 20% RTL threshold
    const t = drone.getState().telemetry;
    expect(t.status).toBe('disarmed'); // RTL over home → immediate land
    expect(t.batteryPct).toBeLessThan(20);
    expect(drone.getEvents(0).some((e) => e.level === 'alert' && e.message.includes('FAILSAFE'))).toBe(true);
    await expect(drone.arm()).rejects.toBeInstanceOf(DroneCommandError); // < 30% arming minimum
    await drone.replaceBattery();
    await drone.arm();
    expect(drone.getState().telemetry.status).toBe('armed');
  });

  it('event log is seq-filterable', async () => {
    const { drone } = rig();
    await drone.arm();
    await drone.disarm();
    const all = drone.getEvents(0);
    expect(all.length).toBe(2);
    expect(drone.getEvents(all[0].seq).map((e) => e.message)).toEqual(['Disarmed']);
  });
});

describe('geofence gate (DroneService)', () => {
  it('rejects a takeoff above the ceiling before the engine sees it', async () => {
    const { drone } = rig();
    await drone.arm();
    await expect(drone.takeoff(500)).rejects.toBeInstanceOf(DroneValidationError);
    expect(drone.getState().telemetry.status).toBe('armed'); // untouched
  });

  it('rejects a goto beyond the fence radius and reports every violation', async () => {
    const { drone, advance } = rig();
    await drone.arm();
    await drone.takeoff(30);
    advance(15);
    const err = await drone.goto(at(2000, 0, 500)).catch((e) => e);
    expect(err).toBeInstanceOf(DroneValidationError);
    expect(err.errors.join(' ')).toContain('geofence radius');
    expect(err.errors.join(' ')).toContain('ceiling');
  });

  it('rejects a mission whose ANY waypoint breaks the fence', async () => {
    const { drone } = rig();
    await drone.arm();
    const bad: MissionPlan = {
      name: 'bad',
      waypoints: [at(50, 0, 30), at(600, 0, 30)],
      speedMps: 8,
      rtlAfterMission: true,
    };
    await expect(drone.startMission(bad)).rejects.toBeInstanceOf(DroneValidationError);
  });
});

describe('mission validation rules', () => {
  const home = { ...HOME, alt: 0 };

  it('flags empty missions, bad speeds, and bad holds', () => {
    expect(validateMission({ name: 'x', waypoints: [], speedMps: 8, rtlAfterMission: true }, FENCE, home))
      .toContain('mission has no waypoints');
    const errs = validateMission(
      { name: '', waypoints: [{ ...at(10, 0, 30), holdSeconds: 9999 }], speedMps: 99, rtlAfterMission: true },
      FENCE, home,
    );
    expect(errs.some((e) => e.includes('name is required'))).toBe(true);
    expect(errs.some((e) => e.includes('speed 99'))).toBe(true);
    expect(errs.some((e) => e.includes('hold of 9999s'))).toBe(true);
  });

  it('accepts a compliant mission', () => {
    const plan: MissionPlan = { name: 'ok', waypoints: [at(100, 100, 60)], speedMps: 8, rtlAfterMission: true };
    expect(validateMission(plan, FENCE, home)).toEqual([]);
  });
});

describe('mission draft normalization (untrusted LLM/surface input)', () => {
  it('coerces strings, fills defaults, and drops zero holds', () => {
    const { plan, errors } = normalizeMissionDraft({
      waypoints: [{ lat: '30.001', lon: '-86.001', alt: '25', holdSeconds: 0 }],
    });
    expect(errors).toEqual([]);
    expect(plan).toMatchObject({ name: 'Drafted mission', speedMps: 8, rtlAfterMission: true });
    expect(plan?.waypoints[0]).toEqual({ lat: 30.001, lon: -86.001, alt: 25 });
  });

  it('reports malformed waypoints instead of guessing', () => {
    expect(normalizeMissionDraft(null).errors).toContain('mission draft is not an object');
    expect(normalizeMissionDraft({ waypoints: [] }).errors).toContain('mission draft has no waypoints array');
    const r = normalizeMissionDraft({ waypoints: [{ lat: 1, lon: 2 }, 'nope'] });
    expect(r.plan).toBeNull();
    expect(r.errors).toEqual([
      'waypoint 1 is missing a numeric lat/lon/alt',
      'waypoint 2 is not an object',
    ]);
  });
});
