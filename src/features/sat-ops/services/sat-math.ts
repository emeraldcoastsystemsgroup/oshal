/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1: quaternion + vector primitives for attitude
 *                     |                             | dynamics. Pure functions, no allocation tricks, no
 *                     |                             | logging — this is the RK4 hot path.
 */

import type { Quat, Vec3 } from '../model/sat-types';

/**
 * @description Construct a Vec3.
 * @param x - X component. @param y - Y component. @param z - Z component.
 * @returns The vector.
 */
export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/**
 * @description Component-wise sum a + b.
 * @param a - Left vector. @param b - Right vector.
 * @returns a + b.
 */
export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * @description Component-wise difference a − b.
 * @param a - Left vector. @param b - Right vector.
 * @returns a − b.
 */
export function vSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * @description Scalar multiple s·a.
 * @param a - Vector. @param s - Scalar.
 * @returns s·a.
 */
export function vScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/**
 * @description Cross product a × b (right-handed).
 * @param a - Left vector. @param b - Right vector.
 * @returns a × b.
 */
export function vCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * @description Euclidean norm |a|.
 * @param a - Vector.
 * @returns The magnitude.
 */
export function vNorm(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** @description The identity quaternion (no rotation). @returns Identity quat. */
export function quatIdentity(): Quat {
  return { w: 1, x: 0, y: 0, z: 0 };
}

/**
 * @description Hamilton product a ⊗ b (apply b's rotation, then a's).
 * @param a - Left quaternion. @param b - Right quaternion.
 * @returns a ⊗ b.
 */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/**
 * @description Conjugate (inverse for unit quaternions).
 * @param q - Quaternion.
 * @returns q*.
 */
export function quatConjugate(q: Quat): Quat {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

/**
 * @description Renormalize to unit length. RK4 integration drifts the norm by O(dt⁵) per
 * step; every propagator step renormalizes so downstream trig on `w` stays valid.
 * @param q - Quaternion (any norm > 0).
 * @returns Unit quaternion in the same direction.
 */
export function quatNormalize(q: Quat): Quat {
  const n = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

/**
 * @description Build the rotation of `angleRad` about `axis` (need not be unit length).
 * @param axis - Rotation axis. @param angleRad - Angle, radians.
 * @returns The unit quaternion.
 */
export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const n = vNorm(axis);
  const s = Math.sin(angleRad / 2) / (n || 1);
  return quatNormalize({ w: Math.cos(angleRad / 2), x: axis.x * s, y: axis.y * s, z: axis.z * s });
}

/**
 * @description Rotate vector `v` by quaternion `q` (q ⊗ [0,v] ⊗ q*). With q = the attitude
 * quaternion (body→inertial), this maps a body vector into inertial coordinates; use the
 * conjugate for inertial→body.
 * @param q - Unit quaternion. @param v - Vector to rotate.
 * @returns The rotated vector.
 */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const p: Quat = { w: 0, x: v.x, y: v.y, z: v.z };
  const r = quatMultiply(quatMultiply(q, p), quatConjugate(q));
  return { x: r.x, y: r.y, z: r.z };
}

/**
 * @description Quaternion kinematics q̇ = ½ q ⊗ [0, ω] for body-rate ω with q mapping
 * body→inertial (rate expressed in the body frame — the standard gyro-integration form).
 * @param q - Current attitude. @param omega - Body angular rate, rad/s.
 * @returns dq/dt (NOT unit norm; integrate then renormalize).
 */
export function quatDerivative(q: Quat, omega: Vec3): Quat {
  const r = quatMultiply(q, { w: 0, x: omega.x, y: omega.y, z: omega.z });
  return { w: 0.5 * r.w, x: 0.5 * r.x, y: 0.5 * r.y, z: 0.5 * r.z };
}

/**
 * @description Angular separation between two attitudes in degrees — the pointing-error
 * metric used by tests and (in W4) the evidence scorer: 2·acos(|(a* ⊗ b).w|).
 * @param a - First attitude. @param b - Second attitude.
 * @returns Separation, degrees, in [0, 180].
 */
export function attitudeSeparationDeg(a: Quat, b: Quat): number {
  const d = quatMultiply(quatConjugate(a), b);
  const w = Math.min(1, Math.abs(d.w));
  return (2 * Math.acos(w) * 180) / Math.PI;
}
