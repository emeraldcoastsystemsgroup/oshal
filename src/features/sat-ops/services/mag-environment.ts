/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | the honest optional magnetic-environment model for the
 *                     |                             | in-house sim — a uniform-magnitude field rotating at
 *                     |                             | orbit rate in the inertial X–Y plane, mapped to the body
 *                     |                             | frame through q, plus per-axis magnetometer scalar reads
 *                     |                             | so the reconstruction path is exercised in vitest exactly
 *                     |                             | as it is against 42. Pure functions of (t, q); NASA 42
 *                     |                             | brings its own field — this is the referee-free sibling.
 */

import type { Quat, Vec3 } from '../model/sat-types';
import { quatConjugate, rotateByQuat } from './sat-math';

/** Configuration for {@link MagEnvironment}. */
export interface MagEnvironmentConfig {
  /** Field magnitude (T), default 35 µT (≈ LEO mean). */
  fieldMagnitudeT?: number;
  /** Inertial rotation rate (rad/s), default 2π/5700 ≈ 95-min LEO. */
  orbitRateRadS?: number;
  /** Initial phase (rad), default 0. */
  phaseRad?: number;
  /** Magnetometer sensing axes in the body frame, default the orthogonal triad. */
  magAxes?: Vec3[];
}

/** Default field: 35 µT, 95-min orbit, zero phase, orthogonal-triad magnetometers. */
export const DEFAULT_MAG_ENV: Required<MagEnvironmentConfig> = {
  fieldMagnitudeT: 35e-6,
  orbitRateRadS: (2 * Math.PI) / 5700,
  phaseRad: 0,
  magAxes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
};

/**
 * @description A uniform-magnitude magnetic field rotating in the inertial X–Y plane at orbit
 * rate — enough structure to prove magnetorquer momentum dumping (the field sweeps the
 * instantaneously-dead direction over an orbit) without pretending to a real dipole/IGRF
 * model, which is 42's job as referee. Body-frame quantities come through the attitude
 * quaternion; magnetometer reads are the per-axis projections the reconstruction inverts.
 */
export class MagEnvironment {
  private readonly cfg: Required<MagEnvironmentConfig>;

  constructor(config: MagEnvironmentConfig = {}) {
    this.cfg = { ...DEFAULT_MAG_ENV, ...config };
  }

  /** @param t - Time (s). @returns The inertial-frame field vector (T). */
  fieldInertial(t: number): Vec3 {
    const a = this.cfg.orbitRateRadS * t + this.cfg.phaseRad;
    return { x: this.cfg.fieldMagnitudeT * Math.cos(a), y: this.cfg.fieldMagnitudeT * Math.sin(a), z: 0 };
  }

  /** @param t - Time (s). @param q - Body→inertial attitude. @returns The body-frame field (T). */
  fieldBody(t: number, q: Quat): Vec3 {
    return rotateByQuat(quatConjugate(q), this.fieldInertial(t));
  }

  /**
   * @description The per-axis magnetometer scalar reads (T) — one projection of the body field
   * onto each configured mag axis. Feeding these back through solveFieldFromMags reconstructs
   * the body field, exactly the path the 42 adapter runs on 42's magField scalars.
   * @param t - Time (s). @param q - Body→inertial attitude.
   * @returns One scalar per magnetometer axis.
   */
  readMagnetometers(t: number, q: Quat): number[] {
    const b = this.fieldBody(t, q);
    return this.cfg.magAxes.map((a) => a.x * b.x + a.y * b.y + a.z * b.z);
  }

  /** @returns The configured magnetometer axes (body frame). */
  get magAxes(): Vec3[] {
    return this.cfg.magAxes;
  }
}
