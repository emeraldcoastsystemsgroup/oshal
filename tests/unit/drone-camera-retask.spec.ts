/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Drone backlog round: CAMERA equipment
 *                     |                             | (photo/record/stop/aim as manual commands AND arrival
 *                     |                             | actions, structured captures, heartbeat merge), LIVE
 *                     |                             | RETASK (validateRetask gate + the conductor replacing the
 *                     |                             | remainder mid-show, dropped drones holding), and the
 *                     |                             | pad-aware proximity guard now covering launch/RTL.
 */

import { describe, expect, it } from 'vitest';
import {
  DroneService,
  FleetShowRunner,
  SimDroneProvider,
  RemoteDroneProvider,
  normalizeCameraAction,
  normalizeCameraCapture,
  normalizeMissionDraft,
  normalizeShowDraft,
  validateRetask,
  validateOutroSeparation,
  haversineM,
  type DroneNodeHeartbeat,
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

function twoDroneTimeline(): ShowTimeline {
  return {
    kind: 'show',
    name: 'Retask test show',
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

async function advanceTo(clock: { t: number }, runner: FleetShowRunner, seconds: number): Promise<void> {
  const target = seconds * 1000;
  while (clock.t < target) {
    clock.t = Math.min(clock.t + 1000, target);
    await runner.tick();
  }
}

describe('Camera equipment — captures + arrival actions', () => {
  it('photo/record/stop produce structured captures, trigger events, and telemetry state', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const applied = await svc.setCamera({ op: 'photo', panDeg: 45, tiltDeg: -30 }, 'alpha');
    expect(applied).toEqual({ op: 'photo', panDeg: 45, tiltDeg: -30 });
    const [photo] = svc.getCaptures(0, 'alpha');
    expect(photo.kind).toBe('photo');
    expect(photo.panDeg).toBe(45);
    expect(photo.tiltDeg).toBe(-30);
    await svc.setCamera({ op: 'record' }, 'alpha');
    expect(svc.getState('alpha').telemetry.camera?.recording).toBe(true);
    clock.t += 7_000;
    await svc.setCamera({ op: 'stop' }, 'alpha');
    const caps = svc.getCaptures(0, 'alpha');
    expect(caps).toHaveLength(2);
    expect(caps[1].kind).toBe('video');
    expect(caps[1].durationS).toBeCloseTo(7, 0);
    const tel = svc.getState('alpha').telemetry;
    expect(tel.camera?.recording).toBe(false);
    expect(tel.camera?.captures).toBe(2);
    const log = svc.getEvents(0, 'alpha').map((e) => e.message).join(' | ');
    expect(log).toMatch(/EQUIP camera → photo #1 \(pan 45°, tilt -30°\)/);
    expect(log).toMatch(/EQUIP camera → recording stopped \(7s clip\)/);
  });

  it('rejects unknown ops and out-of-range gimbal angles everywhere', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    await expect(svc.setCamera({ op: 'zoom' }, 'alpha')).rejects.toThrow(/camera op/);
    await expect(svc.setCamera({ op: 'photo', tiltDeg: 90 }, 'alpha')).rejects.toThrow(/tiltDeg/);
    expect(normalizeCameraAction({ op: 'aim', panDeg: 999 }).errors[0]).toMatch(/panDeg/);
    expect(normalizeMissionDraft({ waypoints: [{ lat: 30, lon: -86, alt: 30, camera: { op: 'nuke' } }] }).errors[0]).toMatch(/camera op/);
    const s = normalizeShowDraft(
      { cues: [{ at: 30, slots: [{ droneId: 'alpha', e: 0, n: 30, alt: 30, camera: { op: 'photo', tiltDeg: -999 } }] }] },
      homesFor(['alpha']),
    );
    expect(s.errors[0]).toMatch(/tiltDeg/);
  });

  it('goto arrival fires the camera at the stop — capture taken WHERE the drone stopped', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    await svc.arm('alpha');
    await svc.takeoff(30, 'alpha');
    clock.t += 15_000;
    await svc.goto({ ...abs(0, 40), alt: 30, camera: { op: 'photo', panDeg: -90 } }, 8, 'alpha');
    expect(svc.getCaptures(0, 'alpha')).toHaveLength(0); // nothing fires before arrival
    clock.t += 10_000;
    const [cap] = svc.getCaptures(0, 'alpha');
    expect(cap.kind).toBe('photo');
    expect(haversineM(cap.position, abs(0, 40))).toBeLessThan(3);
    expect(cap.position.alt).toBeCloseTo(30, 0);
    expect(cap.panDeg).toBe(-90);
  });

  it('the conductor fires slot cameras at their cues', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    const t = twoDroneTimeline();
    t.cues[0].slots[0] = { ...t.cues[0].slots[0], camera: { op: 'record', panDeg: 0 } };
    t.cues[1].slots[0] = { ...t.cues[1].slots[0], camera: { op: 'stop' } };
    await runner.start(t);
    await advanceTo(clock, runner, 30.5); // cue 1: recording starts at the slot
    expect(svc.getState('alpha').telemetry.camera?.recording).toBe(true);
    await advanceTo(clock, runner, 55.5); // cue 2: recording stops → video capture
    expect(svc.getState('alpha').telemetry.camera?.recording).toBe(false);
    const caps = svc.getCaptures(0, 'alpha');
    expect(caps).toHaveLength(1);
    expect(caps[0].kind).toBe('video');
    expect(caps[0].durationS ?? 0).toBeGreaterThan(20); // rolled from cue 1 to cue 2
  });

  it('capture records ride the heartbeat and merge by seq on the controller', () => {
    let now = 0;
    const remote = new RemoteDroneProvider({ droneId: 'drone-1', clock: () => now });
    const hb = (captures: DroneNodeHeartbeat['captures']): DroneNodeHeartbeat => ({
      droneId: 'drone-1',
      endpointUrl: 'http://127.0.0.1:4101',
      engine: 'sim',
      telemetry: { droneId: 'drone-1', status: 'hold', position: { ...HOME, alt: 30 }, home: { ...HOME, alt: 0 }, headingDeg: 0, groundSpeedMps: 0, batteryPct: 90, distanceFromHomeM: 0, mission: null, failsafe: null },
      events: [],
      captures,
    });
    const cap = (seq: number): NonNullable<DroneNodeHeartbeat['captures']>[number] =>
      ({ seq, ts: seq, kind: 'photo', position: { ...HOME, alt: 30 }, headingDeg: 0, panDeg: 0, tiltDeg: -20 });
    remote.ingestHeartbeat(hb([cap(1), cap(2)]));
    now += 2000;
    remote.ingestHeartbeat(hb([cap(2), cap(3)])); // node snapshot overlaps — must not duplicate
    expect(remote.getCaptures(0).map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(remote.getCaptures(2).map((c) => c.seq)).toEqual([3]);
  });

  it('SANITIZES hostile capture fields at ingest — a node cannot smuggle markup to the surface', () => {
    // normalizeCameraCapture: numbers coerced, unknown kind rejected, everything else 0.
    expect(normalizeCameraCapture({ seq: '<img src=x onerror=alert(1)>', ts: 1, kind: 'photo', position: { lat: 30, lon: -86, alt: 30 } })).toBeNull();
    expect(normalizeCameraCapture({ seq: 1, ts: 1, kind: 'evil', position: { lat: 30, lon: -86, alt: 30 } })).toBeNull();
    const clean = normalizeCameraCapture({ seq: 2, ts: 5, kind: 'video', durationS: 7, position: { lat: 30, lon: -86, alt: 30 }, headingDeg: '"><script>', panDeg: 45, tiltDeg: -20 });
    expect(clean).not.toBeNull();
    expect(clean!.headingDeg).toBe(0); // hostile string → 0, never rendered as markup
    expect(clean!.panDeg).toBe(45);
    expect(typeof clean!.seq).toBe('number');
    // End-to-end: a hostile heartbeat capture is dropped/coerced by the remote provider.
    let now = 0;
    const remote = new RemoteDroneProvider({ droneId: 'drone-1', clock: () => now });
    remote.ingestHeartbeat({
      droneId: 'drone-1', endpointUrl: 'http://127.0.0.1:4101', engine: 'sim',
      telemetry: { droneId: 'drone-1', status: 'hold', position: { ...HOME, alt: 30 }, home: { ...HOME, alt: 0 }, headingDeg: 0, groundSpeedMps: 0, batteryPct: 90, distanceFromHomeM: 0, mission: null, failsafe: null },
      events: [],
      captures: [
        { seq: '"><svg onload=alert(1)>', ts: 1, kind: 'photo', position: { ...HOME, alt: 30 }, headingDeg: 0, panDeg: 0, tiltDeg: 0 } as never,
        { seq: 1, ts: 1, kind: 'photo', position: { ...HOME, alt: 30 }, headingDeg: '<b>', panDeg: 0, tiltDeg: 0 } as never,
      ],
    });
    const held = remote.getCaptures(0);
    expect(held).toHaveLength(1);             // the string-seq capture was dropped
    expect(held[0].headingDeg).toBe(0);        // the markup heading was coerced to a number
  });
});

describe('validateOutroSeparation — the staged-outro gate', () => {
  const homes = homesFor(['alpha', 'bravo']);
  it('catches a same-altitude final formation whose return legs cross a holder', () => {
    // alpha ends N of bravo at the SAME altitude; alpha returns first straight down its lane
    // and passes bravo's held position at the same altitude → breach the cue sweep never saw.
    const finalById: Record<string, GeoPoint> = {
      alpha: { ...abs(0, 30), alt: 40 },
      bravo: { ...abs(0, 5), alt: 40 },
    };
    const errors = validateOutroSeparation(finalById, homes, ['alpha', 'bravo']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/staged outro/);
  });
  it('passes when the final formation is altitude-layered (returners clear holders vertically)', () => {
    const finalById: Record<string, GeoPoint> = {
      alpha: { ...abs(0, 30), alt: 40 },
      bravo: { ...abs(0, 5), alt: 60 }, // a full layer above → no vertical overlap on return
    };
    expect(validateOutroSeparation(finalById, homes, ['alpha', 'bravo'])).toEqual([]);
  });
  it('the ballet preset clears the outro gate too (validateShowTimeline now includes it) at every size', () => {
    // Covered by drone-fleet-show.spec's ballet gate test — this asserts the layered Bow keeps
    // an 8-drone ballet outro-clean, the case most likely to cross on return.
    const drones = Array.from({ length: 8 }, (_, i) => ({ droneId: 'd' + i, home: { ...abs(i * 8, 0), alt: 0 } }));
    const homes8: Record<string, GeoPoint> = {};
    drones.forEach((d) => { homes8[d.droneId] = d.home; });
    // Bow (final cue) is layered: reconstruct its final positions and sweep.
    const finalById: Record<string, GeoPoint> = {};
    drones.forEach((d, i) => { finalById[d.droneId] = { ...abs((i - 3.5) * 25, 25), alt: 30 + i * 11 }; });
    expect(validateOutroSeparation(finalById, homes8, drones.map((d) => d.droneId))).toEqual([]);
  });
});

describe('validateRetask — the live-retask gate', () => {
  const roster = ['alpha', 'bravo'];
  const homes = homesFor(roster);
  const live: Record<string, GeoPoint> = {
    alpha: { ...abs(0, 30), alt: 30 },
    bravo: { ...abs(30, 0), alt: 45 },
  };
  const retask = (cues: ShowTimeline['cues']): ShowTimeline => ({ kind: 'show', name: 'rt', rtlAfterShow: true, cues });

  it('accepts a clean remainder from live positions', () => {
    const t = retask([{ at: 20, slots: [{ droneId: 'alpha', ...abs(-40, 30), alt: 30 }] }]);
    expect(validateRetask(t, FENCE, homes, live, roster)).toEqual([]);
  });

  it('rejects adding a drone, a too-soon first cue, and an unreachable leg', () => {
    const add = retask([{ at: 20, slots: [{ droneId: 'charlie', ...abs(0, 90), alt: 60 }] }]);
    expect(validateRetask(add, FENCE, homes, live, roster).join(' ')).toMatch(/cannot add drones/);
    const soon = retask([{ at: 2, slots: [{ droneId: 'alpha', ...abs(-40, 30), alt: 30 }] }]);
    expect(validateRetask(soon, FENCE, homes, live, roster).join(' ')).toMatch(/lead time/);
    const far = retask([{ at: 6, slots: [{ droneId: 'alpha', ...abs(0, 400), alt: 30 }] }]);
    expect(validateRetask(far, FENCE, homes, live, roster).join(' ')).toMatch(/m\/s/);
  });

  it('checks separation against HOLDERS at their live positions', () => {
    // Send alpha to bravo's live spot at bravo's altitude — bravo (dropped) is holding there.
    const clash = retask([{ at: 20, slots: [{ droneId: 'alpha', ...abs(30, 0), alt: 45 }] }]);
    expect(validateRetask(clash, FENCE, homes, live, roster).length).toBeGreaterThan(0);
  });
});

describe('FleetShowRunner — live retask + the pad-aware guard', () => {
  it('replaces the remainder mid-show: new arrivals on the new clock, dropped drones hold + fly the outro', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    await runner.start(twoDroneTimeline());
    await advanceTo(clock, runner, 31); // cues phase; both enroute toward cue 2
    const newTarget = { ...abs(-40, 30), alt: 30 };
    await runner.retask({
      kind: 'show', name: 'Retasked remainder', rtlAfterShow: true,
      cues: [{ at: 20, name: 'swing west', slots: [{ droneId: 'alpha', ...newTarget }] }],
    });
    const bravoHeld = { ...svc.getState('bravo').telemetry.position };
    await advanceTo(clock, runner, 40); // mid-retask: bravo (dropped) is HOLDING, not flying old cue 2
    expect(svc.getState('bravo').telemetry.status).toBe('hold');
    expect(haversineM(svc.getState('bravo').telemetry.position, bravoHeld)).toBeLessThan(3);
    await advanceTo(clock, runner, 51.5); // retask clock started at 31s → cue fires at 51s
    expect(haversineM(svc.getState('alpha').telemetry.position, newTarget)).toBeLessThan(3);
    await advanceTo(clock, runner, 160); // outro: EVERY roster drone (incl. dropped bravo) goes home
    expect(runner.status().phase).toBe('complete');
    expect(svc.getState('alpha').telemetry.status).toBe('disarmed');
    expect(svc.getState('bravo').telemetry.status).toBe('disarmed');
  });

  it('refuses a retask outside the cues phase and one that adds a drone', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    const solo: ShowTimeline = {
      kind: 'show', name: 'solo', rtlAfterShow: true,
      cues: [{ at: 30, slots: [{ droneId: 'alpha', ...abs(0, 30), alt: 30 }] }],
    };
    const rt: ShowTimeline = {
      kind: 'show', name: 'rt', rtlAfterShow: true,
      cues: [{ at: 20, slots: [{ droneId: 'bravo', ...abs(30, 0), alt: 45 }] }],
    };
    await expect(runner.retask(rt)).rejects.toThrow(/cues phase/); // idle
    await runner.start(solo);
    await expect(runner.retask(rt)).rejects.toThrow(/cues phase/); // launch
    await advanceTo(clock, runner, 31);
    await expect(runner.retask(rt)).rejects.toThrow(/cannot add drones/); // bravo not in the roster
    await runner.stop('cleanup');
  });

  it('re-checks the phase INSIDE the lock — a retask that lands after the show ends is rejected', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    const solo: ShowTimeline = {
      kind: 'show', name: 'solo', rtlAfterShow: false,
      cues: [{ at: 30, slots: [{ droneId: 'alpha', ...abs(0, 30), alt: 30 }] }],
    };
    await runner.start(solo);
    await advanceTo(clock, runner, 40); // no RTL → reaches 'complete' after settle
    expect(runner.status().phase).toBe('complete');
    // A retask arriving now must be rejected against the CURRENT phase, not a stale snapshot.
    await expect(runner.retask({
      kind: 'show', name: 'late', rtlAfterShow: true,
      cues: [{ at: 20, slots: [{ droneId: 'alpha', ...abs(-30, 30), alt: 30 }] }],
    })).rejects.toThrow(/cues phase/);
  });

  it('serializes concurrent retasks through the lock — no split/corrupt state', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    await runner.start(twoDroneTimeline());
    await advanceTo(clock, runner, 31);
    const rtA: ShowTimeline = { kind: 'show', name: 'A', rtlAfterShow: true, cues: [{ at: 20, slots: [{ droneId: 'alpha', ...abs(-40, 30), alt: 30 }, { droneId: 'bravo', ...abs(40, 0), alt: 45 }] }] };
    const rtB: ShowTimeline = { kind: 'show', name: 'B', rtlAfterShow: true, cues: [{ at: 20, slots: [{ droneId: 'alpha', ...abs(0, 90), alt: 30 }, { droneId: 'bravo', ...abs(90, 0), alt: 45 }] }] };
    // Fire both without awaiting between — the lock must run them one-at-a-time, leaving a
    // consistent single timeline installed (not a half-A/half-B flyingToCue=-1 wreck).
    await Promise.all([runner.retask(rtA), runner.retask(rtB)]);
    const st = runner.status();
    expect(st.phase).toBe('cues');
    expect(['A', 'B']).toContain(st.name);
    expect(st.formingCue).toBe(1); // dispatchCue(0) completed → flyingToCue=0 → forming=1
    expect(st.drones.sort()).toEqual(['alpha', 'bravo']); // roster intact
  });

  it('launch gates on HOLD not altitude-tolerance — fine-grained ticks never goto a still-takeoff drone', async () => {
    // Regression for a live failure ("cannot fly to a point while takeoff"): a drone within 2m
    // of its cue altitude but still in 'takeoff' status must NOT count as launched, or the cue
    // dispatch issues a goto the provider rejects. 1s-step tests skip the vulnerable window;
    // the deployed 500ms cadence hit it — so advance in 500ms steps across the whole launch.
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    await runner.start(twoDroneTimeline()); // alpha→30m, bravo→45m: different climb finish times
    for (let s = 0; s <= 25; s += 0.5) { clock.t = s * 1000; await runner.tick(); }
    expect(runner.status().phase).toBe('cues');       // launched cleanly, never 'failed'
    expect(runner.status().reason).toBeNull();
  });

  it('the guard now covers RTL: an out-of-band convergence into the landing zone freezes the show', async () => {
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    await runner.start(twoDroneTimeline());
    await advanceTo(clock, runner, 59); // outro underway: alpha (lower) returns first, bravo HOLDS
    expect(runner.status().phase).toBe('rtl');
    // Sabotage the holder: send bravo to 10m short of ALPHA's pad at alpha's cruise altitude.
    // Bravo ends up 12.8m from its OWN pad (not pad-local) while alpha descends — the
    // pad-aware exemption must NOT swallow this breach.
    await svc.goto({ ...abs(0, 10), alt: 30 }, 8, 'bravo');
    await advanceTo(clock, runner, 80);
    expect(runner.status().phase).toBe('failed');
    expect(runner.status().reason).toMatch(/proximity breach/);
  });

  it('pad-local exemption: the full show completes over 8m-spaced pads (landing descends through shared altitude bands)', async () => {
    // The complete-flow run IS the exemption proof: alpha lands from 30m and bravo from 45m
    // over pads 8m apart — without the both-over-own-pad exemption the RTL guard would
    // freeze every landing; with it the show must reach 'complete'.
    const clock = { t: 0 };
    const svc = showService(clock);
    const runner = new FleetShowRunner(svc, { clock: () => clock.t, autoTick: false });
    await runner.start(twoDroneTimeline());
    await advanceTo(clock, runner, 160);
    expect(runner.status().phase).toBe('complete');
    expect(svc.getState('alpha').telemetry.status).toBe('disarmed');
    expect(svc.getState('bravo').telemetry.status).toBe('disarmed');
  });
});
