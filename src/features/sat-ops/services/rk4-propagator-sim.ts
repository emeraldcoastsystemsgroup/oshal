/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1: in-house RK4 gyrostat propagator — quaternion
 *                     |                             | kinematics + Euler rigid-body dynamics with a 3-axis
 *                     |                             | reaction-wheel cluster (torque clamp + momentum
 *                     |                             | saturation). The always-available noop-sim sibling;
 *                     |                             | NASA 42 is the independent referee (ADR-102 §2).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Follow the async SatSimAdapter contract
 *                     |                             | (night 1 round 2): public members return Promises;
 *                     |                             | the integrator itself stays synchronous internally.
 */

import { createChildLogger } from '@/shared/logger';
import type { MtbClusterConfig, Quat, SatAttitudeState, SatBodyConfig, Vec3 } from '../model/sat-types';
import { quatDerivative, quatIdentity, quatNormalize, rotateByQuat, vAdd, vCross, vScale } from './sat-math';
import { MagEnvironment, type MagEnvironmentConfig } from './mag-environment';
import { solveFieldFromMags } from './nasa42-codec';
import type { SatSimAdapter } from './sim-adapter';

const logger = createChildLogger({ module: 'sat-ops:rk4-sim' });

/**
 * @description Default 6U-smallsat-class physical model: asymmetric principal inertia so the
 * dynamics exercise real cross-coupling (a symmetric body would hide ω×Iω sign bugs), wheel
 * limits in the range of COTS smallsat wheels.
 */
export const DEFAULT_SAT_CONFIG: SatBodyConfig = {
  inertia: { x: 0.9, y: 0.8, z: 0.6 },
  wheels: { maxTorqueNm: 0.02, maxMomentumNms: 0.35 },
};

/** Attitude-channel state without the clock — what the integrator actually integrates. */
interface BodyState {
  q: Quat;
  omega: Vec3;
  h: Vec3;
}

/** Time derivative of {@link BodyState}. */
interface BodyDeriv {
  qDot: Quat;
  omegaDot: Vec3;
  hDot: Vec3;
}

/** base + factor·deriv, component-wise — the RK4 stage combinator. */
function addScaled(base: BodyState, d: BodyDeriv, factor: number): BodyState {
  return {
    q: {
      w: base.q.w + d.qDot.w * factor,
      x: base.q.x + d.qDot.x * factor,
      y: base.q.y + d.qDot.y * factor,
      z: base.q.z + d.qDot.z * factor,
    },
    omega: vAdd(base.omega, vScale(d.omegaDot, factor)),
    h: vAdd(base.h, vScale(d.hDot, factor)),
  };
}

/** One axis of the wheel model: torque clamp, and no torque that grows a saturated wheel. */
function clampAxis(cmd: number, momentum: number, maxTorque: number, maxMomentum: number): number {
  const t = Math.max(-maxTorque, Math.min(maxTorque, cmd));
  if (momentum >= maxMomentum && t > 0) return 0;
  if (momentum <= -maxMomentum && t < 0) return 0;
  return t;
}

/** DEFAULT magnetorquer cluster for the small RK4 config: 3 orthogonal rods, 5 A·m² each. */
export const DEFAULT_MTB_CONFIG: MtbClusterConfig = {
  axes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
  maxDipoleAm2: [5, 5, 5],
};

/** Optional environment for the RK4 sim: a magnetic field model + a magnetorquer cluster. */
export interface Rk4SimEnvironment {
  mag?: MagEnvironmentConfig;
  mtb?: MtbClusterConfig;
}

/**
 * @description Clamp a body dipole to the per-rod saturation via the rod axes, returning the
 * realized body dipole Σ axis_j·clamp(axis_j·m). For an orthogonal triad this is the
 * component-wise clamp; general axes go through the projection.
 */
function clampBodyDipole(mBody: Vec3, mtb: MtbClusterConfig): Vec3 {
  const out = { x: 0, y: 0, z: 0 };
  mtb.axes.forEach((a, j) => {
    const proj = a.x * mBody.x + a.y * mBody.y + a.z * mBody.z;
    const max = mtb.maxDipoleAm2[j];
    const clamped = Math.max(-max, Math.min(max, proj));
    out.x += a.x * clamped;
    out.y += a.y * clamped;
    out.z += a.z * clamped;
  });
  return out;
}

/**
 * @description The in-house attitude simulator: a rigid body with a 3-orthogonal
 * reaction-wheel cluster (gyrostat), integrated with fixed-step RK4.
 *
 * Dynamics (body frame, I diagonal, τ_ext = 0 in W1 — no disturbance models yet, stated in
 * ADR-102): I·ω̇ = −ω × (I·ω + h) − τ_w and ḣ = τ_w, with q̇ = ½·q ⊗ [0, ω]. Total inertial
 * angular momentum R(q)ᵀ·(I·ω + h) is conserved by construction — the unit tests assert it,
 * which is what catches sign errors in the wheel reaction term.
 *
 * Actuator honesty: the commanded torque is clamped HERE (zero-order hold over the step,
 * saturation evaluated at step entry), so no controller can command physics the hardware
 * model doesn't have.
 */
export class Rk4PropagatorSim implements SatSimAdapter {
  readonly id: string;

  private readonly config: SatBodyConfig;

  private state: SatAttitudeState;

  private readonly magEnv: MagEnvironment | null;

  private readonly mtb: MtbClusterConfig | null;

  /** The realized (clamped) body dipole held over the current step — applied as τ = m×B. */
  private mActBody: Vec3 = { x: 0, y: 0, z: 0 };

  /**
   * @description Create a propagator.
   * @param id - Vehicle identity (default `sat-alpha`).
   * @param config - Physical model (default {@link DEFAULT_SAT_CONFIG}).
   * @param environment - Optional magnetic field + magnetorquer model. Absent = W1 behavior
   *   exactly: zero field, dipole commands ignored, momentum conserved.
   */
  constructor(id = 'sat-alpha', config: SatBodyConfig = DEFAULT_SAT_CONFIG, environment?: Rk4SimEnvironment) {
    this.id = id;
    this.config = config;
    this.magEnv = environment?.mag !== undefined || environment?.mtb !== undefined ? new MagEnvironment(environment?.mag) : null;
    this.mtb = environment?.mtb ?? (this.magEnv ? DEFAULT_MTB_CONFIG : null);
    this.state = { t: 0, q: quatIdentity(), omega: { x: 0, y: 0, z: 0 }, wheelMomentum: { x: 0, y: 0, z: 0 } };
    logger.info({ id, inertia: config.inertia, wheels: config.wheels, field: !!this.magEnv }, 'RK4 propagator created');
  }

  /**
   * @description Engine + fidelity summary for surfaces and logs.
   * @returns The description sentence.
   */
  describe(): string {
    return this.magEnv
      ? 'in-house RK4 gyrostat propagator (rigid body, wheel cluster, rotating-field + magnetorquer model)'
      : 'in-house RK4 gyrostat propagator (rigid body, 3-axis wheel cluster, no disturbances)';
  }

  /**
   * @description Reset to `initial`, defaulting omitted fields to rest at identity attitude.
   * @param initial - Partial state to apply.
   * @returns The full state now in effect.
   */
  async reset(initial: Partial<SatAttitudeState> = {}): Promise<SatAttitudeState> {
    const t = initial.t ?? 0;
    const q = quatNormalize(initial.q ?? quatIdentity());
    this.state = {
      t,
      q,
      omega: { ...(initial.omega ?? { x: 0, y: 0, z: 0 }) },
      wheelMomentum: { ...(initial.wheelMomentum ?? { x: 0, y: 0, z: 0 }) },
      ...(this.magEnv ? { bFieldBody: solveFieldFromMags(this.magEnv.magAxes, this.magEnv.readMagnetometers(t, q)) } : {}),
    };
    logger.info({ id: this.id, state: this.state }, 'RK4 propagator reset');
    return this.snapshot();
  }

  /**
   * @description Read the current truth state.
   * @returns A defensive copy.
   */
  async getState(): Promise<SatAttitudeState> {
    return this.snapshot();
  }

  /** Synchronous defensive copy of the current state (the async surface wraps this). */
  private snapshot(): SatAttitudeState {
    const s = this.state;
    const out: SatAttitudeState = { t: s.t, q: { ...s.q }, omega: { ...s.omega }, wheelMomentum: { ...s.wheelMomentum } };
    if (s.bFieldBody) out.bFieldBody = { ...s.bFieldBody };
    return out;
  }

  /**
   * @description Advance by `dtSeconds` under a constant (clamped) wheel torque command and,
   * when the field model is active, a constant (clamped) magnetorquer dipole. The realized
   * dipole is held over the step (ZOH) and applied as τ_mag = m_act × B_B inside the dynamics.
   * @param dtSeconds - Step size, seconds; must be finite and > 0.
   * @param wheelTorqueCmd - Commanded wheel torque, N·m, clamped by the wheel model.
   * @param mtbDipoleCmd - Optional body dipole command, A·m² — clamped per rod; ignored when
   *   there is no field model (zero-field no-op).
   * @returns The state after the step.
   */
  async step(dtSeconds: number, wheelTorqueCmd: Vec3, mtbDipoleCmd?: Vec3): Promise<SatAttitudeState> {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      throw new Error(`step dtSeconds must be finite and > 0, got ${dtSeconds}`);
    }
    const { maxTorqueNm, maxMomentumNms } = this.config.wheels;
    const h0 = this.state.wheelMomentum;
    const torque: Vec3 = {
      x: clampAxis(wheelTorqueCmd.x, h0.x, maxTorqueNm, maxMomentumNms),
      y: clampAxis(wheelTorqueCmd.y, h0.y, maxTorqueNm, maxMomentumNms),
      z: clampAxis(wheelTorqueCmd.z, h0.z, maxTorqueNm, maxMomentumNms),
    };
    // Realized dipole held over the step; zero when there's no field model or no command.
    this.mActBody = this.magEnv && this.mtb && mtbDipoleCmd ? clampBodyDipole(mtbDipoleCmd, this.mtb) : { x: 0, y: 0, z: 0 };
    const y0: BodyState = { q: this.state.q, omega: this.state.omega, h: this.state.wheelMomentum };
    const k1 = this.derivative(y0, torque);
    const k2 = this.derivative(addScaled(y0, k1, dtSeconds / 2), torque);
    const k3 = this.derivative(addScaled(y0, k2, dtSeconds / 2), torque);
    const k4 = this.derivative(addScaled(y0, k3, dtSeconds), torque);
    const sixth = dtSeconds / 6;
    const sum: BodyDeriv = {
      qDot: {
        w: k1.qDot.w + 2 * k2.qDot.w + 2 * k3.qDot.w + k4.qDot.w,
        x: k1.qDot.x + 2 * k2.qDot.x + 2 * k3.qDot.x + k4.qDot.x,
        y: k1.qDot.y + 2 * k2.qDot.y + 2 * k3.qDot.y + k4.qDot.y,
        z: k1.qDot.z + 2 * k2.qDot.z + 2 * k3.qDot.z + k4.qDot.z,
      },
      omegaDot: vAdd(vAdd(k1.omegaDot, vScale(k2.omegaDot, 2)), vAdd(vScale(k3.omegaDot, 2), k4.omegaDot)),
      hDot: vAdd(vAdd(k1.hDot, vScale(k2.hDot, 2)), vAdd(vScale(k3.hDot, 2), k4.hDot)),
    };
    const y1 = addScaled(y0, sum, sixth);
    const nextT = this.state.t + dtSeconds;
    const nextQ = quatNormalize(y1.q);
    this.state = {
      t: nextT,
      q: nextQ,
      omega: y1.omega,
      wheelMomentum: y1.h,
      // Sensed field from the magnetometer-read + reconstruction path (not a truth shortcut).
      ...(this.magEnv ? { bFieldBody: solveFieldFromMags(this.magEnv.magAxes, this.magEnv.readMagnetometers(nextT, nextQ)) } : {}),
    };
    return this.snapshot();
  }

  /**
   * @description Total angular momentum of body + wheels expressed in the INERTIAL frame —
   * the conserved quantity (τ_ext = 0) the unit tests check. `q` is the body→inertial
   * attitude quaternion (the q̇ = ½·q⊗[0,ω] convention), so the body-frame total I·ω + h
   * rotates through `q` directly.
   * @returns H_inertial, N·m·s.
   */
  totalMomentumInertial(): Vec3 {
    const { inertia } = this.config;
    const { q, omega, wheelMomentum } = this.state;
    const hBody: Vec3 = {
      x: inertia.x * omega.x + wheelMomentum.x,
      y: inertia.y * omega.y + wheelMomentum.y,
      z: inertia.z * omega.z + wheelMomentum.z,
    };
    return rotateByQuat(q, hBody);
  }

  /**
   * @description Gyrostat equations of motion (see the class JSDoc). With the field model
   * active, an external magnetic torque τ_mag = m_act × B_B(t, q) enters ω̇ with a + sign; the
   * −τ_w wheel-reaction sign is untouched. The field is evaluated at the stage attitude, so the
   * momentum bookkeeping ΔH_I ≈ R(q)·τ_mag·dt is honest.
   */
  private derivative(s: BodyState, wheelTorque: Vec3): BodyDeriv {
    const { inertia } = this.config;
    const iOmega: Vec3 = { x: inertia.x * s.omega.x, y: inertia.y * s.omega.y, z: inertia.z * s.omega.z };
    const totalH = vAdd(iOmega, s.h);
    const gyro = vCross(s.omega, totalH);
    const tauMag = this.magEnv
      ? vCross(this.mActBody, this.magEnv.fieldBody(this.state.t, quatNormalize(s.q)))
      : { x: 0, y: 0, z: 0 };
    return {
      qDot: quatDerivative(quatNormalize(s.q), s.omega),
      omegaDot: {
        x: (-gyro.x - wheelTorque.x + tauMag.x) / inertia.x,
        y: (-gyro.y - wheelTorque.y + tauMag.y) / inertia.y,
        z: (-gyro.z - wheelTorque.z + tauMag.z) / inertia.z,
      },
      hDot: wheelTorque,
    };
  }
}
