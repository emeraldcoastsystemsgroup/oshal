/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-102's forced-conjugate referee gate on
 *                     |                             | REAL NASA 42 data: a captured live run is replayed
 *                     |                             | through the shipped Nasa42SimAdapter twice — once in
 *                     |                             | 42's native wire encoding, once as the opposite-
 *                     |                             | convention twin with the lock FORCED onto that branch —
 *                     |                             | and the two must agree on every MEKF acceptance,
 *                     |                             | rejection, reinitialization and reported attitude. The
 *                     |                             | mirrored control proves the comparison is not vacuous.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  Nasa42SimAdapter,
  attitudeSeparationDeg,
  captureLayout,
  captureVehicle,
  captureVoterVerdict,
  conjugateCaptureWire,
  startNasa42ReplayServer,
  type Nasa42Capture,
  type Nasa42QuaternionConvention,
  type Quat,
  type Vec3,
} from '@/features/sat-ops';

const CAPTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'sat-ops-nasa42-capture-2026-09-21.json');

/** Everything one replayed branch produced — the referee comparison is over these. */
interface BranchRun {
  /** Cumulative `[updatesApplied, rejected, reinits]` after each cycle. */
  dispositions: Array<[number, number, number]>;
  /** The MEKF innovation magnitude reported on each cycle, radians. */
  residualsRad: number[];
  /** The attitude the adapter reported on each cycle. */
  attitudes: Quat[];
  /** The adapter's own account of how the convention was settled. */
  conventionState: ReturnType<Nasa42SimAdapter['conventionState']>;
  /** Final counters and the per-axis attitude 1-sigma the filter ended on. */
  final: { updatesApplied: number; rejected: number; reinits: number; sigmaRad: Vec3 };
}

function loadCapture(): Nasa42Capture {
  return JSON.parse(fs.readFileSync(CAPTURE_PATH, 'utf8')) as Nasa42Capture;
}

/** Replay one capture through the real adapter with the convention forced to `convention`. */
async function runBranch(capture: Nasa42Capture, convention: Nasa42QuaternionConvention): Promise<BranchRun> {
  const server = await startNasa42ReplayServer(capture);
  const { dtSeconds } = captureVehicle(capture);
  try {
    const sat = await Nasa42SimAdapter.connect({
      host: '127.0.0.1',
      port: server.port,
      id: `replay-${convention}`,
      forceConvention: convention,
    });
    const run: BranchRun = {
      dispositions: [],
      residualsRad: [],
      attitudes: [],
      conventionState: sat.conventionState(),
      final: { updatesApplied: 0, rejected: 0, reinits: 0, sigmaRad: { x: 0, y: 0, z: 0 } },
    };
    const record = (q: Quat): void => {
      const d = sat.estimatorDiagnostics();
      run.attitudes.push(q);
      run.dispositions.push(d ? [d.updatesApplied, d.rejected, d.reinits] : [0, 0, 0]);
      run.residualsRad.push(d ? d.lastResidualRad : 0);
    };
    record((await sat.getState()).q);
    for (let i = 1; i < capture.cycles.length; i++) {
      // Zero torque: the sensor stream is fixed, so this is an open-loop replay of 42's own
      // measurements. Only the decode + estimator path is under test.
      record((await sat.step(dtSeconds, { x: 0, y: 0, z: 0 })).q);
    }
    const last = sat.estimatorDiagnostics();
    run.conventionState = sat.conventionState();
    run.final = {
      updatesApplied: last?.updatesApplied ?? 0,
      rejected: last?.rejected ?? 0,
      reinits: last?.reinits ?? 0,
      sigmaRad: last?.attitudeSigmaRad ?? { x: Infinity, y: Infinity, z: Infinity },
    };
    sat.close();
    return run;
  } finally {
    await server.close();
  }
}

/** The largest branch-to-branch attitude disagreement over the replay, in degrees. */
function maxSeparationDeg(a: BranchRun, b: BranchRun): number {
  let worst = 0;
  for (let i = 0; i < a.attitudes.length; i++) {
    worst = Math.max(worst, attitudeSeparationDeg(a.attitudes[i], b.attitudes[i]));
  }
  return worst;
}

describe('sat-ops NASA 42 forced-conjugate referee (ADR-102)', () => {
  const capture = loadCapture();
  const vehicle = captureVehicle(capture);
  const verdict = captureVoterVerdict(capture);
  // The branch the live mission actually flew. It is NOT taken on trust: the mirrored-control
  // case below re-runs this same stream under the opposite lock and requires it to fall apart,
  // which is what makes this the native encoding rather than a label in a file.
  const nativeConvention = capture.flownConvention;
  const twinConvention: Nasa42QuaternionConvention = nativeConvention === 'conjugate' ? 'direct' : 'conjugate';
  const twin = conjugateCaptureWire(capture, vehicle.stMount, twinConvention);

  it('carries a real captured 42 run whose layouts are 42s own', () => {
    const { sizes, lens } = captureLayout(capture);
    expect(capture.wireConvention).toBe('native');
    expect(sizes.nst).toBeGreaterThanOrEqual(1);
    expect(sizes.ngyro).toBeGreaterThanOrEqual(3);
    expect(lens.inLen).toBeGreaterThan(0);
    expect(vehicle.dtSeconds).toBeGreaterThan(0);
    // A capture with too few star fixes cannot referee anything.
    const validCycles = capture.cycles.filter((c) => c.stValid[0] !== 0).length;
    expect(validCycles).toBeGreaterThan(200);
    // The ballots the residual voter cast on this stream were recorded at capture time and
    // must still be reproducible from the fixture by the shipped voter.
    expect(verdict.votes).toEqual(capture.voterVotes);
    expect(verdict.votes.conjugate + verdict.votes.direct).toBeGreaterThan(200);
  });

  it('runs both wire encodings to the same MEKF acceptance, rejection, reinit and attitude', async () => {
    const asFlown = await runBranch(capture, nativeConvention);
    const forcedTwin = await runBranch(twin, twinConvention);

    // The force-lock is what makes the twin branch reachable at all: without it the voter
    // would elect the twin stream's own encoding and this comparison could not be run.
    for (const [branch, convention] of [[asFlown, nativeConvention], [forcedTwin, twinConvention]] as const) {
      expect(branch.conventionState).toEqual({
        convention,
        locked: true,
        forced: true,
        votes: { conjugate: 0, direct: 0 },
      });
    }

    expect(forcedTwin.dispositions).toEqual(asFlown.dispositions);
    expect(forcedTwin.final.updatesApplied).toBe(asFlown.final.updatesApplied);
    expect(forcedTwin.final.rejected).toBe(asFlown.final.rejected);
    expect(forcedTwin.final.reinits).toBe(asFlown.final.reinits);
    expect(forcedTwin.final.updatesApplied).toBeGreaterThan(200);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(forcedTwin.final.sigmaRad[axis]).toBeCloseTo(asFlown.final.sigmaRad[axis], 12);
    }
    asFlown.residualsRad.forEach((residual, i) => {
      expect(forcedTwin.residualsRad[i]).toBeCloseTo(residual, 12);
    });
    // Attitude error between the branches, over every cycle of the captured run. The two
    // encodings take different floating-point routes to the same physical attitude; measured
    // on this capture the worst disagreement is 2.96e-6 deg (0.0106 arcsec), which is 1-2 ulp
    // of the dot product inside attitudeSeparationDeg - 2*acos cannot resolve finer. The bound
    // keeps headroom over that floor while staying far under the tracker's own 2/2/20-arcsec
    // noise, and eight orders of magnitude under the mirrored control below.
    expect(maxSeparationDeg(asFlown, forcedTwin)).toBeLessThan(1e-4);
  }, 120_000);

  it('diverges grossly when the same stream is forced onto the mirrored branch', async () => {
    const asFlown = await runBranch(capture, nativeConvention);
    const mirrored = await runBranch(capture, twinConvention);
    // A mirrored interpretation of REAL 42 fixes is the night-1 failure the voter exists to
    // prevent; if this control ever matched, the comparison above would prove nothing.
    expect(maxSeparationDeg(asFlown, mirrored)).toBeGreaterThan(1);
    expect(mirrored.final.reinits + mirrored.final.rejected)
      .toBeGreaterThan(asFlown.final.reinits + asFlown.final.rejected);
    // Measured on this capture: 1313 rejections and 62 reinitializations against 9 and 2.
    expect(mirrored.final.rejected).toBeGreaterThan(100);
    expect(mirrored.final.reinits).toBeGreaterThan(10);
  }, 120_000);
});
