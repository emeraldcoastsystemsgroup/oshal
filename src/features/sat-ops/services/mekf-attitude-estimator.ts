/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | 6-state multiplicative EKF (3 attitude-error +
 *                     |                             | 3 gyro-bias), the honest replacement for W1's snap-to-
 *                     |                             | star-tracker. Right-multiplicative body-frame error
 *                     |                             | (q_true = q̂⊗δq), Farrenkopf discrete Q (NEGATIVE cross
 *                     |                             | block), blockwise Joseph-form covariance, χ² gate +
 *                     |                             | reinit rail (descendant of the W1 snap; guards the
 *                     |                             | night-1 frozen-attitude class). Sensors lie by omission;
 *                     |                             | during an ST outage P grows honestly, it never freezes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rate-dependent ST underweighting (stLagS):
 *                     |                             | live W2 mission showed 42's AC struct carries ~one
 *                     |                             | FSW-cycle gyro↔ST epoch skew; at spec-sheet R that is
 *                     |                             | a 100σ+ deterministic residual → gate thrash + 44
 *                     |                             | reinits. S gains (|ω|·stLagS)²·I so precision stays
 *                     |                             | arcsec at rest and widens honestly with rate.
 */

import type { Quat, Vec3 } from '../model/sat-types';
import { quatConjugate, quatFromAxisAngle, quatMultiply, quatNormalize, vNorm } from './sat-math';
import {
  m3add,
  m3diag,
  m3diagOf,
  m3identity,
  m3inverse,
  m3mul,
  m3mulVec,
  m3scale,
  m3skew,
  m3sub,
  m3symmetrize,
  m3transpose,
  rotateDiagCovariance,
  type Mat3,
} from './mat3';

/** deg/√hr → rad/√s (ARW): x·(π/180)/60. */
export function degPerRtHrToRadPerRtS(x: number): number {
  return (x * Math.PI) / 180 / 60;
}

/** deg/hr → rad/s: x·(π/180)/3600. */
export function degPerHrToRadPerS(x: number): number {
  return (x * Math.PI) / 180 / 3600;
}

/** arcsec → rad: x·(π/180)/3600. */
export function arcsecToRad(x: number): number {
  return (x * Math.PI) / 180 / 3600;
}

/**
 * @description MEKF tuning. Noise PSDs are the gyro Allan figures converted to SI; the ST
 * measurement covariance is given in the STAR-TRACKER frame plus the mount quaternion, and
 * rotated into body axes once at construction.
 */
export interface MekfConfig {
  /** Rate white-noise PSD σ_v (rad/√s) — from gyro ARW. */
  sigmaVRadRtS: number;
  /** Rate random-walk PSD σ_u (rad·s^-3/2) — from gyro bias stability. */
  sigmaURadS15: number;
  /** Initial attitude 1σ per axis (rad) at (re)initialization from an ST fix. */
  sigmaTh0Rad: number;
  /** Initial gyro-bias 1σ per axis (rad/s). */
  sigmaB0RadS: number;
  /** ST measurement noise variance in the ST frame (rad²), pre-mount-rotation. */
  rStDiagRad2: Vec3;
  /** ST mount quaternion (ST→body) used to rotate rStDiag into body axes. */
  stMount: Quat;
  /** Optional process-noise headroom on the attitude block (default 1). */
  qProcessScale?: number;
  /** χ² gate on the 3-DoF Mahalanobis residual (default 16.27 = 99.9%). */
  gateChi2?: number;
  /** Residual magnitude (rad) above which a fix forces a hard reinit (default 0.35). */
  reinitThresholdRad?: number;
  /** Consecutive gate rejects that force a reinit (default 8). */
  maxConsecutiveRejects?: number;
  /**
   * ST sampling-lag underweighting horizon, seconds (default 0). When the measurement
   * pipeline has an unknown skew of up to this many seconds between the gyro propagation
   * epoch and the ST sample epoch, the innovation covariance is inflated by (|ω|·stLagS)²
   * per axis — the residual such a skew produces. At rest this adds nothing (spec-sheet
   * arcsec precision holds); at rate it widens the gate by exactly the term that is
   * unmodeled, instead of letting a deterministic skew masquerade as a 100σ outlier.
   */
  stLagS?: number;
}

/** Diagnostics surfaced to node telemetry. */
export interface MekfDiagnostics {
  initialized: boolean;
  updatesApplied: number;
  rejected: number;
  reinits: number;
  lastResidualRad: number;
}

/** The result of one ST update. */
export interface MekfUpdateResult {
  applied: boolean;
  rejected: boolean;
  reinitialized: boolean;
  residualRad: number;
}

/** NASA-42 CfsSat MEKF config (arcsec-grade — proven live, not in vitest). */
export const NASA42_MEKF_CONFIG: Omit<MekfConfig, 'stMount'> = {
  sigmaVRadRtS: degPerRtHrToRadPerRtS(0.007),
  sigmaURadS15: degPerHrToRadPerS(0.01) / 60, // over 1 hr: σ_u = σ_b(T)/√T = (0.01 deg/hr)/√3600
  sigmaTh0Rad: 1.0e-2,
  sigmaB0RadS: 1.5e-7,
  rStDiagRad2: { x: arcsecToRad(2) ** 2, y: arcsecToRad(2) ** 2, z: arcsecToRad(20) ** 2 },
  // Live 2026-07-18 mission: 42's standalone-AC struct carries a ~one-FSW-cycle (0.2 s) skew
  // between the gyro epoch and the ST sample; at spec-sheet R this read as a 100σ+ outlier
  // and thrashed the reinit rail (rej=1149, reinit=44 over one mission). 1.5 cycles headroom.
  stLagS: 0.3,
};

/**
 * @description The multiplicative EKF. Reference quaternion q̂ (body→inertial) propagated with
 * the bias-corrected measured rate; the 6-state error [δθ; δb] is estimated linearly and reset
 * multiplicatively into q̂ each measurement. Covariance is stored as three 3×3 blocks
 * (Pθθ, Pθb, Pbb) and updated blockwise — no 6×6 dense algebra.
 */
export class MekfAttitudeEstimator {
  private q: Quat = { w: 1, x: 0, y: 0, z: 0 };

  private b: Vec3 = { x: 0, y: 0, z: 0 };

  private pTT: Mat3;

  private pTB: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  private pBB: Mat3;

  private readonly rBody: Mat3;

  private readonly qScale: number;

  private readonly gate: number;

  private readonly reinitThreshold: number;

  private readonly maxRejects: number;

  private readonly stLag: number;

  private inited = false;

  private consecutiveRejects = 0;

  private diag: MekfDiagnostics = { initialized: false, updatesApplied: 0, rejected: 0, reinits: 0, lastResidualRad: 0 };

  constructor(private readonly cfg: MekfConfig) {
    this.rBody = rotateDiagCovariance(cfg.stMount, cfg.rStDiagRad2);
    this.qScale = cfg.qProcessScale ?? 1;
    this.gate = cfg.gateChi2 ?? 16.27;
    this.reinitThreshold = cfg.reinitThresholdRad ?? 0.35;
    this.maxRejects = cfg.maxConsecutiveRejects ?? 8;
    this.stLag = cfg.stLagS ?? 0;
    this.pTT = m3scale(m3identity(), cfg.sigmaTh0Rad ** 2);
    this.pBB = m3scale(m3identity(), cfg.sigmaB0RadS ** 2);
  }

  /** @returns Whether the filter has ingested at least one star fix. */
  initialized(): boolean {
    return this.inited;
  }

  /** @returns The estimated body→inertial attitude. */
  attitude(): Quat {
    return { ...this.q };
  }

  /** @returns The estimated gyro bias (rad/s). */
  biasRadS(): Vec3 {
    return { ...this.b };
  }

  /** @param omegaMeas - Raw measured body rate. @returns The bias-corrected rate estimate ω_meas − b̂. */
  rateEstimate(omegaMeas: Vec3): Vec3 {
    return { x: omegaMeas.x - this.b.x, y: omegaMeas.y - this.b.y, z: omegaMeas.z - this.b.z };
  }

  /** @returns Per-axis attitude 1σ (rad). */
  attitudeSigmaRad(): Vec3 {
    const d = m3diagOf(this.pTT);
    return { x: Math.sqrt(Math.max(0, d.x)), y: Math.sqrt(Math.max(0, d.y)), z: Math.sqrt(Math.max(0, d.z)) };
  }

  /** @returns Per-axis bias 1σ (rad/s). */
  biasSigmaRadS(): Vec3 {
    const d = m3diagOf(this.pBB);
    return { x: Math.sqrt(Math.max(0, d.x)), y: Math.sqrt(Math.max(0, d.y)), z: Math.sqrt(Math.max(0, d.z)) };
  }

  /** @returns trace(Pθθ) — the scalar attitude-uncertainty health metric (rad²). */
  traceAttitudeCov(): number {
    return this.pTT[0][0] + this.pTT[1][1] + this.pTT[2][2];
  }

  /** @returns A copy of the diagnostics counters. */
  diagnostics(): MekfDiagnostics {
    return { ...this.diag, initialized: this.inited };
  }

  /**
   * @description Propagate one step: advance the reference quaternion with the bias-corrected
   * rate and grow the covariance through the error-state transition + Farrenkopf process
   * noise. Call once per control step before any measurement update.
   * @param omegaMeas - Raw measured body rate (rad/s).
   * @param dt - Step size (s).
   */
  propagate(omegaMeas: Vec3, dt: number): void {
    const w = this.rateEstimate(omegaMeas);
    const angle = Math.hypot(w.x, w.y, w.z) * dt;
    if (angle > 0) this.q = quatNormalize(quatMultiply(this.q, quatFromAxisAngle(w, angle)));

    // A = exp(−[ω̂×]dt) ≈ I − [ω̂×]dt + ½[ω̂×]²dt²  (2nd-order; exact to <1e-9 at ω<1 deg/s)
    const wx = m3skew(w);
    const wx2 = m3mul(wx, wx);
    const A = m3add(m3sub(m3identity(), m3scale(wx, dt)), m3scale(wx2, 0.5 * dt * dt));
    // B = −I·dt, so B·X = −dt·X and B·X·Bᵀ = dt²·X.
    const sv2 = this.cfg.sigmaVRadRtS ** 2;
    const su2 = this.cfg.sigmaURadS15 ** 2;
    const Qtt = m3scale(m3identity(), (sv2 * dt + (su2 * dt ** 3) / 3) * this.qScale);
    const Qtb = m3scale(m3identity(), -0.5 * su2 * dt * dt); // NEGATIVE — from the −δb term in δθ̇
    const Qbb = m3scale(m3identity(), su2 * dt);

    const At = m3transpose(A);
    // Pθθ⁺ = A·Pθθ·Aᵀ − dt·(A·Pθb·+ Pθbᵀ·Aᵀ) + dt²·Pbb + Qθθ
    const APθθAt = m3mul(m3mul(A, this.pTT), At);
    const APθb = m3mul(A, this.pTB);
    const term2 = m3scale(m3add(APθb, m3transpose(APθb)), -dt);
    const pTTnext = m3add(m3add(m3add(APθθAt, term2), m3scale(this.pBB, dt * dt)), Qtt);
    // Pθb⁺ = A·Pθb − dt·Pbb + Qθb
    const pTBnext = m3add(m3sub(APθb, m3scale(this.pBB, dt)), Qtb);
    // Pbb⁺ = Pbb + Qbb
    const pBBnext = m3add(this.pBB, Qbb);

    this.pTT = m3symmetrize(pTTnext);
    this.pTB = pTBnext;
    this.pBB = m3symmetrize(pBBnext);
  }

  /**
   * @description Fold one star-tracker attitude measurement (body→inertial, mount already
   * composed out) into the estimate. Gates outliers on the Mahalanobis distance, forces a
   * hard reinit on a first fix / large residual / persistent rejection, and otherwise does a
   * blockwise Joseph-form Kalman update with a multiplicative reset.
   * @param qMeas - Measured body→inertial attitude.
   * @param omegaRadS - Current body rate; with cfg.stLagS it sizes the sampling-skew
   *                    underweighting term (|ω|·stLagS)² added to the innovation covariance.
   * @returns What happened (applied / rejected / reinitialized + residual magnitude).
   */
  updateStarTracker(qMeas: Quat, omegaRadS?: Vec3): MekfUpdateResult {
    const dq = quatNormalize(quatMultiply(quatConjugate(this.q), qMeas));
    const s = dq.w >= 0 ? 1 : -1;
    const z: Vec3 = { x: 2 * s * dq.x, y: 2 * s * dq.y, z: 2 * s * dq.z };
    const residual = Math.hypot(z.x, z.y, z.z);
    this.diag.lastResidualRad = residual;

    if (!this.inited || residual > this.reinitThreshold || this.consecutiveRejects >= this.maxRejects) {
      this.reinit(qMeas);
      return { applied: true, rejected: false, reinitialized: true, residualRad: residual };
    }

    const lagSigma = omegaRadS ? vNorm(omegaRadS) * this.stLag : 0;
    const S = m3add(m3add(this.pTT, this.rBody), m3scale(m3identity(), lagSigma ** 2));
    const Sinv = m3inverse(S);
    const d2 = this.mahalanobis(z, Sinv);
    if (d2 > this.gate) {
      this.consecutiveRejects++;
      this.diag.rejected++;
      return { applied: false, rejected: true, reinitialized: false, residualRad: residual };
    }
    this.consecutiveRejects = 0;
    this.kalmanUpdate(z, Sinv);
    this.diag.updatesApplied++;
    return { applied: true, rejected: false, reinitialized: false, residualRad: residual };
  }

  /** zᵀ·S⁻¹·z. */
  private mahalanobis(z: Vec3, Sinv: Mat3): number {
    const sz = m3mulVec(Sinv, z);
    return z.x * sz.x + z.y * sz.y + z.z * sz.z;
  }

  /** Hard reinitialize from a star fix: adopt its attitude, keep the bias, refresh Pθθ/Pθb. */
  private reinit(qMeas: Quat): void {
    this.q = quatNormalize(qMeas);
    this.pTT = m3scale(m3identity(), this.cfg.sigmaTh0Rad ** 2);
    this.pTB = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.consecutiveRejects = 0;
    this.inited = true;
    this.diag.reinits++;
  }

  /** Blockwise Joseph-form Kalman update + multiplicative reset. */
  private kalmanUpdate(z: Vec3, Sinv: Mat3): void {
    const Kt = m3mul(this.pTT, Sinv); // Kθ = Pθθ·S⁻¹
    const Kb = m3mul(m3transpose(this.pTB), Sinv); // Kb = Pθbᵀ·S⁻¹
    const dTheta = m3mulVec(Kt, z);
    const dBias = m3mulVec(Kb, z);

    const L = m3sub(m3identity(), Kt);
    const R = this.rBody;
    const KtR = m3mul(Kt, R);
    const KbR = m3mul(Kb, R);
    const Kbt = m3transpose(Kb);
    // Pθθ⁺ = L·Pθθ·Lᵀ + Kθ·R·Kθᵀ
    const pTTn = m3add(m3mul(m3mul(L, this.pTT), m3transpose(L)), m3mul(KtR, m3transpose(Kt)));
    // Pθb⁺ = L·(Pθb − Pθθ·Kbᵀ) + Kθ·R·Kbᵀ
    const pTBn = m3add(m3mul(L, m3sub(this.pTB, m3mul(this.pTT, Kbt))), m3mul(KtR, Kbt));
    // Pbb⁺ = Pbb − Kb·Pθb − Pθbᵀ·Kbᵀ + Kb·Pθθ·Kbᵀ + Kb·R·Kbᵀ
    const pBBn = m3add(
      m3add(
        m3sub(m3sub(this.pBB, m3mul(Kb, this.pTB)), m3mul(m3transpose(this.pTB), Kbt)),
        m3mul(m3mul(Kb, this.pTT), Kbt),
      ),
      m3mul(KbR, Kbt),
    );

    this.pTT = m3symmetrize(pTTn);
    this.pTB = pTBn;
    this.pBB = m3symmetrize(pBBn);

    // Multiplicative reset (first-order reset quat; normalization absorbs the 2nd-order defect).
    this.q = quatNormalize(quatMultiply(this.q, { w: 1, x: dTheta.x / 2, y: dTheta.y / 2, z: dTheta.z / 2 }));
    this.b = { x: this.b.x + dBias.x, y: this.b.y + dBias.y, z: this.b.z + dBias.z };
  }
}
