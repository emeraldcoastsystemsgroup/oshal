/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | 3×3 dense linear algebra for the MEKF (blockwise
 *                     |                             | covariance in 3×3 sub-blocks). Row-major number[3][3].
 *                     |                             | Pure functions, no allocation cleverness — the filter
 *                     |                             | hot path is 0.2s cadence, clarity beats microopt.
 */

import type { Quat, Vec3 } from '../model/sat-types';

/** A 3×3 matrix, row-major: `m[row][col]`. */
export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/** @description The 3×3 identity. @returns I₃. */
export function m3identity(): Mat3 {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

/** @description A diagonal matrix from a vector. @param d - Diagonal entries. @returns diag(d). */
export function m3diag(d: Vec3): Mat3 {
  return [[d.x, 0, 0], [0, d.y, 0], [0, 0, d.z]];
}

/** @description Scalar multiple s·A. @param a - Matrix. @param s - Scalar. @returns s·A. */
export function m3scale(a: Mat3, s: number): Mat3 {
  return a.map((row) => row.map((v) => v * s)) as Mat3;
}

/** @description Sum A+B. @param a - Left. @param b - Right. @returns A+B. */
export function m3add(a: Mat3, b: Mat3): Mat3 {
  return a.map((row, i) => row.map((v, j) => v + b[i][j])) as Mat3;
}

/** @description Difference A−B. @param a - Left. @param b - Right. @returns A−B. */
export function m3sub(a: Mat3, b: Mat3): Mat3 {
  return a.map((row, i) => row.map((v, j) => v - b[i][j])) as Mat3;
}

/** @description Transpose Aᵀ. @param a - Matrix. @returns Aᵀ. */
export function m3transpose(a: Mat3): Mat3 {
  return [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]];
}

/** @description Matrix product A·B. @param a - Left. @param b - Right. @returns A·B. */
export function m3mul(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

/** @description Matrix-vector product A·v. @param a - Matrix. @param v - Vector. @returns A·v. */
export function m3mulVec(a: Mat3, v: Vec3): Vec3 {
  return {
    x: a[0][0] * v.x + a[0][1] * v.y + a[0][2] * v.z,
    y: a[1][0] * v.x + a[1][1] * v.y + a[1][2] * v.z,
    z: a[2][0] * v.x + a[2][1] * v.y + a[2][2] * v.z,
  };
}

/** @description Force symmetry ½(A+Aᵀ) — kills accumulated round-off asymmetry in covariance blocks. @param a - Matrix. @returns The symmetrized matrix. */
export function m3symmetrize(a: Mat3): Mat3 {
  return [
    [a[0][0], (a[0][1] + a[1][0]) / 2, (a[0][2] + a[2][0]) / 2],
    [(a[0][1] + a[1][0]) / 2, a[1][1], (a[1][2] + a[2][1]) / 2],
    [(a[0][2] + a[2][0]) / 2, (a[1][2] + a[2][1]) / 2, a[2][2]],
  ];
}

/** @description Skew-symmetric cross-product matrix [v×] (so [v×]·u = v×u). @param v - Vector. @returns [v×]. */
export function m3skew(v: Vec3): Mat3 {
  return [[0, -v.z, v.y], [v.z, 0, -v.x], [-v.y, v.x, 0]];
}

/**
 * @description Inverse of a 3×3 matrix via cofactors. Throws on a singular (near-zero
 * determinant) matrix rather than returning NaNs.
 * @param m - Matrix.
 * @returns A⁻¹.
 */
export function m3inverse(m: Mat3): Mat3 {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) throw new Error('m3inverse: singular matrix');
  return m3scale([[A, B, C], [D, E, F], [G, H, I]], 1 / det);
}

/** @description Rotation matrix C(q) such that C·v = rotateByQuat(q, v) (body→inertial for an attitude quat). @param q - Unit quaternion. @returns The 3×3 rotation. */
export function m3fromQuat(q: Quat): Mat3 {
  const { w, x, y, z } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

/**
 * @description Rotate a diagonal covariance by a quaternion: C(q)·diag(d)·C(q)ᵀ. Used once at
 * MEKF construction to carry the star-tracker noise (specified in the ST frame) into body
 * axes through the ST mount — the 20-arcsec roll axis must land on the correct body axis.
 * @param q - The mount quaternion (ST→body).
 * @param d - The ST-frame variance diagonal (rad²).
 * @returns The body-frame 3×3 covariance.
 */
export function rotateDiagCovariance(q: Quat, d: Vec3): Mat3 {
  const c = m3fromQuat(q);
  return m3mul(m3mul(c, m3diag(d)), m3transpose(c));
}

/** @description Extract the diagonal as a vector. @param a - Matrix. @returns (A₀₀, A₁₁, A₂₂). */
export function m3diagOf(a: Mat3): Vec3 {
  return { x: a[0][0], y: a[1][1], z: a[2][2] };
}
