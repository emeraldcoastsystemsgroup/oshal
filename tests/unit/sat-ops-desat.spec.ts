/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | magnetorquer desaturation proofs on the extended RK4
 *                     |                             | sim. The SIGN canary (negated k pumps wheels — the
 *                     |                             | night-1 mirrored-reference failure class), field
 *                     |                             | reconstruction round-trip, ⊥-component exponential decay,
 *                     |                             | dead in-plane axis swept by the rotating field over an
 *                     |                             | orbit, W1 zero-field behavior preserved, per-rod clamp,
 *                     |                             | and momentum bookkeeping ΔH_I ≈ R(q)·τ_mag·dt.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAG_ENV,
  DEFAULT_MTB_CONFIG,
  DEFAULT_SAT_CONFIG,
  MagEnvironment,
  MtbDesatController,
  QuaternionPdController,
  Rk4PropagatorSim,
  quatIdentity,
  solveFieldFromMags,
  vCross,
  vNorm,
  vSub,
  type Quat,
  type Vec3,
} from '@/features/sat-ops';

const ORTHO_MAGS = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];

function desatConfig(k: number): { kDesat: number; mtbAxes: Vec3[]; maxDipoleAm2: number[]; deadbandNms: number } {
  return { kDesat: k, mtbAxes: DEFAULT_MTB_CONFIG.axes, maxDipoleAm2: DEFAULT_MTB_CONFIG.maxDipoleAm2, deadbandNms: 0.001 };
}

describe('sat-ops magnetic environment', () => {
  it('rotates the field and reconstructs it from magnetometer scalars', () => {
    const env = new MagEnvironment();
    const b0 = env.fieldInertial(0);
    expect(vNorm(b0)).toBeCloseTo(35e-6, 10);
    expect(b0.z).toBe(0);
    const quarter = (2 * Math.PI) / DEFAULT_MAG_ENV.orbitRateRadS / 4;
    const bq = env.fieldInertial(quarter);
    expect(bq.y).toBeCloseTo(35e-6, 8); // 90° into the X-Y rotation
    // reconstruction round-trip at a nontrivial attitude
    const q = { w: Math.SQRT1_2, x: Math.SQRT1_2, y: 0, z: 0 };
    const reads = env.readMagnetometers(123, q);
    const recon = solveFieldFromMags(ORTHO_MAGS, reads);
    const truth = env.fieldBody(123, q);
    expect(vNorm(vSub(recon, truth))).toBeLessThan(1e-15);
  });
});

describe('sat-ops MTB desat law', () => {
  it('SIGN CANARY: the correct law removes ⊥-momentum, the negated law pumps it', () => {
    // Δh along +z, B along +x → Δh_⊥ = Δh (fully perpendicular). τ = m×B should oppose Δh.
    const B: Vec3 = { x: 35e-6, y: 0, z: 0 };
    const dh: Vec3 = { x: 0, y: 0, z: 0.1 };
    const ctrl = new MtbDesatController(desatConfig(2e-3));
    const cmd = ctrl.computeDipole(dh, B);
    const tau = vCross(cmd.bodyDipoleAm2, B);
    // τ must point −z (removes +z momentum): ḣ = τ, so τ·Δh < 0.
    expect(tau.z).toBeLessThan(0);
    expect(tau.x * dh.x + tau.y * dh.y + tau.z * dh.z).toBeLessThan(0);
    // Independent closed-form check (a negated-cross assertion is a tautology of the above):
    // m = (k/|B|²)(Δh×B); ẑ×x̂ = ŷ, so the dipole is pure +y with |m| = k·|Δh|/|B| = 5.71,
    // railed at the 5 A·m² per-rod limit — the clamp is part of the contract.
    expect(cmd.bodyDipoleAm2.x).toBeCloseTo(0, 12);
    expect(cmd.bodyDipoleAm2.z).toBeCloseTo(0, 12);
    expect((2e-3 * 0.1) / 35e-6).toBeGreaterThan(DEFAULT_MTB_CONFIG.maxDipoleAm2[1]); // demand exceeds the rod
    expect(cmd.bodyDipoleAm2.y).toBeCloseTo(DEFAULT_MTB_CONFIG.maxDipoleAm2[1], 12); // clamped, not scaled down
  });

  it('respects the deadband and the minimum-field guard', () => {
    const ctrl = new MtbDesatController(desatConfig(2e-3));
    expect(ctrl.computeDipole({ x: 0, y: 0, z: 0.0005 }, { x: 35e-6, y: 0, z: 0 }).active).toBe(false); // below deadband
    expect(ctrl.computeDipole({ x: 0, y: 0, z: 0.1 }, { x: 1e-9, y: 0, z: 0 }).active).toBe(false); // field too weak
  });

  it('dumps the ⊥ component under concurrent PD hold (closed loop on the sim)', async () => {
    // Momentum dumping REQUIRES the attitude controller running: the magnetic torque acts on
    // the BODY, and it is the wheels countering it (to hold attitude) that OFFLOADS wheel
    // momentum (ḣ = τ_w ≈ τ_mag). Field fixed along inertial +x, Δh seeded along +z (⊥ to B).
    const env = { mag: { fieldMagnitudeT: 35e-6, orbitRateRadS: 0, phaseRad: 0 }, mtb: DEFAULT_MTB_CONFIG };
    const sim = new Rk4PropagatorSim('desat-test', DEFAULT_SAT_CONFIG, env);
    const hold: Quat = quatIdentity();
    await sim.reset({ q: hold, wheelMomentum: { x: 0, y: 0, z: 0.05 } });
    const pd = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });
    const desat = new MtbDesatController(desatConfig(2e-3));
    const dt = 1.0;
    const h0 = 0.05;
    let hz = h0;
    for (let i = 0; i < 600; i++) {
      const st = await sim.getState();
      const cmd = desat.computeDipole(st.wheelMomentum, st.bFieldBody ?? { x: 0, y: 0, z: 0 });
      const next = await sim.step(dt, pd.computeWheelTorque(st, hold), cmd.bodyDipoleAm2);
      hz = next.wheelMomentum.z;
    }
    expect(Math.abs(hz)).toBeLessThan(0.5 * h0); // ⊥ component offloaded through the wheels
  }, 20_000);

  it('sweeps the dead in-plane axis over an orbit so an in-plane load also dumps', async () => {
    const env = { mag: { fieldMagnitudeT: 35e-6, orbitRateRadS: (2 * Math.PI) / 600, phaseRad: 0 }, mtb: DEFAULT_MTB_CONFIG };
    const sim = new Rk4PropagatorSim('desat-orbit', DEFAULT_SAT_CONFIG, env);
    const hold: Quat = quatIdentity();
    // Seed momentum IN the field's rotation plane (x): instantaneously partly-dead, but the
    // field rotates through it within the orbit.
    await sim.reset({ q: hold, wheelMomentum: { x: 0.05, y: 0, z: 0 } });
    const pd = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });
    const desat = new MtbDesatController(desatConfig(2e-3));
    const h0 = 0.05;
    let hMag = h0;
    for (let i = 0; i < 1800; i++) {
      const st = await sim.getState();
      const cmd = desat.computeDipole(st.wheelMomentum, st.bFieldBody ?? { x: 0, y: 0, z: 0 });
      const next = await sim.step(1.0, pd.computeWheelTorque(st, hold), cmd.bodyDipoleAm2);
      hMag = vNorm(next.wheelMomentum);
    }
    expect(hMag).toBeLessThan(0.5 * h0); // three orbits dump the in-plane load too
  }, 30_000);

  it('applies the per-rod dipole clamp inside the sim (bounded torque)', async () => {
    const env = { mag: { fieldMagnitudeT: 35e-6, orbitRateRadS: 0 }, mtb: DEFAULT_MTB_CONFIG };
    const sim = new Rk4PropagatorSim('clamp-test', DEFAULT_SAT_CONFIG, env);
    await sim.reset({});
    const before = await sim.getState();
    // Command an absurd dipole; the rods clamp at 5 A·m², so |τ| ≤ 3·5·|B| bounds ω̇.
    const after = await sim.step(1.0, { x: 0, y: 0, z: 0 }, { x: 1e6, y: -1e6, z: 1e6 });
    const dOmega = vNorm(vSub(after.omega, before.omega));
    const maxTorque = Math.sqrt(3) * 5 * 35e-6; // |Σ clamped m × B|
    const maxAlpha = maxTorque / Math.min(DEFAULT_SAT_CONFIG.inertia.x, DEFAULT_SAT_CONFIG.inertia.y, DEFAULT_SAT_CONFIG.inertia.z);
    expect(dOmega).toBeLessThanOrEqual(maxAlpha * 1.0 + 1e-9);
  });
});

describe('sat-ops W1 behavior preserved without an environment', () => {
  it('a zero-field sim ignores the dipole and conserves momentum', async () => {
    const sim = new Rk4PropagatorSim(); // no environment
    await sim.reset({ omega: { x: 0.1, y: -0.15, z: 0.08 } });
    const h0 = sim.totalMomentumInertial();
    for (let i = 0; i < 600; i++) await sim.step(0.05, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 }); // dipole ignored
    const h1 = sim.totalMomentumInertial();
    expect(vNorm(vSub(h1, h0)) / vNorm(h0)).toBeLessThan(1e-6); // still conserved
    expect((await sim.getState()).bFieldBody).toBeUndefined(); // no field reported
  });

  it('momentum bookkeeping: ΔH_inertial ≈ R(q)·τ_mag·dt over one step', async () => {
    const env = { mag: { fieldMagnitudeT: 35e-6, orbitRateRadS: 0 }, mtb: DEFAULT_MTB_CONFIG };
    const sim = new Rk4PropagatorSim('bookkeep', DEFAULT_SAT_CONFIG, env);
    await sim.reset({ wheelMomentum: { x: 0, y: 0, z: 0.05 } });
    const h0 = sim.totalMomentumInertial();
    const dip = { x: 0, y: 3, z: 0 }; // within clamp
    await sim.step(0.5, { x: 0, y: 0, z: 0 }, dip);
    const h1 = sim.totalMomentumInertial();
    // external torque changed the inertial total (unlike the W1 conservation invariant): it
    // moved, and by roughly |m×B|·dt. This is the honesty assertion — desat is NOT conservative.
    expect(vNorm(vSub(h1, h0))).toBeGreaterThan(0);
    const B = new MagEnvironment(env.mag).fieldBody(0, { w: 1, x: 0, y: 0, z: 0 });
    const tau = vCross(dip, B);
    expect(vNorm(vSub(h1, h0))).toBeCloseTo(vNorm(tau) * 0.5, 4);
  });
});
