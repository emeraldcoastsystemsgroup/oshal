/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1: quaternion-PD attitude controller (port of the
 *                     |                             | 07-17 challenge demo) — shortest-path error quaternion,
 *                     |                             | per-axis gains derived from inertia, wheel-reaction sign
 *                     |                             | handled here so the sim's clamp is the only other actor.
 */

import { createChildLogger } from '@/shared/logger';
import type { Quat, SatAttitudeState, Vec3 } from '../model/sat-types';
import { quatConjugate, quatMultiply, quatNormalize } from './sat-math';

const logger = createChildLogger({ module: 'sat-ops:adcs-pd' });

/**
 * @description Tuning for {@link QuaternionPdController}. Gains are derived per-axis from the
 * inertia so one (ωn, ζ) pair tunes all three axes to the same closed-loop dynamics:
 * kp_i = I_i·ωn², kd_i = 2·ζ·ωn·I_i — the standard small-angle linearization result.
 */
export interface AdcsPdConfig {
  /** Principal moments of inertia the controller assumes (kg·m²) — match the plant's. */
  inertia: Vec3;
  /** Closed-loop natural frequency, rad/s. Default 0.3 (≈ 20 s settle on smallsat inertia). */
  naturalFreqRadS?: number;
  /** Damping ratio. Default 1.0 (critically damped — no overshoot to fight wheel limits). */
  dampingRatio?: number;
}

/**
 * @description Quaternion-PD pointing controller. Computes the reaction-wheel torque command
 * that drives the body to `target` and rates to zero: shortest-path error quaternion
 * (sign(w) disambiguation, so a 359° error commands a 1° correction), P on the error vector
 * part, D on body rate. The output is the WHEEL command — the body feels the reaction, so the
 * sign flip lives here, once, instead of leaking into every caller.
 *
 * W1 honesty (ADR-102): this reads truth state from the sim. It is a control demo until W2's
 * EKF feeds it estimated state; do not describe it as flight software.
 */
export class QuaternionPdController {
  private readonly kp: Vec3;

  private readonly kd: Vec3;

  /**
   * @description Create a controller with gains derived from the plant model.
   * @param config - Inertia + closed-loop tuning.
   */
  constructor(config: AdcsPdConfig) {
    const wn = config.naturalFreqRadS ?? 0.3;
    const zeta = config.dampingRatio ?? 1.0;
    const i = config.inertia;
    this.kp = { x: i.x * wn * wn, y: i.y * wn * wn, z: i.z * wn * wn };
    this.kd = { x: 2 * zeta * wn * i.x, y: 2 * zeta * wn * i.y, z: 2 * zeta * wn * i.z };
    logger.info({ kp: this.kp, kd: this.kd, wn, zeta }, 'quaternion-PD controller created');
  }

  /**
   * @description Compute the wheel torque command for one control tick.
   * @param state - Current attitude state (truth in W1; estimated state from W2 on).
   * @param target - Desired attitude (body→inertial, same convention as state.q), unit-norm.
   * @returns Wheel torque command, N·m (unclamped — the sim's actuator model clamps).
   */
  computeWheelTorque(state: SatAttitudeState, target: Quat): Vec3 {
    const qErr = quatNormalize(quatMultiply(quatConjugate(target), state.q));
    const sign = qErr.w >= 0 ? 1 : -1;
    // Body control torque τ = −kp·sign(w)·vec(q_err) − kd·ω; wheels must spin the other way.
    const bodyTorque: Vec3 = {
      x: -this.kp.x * sign * qErr.x - this.kd.x * state.omega.x,
      y: -this.kp.y * sign * qErr.y - this.kd.y * state.omega.y,
      z: -this.kp.z * sign * qErr.z - this.kd.z * state.omega.z,
    };
    return { x: -bodyTorque.x, y: -bodyTorque.y, z: -bodyTorque.z };
  }
}
