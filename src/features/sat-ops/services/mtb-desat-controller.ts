/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | the cross-product magnetorquer momentum-dumping law.
 *                     |                             | m = (k/|B|²)(Δh × B) from the MEASURED body field, so
 *                     |                             | τ = m×B = −k·Δh_⊥ — the ⊥-to-B momentum decays at rate
 *                     |                             | k while B rotates over the orbit sweeping the dead
 *                     |                             | direction. Sign verified against I·ω̇ = −ω×(Iω+h) − τ_w
 *                     |                             | + τ_mag; the NEGATED variant PUMPS the wheels (the
 *                     |                             | night-1 mirrored-reference failure class) — canary-tested.
 */

import type { Vec3 } from '../model/sat-types';
import { vCross, vNorm, vSub } from './sat-math';
import { wheelDistribution } from './nasa42-codec';

/** Configuration for {@link MtbDesatController}. */
export interface MtbDesatConfig {
  /** Desaturation gain (s⁻¹) — the ⊥-component decay rate in the linear regime. */
  kDesat: number;
  /** Magnetorquer axes in the body frame. */
  mtbAxes: Vec3[];
  /** Per-rod dipole saturation (A·m²). */
  maxDipoleAm2: number[];
  /** Target cluster momentum (N·m·s), default zero — nonzero supports future momentum-bias designs. */
  hTargetNms?: Vec3;
  /** Minimum field magnitude (T) below which no dipole is commanded (guards the 1/|B|² term). */
  minFieldT?: number;
  /** Momentum deadband (N·m·s) below which dumping is off; re-arms at 2× (hysteresis). */
  deadbandNms?: number;
}

/** One desat command: per-rod dipoles, the realized body dipole, and whether the law fired. */
export interface MtbDesatCommand {
  perMtbAm2: number[];
  bodyDipoleAm2: Vec3;
  active: boolean;
}

/** RK4 default desat config: k=2e-3, 3 orthogonal rods @ 5 A·m² (short unit-test dump times). */
export const DEFAULT_DESAT_CONFIG_RK4: MtbDesatConfig = {
  kDesat: 2e-3,
  mtbAxes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
  maxDipoleAm2: [5, 5, 5],
};

/** CfsSat desat gain (s⁻¹) — the axes/Mmax come from the 42 table at runtime, never hardcoded. */
export const CFS_SAT_DESAT_KDESAT = 1e-3;

/**
 * @description The magnetorquer momentum-dumping controller. Pure except a deadband hysteresis
 * latch. Computes the ideal body dipole from measured cluster momentum + field, distributes it
 * across the rods with the same minimum-norm pseudo-inverse the wheels use, and clamps per rod
 * to Mmax — so callers think in body vectors and the hardware model owns the distribution.
 */
export class MtbDesatController {
  private readonly distribution: number[][];

  private readonly hTarget: Vec3;

  private readonly minField: number;

  private readonly deadband: number;

  private armed = false;

  constructor(private readonly cfg: MtbDesatConfig) {
    this.distribution = wheelDistribution(cfg.mtbAxes);
    this.hTarget = cfg.hTargetNms ?? { x: 0, y: 0, z: 0 };
    this.minField = cfg.minFieldT ?? 1e-6;
    const meanMax = cfg.maxDipoleAm2.reduce((a, b) => a + b, 0) / Math.max(1, cfg.maxDipoleAm2.length);
    this.deadband = cfg.deadbandNms ?? 0.02 * meanMax; // scaled off rod authority; overridable
  }

  /**
   * @description Compute the desat command for one control tick.
   * @param wheelMomentumBody - Cluster momentum in the body frame (N·m·s).
   * @param bFieldBody - Measured body-frame field (T).
   * @returns The per-rod dipoles, realized body dipole, and active flag.
   */
  computeDipole(wheelMomentumBody: Vec3, bFieldBody: Vec3): MtbDesatCommand {
    const dh = vSub(wheelMomentumBody, this.hTarget);
    const bMag = vNorm(bFieldBody);
    const dhMag = vNorm(dh);
    // Deadband hysteresis: fire above 2× deadband, stay on until below 1× deadband.
    if (dhMag < this.deadband) this.armed = false;
    else if (dhMag >= 2 * this.deadband) this.armed = true;
    if (!this.armed || bMag < this.minField) {
      return { perMtbAm2: this.cfg.mtbAxes.map(() => 0), bodyDipoleAm2: { x: 0, y: 0, z: 0 }, active: false };
    }
    // Ideal body dipole m = (k/|B|²)(Δh × B).
    const cross = vCross(dh, bFieldBody);
    const scale = this.cfg.kDesat / (bMag * bMag);
    const mIdeal: Vec3 = { x: cross.x * scale, y: cross.y * scale, z: cross.z * scale };
    // Distribute per rod (minimum-norm), clamp to Mmax.
    const perMtb = this.distribution.map((row, j) => {
      const raw = row[0] * mIdeal.x + row[1] * mIdeal.y + row[2] * mIdeal.z;
      const max = this.cfg.maxDipoleAm2[j];
      return Math.max(-max, Math.min(max, raw));
    });
    // Realized body dipole = Σ axis_j · m_j (clamped) — what telemetry reports + the sim applies.
    const bodyDipole = { x: 0, y: 0, z: 0 };
    this.cfg.mtbAxes.forEach((a, j) => {
      bodyDipole.x += a.x * perMtb[j];
      bodyDipole.y += a.y * perMtb[j];
      bodyDipole.z += a.z * perMtb[j];
    });
    return { perMtbAm2: perMtb, bodyDipoleAm2: bodyDipole, active: true };
  }

  /**
   * @description Predicted steady-state pointing bias (rad) from running desat continuously
   * under POINT — the continuous-vs-dedicated-DESAT-mode criterion helper. θ_ss = τ_mag/kp.
   * @param kpMin - Smallest per-axis proportional gain (N·m/rad).
   * @param fieldMagT - Field magnitude (T).
   * @returns The worst-case steady-state offset (rad).
   */
  predictedPointingBiasRad(kpMin: number, fieldMagT: number): number {
    const totalMax = this.cfg.maxDipoleAm2.reduce((a, b) => a + b, 0);
    return (fieldMagT * totalMax) / Math.max(1e-9, kpMin);
  }
}
