/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | physically-honest synthetic sensors over RK4 truth so
 *                     |                             | the MEKF is unit-provable without the 42 container.
 *                     |                             | Seeded (mulberry32 + Box-Muller) → deterministic per
 *                     |                             | seed. Gyro = white rate noise (σ_v²/dt) + random-walk
 *                     |                             | bias; star tracker = body-frame small-angle noise on a
 *                     |                             | latched sample cadence with schedulable outages.
 */

import type { Quat, Vec3 } from '../model/sat-types';
import { quatMultiply, quatNormalize } from './sat-math';
import { arcsecToRad, degPerHrToRadPerS, degPerRtHrToRadPerRtS } from './mekf-attitude-estimator';

/** Noise figures for {@link SatSensorSim}. */
export interface SensorNoiseConfig {
  /** Gyro angle random walk as a rate PSD σ_v (rad/√s). */
  sigmaArwRadRtS: number;
  /** Gyro rate random walk σ_u (rad·s^-3/2) driving the bias. */
  sigmaRrwRadS15: number;
  /** Injected TRUTH initial gyro bias (rad/s) — exposed via trueBias() for assertions. */
  initialBiasRadS: Vec3;
  /** Star-tracker measurement noise variance per body axis (rad²). */
  stNoiseDiagRad2: Vec3;
  /** Star-tracker sample cadence (s); samples latch between cadence boundaries. */
  stSampleSeconds: number;
}

/** CfsSat-grade noise (SC_CfsSat0 figures) — the live-42 preset. Too small for vitest asserts. */
export const CFS_SAT_SENSOR_NOISE: SensorNoiseConfig = {
  sigmaArwRadRtS: degPerRtHrToRadPerRtS(0.007),
  sigmaRrwRadS15: degPerHrToRadPerS(0.01) / 60,
  initialBiasRadS: { x: degPerHrToRadPerS(0.01), y: degPerHrToRadPerS(-0.008), z: degPerHrToRadPerS(0.006) },
  stNoiseDiagRad2: { x: arcsecToRad(2) ** 2, y: arcsecToRad(2) ** 2, z: arcsecToRad(20) ** 2 },
  stSampleSeconds: 0.25,
};

/** MEMS-grade noise — big enough that vitest can assert convergence above float noise. */
export const MEMS_TEST_SENSOR_NOISE: SensorNoiseConfig = {
  sigmaArwRadRtS: degPerRtHrToRadPerRtS(0.15),
  sigmaRrwRadS15: degPerHrToRadPerS(2) / 60,
  initialBiasRadS: { x: degPerHrToRadPerS(10), y: degPerHrToRadPerS(-6), z: degPerHrToRadPerS(4) },
  stNoiseDiagRad2: { x: arcsecToRad(30) ** 2, y: arcsecToRad(30) ** 2, z: arcsecToRad(30) ** 2 },
  stSampleSeconds: 0.25,
};

/** Deterministic uniform PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @description A synthetic gyro + star tracker over externally supplied truth. Fully
 * deterministic for a given seed, so filter-convergence assertions are exact-reproducible.
 * The gyro integrates a random-walk bias and adds discrete white rate noise whose variance
 * σ_v²/dt reproduces the continuous ARW; the star tracker latches a body-frame small-angle
 * noisy fix at its cadence and can be forced into exclusion outages.
 */
export class SatSensorSim {
  private readonly rand: () => number;

  private bias: Vec3;

  private gauss: number | null = null;

  private lastStSampleT = -Infinity;

  private latched: { q: Quat; valid: boolean } = { q: { w: 1, x: 0, y: 0, z: 0 }, valid: false };

  private outage: { from: number; to: number } | null = null;

  constructor(private readonly cfg: SensorNoiseConfig & { seed: number }) {
    this.rand = mulberry32(cfg.seed);
    this.bias = { ...cfg.initialBiasRadS };
  }

  /** Standard-normal via Box-Muller (caches the paired sample). */
  private normal(): number {
    if (this.gauss !== null) {
      const g = this.gauss;
      this.gauss = null;
      return g;
    }
    const u1 = Math.max(this.rand(), 1e-12);
    const u2 = this.rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.gauss = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }

  /**
   * @description Sample the gyro: advance the random-walk bias by one truth step and return
   * the measured rate ω_meas = ω_true + b + white(σ_v²/dt).
   * @param omegaTrue - True body rate (rad/s).
   * @param dtSeconds - Truth step size (s).
   * @returns The measured body rate (rad/s).
   */
  sampleGyro(omegaTrue: Vec3, dtSeconds: number): Vec3 {
    const rwSigma = this.cfg.sigmaRrwRadS15 * Math.sqrt(dtSeconds);
    this.bias = {
      x: this.bias.x + rwSigma * this.normal(),
      y: this.bias.y + rwSigma * this.normal(),
      z: this.bias.z + rwSigma * this.normal(),
    };
    const wn = this.cfg.sigmaArwRadRtS / Math.sqrt(dtSeconds);
    return {
      x: omegaTrue.x + this.bias.x + wn * this.normal(),
      y: omegaTrue.y + this.bias.y + wn * this.normal(),
      z: omegaTrue.z + this.bias.z + wn * this.normal(),
    };
  }

  /**
   * @description Sample the star tracker at time `t`. Produces a fresh noisy body→inertial fix
   * only at cadence boundaries (latched otherwise), and reports invalid during an outage.
   * @param qTrue - True body→inertial attitude.
   * @param t - Simulation time (s).
   * @returns The latched fix, its validity, and whether this call produced a fresh sample.
   */
  sampleStarTracker(qTrue: Quat, t: number): { q: Quat; valid: boolean; fresh: boolean } {
    const inOutage = this.outage !== null && t >= this.outage.from && t < this.outage.to;
    const due = t - this.lastStSampleT >= this.cfg.stSampleSeconds - 1e-9;
    if (!due) return { q: { ...this.latched.q }, valid: this.latched.valid && !inOutage, fresh: false };
    this.lastStSampleT = t;
    if (inOutage) {
      this.latched = { q: this.latched.q, valid: false };
      return { q: { ...this.latched.q }, valid: false, fresh: true };
    }
    const d = this.cfg.stNoiseDiagRad2;
    const noise: Quat = {
      w: 1,
      x: 0.5 * Math.sqrt(d.x) * this.normal(),
      y: 0.5 * Math.sqrt(d.y) * this.normal(),
      z: 0.5 * Math.sqrt(d.z) * this.normal(),
    };
    this.latched = { q: quatNormalize(quatMultiply(qTrue, noise)), valid: true };
    return { q: { ...this.latched.q }, valid: true, fresh: true };
  }

  /**
   * @description Schedule a star-tracker exclusion outage on [fromT, toT) sim-seconds.
   * @param fromT - Outage start (s).
   * @param toT - Outage end (s).
   */
  setOutage(fromT: number, toT: number): void {
    this.outage = { from: fromT, to: toT };
  }

  /** @returns The current TRUTH gyro bias (rad/s) for convergence assertions. */
  trueBias(): Vec3 {
    return { ...this.bias };
  }
}
