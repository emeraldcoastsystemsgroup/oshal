/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — fleet missions
 *                     |                             | (ADR-099 decision #2): draft normalization, the pairwise
 *                     |                             | separation validator (incl. path crossings BETWEEN
 *                     |                             | waypoints), all-or-nothing startFleetMission (validation
 *                     |                             | rejects before ANY drone moves; runtime failure unwinds
 *                     |                             | already-started members), the hardware confirm rail on
 *                     |                             | fleet orders, and the abortFleet safety sweep.
 */

import { describe, expect, it } from 'vitest';
import {
  DroneService,
  DroneValidationError,
  SimDroneProvider,
  isFleetMissionShape,
  normalizeFleetMissionDraft,
  validateFleetSeparation,
  minPolylineDistanceM,
  MAX_FLEET_ASSIGNMENTS,
  type DroneNodeHeartbeat,
  type DroneTelemetry,
  type FleetAssignment,
  type MissionPlan,
} from '@/features/drone';

const HOME = { lat: 30.0, lon: -86.0 };
const M_PER_DEG_LAT = 111320;

/** A waypoint at metric offsets from HOME — keeps the geometry in the tests readable. */
function wp(eastM: number, northM: number, alt: number): { lat: number; lon: number; alt: number } {
  return {
    lat: HOME.lat + northM / M_PER_DEG_LAT,
    lon: HOME.lon + eastM / (M_PER_DEG_LAT * Math.cos((HOME.lat * Math.PI) / 180)),
    alt,
  };
}

function plan(name: string, waypoints: Array<{ lat: number; lon: number; alt: number }>): MissionPlan {
  return { name, waypoints, speedMps: 8, rtlAfterMission: true };
}

function assignment(droneId: string, waypoints: Array<{ lat: number; lon: number; alt: number }>): FleetAssignment {
  return { droneId, plan: plan(`${droneId} leg`, waypoints) };
}

function telemetry(over: Partial<DroneTelemetry> = {}): DroneTelemetry {
  return {
    droneId: 'drone-1',
    status: 'disarmed',
    position: { lat: HOME.lat, lon: HOME.lon, alt: 0 },
    home: { lat: HOME.lat, lon: HOME.lon, alt: 0 },
    headingDeg: 0,
    groundSpeedMps: 0,
    batteryPct: 100,
    distanceFromHomeM: 0,
    mission: null,
    failsafe: null,
    ...over,
  };
}

function heartbeat(over: Partial<DroneNodeHeartbeat> = {}): DroneNodeHeartbeat {
  return { droneId: 'drone-1', endpointUrl: 'http://127.0.0.1:9', engine: 'sim', telemetry: telemetry(), events: [], ...over };
}

/** A service with a fake clock, alpha + bravo embedded sims, and the default 500m fence. */
function fleetService(clockRef: { t: number }): DroneService {
  return new DroneService({
    provider: new SimDroneProvider({ home: HOME, clock: () => clockRef.t }),
    home: HOME,
    clock: () => clockRef.t,
    extraSimIds: ['bravo'],
  });
}

describe('normalizeFleetMissionDraft', () => {
  it('normalizes a two-drone draft and names unnamed member plans after the fleet', () => {
    const raw = {
      name: 'Twin survey',
      assignments: [
        { droneId: 'alpha', waypoints: [wp(0, 50, 30)], speedMps: 8 },
        { droneId: 'bravo', waypoints: [wp(50, 0, 45)] },
      ],
    };
    expect(isFleetMissionShape(raw)).toBe(true);
    const { plan: fleet, errors } = normalizeFleetMissionDraft(raw);
    expect(errors).toEqual([]);
    expect(fleet?.assignments.map((a) => a.droneId)).toEqual(['alpha', 'bravo']);
    expect(fleet?.assignments[0].plan.name).toBe('Twin survey · alpha');
    expect(fleet?.assignments[1].plan.rtlAfterMission).toBe(true);
  });

  it('is idempotent — a stored (already-normalized) fleet plan re-normalizes unchanged', () => {
    const first = normalizeFleetMissionDraft({
      name: 'Twin survey',
      assignments: [
        { droneId: 'alpha', waypoints: [wp(0, 50, 30)] },
        { droneId: 'bravo', waypoints: [wp(50, 0, 45)] },
      ],
    });
    // Execute-time re-validation runs the STORED row (nested plan shape) back through.
    const second = normalizeFleetMissionDraft(first.plan);
    expect(second.errors).toEqual([]);
    expect(second.plan).toEqual(first.plan);
  });

  it('rejects duplicate drones, hostile ids, shapeless drafts, and oversized fleets', () => {
    expect(normalizeFleetMissionDraft(null).errors).toEqual(['fleet mission draft is not an object']);
    expect(normalizeFleetMissionDraft({ assignments: [] }).errors[0]).toMatch(/no assignments/);
    const dup = normalizeFleetMissionDraft({
      assignments: [
        { droneId: 'alpha', waypoints: [wp(0, 10, 30)] },
        { droneId: 'alpha', waypoints: [wp(0, 20, 45)] },
      ],
    });
    expect(dup.plan).toBeNull();
    expect(dup.errors[0]).toMatch(/more than one assignment/);
    expect(normalizeFleetMissionDraft({ assignments: [{ droneId: '../etc', waypoints: [wp(0, 10, 30)] }] }).errors[0]).toMatch(/valid droneId/);
    const big = normalizeFleetMissionDraft({
      assignments: Array.from({ length: MAX_FLEET_ASSIGNMENTS + 1 }, (_, i) => ({ droneId: `d${i}`, waypoints: [wp(0, 10, 30)] })),
    });
    expect(big.errors[0]).toMatch(/limit is/);
  });
});

describe('validateFleetSeparation', () => {
  it('rejects same-altitude lanes that run too close', () => {
    const errors = validateFleetSeparation([
      assignment('alpha', [wp(0, 0, 30), wp(0, 200, 30)]),
      assignment('bravo', [wp(5, 0, 30), wp(5, 200, 30)]),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"alpha" and "bravo"/);
  });

  it('accepts the same close lanes once they are altitude-layered', () => {
    expect(validateFleetSeparation([
      assignment('alpha', [wp(0, 0, 30), wp(0, 200, 30)]),
      assignment('bravo', [wp(5, 0, 45), wp(5, 200, 45)]),
    ])).toEqual([]);
  });

  it('accepts same-altitude lanes that keep horizontal distance', () => {
    expect(validateFleetSeparation([
      assignment('alpha', [wp(0, 0, 30), wp(0, 200, 30)]),
      assignment('bravo', [wp(100, 0, 30), wp(100, 200, 30)]),
    ])).toEqual([]);
  });

  it('catches paths that cross BETWEEN waypoints, not just close waypoints', () => {
    // X pattern: every waypoint pair is ≥100m apart, but the legs cross mid-span.
    const a = [wp(0, 0, 30), wp(100, 100, 30)];
    const b = [wp(0, 100, 30), wp(100, 0, 30)];
    expect(minPolylineDistanceM(a, b)).toBe(0);
    const errors = validateFleetSeparation([assignment('alpha', a), assignment('bravo', b)]);
    expect(errors).toHaveLength(1);
  });
});

describe('DroneService.startFleetMission — all-or-nothing', () => {
  it('flies every member of a valid fleet order (ground members auto-armed by the approval)', async () => {
    const clock = { t: 0 };
    const svc = fleetService(clock);
    await svc.startFleetMission({
      name: 'Airshow',
      assignments: [
        assignment('alpha', [wp(0, 60, 30), wp(0, 120, 30)]),
        assignment('bravo', [wp(60, 0, 45), wp(120, 0, 45)]),
      ],
    });
    const alpha = svc.getState('alpha').telemetry;
    const bravo = svc.getState('bravo').telemetry;
    expect(alpha.status).toBe('takeoff');
    expect(alpha.mission?.name).toBe('alpha leg');
    expect(bravo.status).toBe('takeoff');
    expect(bravo.mission?.name).toBe('bravo leg');
  });

  it('rejects the WHOLE order when one member violates the fence — nothing moves', async () => {
    const clock = { t: 0 };
    const svc = fleetService(clock);
    await expect(svc.startFleetMission({
      name: 'Bad order',
      assignments: [
        assignment('alpha', [wp(0, 60, 30)]),
        assignment('bravo', [wp(900, 0, 45)]), // outside the 500m fence
      ],
    })).rejects.toThrow(DroneValidationError);
    expect(svc.getState('alpha').telemetry.status).toBe('disarmed');
    expect(svc.getState('bravo').telemetry.status).toBe('disarmed');
  });

  it('rejects the whole order on a separation conflict, naming both drones', async () => {
    const clock = { t: 0 };
    const svc = fleetService(clock);
    await expect(svc.startFleetMission({
      name: 'Collision course',
      assignments: [
        assignment('alpha', [wp(0, 0, 30), wp(100, 100, 30)]),
        assignment('bravo', [wp(0, 100, 30), wp(100, 0, 30)]),
      ],
    })).rejects.toThrow(/"alpha" and "bravo"/);
    expect(svc.getState('alpha').telemetry.status).toBe('disarmed');
  });

  it('requires the confirm rail when any member is real hardware, and rejects offline members', async () => {
    const clock = { t: 0 };
    const svc = fleetService(clock);
    svc.ingestHeartbeat(heartbeat({ droneId: 'drone-1', engine: 'mavlink' }));
    await expect(svc.startFleetMission({
      name: 'Mixed order',
      assignments: [assignment('alpha', [wp(0, 60, 30)]), assignment('drone-1', [wp(60, 0, 45)])],
    })).rejects.toThrow(/real hardware.*confirm/);
    expect(svc.getState('alpha').telemetry.status).toBe('disarmed');

    clock.t += 20_000; // drone-1 goes stale → offline members reject the order too
    await expect(svc.startFleetMission({
      name: 'Offline order',
      assignments: [assignment('alpha', [wp(0, 60, 30)]), assignment('drone-1', [wp(60, 0, 45)])],
      // confirm satisfied — the offline check is what must reject now
    }, true)).rejects.toThrow(/offline/);
    expect(svc.getState('alpha').telemetry.status).toBe('disarmed');
  });

  it('unwinds already-started members when a later member fails at runtime', async () => {
    const clock = { t: 0 };
    const svc = fleetService(clock);
    // drone-9 heartbeats as an ONLINE sim node, but its endpoint answers nothing — phase-1
    // validation passes, phase-2 startMission fails, and alpha (already flying) must abort.
    svc.ingestHeartbeat(heartbeat({ droneId: 'drone-9' }));
    await expect(svc.startFleetMission({
      name: 'Half-dead fleet',
      assignments: [assignment('alpha', [wp(0, 60, 30)]), assignment('drone-9', [wp(60, 0, 45)])],
    })).rejects.toThrow(/failed at drone "drone-9".*already-started members \[alpha\]/);
    expect(svc.getState('alpha').telemetry.mission).toBeNull();
  });
});

describe('DroneService.abortFleet — the safety sweep', () => {
  it('reports one outcome per drone and never throws', async () => {
    const clock = { t: 0 };
    const svc = fleetService(clock);
    svc.ingestHeartbeat(heartbeat({ droneId: 'drone-1' }));
    clock.t += 20_000; // drone-1 offline; alpha flying; bravo idle on the ground
    await svc.startFleetMission({ name: 'Solo', assignments: [assignment('alpha', [wp(0, 60, 30)])] });
    const outcomes = await svc.abortFleet();
    const byId = Object.fromEntries(outcomes.map((o) => [o.droneId, o.outcome]));
    expect(byId).toEqual({ alpha: 'aborted', bravo: 'no-mission', 'drone-1': 'offline' });
    expect(svc.getState('alpha').telemetry.mission).toBeNull();
  });
});
