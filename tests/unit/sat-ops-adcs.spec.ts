/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1: physics + closed-loop proofs for the RK4
 *                     |                             | gyrostat propagator and quaternion-PD controller —
 *                     |                             | norm preservation, inertial momentum conservation,
 *                     |                             | tumbling-slew settle, wheel torque/momentum saturation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Follow the async SatSimAdapter contract
 *                     |                             | (night 1 round 2) — awaits throughout, rejects-based
 *                     |                             | invalid-dt assertion. Physics assertions unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAT_CONFIG,
  QuaternionPdController,
  Rk4PropagatorSim,
  attitudeSeparationDeg,
  quatFromAxisAngle,
  quatIdentity,
  vNorm,
  vSub,
  type Vec3,
} from '@/features/sat-ops';

const TUMBLE: Vec3 = { x: 0.1, y: -0.15, z: 0.08 }; // rad/s — an ~11°/s composite tumble

async function quatNormOf(sim: Rk4PropagatorSim): Promise<number> {
  const { q } = await sim.getState();
  return Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
}

describe('sat-ops RK4 gyrostat propagator', () => {
  it('honors the SatSimAdapter contract: identity, reset defaults, describe', async () => {
    const sim = new Rk4PropagatorSim('sat-test');
    expect(sim.id).toBe('sat-test');
    expect(sim.describe()).toContain('RK4');
    const s = await sim.reset({ omega: TUMBLE });
    expect(s.t).toBe(0);
    expect(s.q).toEqual(quatIdentity());
    expect(s.omega).toEqual(TUMBLE);
    expect(s.wheelMomentum).toEqual({ x: 0, y: 0, z: 0 });
    // getState is a defensive copy — mutating it must not touch the sim.
    const copy = await sim.getState();
    copy.omega.x = 999;
    expect((await sim.getState()).omega.x).toBe(TUMBLE.x);
    await expect(sim.step(0, { x: 0, y: 0, z: 0 })).rejects.toThrow();
  });

  it('preserves quaternion unit norm through 10,000 free-tumble steps', async () => {
    const sim = new Rk4PropagatorSim();
    await sim.reset({ omega: TUMBLE });
    for (let i = 0; i < 10_000; i++) await sim.step(0.05, { x: 0, y: 0, z: 0 });
    expect(Math.abs((await quatNormOf(sim)) - 1)).toBeLessThan(1e-9);
  });

  it('conserves inertial angular momentum for a free asymmetric rigid body', async () => {
    const sim = new Rk4PropagatorSim();
    await sim.reset({ omega: TUMBLE });
    const h0 = sim.totalMomentumInertial();
    for (let i = 0; i < 1200; i++) await sim.step(0.05, { x: 0, y: 0, z: 0 }); // 60 s
    const h1 = sim.totalMomentumInertial();
    expect(vNorm(vSub(h1, h0)) / vNorm(h0)).toBeLessThan(1e-6);
  });

  it('bounds wheel momentum growth by the torque limit and freezes a saturated wheel', async () => {
    const sim = new Rk4PropagatorSim();
    await sim.reset({});
    const before = (await sim.getState()).wheelMomentum;
    const huge: Vec3 = { x: 5, y: -5, z: 5 }; // far beyond maxTorqueNm = 0.02
    const after = (await sim.step(0.1, huge)).wheelMomentum;
    const { maxTorqueNm, maxMomentumNms } = DEFAULT_SAT_CONFIG.wheels;
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(after[axis] - before[axis]) / 0.1).toBeLessThanOrEqual(maxTorqueNm + 1e-9);
    }
    // A wheel sitting exactly at the momentum cap accepts no torque that grows it further…
    await sim.reset({ wheelMomentum: { x: maxMomentumNms, y: 0, z: 0 } });
    expect((await sim.step(0.1, { x: maxTorqueNm, y: 0, z: 0 })).wheelMomentum.x).toBe(maxMomentumNms);
    // …but still accepts torque that unloads it.
    const unloaded = (await sim.step(0.1, { x: -maxTorqueNm, y: 0, z: 0 })).wheelMomentum.x;
    expect(unloaded).toBeLessThan(maxMomentumNms);
  });
});

describe('sat-ops quaternion-PD closed loop', () => {
  it('settles a tumbling 45° slew to <0.5° and <0.02°/s within 180 simulated seconds', async () => {
    const sim = new Rk4PropagatorSim();
    await sim.reset({ omega: TUMBLE });
    const controller = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });
    const target = quatFromAxisAngle({ x: 1, y: 2, z: -1 }, Math.PI / 4);
    const dt = 0.1;
    for (let i = 0; i < 1800; i++) {
      const state = await sim.getState();
      await sim.step(dt, controller.computeWheelTorque(state, target));
    }
    const final = await sim.getState();
    expect(attitudeSeparationDeg(final.q, target)).toBeLessThan(0.5);
    expect(vNorm(final.omega)).toBeLessThan(3.5e-4); // 0.02 °/s
  });

  it('conserves total (body + wheels) inertial momentum while the wheels absorb the tumble', async () => {
    const sim = new Rk4PropagatorSim();
    await sim.reset({ omega: TUMBLE });
    const controller = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });
    const target = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 3);
    const h0 = sim.totalMomentumInertial();
    for (let i = 0; i < 1800; i++) {
      await sim.step(0.1, controller.computeWheelTorque(await sim.getState(), target));
    }
    // No external torque exists in this model, so control can only EXCHANGE momentum
    // between body and wheels — the inertial total must ride through the whole slew.
    expect(vNorm(vSub(sim.totalMomentumInertial(), h0)) / vNorm(h0)).toBeLessThan(1e-4);
    // And the exchange actually happened: the body is still, the wheels hold the tumble.
    const final = await sim.getState();
    expect(vNorm(final.omega)).toBeLessThan(3.5e-4);
    expect(vNorm(final.wheelMomentum)).toBeGreaterThan(0.9 * vNorm(h0));
  });

  it('takes the shortest path: a 350° commanded rotation corrects 10°, not 350°', async () => {
    const sim = new Rk4PropagatorSim();
    await sim.reset({});
    const controller = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });
    const target = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, (350 * Math.PI) / 180);
    const initialSeparation = attitudeSeparationDeg((await sim.getState()).q, target); // 10°
    expect(initialSeparation).toBeCloseTo(10, 5);
    let maxSeparation = initialSeparation;
    for (let i = 0; i < 1200; i++) {
      await sim.step(0.1, controller.computeWheelTorque(await sim.getState(), target));
      maxSeparation = Math.max(maxSeparation, attitudeSeparationDeg((await sim.getState()).q, target));
    }
    expect(attitudeSeparationDeg((await sim.getState()).q, target)).toBeLessThan(0.5);
    // Shortest-path means the error never grows past its start toward the long way round.
    expect(maxSeparation).toBeLessThan(initialSeparation + 1);
  });
});
