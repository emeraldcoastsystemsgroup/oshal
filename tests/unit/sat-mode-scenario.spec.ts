/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | the full ADCS scenario over the mode manager + RK4 sim
 *                     |                             | with the magnetic environment: tumble → DETUMBLE →
 *                     |                             | (operator point) SLEW → POINT, and a momentum-loaded
 *                     |                             | run that drives DESAT and returns to POINT. Truth-state
 *                     |                             | engine (deterministic) so the mode logic, not sensor
 *                     |                             | noise, is under test.
 */

import { describe, expect, it } from 'vitest';
import {
  AdcsModeManager,
  DEFAULT_DESAT_CONFIG_RK4,
  DEFAULT_MTB_CONFIG,
  DEFAULT_SAT_CONFIG,
  MtbDesatController,
  QuaternionPdController,
  Rk4PropagatorSim,
  attitudeSeparationDeg,
  quatFromAxisAngle,
  quatIdentity,
  vNorm,
  type ControlLawCommand,
  type SatAttitudeState,
  type Vec3,
} from '@/features/sat-ops';

const RATE_DAMP_TC_S = 50;
const HMAX = DEFAULT_SAT_CONFIG.wheels.maxMomentumNms;

/** A minimal in-test node loop: manager tick → law→torque + dumping→dipole → sim step. */
class ScenarioRig {
  readonly mgr = new AdcsModeManager();

  private readonly pd = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });

  private readonly desat: MtbDesatController;

  state: SatAttitudeState;

  lastMode = 'SAFE';

  constructor(private readonly sim: Rk4PropagatorSim, initial: SatAttitudeState, kDesat = DEFAULT_DESAT_CONFIG_RK4.kDesat) {
    this.state = initial;
    // The scenario tests the MODE LOGIC (escalate/return), not the dump time — a faster gain
    // keeps it quick. Absolute dump-rate correctness is covered by the desat spec.
    this.desat = new MtbDesatController({ ...DEFAULT_DESAT_CONFIG_RK4, kDesat });
  }

  private frac(): number {
    const h = this.state.wheelMomentum;
    return Math.max(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) / HMAX;
  }

  private torque(law: ControlLawCommand): Vec3 {
    if (law.kind === 'quatPd') return this.pd.computeWheelTorque(this.state, law.target);
    if (law.kind === 'rateDamp' || law.kind === 'desat') {
      const i = DEFAULT_SAT_CONFIG.inertia;
      return { x: (i.x / RATE_DAMP_TC_S) * this.state.omega.x, y: (i.y / RATE_DAMP_TC_S) * this.state.omega.y, z: (i.z / RATE_DAMP_TC_S) * this.state.omega.z };
    }
    return { x: 0, y: 0, z: 0 };
  }

  async step(dt: number): Promise<string> {
    const out = this.mgr.tick({ state: this.state, ekfHealthy: true, wheelMomentumFrac: this.frac() });
    const wantsDump = out.law.kind === 'desat' || out.dumping;
    const dipole = wantsDump && this.state.bFieldBody ? this.desat.computeDipole(this.state.wheelMomentum, this.state.bFieldBody).bodyDipoleAm2 : undefined;
    this.state = await this.sim.step(dt, this.torque(out.law), dipole);
    this.lastMode = out.mode;
    return out.mode;
  }

  async runUntil(pred: () => boolean, maxSteps: number, dt: number): Promise<boolean> {
    for (let i = 0; i < maxSteps; i++) {
      await this.step(dt);
      if (pred()) return true;
    }
    return false;
  }
}

describe('sat-ops ADCS full scenario (mode manager + RK4 + magnetics)', () => {
  it('tumble → DETUMBLE → SLEW → POINT → DESAT → POINT', async () => {
    const env = { mag: { fieldMagnitudeT: 35e-6, orbitRateRadS: (2 * Math.PI) / 600 }, mtb: DEFAULT_MTB_CONFIG };
    const sim = new Rk4PropagatorSim('scenario', DEFAULT_SAT_CONFIG, env);
    const initial = await sim.reset({ omega: { x: 5 * (Math.PI / 180), y: -2 * (Math.PI / 180), z: 1 * (Math.PI / 180) } }); // ~5.5°/s tumble
    const rig = new ScenarioRig(sim, initial, 1e-2); // faster desat gain for a quick scenario
    const dt = 0.5;

    // 1) Operator commands detumble; rates fall below 0.5°/s.
    rig.mgr.commandDetumble();
    expect(await rig.step(dt)).toBe('DETUMBLE');
    const detumbled = await rig.runUntil(() => vNorm(rig.state.omega) < 0.5 * (Math.PI / 180), 2000, dt);
    expect(detumbled).toBe(true);
    // auto-completes to SAFE (no target latched)
    await rig.runUntil(() => rig.mgr.mode() === 'SAFE', 200, dt);
    expect(rig.mgr.mode()).toBe('SAFE');

    // 2) Operator points 40° away → SLEW, converging to POINT.
    const target = quatFromAxisAngle({ x: 1, y: 1, z: 0 }, 40 * (Math.PI / 180));
    rig.mgr.commandPoint(target);
    expect(await rig.step(dt)).toBe('SLEW');
    const pointed = await rig.runUntil(() => rig.mgr.mode() === 'POINT' && attitudeSeparationDeg(rig.state.q, target) < 1, 4000, dt);
    expect(pointed).toBe(true);
    expect(attitudeSeparationDeg(rig.state.q, target)).toBeLessThan(1);

    // 3) Inject a near-saturation wheel load → DESAT escalation, dumped back under 40% → POINT.
    // Preserve sim time `t` — resetting it to 0 would (correctly) trip the manager's
    // time-went-backwards → SAFE guard, which is a real engine-reset safety, not what we test here.
    rig.state = await sim.reset({ t: rig.state.t, q: rig.state.q, omega: { x: 0, y: 0, z: 0 }, wheelMomentum: { x: 0.97 * HMAX, y: 0, z: 0 } });
    // the manager must escalate to DESAT (momentum ≥ 95%)
    const escalated = await rig.runUntil(() => rig.mgr.mode() === 'DESAT', 50, dt);
    expect(escalated).toBe(true);
    // dumping brings momentum down; manager returns to the latched target (POINT/SLEW)
    const recovered = await rig.runUntil(() => rig.mgr.mode() === 'POINT' || rig.mgr.mode() === 'SLEW', 8000, dt);
    expect(recovered).toBe(true);
    expect(Math.abs(rig.state.wheelMomentum.x) / HMAX).toBeLessThan(0.45);
  }, 60_000);
});
