/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | SatSimAdapter decorator that makes the RK4 path
 *                     |                             | structurally identical to the 42 sensed-state path —
 *                     |                             | wraps a truth Rk4PropagatorSim, runs SatSensorSim +
 *                     |                             | MEKF each step, and reports the ESTIMATED state. Truth
 *                     |                             | stays available via truthState() for scoring, mirroring
 *                     |                             | "the sim keeps truth for scoring". Same calibrated()
 *                     |                             | semantics as Nasa42SimAdapter so the node is engine-blind.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | W3 surface verify found slew-time gate
 *                     |                             | thrash on this path: (1) the gyro now reports the
 *                     |                             | DELTA-ANGLE average rate over the step (what a rate-
 *                     |                             | integrating gyro measures) instead of the end-of-step
 *                     |                             | instantaneous rate — kills the ½α·dt² per-step bias
 *                     |                             | that read as an 11σ outlier at slew start; (2) ST
 *                     |                             | updates pass ω so the config's stLagS term is actually
 *                     |                             | live on this path (it was silently inert).
 */

import type { Quat, SatAttitudeState, Vec3 } from '../model/sat-types';
import type { SatSimAdapter } from './sim-adapter';
import type { Rk4PropagatorSim } from './rk4-propagator-sim';
import type { SatSensorSim } from './sat-sensor-sim';
import type { MekfAttitudeEstimator } from './mekf-attitude-estimator';
import { quatConjugate, quatMultiply, quatNormalize } from './sat-math';

/** Rotation vector (rad) of a delta quaternion — the true attitude increment of one step. */
function rotVecOf(dq: Quat): Vec3 {
  const s = dq.w >= 0 ? 1 : -1; // shortest arc
  const vn = Math.hypot(dq.x, dq.y, dq.z);
  if (vn < 1e-12) return { x: 0, y: 0, z: 0 };
  const angle = 2 * Math.atan2(vn, s * dq.w);
  const k = angle / vn;
  return { x: s * dq.x * k, y: s * dq.y * k, z: s * dq.z * k };
}

/** Estimator readout attached to node telemetry. */
export interface EstimatorReadout {
  initialized: boolean;
  updatesApplied: number;
  rejected: number;
  reinits: number;
  lastResidualRad: number;
  biasRadS: Vec3;
  attitudeSigmaRad: Vec3;
}

/**
 * @description Wraps a truth RK4 sim with a synthetic-sensor + MEKF pipeline and reports the
 * ESTIMATED attitude/rate — so a controller on the RK4 engine consumes exactly the kind of
 * state the 42 adapter reports (estimated, not truth). `truthState()` exposes the underlying
 * truth for scoring and tests. `mtbDipoleCmd` (added in the desat commit) is forwarded to the
 * inner sim unchanged.
 */
export class EstimatingSimAdapter implements SatSimAdapter {
  readonly id: string;

  constructor(
    private readonly inner: Rk4PropagatorSim,
    private readonly sensors: SatSensorSim,
    private readonly mekf: MekfAttitudeEstimator,
  ) {
    this.id = inner.id;
  }

  /** @returns Engine + fidelity summary. */
  describe(): string {
    return `${this.inner.describe()} + MEKF (estimated-state reporting)`;
  }

  /**
   * @description Reset truth and re-seed the estimator implicitly (a fresh reset means the
   * next star fix reinitializes the filter).
   * @param initial - Partial initial truth state.
   * @returns The estimated state after reset (equals truth until the first fix).
   */
  async reset(initial?: Partial<SatAttitudeState>): Promise<SatAttitudeState> {
    const truth = await this.inner.reset(initial);
    this.prevTruthQ = truth.q; // a stale increment across a reset would corrupt the first delta-angle
    // Before any fix the filter is uninitialized; report truth so the node has a sane start.
    return truth;
  }

  /** @returns The estimated state (q̂, bias-corrected ω̂, truth wheel momentum + field as sensor stand-ins). */
  async getState(): Promise<SatAttitudeState> {
    const truth = await this.inner.getState();
    if (!this.mekf.initialized()) return truth;
    return {
      t: truth.t,
      q: this.mekf.attitude(),
      omega: this.mekf.rateEstimate(this.lastOmegaMeas),
      wheelMomentum: truth.wheelMomentum,
      ...(truth.bFieldBody ? { bFieldBody: truth.bFieldBody } : {}),
    };
  }

  /** @returns The underlying TRUTH state (never estimated) — for scoring and unit assertions. */
  async truthState(): Promise<SatAttitudeState> {
    return this.inner.getState();
  }

  private lastOmegaMeas: Vec3 = { x: 0, y: 0, z: 0 };

  private prevTruthQ: Quat | null = null;

  /**
   * @description Advance truth one step, sample the sensors, run the filter (propagate + any
   * fresh ST update), and report the estimated state.
   * @param dtSeconds - Step size (s).
   * @param wheelTorqueCmd - Wheel torque command (N·m).
   * @param mtbDipoleCmd - Optional magnetorquer dipole (A·m²), forwarded to the inner sim.
   * @returns The estimated state after the step.
   */
  async step(dtSeconds: number, wheelTorqueCmd: Vec3, mtbDipoleCmd?: Vec3): Promise<SatAttitudeState> {
    const prevQ = this.prevTruthQ ?? (await this.inner.getState()).q;
    const truth = await this.inner.step(dtSeconds, wheelTorqueCmd, mtbDipoleCmd);
    this.prevTruthQ = truth.q;
    // Delta-angle gyro: the AVERAGE body rate over the step (rotation vector of the true
    // increment / dt) — matches the filter's piecewise-constant propagation exactly, so the
    // residual carries sensor noise only, not the controller's acceleration transient.
    const dq = quatNormalize(quatMultiply(quatConjugate(prevQ), truth.q));
    const rv = rotVecOf(dq);
    const omegaAvg: Vec3 = { x: rv.x / dtSeconds, y: rv.y / dtSeconds, z: rv.z / dtSeconds };
    const omegaMeas = this.sensors.sampleGyro(omegaAvg, dtSeconds);
    this.lastOmegaMeas = omegaMeas;
    this.mekf.propagate(omegaMeas, dtSeconds);
    const st = this.sensors.sampleStarTracker(truth.q, truth.t);
    if (st.valid && st.fresh) this.mekf.updateStarTracker(st.q, omegaMeas);
    if (!this.mekf.initialized()) return truth;
    return {
      t: truth.t,
      q: this.mekf.attitude(),
      omega: this.mekf.rateEstimate(omegaMeas),
      wheelMomentum: truth.wheelMomentum,
      ...(truth.bFieldBody ? { bFieldBody: truth.bFieldBody } : {}),
    };
  }

  /** @returns Whether the last ST sample was a valid fix (mirrors Nasa42SimAdapter). */
  starTrackerValid(): boolean {
    return this.mekf.initialized();
  }

  /** @returns Whether the attitude is trustworthy for defining targets (filter initialized). */
  attitudeCalibrated(): boolean {
    return this.mekf.initialized();
  }

  /** @returns The estimator readout for node telemetry, or null before the first fix. */
  estimator(): EstimatorReadout | null {
    if (!this.mekf.initialized()) return null;
    const d = this.mekf.diagnostics();
    return {
      initialized: d.initialized,
      updatesApplied: d.updatesApplied,
      rejected: d.rejected,
      reinits: d.reinits,
      lastResidualRad: d.lastResidualRad,
      biasRadS: this.mekf.biasRadS(),
      attitudeSigmaRad: this.mekf.attitudeSigmaRad(),
    };
  }
}
