/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Sat-Ops (ADR-102) forced-conjugate referee
 *                     |                             | gate: fly the live NASA 42 container exactly as the
 *                     |                             | smoke does, with the quaternion convention FORCED, and
 *                     |                             | record 42's own handshake frames plus every cycle's
 *                     |                             | star-tracker and gyro fields as a replayable capture.
 *                     |                             | Also reports what the residual voter would have elected
 *                     |                             | on the same stream, so the capture states which branch
 *                     |                             | is 42's native encoding and which is the twin.
 */

import fs from 'fs';
import path from 'path';
import {
  Nasa42SimAdapter,
  QuaternionPdController,
  attitudeSeparationDeg,
  captureVoterVerdict,
  quatFromAxisAngle,
  quatMultiply,
  vNorm,
  type Nasa42Capture,
  type Nasa42CaptureCycle,
  type Nasa42CaptureStream,
  type Nasa42QuaternionConvention,
} from '@/features/sat-ops';

const HOST = process.env.SAT42_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SAT42_PORT ?? 10001);
/** Cap on recorded cycles — 1500 cycles is 300 sim-s at 42's 0.2 s FSW step. */
const CAPTURE_CYCLES = Number(process.env.SAT42_CAPTURE_CYCLES ?? 1500);
/** Give the star tracker this long (sim-s) to clear its exclusion cones before giving up. */
const ACQUIRE_MAX_S = Number(process.env.SAT42_ACQUIRE_MAX_S ?? 6000);
const FORCE_CONVENTION = (process.env.SAT42_FORCE_CONVENTION ?? 'conjugate') as Nasa42QuaternionConvention;
const OUT_PATH = process.env.SAT42_CAPTURE_OUT
  ?? path.join(process.cwd(), 'tests', 'fixtures', 'sat-ops-nasa42-capture.json');
const FORTYTWO_REF = process.env.SAT42_FORTYTWO_REF ?? '18106c544b4318e79d393643604356dfa6e7ad78';

const SEARCH_RATE = { x: 0.0061, y: 0, z: 0 };
const RATE_TC_S = 50;
const SLEW_DEG = 30;

/** Snapshot the sensor fields the attitude estimate consumes from the adapter's last record. */
function cycleOf(sat: Nasa42SimAdapter): Nasa42CaptureCycle {
  const rec = sat.lastSensorRecord();
  return { stValid: [...rec.stValid], stQn: [...rec.stQn], gyroRate: [...rec.gyroRate] };
}

/** Rate-only search torque: frame-independent, so it works before any star fix exists. */
function searchTorque(sat: Nasa42SimAdapter, omega: { x: number; y: number; z: number }): {
  x: number; y: number; z: number;
} {
  const moi = sat.vehicle.moiDiag;
  return {
    x: (moi.x / RATE_TC_S) * (omega.x - SEARCH_RATE.x),
    y: (moi.y / RATE_TC_S) * (omega.y - SEARCH_RATE.y),
    z: (moi.z / RATE_TC_S) * (omega.z - SEARCH_RATE.z),
  };
}

/**
 * @description Capture one live NASA 42 run to a replayable fixture.
 * @returns Resolves once the capture is written.
 */
async function main(): Promise<void> {
  console.log(`sat-ops 42 capture: connecting to ${HOST}:${PORT} with convention FORCED to ${FORCE_CONVENTION}`);
  const sat = await Nasa42SimAdapter.connect({ host: HOST, port: PORT, forceConvention: FORCE_CONVENTION });
  try {
    const v = sat.vehicle;
    console.log(`vehicle: ${sat.describe()}`);
    console.log(`convention state at connect: ${JSON.stringify(sat.conventionState())}`);

    let state = await sat.getState();
    while (!sat.starTrackerValid() && state.t < ACQUIRE_MAX_S) {
      state = await sat.step(v.dtSeconds, searchTorque(sat, state.omega));
    }
    if (!sat.starTrackerValid()) {
      console.log(`FAIL — no star fix within ${ACQUIRE_MAX_S} sim-s of search rotation; nothing to capture`);
      process.exitCode = 1;
      return;
    }
    console.log(`first star fix at t=${state.t.toFixed(1)}s — recording ${CAPTURE_CYCLES} cycles from here`);

    const target = quatMultiply(state.q, quatFromAxisAngle({ x: 1, y: 1, z: 0 }, (SLEW_DEG * Math.PI) / 180));
    const controller = new QuaternionPdController({ inertia: v.moiDiag, naturalFreqRadS: 0.05, dampingRatio: 1.0 });
    const cycles: Nasa42CaptureCycle[] = [cycleOf(sat)];
    let validCycles = cycles[0].stValid[0] === 0 ? 0 : 1;
    for (let i = 1; i < CAPTURE_CYCLES; i++) {
      state = await sat.step(v.dtSeconds, controller.computeWheelTorque(state, target));
      const cycle = cycleOf(sat);
      cycles.push(cycle);
      if (cycle.stValid[0] !== 0) validCycles++;
    }

    const diagnostics = sat.estimatorDiagnostics();
    console.log(`live forced-${FORCE_CONVENTION} run: ${JSON.stringify(diagnostics)}`);
    console.log(`  final attitude error vs commanded target: ${attitudeSeparationDeg(state.q, target).toFixed(4)}°`);
    console.log(`  final |omega| ${((vNorm(state.omega) * 180) / Math.PI).toFixed(5)}°/s`);
    console.log(`  valid star-tracker cycles: ${validCycles}/${cycles.length}`);
    console.log(`  convention state at end: ${JSON.stringify(sat.conventionState())}`);

    const stream: Nasa42CaptureStream = {
      source: `oshal-sat42:latest at ${HOST}:${PORT}`,
      capturedAt: new Date().toISOString(),
      fortyTwoRef: FORTYTWO_REF,
      wireConvention: 'native',
      sizesBase64: sat.handshakeFrames.sizesBytes.toString('base64'),
      lensBase64: sat.handshakeFrames.lensBytes.toString('base64'),
      tblBase64: sat.handshakeFrames.tblBytes.toString('base64'),
      cycles,
    };
    const verdict = captureVoterVerdict(stream);
    console.log(`  residual voter on the same stream elects: ${verdict.convention} ${JSON.stringify(verdict.votes)}`);
    const capture: Nasa42Capture = { ...stream, flownConvention: FORCE_CONVENTION, voterVotes: verdict.votes };
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(capture)}\n`, 'utf8');
    console.log(`wrote ${cycles.length} cycles (${fs.statSync(OUT_PATH).size} bytes) to ${OUT_PATH}`);
  } finally {
    sat.close();
  }
}

main().catch((err) => {
  console.error('capture FAILED with error:', err);
  process.exitCode = 1;
});
