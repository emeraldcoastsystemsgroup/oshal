/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1 round 2: live closed-loop smoke — our
 *                     |                             | quaternion-PD controller flying NASA 42's CfsSat over
 *                     |                             | the standalone-AC socket. Gains derive from the MOI 42
 *                     |                             | reports in its table message; PASS = a 30° slew settles
 *                     |                             | under 1° and 0.05°/s on SENSED state within 900 sim-s.
 *                     |                             | Run: docker run --rm -p 10001:10001 oshal-sat42:latest
 *                     |                             | then ts-node -r tsconfig-paths/register this file.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Live finding: the stock LEO geometry keeps
 *                     |                             | the ST occluded until ~843 s, so slewing at t=0 chases
 *                     |                             | a dead-reckoned frame. Added Phase 0 attitude
 *                     |                             | acquisition — coast until the first valid star fix,
 *                     |                             | THEN define the target and slew (mission-honest order).
 */

import {
  Nasa42SimAdapter,
  QuaternionPdController,
  attitudeSeparationDeg,
  quatFromAxisAngle,
  quatMultiply,
  vNorm,
} from '@/features/sat-ops';

const HOST = process.env.SAT42_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SAT42_PORT ?? 10001);
const SIM_SECONDS = Number(process.env.SAT42_SMOKE_SECONDS ?? 900);
const SLEW_DEG = 30;
const PASS_ERR_DEG = 1.0;
const PASS_RATE_RAD_S = 8.7e-4; // 0.05 °/s

/**
 * @description Run the closed-loop smoke and report PASS/FAIL on stdout (exit code follows).
 * @returns Resolves when the verdict is printed.
 */
async function main(): Promise<void> {
  console.log(`sat-ops 42 smoke: connecting to ${HOST}:${PORT} ...`);
  const sat = await Nasa42SimAdapter.connect({ host: HOST, port: PORT });
  try {
    const v = sat.vehicle;
    console.log(`vehicle: ${sat.describe()}`);
    console.log(`  mass ${v.massKg.toFixed(1)} kg | MOI diag [${v.moiDiag.x.toFixed(2)}, ${v.moiDiag.y.toFixed(2)}, ${v.moiDiag.z.toFixed(2)}] kg·m²`);
    console.log(`  wheels Tmax [${v.wheelMaxTorqueNm.map((t) => t.toFixed(2)).join(', ')}] N·m | gyro axes ${v.gyroAxes.length} | FSW dt ${v.dtSeconds}s`);

    const controller = new QuaternionPdController({ inertia: v.moiDiag, naturalFreqRadS: 0.05, dampingRatio: 1.0 });

    // Phase 0 — attitude acquisition rotisserie: a gyro-only RATE command (needs no
    // attitude knowledge, so it is frame-independent) sweeps the star-tracker boresight
    // until it clears the Sun/Earth exclusion cones and delivers the first valid fix.
    // Pure coasting was live-proven insufficient (torque-free body ≈ inertially fixed →
    // boresight can sit inside the Earth cone indefinitely); slewing before a fix chases a
    // dead-reckoned frame (night-1 run: perfect-looking convergence, 132° truth snap later).
    const ACQUIRE_MAX_S = 6000;
    const SEARCH_RATE: { x: number; y: number; z: number } = { x: 0.0061, y: 0, z: 0 }; // ~0.35°/s about body X
    const RATE_TC_S = 50; // rate-loop time constant
    let state = await sat.getState();
    let acquireCycles = 0;
    while (!sat.attitudeCalibrated() && state.t < ACQUIRE_MAX_S) {
      const wheelTorque = {
        x: (v.moiDiag.x / RATE_TC_S) * (state.omega.x - SEARCH_RATE.x),
        y: (v.moiDiag.y / RATE_TC_S) * (state.omega.y - SEARCH_RATE.y),
        z: (v.moiDiag.z / RATE_TC_S) * (state.omega.z - SEARCH_RATE.z),
      };
      state = await sat.step(v.dtSeconds, wheelTorque);
      acquireCycles++;
    }
    if (!sat.attitudeCalibrated()) {
      console.log(`FAIL — no calibrated star-fixed attitude within ${ACQUIRE_MAX_S} sim-s of search rotation; cannot define a truthful target`);
      process.exitCode = 1;
      return;
    }
    console.log(`attitude calibrated (star-fixed, convention locked) at t=${state.t.toFixed(1)}s (${acquireCycles} search cycles)`);

    const target = quatMultiply(state.q, quatFromAxisAngle({ x: 1, y: 1, z: 0 }, (SLEW_DEG * Math.PI) / 180));
    console.log(`commanding a ${SLEW_DEG}° slew; initial error ${attitudeSeparationDeg(state.q, target).toFixed(3)}°`);

    const cycles = Math.ceil(SIM_SECONDS / v.dtSeconds);
    const logEvery = Math.max(1, Math.round(25 / v.dtSeconds));
    const t0 = Date.now();
    for (let i = 0; i < cycles; i++) {
      state = await sat.step(v.dtSeconds, controller.computeWheelTorque(state, target));
      if (i % logEvery === 0) {
        const err = attitudeSeparationDeg(state.q, target);
        const rate = (vNorm(state.omega) * 180) / Math.PI;
        console.log(`  t=${state.t.toFixed(1).padStart(7)}s  err=${err.toFixed(4).padStart(9)}°  |ω|=${rate.toFixed(5)}°/s  |Hw|=${vNorm(state.wheelMomentum).toFixed(3)} N·m·s`);
      }
    }

    const errDeg = attitudeSeparationDeg(state.q, target);
    const rateRadS = vNorm(state.omega);
    const wallS = ((Date.now() - t0) / 1000).toFixed(1);
    const pass = errDeg < PASS_ERR_DEG && rateRadS < PASS_RATE_RAD_S;
    console.log(`final after ${SIM_SECONDS} sim-s (${wallS} wall-s): err=${errDeg.toFixed(4)}° |ω|=${((rateRadS * 180) / Math.PI).toFixed(5)}°/s`);
    console.log(pass
      ? `PASS — our PD controller settled NASA 42's CfsSat to ${errDeg.toFixed(3)}° on sensed state`
      : `FAIL — err ${errDeg.toFixed(3)}° (need <${PASS_ERR_DEG}°) rate ${((rateRadS * 180) / Math.PI).toFixed(4)}°/s (need <0.05°/s)`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    sat.close();
  }
}

main().catch((err) => {
  console.error('smoke FAILED with error:', err);
  process.exitCode = 1;
});
