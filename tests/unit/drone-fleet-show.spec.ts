/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — show timelines +
 *                     |                             | the conductor: draft normalization (relative + idempotent
 *                     |                             | absolute), the full validation gate (launch window,
 *                     |                             | reachability, cue + transition-leg separation), the ballet
 *                     |                             | preset clearing its own gate at every fleet size, and the
 *                     |                             | FleetShowRunner on a fake clock — synchronized arrivals AT
 *                     |                             | cue times, phase machine through launch→cues→rtl→complete,
 *                     |                             | freeze-the-show stop, and the one-show-at-a-time rule.
 */

import { describe, expect, it } from 'vitest';
import {
  DroneService,
  FleetShowRunner,
  SimDroneProvider,
  generateBalletShow,
  normalizeShowDraft,
  normalizeMissionDraft,
  validateShowTimeline,
  haversineM,
  type Geofence,
  type GeoPoint,
  type ShowTimeline,
} from '@/features/drone';

const FENCE: Geofence = { maxRadiusM: 500, maxAltM: 120, minAltM: 2 };
const HOME = { lat: 30.0, lon: -86.0 };
const M_PER_DEG_LAT = 111320;

function abs(eastM: number, northM: number): { lat: number; lon: number } {
  return {
    lat: HOME.lat + northM / M_PER_DEG_LAT,
    lon: HOME.lon + eastM / (M_PER_DEG_LAT * Math.cos((HOME.lat * Math.PI) / 180)),
  };
}

function homesFor(ids: string[]): Record<string, GeoPoint> {
  const homes: Record<string, GeoPoint> = {};
  ids.forEach((id, i) => { homes[id] = { ...abs(i * 8, 0), alt: 0 }; });
  return homes;
}

/** alpha + bravo service on a fake clock (bravo's pad sits 8m east, like the embedded sims). */
function showService(clockRef: { t: number }): DroneService {
  return new DroneService({
    provider: new SimDroneProvider({ home: HOME, clock: () => clockRef.t }),
    home: HOME,
    clock: () => clockRef.t,
    extraSimIds: ['bravo'],
  });
}

/** A minimal 2-drone timeline: layered launch (8m pads), two cues, RTL outro. */
function twoDroneTimeline(): ShowTimeline {
  return {
    kind: 'show',
    name: 'Test show',
    rtlAfterShow: true,
    cues: [
      { at: 30, name: 'line', slots: [
        { droneId: 'alpha', ...abs(0, 30), alt: 30 },
        { droneId: 'bravo', ...abs(30, 0), alt: 45 },
      ] },
      { at: 55, name: 'shift', slots: [
        { droneId: 'alpha', ...abs(0, 60), alt: 30 },
        { droneId: 'bravo', ...abs(60, 0), alt: 45 },
      ] },
    ],
  };
}

describe('normalizeShowDraft', () => {
  it('absolutizes stage-relative slots and is idempotent on the stored shape', () => {
    const homes = homesFor(['alpha', 'bravo']);
    const first = normalizeShowDraft({
      name: 'Rel',
      cues: [{ at: 30, slots: [{ droneId: 'alpha', e: 0, n: 30, alt: 30 }, { droneId: 'bravo', e: 30, n: 0, alt: 45 }] }],
    }, homes);
    expect(first.errors).toEqual([]);
    const slot = first.timeline!.cues[0].slots[0];
    // e:0 n:30 from the pads' centroid (4m east of alpha's pad) → ~30m north of it.
    expect(haversineM(slot, { lat: homes.alpha.lat + 30 / M_PER_DEG_LAT, lon: homes.alpha.lon })).toBeLessThan(6);
    const second = normalizeShowDraft(first.timeline, homes);
    expect(second.errors).toEqual([]);
    expect(second.timeline).toEqual(first.timeline);
  });

  it('rejects shapeless drafts, duplicate slots, and bad cue times', () => {
    const homes = homesFor(['alpha']);
    expect(normalizeShowDraft(null, homes).errors).toEqual(['show draft is not an object']);
    expect(normalizeShowDraft({ cues: [] }, homes).errors[0]).toMatch(/no cues/);
    expect(normalizeShowDraft({ cues: [{ at: 0, slots: [{ droneId: 'alpha', e: 0, n: 0, alt: 30 }] }] }, homes).errors[0]).toMatch(/positive "at"/);
    expect(normalizeShowDraft({
      cues: [{ at: 30, slots: [{ droneId: 'alpha', e: 0, n: 0, alt: 30 }, { droneId: 'alpha', e: 5, n: 0, alt: 45 }] }],
    }, homes).errors[0]).toMatch(/twice/);
  });
});

describe('validateShowTimeline', () => {
  it('accepts the two-drone timeline', () => {
    expect(validateShowTimeline(twoDroneTimeline(), FENCE, homesFor(['alpha', 'bravo']))).toEqual([]);
  });

  it('rejects a first cue inside the climb window', () => {
    const t = twoDroneTimeline();
    t.cues[0].at = 10; // bravo must climb to 45m — needs ≥ 27.5s
    t.cues[1].at = 20;
    expect(validateShowTimeline(t, FENCE, homesFor(['alpha', 'bravo'])).join(' ')).toMatch(/too early/);
  });

  it('rejects an unreachable transition leg', () => {
    const t = twoDroneTimeline();
    t.cues[1].slots[0] = { droneId: 'alpha', ...abs(0, 450), alt: 30 }; // 420m in 25s → 16.8 m/s
    expect(validateShowTimeline(t, FENCE, homesFor(['alpha', 'bravo'])).join(' ')).toMatch(/needs 16.8 m\/s/);
  });

  it('rejects formations the fleet gate would never allow', () => {
    const tooClose = twoDroneTimeline();
    tooClose.cues[0].slots[1] = { droneId: 'bravo', ...abs(5, 30), alt: 30 }; // 5m from alpha, level
    expect(validateShowTimeline(tooClose, FENCE, homesFor(['alpha', 'bravo'])).join(' ')).toMatch(/launch→cue 1/);
  });

  it('accepts MIXED-PRESENCE timelines — each drone on its own schedule', () => {
    // bravo skips cue 1 entirely: it launches, holds above its pad at 45m, joins at cue 2.
    const mixed = twoDroneTimeline();
    mixed.cues[0].slots = [mixed.cues[0].slots[0]];
    expect(validateShowTimeline(mixed, FENCE, homesFor(['alpha', 'bravo']))).toEqual([]);
    // But a holder parked in a mover's path is still caught: alpha's cue-2 slot lands on
    // bravo's holding position (above bravo's pad, same altitude band).
    const clash = twoDroneTimeline();
    clash.cues[0].slots = [clash.cues[0].slots[0]];
    clash.cues[1].slots[0] = { droneId: 'alpha', ...abs(8, 0), alt: 45 };
    clash.cues[1].slots[1] = { droneId: 'bravo', ...abs(120, 0), alt: 45 };
    expect(validateShowTimeline(clash, FENCE, homesFor(['alpha', 'bravo'])).join(' ')).toMatch(/→cue 2/);
  });

  it('the ballet preset clears its own gate at every fleet size', () => {
    for (const n of [2, 3, 8]) {
      const ids = Array.from({ length: n }, (_, i) => (i === 0 ? 'alpha' : `sim-${i}`));
      const homes = homesFor(ids);
      const draft = generateBalletShow(ids.map((id) => ({ droneId: id, home: homes[id] })));
      const { timeline, errors } = normalizeShowDraft(draft, homes);
      expect(errors).toEqual([]);
      expect(validateShowTimeline(timeline!, FENCE, homes)).toEqual([]);
      expect(timeline!.cues).toHaveLength(5);
    }
  });
});

describe('Equipment + rotation — arrival actions', () => {
  it('goto arrival applies heading + LED and logs the equipment trigger event', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    await svc.arm('alpha');
    await svc.takeoff(30, 'alpha');
    clock.t += 15_000; // climb done → hold
    await svc.goto({ ...abs(0, 40), alt: 30, headingDeg: 270, led: '#00ff00' }, 8, 'alpha');
    clock.t += 10_000; // 40m at 8 m/s → arrived
    const tel = svc.getState('alpha').telemetry;
    expect(tel.headingDeg).toBe(270);
    expect(tel.led).toBe('#00ff00');
    expect(svc.getEvents(0, 'alpha').map((e) => e.message).join(' ')).toMatch(/EQUIP led → #00ff00/);
  });

  it('manual LED is color-validated; rotate is refused on a disarmed drone', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    await expect(svc.setLed('<script>', 'alpha')).rejects.toThrow(/invalid LED color/);
    await svc.setLed('red', 'alpha');
    expect(svc.getState('alpha').telemetry.led).toBe('red');
    await svc.setLed('off', 'alpha');
    expect(svc.getState('alpha').telemetry.led).toBeNull();
    await expect(svc.setHeading(90, 'alpha')).rejects.toThrow(/cannot rotate while disarmed/);
  });

  it('normalizers carry heading/led and reject junk colors', () => {
    const m = normalizeMissionDraft({ waypoints: [{ lat: 30, lon: -86, alt: 30, headingDeg: -90, led: '#FF0000' }] });
    expect(m.errors).toEqual([]);
    expect(m.plan!.waypoints[0].headingDeg).toBe(270);
    expect(m.plan!.waypoints[0].led).toBe('#ff0000');
    expect(normalizeMissionDraft({ waypoints: [{ lat: 30, lon: -86, alt: 30, led: 'javascript:x' }] }).errors[0]).toMatch(/invalid LED color/);
    const s = normalizeShowDraft({ cues: [{ at: 30, slots: [{ droneId: 'alpha', e: 0, n: 30, alt: 30, led: 'lime', headingDeg: 400 }] }] }, homesFor(['alpha']));
    expect(s.errors).toEqual([]);
    expect(s.timeline!.cues[0].slots[0].led).toBe('lime');
    expect(s.timeline!.cues[0].slots[0].headingDeg).toBe(40);
  });

  it('the conductor fires slot LEDs at their cues — green at cue 1, off at cue 2', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    const t = twoDroneTimeline();
    t.cues[0].slots[0] = { ...t.cues[0].slots[0], led: '#00ff00', headingDeg: 180 };
    t.cues[1].slots[0] = { ...t.cues[1].slots[0], led: 'off' };
    await runner.start(t);
    const advanceTo = async (seconds: number): Promise<void> => {
      while (clock.t < seconds * 1000) { clock.t = Math.min(clock.t + 1000, seconds * 1000); await runner.tick(); }
    };
    await advanceTo(30.5); // cue 1 reached → LED green; rotation logged AT the stop
    expect(svc.getState('alpha').telemetry.led).toBe('#00ff00');
    // Heading is transient (motion re-steers it) — the arrival rotation shows in the log.
    expect(svc.getEvents(0, 'alpha').map((e) => e.message).join(' | ')).toMatch(/Rotated to 180°/);
    await advanceTo(55.5); // cue 2 reached → LED off
    expect(svc.getState('alpha').telemetry.led).toBeNull();
  });
});

describe('FleetShowRunner — the conductor on a fake clock', () => {
  async function advanceTo(clock: { t: number }, runner: FleetShowRunner, seconds: number, stepS = 1): Promise<void> {
    const target = seconds * 1000;
    while (clock.t < target) {
      clock.t = Math.min(clock.t + stepS * 1000, target);
      await runner.tick();
    }
  }

  it('flies the timeline with synchronized arrivals AT the cue times, then RTLs to complete', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    const t = twoDroneTimeline();
    await runner.start(t);
    expect(svc.getState('alpha').telemetry.status).toBe('takeoff');
    expect(runner.status().phase).toBe('launch');

    await advanceTo(clock, runner, 22); // both at first-cue altitude → cue 1 legs dispatched
    expect(runner.status().phase).toBe('cues');
    expect(runner.status().formingCue).toBe(1);

    await advanceTo(clock, runner, 30.5); // cue 1 fires: BOTH drones are on their slots NOW
    for (const s of t.cues[0].slots) {
      const pos = svc.getState(s.droneId).telemetry.position;
      expect(haversineM(pos, s)).toBeLessThan(3);
      expect(Math.abs(pos.alt - s.alt)).toBeLessThan(2);
    }
    expect(runner.status().formingCue).toBe(2); // conductor already dispatched cue 2

    await advanceTo(clock, runner, 55.5); // cue 2 fires: formation reached in sync again
    for (const s of t.cues[1].slots) {
      expect(haversineM(svc.getState(s.droneId).telemetry.position, s)).toBeLessThan(3);
    }

    // Telemetry depth (round 2): the sim models rotors, odometer, and airborne time.
    expect(svc.getState('alpha').telemetry.rotorRpm).toBeGreaterThan(2000);

    await advanceTo(clock, runner, 62); // settle passed → outro
    expect(runner.status().phase).toBe('rtl');
    await advanceTo(clock, runner, 140);
    expect(runner.status().phase).toBe('complete');
    const done = svc.getState('alpha').telemetry;
    expect(done.status).toBe('disarmed');
    expect(done.rotorRpm).toBe(0);
    expect(done.odometerM ?? 0).toBeGreaterThan(100);   // climb + two legs + RTL + descent
    expect(done.flightTimeS ?? 0).toBeGreaterThan(60);
    expect(svc.getState('bravo').telemetry.status).toBe('disarmed');
  });

  it('mixed presence: an absent drone holds above its pad until its cue calls it', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    const t = twoDroneTimeline();
    t.cues[0].slots = [t.cues[0].slots[0]]; // cue 1 tasks alpha only
    await runner.start(t);
    await advanceTo(clock, runner, 22);
    // bravo launched at t0 regardless — to its FIRST-appearance altitude (cue 2 → 45m) — and holds.
    const bravoAt22 = svc.getState('bravo').telemetry;
    expect(bravoAt22.status).toBe('hold');
    expect(Math.abs(bravoAt22.position.alt - 45)).toBeLessThan(2);
    const parked = { ...bravoAt22.position };
    await advanceTo(clock, runner, 30.5); // cue 1 fires: alpha moves, bravo stays parked
    expect(haversineM(svc.getState('bravo').telemetry.position, parked)).toBeLessThan(2);
    await advanceTo(clock, runner, 55.5); // cue 2 fires: bravo joined the show on time
    expect(haversineM(svc.getState('bravo').telemetry.position, t.cues[1].slots[1])).toBeLessThan(3);
    await advanceTo(clock, runner, 140);
    expect(runner.status().phase).toBe('complete');
  });

  it('freezes the show on a LIVE proximity breach the plan never contained', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    const t = twoDroneTimeline();
    await runner.start(t);
    await advanceTo(clock, runner, 31); // cue 2 legs dispatched; conductor mid-show
    // Out-of-band sabotage: send bravo to ALPHA's cue-2 slot at ALPHA's altitude.
    await svc.goto({ ...abs(0, 60), alt: 30 }, 8, 'bravo');
    await advanceTo(clock, runner, 50);
    expect(runner.status().phase).toBe('failed');
    expect(runner.status().reason).toMatch(/proximity breach/);
    // Frozen, not shearing on: both drones are holding.
    expect(svc.getState('alpha').telemetry.status).toBe('hold');
    expect(svc.getState('bravo').telemetry.status).toBe('hold');
  });

  it('stop() freezes the show — drones hold in place, phase = stopped', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    await runner.start(twoDroneTimeline());
    await advanceTo(clock, runner, 25); // mid-transit toward cue 1
    await runner.stop('operator stop');
    expect(runner.status().phase).toBe('stopped');
    expect(runner.status().reason).toBe('operator stop');
    const frozen = svc.getState('alpha').telemetry.position;
    await advanceTo(clock, runner, 40); // conductor is dead; drones must be holding, not drifting on
    expect(haversineM(svc.getState('alpha').telemetry.position, frozen)).toBeLessThan(3);
    expect(svc.getState('alpha').telemetry.status).toBe('hold');
  });

  it('enforces one show at a time and ground starts', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    await runner.start(twoDroneTimeline());
    await expect(runner.start(twoDroneTimeline())).rejects.toThrow(/already running/);
    await runner.stop('cleanup');
    // alpha is now airborne (holding) — a fresh show must refuse a non-ground start.
    await expect(runner.start(twoDroneTimeline())).rejects.toThrow(/from the ground/);
  });
});
