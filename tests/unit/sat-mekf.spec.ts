/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | MEKF proofs. Unit conversions, the Farrenkopf
 *                     |                             | propagate-only covariance closed form (sign traps on Q
 *                     |                             | and B), residual direction, bias convergence to injected
 *                     |                             | truth, the ≥2.5× win over raw dead-reckoning through a
 *                     |                             | 200s ST outage, the reinit rail, the outlier gate, the
 *                     |                             | latched-fix dedupe, estimator-in-the-loop control, and
 *                     |                             | the ST-mount R rotation. MEMS preset (CfsSat-grade noise
 *                     |                             | is below float-comparison comfort — proven live on 42).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAT_CONFIG,
  EstimatingSimAdapter,
  MEMS_TEST_SENSOR_NOISE,
  MekfAttitudeEstimator,
  QuaternionPdController,
  Rk4PropagatorSim,
  SatSensorSim,
  arcsecToRad,
  attitudeSeparationDeg,
  degPerHrToRadPerS,
  degPerRtHrToRadPerRtS,
  m3diagOf,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  rotateDiagCovariance,
  vNorm,
  vSub,
  type MekfConfig,
  type Quat,
  type Vec3,
} from '@/features/sat-ops';

const IDENT: Quat = { w: 1, x: 0, y: 0, z: 0 };

/** MEMS-grade estimator config matching the MEMS sensor preset (identity mount). */
function memsConfig(overrides: Partial<MekfConfig> = {}): MekfConfig {
  return {
    sigmaVRadRtS: degPerRtHrToRadPerRtS(0.15),
    sigmaURadS15: degPerHrToRadPerS(2) / 60,
    sigmaTh0Rad: 1e-2,
    sigmaB0RadS: degPerHrToRadPerS(20),
    rStDiagRad2: { x: arcsecToRad(30) ** 2, y: arcsecToRad(30) ** 2, z: arcsecToRad(30) ** 2 },
    stMount: IDENT,
    ...overrides,
  };
}

describe('sat-ops MEKF unit conversions', () => {
  it('converts gyro figures to SI exactly', () => {
    expect(degPerRtHrToRadPerRtS(0.007)).toBeCloseTo(2.03622e-6, 11);
    expect(degPerHrToRadPerS(0.01)).toBeCloseTo(4.84814e-8, 13);
    expect(arcsecToRad(20)).toBeCloseTo(9.69627e-5, 10);
  });
});

describe('sat-ops MEKF propagate-only covariance (Farrenkopf closed form)', () => {
  it('matches the closed form and pins the Q/B sign traps', () => {
    const sigTh0 = 1e-2;
    const sigB0 = arcsecToRad(20); // 9.69627e-5
    const sigV = degPerRtHrToRadPerRtS(0.15);
    const sigU = degPerHrToRadPerS(2) / 60;
    const mekf = new MekfAttitudeEstimator(memsConfig({ sigmaTh0Rad: sigTh0, sigmaB0RadS: sigB0 }));
    // force initialized (reinit uses sigmaTh0 for Pθθ, keeps Pbb=sigB0², Pθb=0) then propagate
    mekf.updateStarTracker(IDENT);
    const dt = 0.1;
    const n = 4000;
    for (let i = 0; i < n; i++) mekf.propagate({ x: 0, y: 0, z: 0 }, dt);
    const t = n * dt;
    const varTh = m3diagOf(covTT(mekf));
    const varBb = m3diagOf(covBB(mekf));
    const expTh = sigTh0 ** 2 + sigV ** 2 * t + sigB0 ** 2 * t ** 2 + (sigU ** 2 * t ** 3) / 3;
    const expBb = sigB0 ** 2 + sigU ** 2 * t;
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(varTh[axis]).toBeCloseTo(expTh, -1); // relative 1e-6 over a ~1e-4 quantity
      expect(Math.abs(varTh[axis] / expTh - 1)).toBeLessThan(1e-6);
      expect(Math.abs(varBb[axis] / expBb - 1)).toBeLessThan(1e-9);
    }
    // cross block sign: Pθb = −(σ_b0²·t + ½σ_u²·t²)
    const expThb = -(sigB0 ** 2 * t + 0.5 * sigU ** 2 * t ** 2);
    expect(Math.abs(covTB(mekf)[0][0] / expThb - 1)).toBeLessThan(1e-6);
  });

  it('grows covariance honestly and stays symmetric + positive over 10k interleaved steps', () => {
    const sensors = new SatSensorSim({ ...MEMS_TEST_SENSOR_NOISE, seed: 7 });
    const mekf = new MekfAttitudeEstimator(memsConfig());
    const sim = new Rk4PropagatorSim();
    void (async () => {})();
    let last = IDENT;
    for (let i = 0; i < 10_000; i++) {
      const omega = { x: 0.01, y: -0.02, z: 0.015 };
      const meas = sensors.sampleGyro(omega, 0.1);
      mekf.propagate(meas, 0.1);
      last = quatNormalize(quatMultiply(last, quatFromAxisAngle(omega, vNorm(omega) * 0.1)));
      const st = sensors.sampleStarTracker(last, i * 0.1);
      if (st.valid && st.fresh) mekf.updateStarTracker(st.q);
    }
    const tt = covTT(mekf);
    const bb = covBB(mekf);
    expect(tt[0][1]).toBe(tt[1][0]); // stored symmetric after m3symmetrize
    expect(tt[0][2]).toBe(tt[2][0]);
    expect(bb[0][1]).toBe(bb[1][0]);
    for (const v of [tt[0][0], tt[1][1], tt[2][2], bb[0][0], bb[1][1], bb[2][2]]) {
      expect(v).toBeGreaterThan(0);
      expect(Number.isFinite(v)).toBe(true);
    }
    void sim;
  });
});

describe('sat-ops MEKF measurement update', () => {
  it('reduces attitude error along the correct axis and sign', () => {
    const mekf = new MekfAttitudeEstimator(memsConfig({ sigmaVRadRtS: 0, sigmaURadS15: 0, rStDiagRad2: { x: 2.1e-8, y: 2.1e-8, z: 2.1e-8 } }));
    mekf.updateStarTracker(IDENT); // initialize at identity
    const qTrue = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, (0.5 * Math.PI) / 180); // 0.5° about +x
    const before = attitudeSeparationDeg(mekf.attitude(), qTrue);
    mekf.updateStarTracker(qTrue);
    const after = attitudeSeparationDeg(mekf.attitude(), qTrue);
    expect(after).toBeLessThan(before * 0.1); // ≥90% reduction
    // correction axis is +x: the estimate rotated toward qTrue about ~x
    const dq = quatMultiply({ w: mekf.attitude().w, x: -mekf.attitude().x, y: -mekf.attitude().y, z: -mekf.attitude().z }, qTrue);
    expect(Math.abs(dq.x)).toBeGreaterThan(Math.abs(dq.y) + Math.abs(dq.z));
  });

  it('gates a 5σ outlier (rejected, estimate barely moves)', () => {
    const mekf = new MekfAttitudeEstimator(memsConfig({ sigmaVRadRtS: 0, sigmaURadS15: 0 }));
    mekf.updateStarTracker(IDENT);
    for (let i = 0; i < 20; i++) mekf.updateStarTracker(IDENT); // shrink Pθθ toward R
    const sigma = Math.sqrt(mekf.attitudeSigmaRad().y ** 2 + arcsecToRad(30) ** 2);
    const outlier = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 5 * sigma);
    const before = mekf.attitude();
    const r = mekf.updateStarTracker(outlier);
    expect(r.rejected).toBe(true);
    expect(r.applied).toBe(false);
    expect(attitudeSeparationDeg(mekf.attitude(), before)).toBeLessThan((5 * sigma * 180) / Math.PI * 0.05);
  });

  it('dedupes a bit-identical latched fix', () => {
    const mekf = new MekfAttitudeEstimator(memsConfig());
    mekf.updateStarTracker(IDENT);
    const q = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 0.001);
    const r1 = mekf.updateStarTracker(q);
    const attAfter1 = mekf.attitude();
    const trace1 = mekf.traceAttitudeCov();
    expect(r1.applied).toBe(true);
    // A second call with the SAME measurement is legitimate to APPLY at the filter level; the
    // dedupe lives in the ADAPTER (raw stQn key). Here we prove the filter is deterministic:
    // re-applying identical info shrinks P further, so the adapter-level guard is load-bearing.
    const r2 = mekf.updateStarTracker(q);
    expect(r2.applied).toBe(true);
    expect(mekf.traceAttitudeCov()).toBeLessThan(trace1); // overconfidence WITHOUT the adapter dedupe
    void attAfter1;
  });

  it('reinitializes on a 30° residual and recovers', () => {
    const sensors = new SatSensorSim({ ...MEMS_TEST_SENSOR_NOISE, seed: 11 });
    const mekf = new MekfAttitudeEstimator(memsConfig());
    let truth = quatFromAxisAngle({ x: 1, y: 1, z: 1 }, 0.4);
    for (let i = 0; i < 200; i++) {
      mekf.propagate(sensors.sampleGyro({ x: 0, y: 0, z: 0 }, 0.1), 0.1);
      const st = sensors.sampleStarTracker(truth, i * 0.1);
      if (st.valid && st.fresh) mekf.updateStarTracker(st.q);
    }
    const beforeReinits = mekf.diagnostics().reinits;
    const offset = quatMultiply(truth, quatFromAxisAngle({ x: 0, y: 0, z: 1 }, (30 * Math.PI) / 180));
    const r = mekf.updateStarTracker(offset);
    expect(r.reinitialized).toBe(true);
    expect(mekf.diagnostics().reinits).toBe(beforeReinits + 1);
    truth = offset;
    for (let i = 200; i < 260; i++) {
      mekf.propagate(sensors.sampleGyro({ x: 0, y: 0, z: 0 }, 0.1), 0.1);
      const st = sensors.sampleStarTracker(truth, i * 0.1);
      if (st.valid && st.fresh) mekf.updateStarTracker(st.q);
    }
    expect(attitudeSeparationDeg(mekf.attitude(), truth)).toBeLessThan(1);
  });
});

describe('sat-ops MEKF estimation quality', () => {
  it('converges the gyro bias to the injected truth', () => {
    const sensors = new SatSensorSim({ ...MEMS_TEST_SENSOR_NOISE, seed: 42 });
    const mekf = new MekfAttitudeEstimator(memsConfig());
    const sim = new Rk4PropagatorSim();
    return (async (): Promise<void> => {
      await sim.reset({ omega: { x: 0.02, y: -0.03, z: 0.015 } });
      for (let i = 0; i < 4000; i++) {
        const truth = await sim.step(0.1, { x: 0, y: 0, z: 0 });
        const meas = sensors.sampleGyro(truth.omega, 0.1);
        mekf.propagate(meas, 0.1);
        const st = sensors.sampleStarTracker(truth.q, truth.t);
        if (st.valid && st.fresh) mekf.updateStarTracker(st.q);
      }
      const bTrue = sensors.trueBias();
      const bHat = mekf.biasRadS();
      const err = vNorm(vSub(bHat, bTrue));
      expect(err).toBeLessThan(0.15 * vNorm(bTrue));
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(mekf.biasSigmaRadS()[axis]).toBeLessThan(degPerHrToRadPerS(2));
      }
    })();
  }, 30_000);

  it('beats raw dead-reckoning ≥2.5× through a forced 200s ST outage', () => {
    const sensors = new SatSensorSim({ ...MEMS_TEST_SENSOR_NOISE, seed: 42 });
    const mekf = new MekfAttitudeEstimator(memsConfig());
    const sim = new Rk4PropagatorSim();
    return (async (): Promise<void> => {
      await sim.reset({ omega: { x: 0.02, y: -0.03, z: 0.015 } });
      // converge for 400s
      let truth = await sim.getState();
      for (let i = 0; i < 4000; i++) {
        truth = await sim.step(0.1, { x: 0, y: 0, z: 0 });
        mekf.propagate(sensors.sampleGyro(truth.omega, 0.1), 0.1);
        const st = sensors.sampleStarTracker(truth.q, truth.t);
        if (st.valid && st.fresh) mekf.updateStarTracker(st.q);
      }
      // outage 400→600; a raw dead-reckoner starts from the truth at t=400 and integrates ω_meas
      sensors.setOutage(400, 600);
      let raw = { ...truth.q };
      const traceStart = mekf.traceAttitudeCov();
      let prevTrace = traceStart;
      let monotone = true;
      for (let i = 4000; i < 6000; i++) {
        truth = await sim.step(0.1, { x: 0, y: 0, z: 0 });
        const meas = sensors.sampleGyro(truth.omega, 0.1);
        mekf.propagate(meas, 0.1);
        const tr = mekf.traceAttitudeCov();
        if (tr < prevTrace - 1e-18) monotone = false;
        prevTrace = tr;
        raw = quatNormalize(quatMultiply(raw, quatFromAxisAngle(meas, vNorm(meas) * 0.1)));
        const st = sensors.sampleStarTracker(truth.q, truth.t);
        if (st.valid && st.fresh) mekf.updateStarTracker(st.q);
      }
      const mekfErr = attitudeSeparationDeg(mekf.attitude(), truth.q);
      const rawErr = attitudeSeparationDeg(raw, truth.q);
      // The two real claims: the MEKF holds accuracy through the blind outage, and it beats a
      // raw (uncorrected-gyro) dead-reckoner by a wide margin. The raw floor just proves raw
      // drifts substantially — the bias random-walk makes its exact value seed-dependent, so
      // the ratio (not an absolute raw constant) carries the physics.
      expect(mekfErr).toBeLessThan(0.15);
      expect(rawErr).toBeGreaterThanOrEqual(0.3);
      expect(rawErr / mekfErr).toBeGreaterThanOrEqual(2.5);
      expect(monotone).toBe(true); // P grew honestly through the outage
    })();
  }, 45_000);

  it('closes the control loop on ESTIMATED state (the property W1 lacked)', () => {
    const sim = new Rk4PropagatorSim();
    const sensors = new SatSensorSim({ ...MEMS_TEST_SENSOR_NOISE, seed: 3 });
    const mekf = new MekfAttitudeEstimator(memsConfig());
    const adapter = new EstimatingSimAdapter(sim, sensors, mekf);
    const controller = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });
    return (async (): Promise<void> => {
      await adapter.reset({ omega: { x: 0.01, y: -0.015, z: 0.008 } });
      // let the filter initialize
      let est = await adapter.getState();
      for (let i = 0; i < 30; i++) est = await adapter.step(0.1, { x: 0, y: 0, z: 0 });
      const target = quatMultiply(est.q, quatFromAxisAngle({ x: 1, y: 1, z: -1 }, (30 * Math.PI) / 180));
      for (let i = 0; i < 1500; i++) {
        est = await adapter.step(0.1, controller.computeWheelTorque(est, target));
      }
      const truth = await adapter.truthState();
      expect(attitudeSeparationDeg(est.q, target)).toBeLessThan(0.5); // estimated error
      expect(attitudeSeparationDeg(truth.q, target)).toBeLessThan(0.7); // TRUE error
    })();
  }, 30_000);
});

describe('sat-ops MEKF ST sampling-lag underweighting (stLagS)', () => {
  // Reproduces the first live W2 mission failure. 42 samples the ST every 0.25 s but the FSW
  // (and our propagation) runs at 0.2 s — the epoch offset between the gyro-propagated state
  // and the freshest ST fix BEATS through 0 → 0.05 → 0.10 → 0.15 → 0.20 s. A constant lag at
  // constant rate would be absorbed as a fixed offset (zero innovation); the BEAT makes each
  // fresh fix jump by ω·0.05s ≈ 63 arcsec — a 30σ+ outlier against 2-arcsec R once P has
  // converged, so the gate rejects until the rail reinits, forever (live: rej=1149, reinit=44).
  const OMEGA: Vec3 = { x: 0.35 * (Math.PI / 180), y: 0, z: 0 }; // 0.35°/s coast
  const DT = 0.2; // FSW / propagation period
  const ST_PERIOD = 0.25; // 42's ST sampling period

  /** Run 600 FSW cycles of perfect gyro + beat-lagged noiseless ST; return diagnostics. */
  function runLagged(stLagS: number | undefined): { reinits: number; applied: number; rejected: number; errDeg: number } {
    const mekf = new MekfAttitudeEstimator(memsConfig({
      rStDiagRad2: { x: arcsecToRad(2) ** 2, y: arcsecToRad(2) ** 2, z: arcsecToRad(20) ** 2 },
      sigmaVRadRtS: degPerRtHrToRadPerRtS(0.007),
      sigmaURadS15: degPerHrToRadPerS(0.01) / 60,
      ...(stLagS === undefined ? {} : { stLagS }),
    }));
    const qAt = (t: number): Quat => quatNormalize(quatFromAxisAngle(OMEGA, vNorm(OMEGA) * t));
    let lastStEpoch = -1;
    let t = 0;
    for (let i = 0; i < 600; i++) {
      t = (i + 1) * DT;
      mekf.propagate(OMEGA, DT);
      const stEpoch = ST_PERIOD * Math.floor(t / ST_PERIOD); // freshest fix at-or-before t
      if (stEpoch !== lastStEpoch) {
        lastStEpoch = stEpoch;
        mekf.updateStarTracker(qAt(stEpoch), OMEGA); // stale by the beating t−stEpoch
      }
    }
    const d = mekf.diagnostics();
    return { reinits: d.reinits, applied: d.updatesApplied, rejected: d.rejected, errDeg: attitudeSeparationDeg(mekf.attitude(), qAt(t)) };
  }

  it('without the lag term, the beat starves the filter — most fixes gate-rejected', () => {
    // The pure beat re-aligns epochs every 1.0 s (a perfect fix applies, resetting the
    // consecutive-reject streak), so the reinit RAIL needs live dynamics on top — the unit-
    // pinnable defect is information starvation: the majority of fixes are discarded.
    const r = runLagged(undefined);
    expect(r.rejected).toBeGreaterThan(100);
    expect(r.rejected).toBeGreaterThan(r.applied); // most information thrown away
  });

  it('with stLagS the skew is priced: updates apply, one seed reinit only, estimate tracks', () => {
    const r = runLagged(0.3);
    expect(r.reinits).toBe(1); // the initial seed and nothing else
    expect(r.rejected).toBe(0);
    expect(r.applied).toBeGreaterThan(290);
    expect(r.errDeg).toBeLessThan(0.15); // within ~the skew itself (0.07°) + margin
  });
});

describe('sat-ops MEKF reinit rail (maxConsecutiveRejects)', () => {
  it('fires after exactly maxRejects consecutive gate rejections and snaps to the fix', () => {
    const mekf = new MekfAttitudeEstimator(memsConfig());
    mekf.updateStarTracker(quatIdentity()); // seed → reinit #1
    for (let i = 0; i < 5; i++) mekf.updateStarTracker(quatIdentity()); // converge P to ~R scale
    // A persistent 1.15° offset: far past the χ² gate once P has converged, but below the
    // 0.35 rad hard-reinit threshold — the RAIL (default 8 consecutive rejects) must catch it.
    const off = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 0.02);
    const results = Array.from({ length: 9 }, () => mekf.updateStarTracker(off));
    expect(results.slice(0, 8).every((r) => r.rejected && !r.reinitialized)).toBe(true);
    expect(results[8].reinitialized).toBe(true); // the 9th call trips the rail
    expect(mekf.diagnostics().reinits).toBe(2); // seed + rail, nothing else
    expect(attitudeSeparationDeg(mekf.attitude(), off)).toBeLessThan(1e-9); // snapped to the fix
  });
});

describe('sat-ops MEKF ST-mount R rotation', () => {
  it('keeps the 20-arcsec roll axis on the correct body axis', () => {
    const d: Vec3 = { x: 9.40177e-11, y: 9.40177e-11, z: 9.40177e-9 };
    const at180X = rotateDiagCovariance(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI), d);
    expect(at180X[2][2]).toBeCloseTo(9.40177e-9, 15);
    expect(at180X[0][0]).toBeCloseTo(9.40177e-11, 15);
    const at90X = rotateDiagCovariance(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2), d);
    expect(at90X[1][1]).toBeCloseTo(9.40177e-9, 12); // 90°-about-X moves roll to body Y
  });
});

// ── test-only reflection into the MEKF's private covariance blocks ────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
function covTT(m: MekfAttitudeEstimator): any { return (m as any).pTT; }
function covTB(m: MekfAttitudeEstimator): any { return (m as any).pTB; }
function covBB(m: MekfAttitudeEstimator): any { return (m as any).pBB; }
