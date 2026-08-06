/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove NASA 42 direct/conjugate star-tracker
 *                     |                             | streams preserve the same body-axis 2/2/20-arcsec
 *                     |                             | covariance and produce identical MEKF acceptance.
 */

import { describe, expect, it } from 'vitest';
import {
  MekfAttitudeEstimator,
  NASA42_MEKF_CONFIG,
  arcsecToRad,
  mapNasa42BodyAttitude,
  nasa42StarTrackerBodyBase,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  rotateDiagCovariance,
  type MekfConfig,
  type MekfUpdateResult,
  type Nasa42QuaternionConvention,
  type Quat,
  type Vec3,
} from '@/features/sat-ops';

const ST_SIGMA_ARCSEC: Vec3 = { x: 2, y: 2, z: 20 };
const ST_VARIANCE_RAD2: Vec3 = {
  x: arcsecToRad(ST_SIGMA_ARCSEC.x) ** 2,
  y: arcsecToRad(ST_SIGMA_ARCSEC.y) ** 2,
  z: arcsecToRad(ST_SIGMA_ARCSEC.z) ** 2,
};

// A non-axis-aligned mount and truth attitude make conjugation/mount-order mistakes visible.
const ST_MOUNT = quatNormalize(quatMultiply(
  quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2),
  quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 5),
));
const TRUTH = quatNormalize(quatMultiply(
  quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.71),
  quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -0.38),
));

function scalarLast(q: Quat): number[] {
  return [q.x, q.y, q.z, q.w];
}

/** Encode one physical body-to-inertial fix exactly as either NASA 42 convention. */
function encode42Fix(qBodyToInertial: Quat, convention: Nasa42QuaternionConvention): number[] {
  const nativeBody = convention === 'conjugate' ? quatConjugate(qBodyToInertial) : qBodyToInertial;
  return scalarLast(quatNormalize(quatMultiply(nativeBody, ST_MOUNT)));
}

/** Run the production compose-out + convention boundary over a synthetic 42 wire fix. */
function decode42Fix(stQn: number[], convention: Nasa42QuaternionConvention): Quat {
  return mapNasa42BodyAttitude(nasa42StarTrackerBodyBase(stQn, ST_MOUNT), convention);
}

function config(): MekfConfig {
  return {
    ...NASA42_MEKF_CONFIG,
    stMount: ST_MOUNT,
    // Keep deterministic replay innovations well within the normal gate. The covariance
    // under test remains the actual NASA 42 2/2/20-arcsec ellipsoid.
    sigmaVRadRtS: 0,
    sigmaURadS15: 0,
  };
}

describe('sat-ops NASA 42 direct/conjugate covariance replay', () => {
  it('places the 2/2/20-arcsec ellipsoid on identical body axes in both conventions', () => {
    const axes: Vec3[] = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    ];
    const sigmas = [ST_SIGMA_ARCSEC.x, ST_SIGMA_ARCSEC.y, ST_SIGMA_ARCSEC.z];
    const innovations = { direct: [] as Vec3[], conjugate: [] as Vec3[] };

    for (const convention of ['direct', 'conjugate'] as const) {
      axes.forEach((axis, i) => {
        const trackerError = quatFromAxisAngle(axis, arcsecToRad(sigmas[i]));
        const bodyError = quatMultiply(quatMultiply(ST_MOUNT, trackerError), quatConjugate(ST_MOUNT));
        const noisyPhysicalFix = quatNormalize(quatMultiply(TRUTH, bodyError));
        const decoded = decode42Fix(encode42Fix(noisyPhysicalFix, convention), convention);
        const dq = quatNormalize(quatMultiply(quatConjugate(TRUTH), decoded));
        innovations[convention].push({ x: 2 * dq.x, y: 2 * dq.y, z: 2 * dq.z });
      });
    }

    for (let sample = 0; sample < innovations.direct.length; sample++) {
      for (const component of ['x', 'y', 'z'] as const) {
        expect(innovations.conjugate[sample][component]).toBeCloseTo(innovations.direct[sample][component], 14);
      }
    }

    // Reconstruct the covariance from the three one-sigma body innovations. This directly
    // checks which body axes receive the tracker-frame roll variance, including off-diagonals.
    const component = (v: Vec3, axis: number): number => axis === 0 ? v.x : axis === 1 ? v.y : v.z;
    const empirical = [0, 1, 2].map((row) => [0, 1, 2].map((col) => innovations.direct.reduce(
      (sum, innovation) => sum + component(innovation, row) * component(innovation, col),
      0,
    ))) as [[number, number, number], [number, number, number], [number, number, number]];
    const expected = rotateDiagCovariance(ST_MOUNT, ST_VARIANCE_RAD2);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) expect(empirical[row][col]).toBeCloseTo(expected[row][col], 16);
    }
  });

  it('has identical gate decisions and acceptance counters over a forced-conjugate replay', () => {
    const filters = {
      direct: new MekfAttitudeEstimator(config()),
      conjugate: new MekfAttitudeEstimator(config()),
    };
    const outcomes = { direct: [] as MekfUpdateResult[], conjugate: [] as MekfUpdateResult[] };

    for (const convention of ['direct', 'conjugate'] as const) {
      const filter = filters[convention];
      filter.updateStarTracker(decode42Fix(encode42Fix(TRUTH, convention), convention));
      for (let sample = 0; sample < 240; sample++) {
        const axis = sample % 3;
        const unit: Vec3 = axis === 0
          ? { x: 1, y: 0, z: 0 }
          : axis === 1 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
        const sigma = axis === 2 ? ST_SIGMA_ARCSEC.z : ST_SIGMA_ARCSEC.x;
        const signedSigma = sigma * Math.sin(sample * 0.73);
        const trackerError = quatFromAxisAngle(unit, arcsecToRad(signedSigma));
        const bodyError = quatMultiply(quatMultiply(ST_MOUNT, trackerError), quatConjugate(ST_MOUNT));
        const physicalFix = quatNormalize(quatMultiply(TRUTH, bodyError));
        outcomes[convention].push(filter.updateStarTracker(decode42Fix(encode42Fix(physicalFix, convention), convention)));
      }
    }

    const dispositions = (entries: MekfUpdateResult[]) => entries.map(({ applied, rejected, reinitialized }) => ({
      applied,
      rejected,
      reinitialized,
    }));
    expect(dispositions(outcomes.conjugate)).toEqual(dispositions(outcomes.direct));
    outcomes.direct.forEach((outcome, i) => {
      expect(outcomes.conjugate[i].residualRad).toBeCloseTo(outcome.residualRad, 12);
    });

    const direct = filters.direct.diagnostics();
    const conjugate = filters.conjugate.diagnostics();
    expect({ ...conjugate, lastResidualRad: 0 }).toEqual({ ...direct, lastResidualRad: 0 });
    expect(conjugate.lastResidualRad).toBeCloseTo(direct.lastResidualRad, 12);
    expect(conjugate.updatesApplied).toBeGreaterThan(200);
  });
});
