/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1 round 2: pure codec for NASA 42's standalone-AC
 *                     |                             | IPC (CFS_FSW + _AC_STANDALONE_). Field-major binary
 *                     |                             | layouts transcribed from 42's generated ScIPC.c at
 *                     |                             | commit 18106c54; every message ends in one NUL pad and
 *                     |                             | is Ack'd with the 4-byte "Ack\0". Layout lengths are
 *                     |                             | VERIFIED at runtime against 42's own BufLens message,
 *                     |                             | so a layout drift fails loudly instead of mis-parsing.
 */

import type { Quat, Vec3 } from '../model/sat-types';
import { attitudeSeparationDeg, quatConjugate, quatFromAxisAngle, quatMultiply, vNorm } from './sat-math';

/** The 4-byte acknowledgment ("Ack\0") every peer sends after each successful read. */
export const ACK = Buffer.from([0x41, 0x63, 0x6b, 0x00]);

/** Array sizes 42 sends first — 12 little-endian int64s, in exactly this order. */
export interface AcArraySizes {
  nb: number;
  ng: number;
  nwhl: number;
  nmtb: number;
  nthr: number;
  ngyro: number;
  nmag: number;
  ncss: number;
  nfss: number;
  nst: number;
  ngps: number;
  nacc: number;
}

/** The three message lengths 42 sends second (bytes, including the 1-byte NUL pad). */
export interface AcBufLens {
  inLen: number;
  outLen: number;
  tblLen: number;
}

/**
 * @description One field of a 42 IPC message. 42 serializes FIELD-major: each field is its
 * own `for(k)` loop over the owning array (all wheel Tcmds, THEN all MTB Mcmds — never
 * interleaved per device). `per: null` means the field appears exactly once.
 */
export interface LayoutField {
  key: string;
  kind: 'long' | 'double';
  per: keyof AcArraySizes | null;
  elems: number;
}

const F = (key: string, kind: 'long' | 'double', per: keyof AcArraySizes | null, elems: number): LayoutField => ({ key, kind, per, elems });

/** The In message (42 → controller): sensor readings, transcribed from WriteAcInToSocket. */
export const IN_LAYOUT: LayoutField[] = [
  F('gAng', 'double', 'ng', 3), F('gCmdQrl', 'double', 'ng', 4), F('gCmdQrn', 'double', 'ng', 4),
  F('gyroRate', 'double', 'ngyro', 1),
  F('magField', 'double', 'nmag', 1),
  F('cssValid', 'long', 'ncss', 1), F('cssIllum', 'double', 'ncss', 1),
  F('fssValid', 'long', 'nfss', 1), F('fssSunAng', 'double', 'nfss', 2),
  F('stValid', 'long', 'nst', 1), F('stQn', 'double', 'nst', 4),
  F('gpsValid', 'long', 'ngps', 1), F('gpsRollover', 'long', 'ngps', 1), F('gpsWeek', 'long', 'ngps', 1),
  F('gpsSec', 'double', 'ngps', 1), F('gpsPosN', 'double', 'ngps', 3), F('gpsVelN', 'double', 'ngps', 3),
  F('gpsPosW', 'double', 'ngps', 3), F('gpsVelW', 'double', 'ngps', 3),
  F('gpsLng', 'double', 'ngps', 1), F('gpsLat', 'double', 'ngps', 1), F('gpsAlt', 'double', 'ngps', 1),
  F('gpsWgsLng', 'double', 'ngps', 1), F('gpsWgsLat', 'double', 'ngps', 1), F('gpsWgsAlt', 'double', 'ngps', 1),
  F('accelAcc', 'double', 'nacc', 1),
  F('whlH', 'double', 'nwhl', 1),
  F('cmdQrl', 'double', null, 4), F('cmdQrn', 'double', null, 4),
];

/** The Out message (controller → 42): actuator commands, transcribed from ReadAcOutFromSocket. */
export const OUT_LAYOUT: LayoutField[] = [
  F('svb', 'double', null, 3), F('bvb', 'double', null, 3), F('hvb', 'double', null, 3),
  F('gCmdQrl', 'double', 'ng', 4), F('gCmdQrn', 'double', 'ng', 4),
  F('gCmdAngRate', 'double', 'ng', 3), F('gCmdAng', 'double', 'ng', 3),
  F('gCmdPosRate', 'double', 'ng', 3), F('gCmdPos', 'double', 'ng', 3),
  F('whlTcmd', 'double', 'nwhl', 1),
  F('mtbMcmd', 'double', 'nmtb', 1),
  F('thrPulseWidthCmd', 'double', 'nthr', 1), F('thrThrustLevelCmd', 'double', 'nthr', 1),
  F('cmdQrl', 'double', null, 4), F('cmdQrn', 'double', null, 4),
  F('cmdAngRate', 'double', null, 3), F('cmdAng', 'double', null, 3),
  F('cmdPosRate', 'double', null, 3), F('cmdPos', 'double', null, 3),
];

/** The one-time Tbl message (mass properties + mounts + limits), from WriteAcTblToSocket. */
export const TBL_LAYOUT: LayoutField[] = [
  F('id', 'long', null, 1),
  F('nb', 'long', null, 1), F('ng', 'long', null, 1), F('nwhl', 'long', null, 1), F('nmtb', 'long', null, 1),
  F('nthr', 'long', null, 1), F('ngyro', 'long', null, 1), F('nmag', 'long', null, 1), F('ncss', 'long', null, 1),
  F('nfss', 'long', null, 1), F('nst', 'long', null, 1), F('ngps', 'long', null, 1), F('nacc', 'long', null, 1),
  F('pi', 'double', null, 1), F('twoPi', 'double', null, 1), F('dt', 'double', null, 1),
  F('mass', 'double', null, 1), F('cm', 'double', null, 3), F('moi', 'double', null, 9),
  F('bMass', 'double', 'nb', 1), F('bCm', 'double', 'nb', 3), F('bMoi', 'double', 'nb', 9),
  F('gIsSpherical', 'long', 'ng', 1), F('gRotDof', 'long', 'ng', 1), F('gTrnDof', 'long', 'ng', 1),
  F('gRotSeq', 'long', 'ng', 1), F('gTrnSeq', 'long', 'ng', 1),
  F('gCGiBi', 'double', 'ng', 9), F('gCBoGo', 'double', 'ng', 9),
  F('gAngGain', 'double', 'ng', 3), F('gAngRateGain', 'double', 'ng', 3),
  F('gPosGain', 'double', 'ng', 3), F('gPosRateGain', 'double', 'ng', 3),
  F('gMaxAngRate', 'double', 'ng', 3), F('gMaxPosRate', 'double', 'ng', 3),
  F('gMaxTrq', 'double', 'ng', 3), F('gMaxFrc', 'double', 'ng', 3),
  F('gyroAxis', 'double', 'ngyro', 3),
  F('magAxis', 'double', 'nmag', 3),
  F('cssBody', 'long', 'ncss', 1), F('cssAxis', 'double', 'ncss', 3), F('cssScale', 'double', 'ncss', 1),
  F('fssQb', 'double', 'nfss', 4), F('fssCB', 'double', 'nfss', 9),
  F('stQb', 'double', 'nst', 4), F('stCB', 'double', 'nst', 9),
  F('accelPosB', 'double', 'nacc', 3), F('accelAxis', 'double', 'nacc', 3),
  F('whlBody', 'long', 'nwhl', 1), F('whlAxis', 'double', 'nwhl', 3), F('whlDistVec', 'double', 'nwhl', 3),
  F('whlJ', 'double', 'nwhl', 1), F('whlTmax', 'double', 'nwhl', 1), F('whlHmax', 'double', 'nwhl', 1),
  F('mtbAxis', 'double', 'nmtb', 3), F('mtbDistVec', 'double', 'nmtb', 3), F('mtbMmax', 'double', 'nmtb', 1),
  F('thrBody', 'long', 'nthr', 1), F('thrPosB', 'double', 'nthr', 3), F('thrAxis', 'double', 'nthr', 3),
  F('thrRxA', 'double', 'nthr', 3), F('thrFmax', 'double', 'nthr', 1),
  // Built-in controller gain tables (unused by our controller — parsed only so the byte
  // walk stays exact): Instant{wc,amax,vmax,Kprec,Knute}, Sandbox{Kr3,Kp3},
  // Spinner{Ispin,Itrans,SpinRate,Knute,Kprec}, ThreeAxis{Kr3,Kp3,Kunl}, Iss{Kr3,Kp3,Tmax},
  // Cmg{Kr3,Kp3}, Thr{Kw3,Kth3,Kv,Kp}, Cfs{Kr3,Kp3,Kunl}, ThrSteer{Kr3,Kp3}.
  F('instantCtrl', 'double', null, 5), F('sandboxCtrl', 'double', null, 6),
  F('spinnerCtrl', 'double', null, 5), F('threeAxisCtrl', 'double', null, 7),
  F('issCtrl', 'double', null, 7), F('cmgCtrl', 'double', null, 6),
  F('thrCtrl', 'double', null, 8), F('cfsCtrl', 'double', null, 7),
  F('thrSteerCtrl', 'double', null, 6),
];

const SIZE_KEYS: Array<keyof AcArraySizes> = ['nb', 'ng', 'nwhl', 'nmtb', 'nthr', 'ngyro', 'nmag', 'ncss', 'nfss', 'nst', 'ngps', 'nacc'];

/**
 * @description Parse the 96-byte array-sizes message (12 LE int64s).
 * @param buf - Exactly the sizes message.
 * @returns The named sizes.
 */
export function parseAcArraySizes(buf: Buffer): AcArraySizes {
  if (buf.length < 96) throw new Error(`array-sizes message too short: ${buf.length} < 96`);
  const out = {} as AcArraySizes;
  SIZE_KEYS.forEach((k, i) => {
    out[k] = Number(buf.readBigInt64LE(i * 8));
  });
  return out;
}

/**
 * @description Parse the 24-byte buffer-lengths message (3 LE int64s).
 * @param buf - Exactly the buf-lens message.
 * @returns In/Out/Tbl lengths in bytes (each includes the trailing NUL pad).
 */
export function parseAcBufLens(buf: Buffer): AcBufLens {
  if (buf.length < 24) throw new Error(`buf-lens message too short: ${buf.length} < 24`);
  return {
    inLen: Number(buf.readBigInt64LE(0)),
    outLen: Number(buf.readBigInt64LE(8)),
    tblLen: Number(buf.readBigInt64LE(16)),
  };
}

/**
 * @description Total serialized length of a layout for the given sizes, INCLUDING the
 * 1-byte NUL pad 42 appends. Matching this against 42's own BufLens message is the runtime
 * proof that the transcribed layouts are byte-exact.
 * @param layout - Message layout. @param sizes - Array sizes from the handshake.
 * @returns Length in bytes.
 */
export function layoutLength(layout: LayoutField[], sizes: AcArraySizes): number {
  let n = 0;
  for (const f of layout) n += (f.per ? sizes[f.per] : 1) * f.elems * 8;
  return n + 1;
}

/**
 * @description Decode a message into flat per-field arrays (field-major, matching the wire).
 * @param buf - The full message. @param layout - Its layout. @param sizes - Array sizes.
 * @returns Map of field key → flat number array (longs are converted via Number()).
 */
export function readLayout(buf: Buffer, layout: LayoutField[], sizes: AcArraySizes): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  let off = 0;
  for (const f of layout) {
    const count = (f.per ? sizes[f.per] : 1) * f.elems;
    const vals: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      vals[i] = f.kind === 'double' ? buf.readDoubleLE(off) : Number(buf.readBigInt64LE(off));
      off += 8;
    }
    out[f.key] = vals;
  }
  return out;
}

/**
 * @description Encode a message from flat per-field arrays; absent fields serialize as
 * zeros. Appends the NUL pad, so the result is exactly `layoutLength` bytes.
 * @param layout - Message layout. @param sizes - Array sizes. @param values - Field values.
 * @returns The wire buffer.
 */
export function writeLayout(layout: LayoutField[], sizes: AcArraySizes, values: Record<string, number[]>): Buffer {
  const buf = Buffer.alloc(layoutLength(layout, sizes));
  let off = 0;
  for (const f of layout) {
    const count = (f.per ? sizes[f.per] : 1) * f.elems;
    const vals = values[f.key] ?? [];
    for (let i = 0; i < count; i++) {
      const v = vals[i] ?? 0;
      if (f.kind === 'double') buf.writeDoubleLE(v, off);
      else buf.writeBigInt64LE(BigInt(Math.round(v)), off);
      off += 8;
    }
  }
  return buf;
}

/**
 * @description 42 stores quaternions scalar-LAST (q[3] is the scalar); sat-ops is
 * scalar-first. This converts wire order to {@link Quat} without changing convention.
 * @param arr - Four wire values [q1,q2,q3,q4=scalar].
 * @returns Scalar-first quaternion.
 */
export function scalarLastToQuat(arr: number[]): Quat {
  return { w: arr[3], x: arr[0], y: arr[1], z: arr[2] };
}

/**
 * @description Group a flat field-major array into per-item Vec3s (e.g. wheel axes).
 * @param flat - Flat values, 3 per item. @param count - Item count.
 * @returns One Vec3 per item.
 */
export function groupVec3(flat: number[], count: number): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k < count; k++) out.push({ x: flat[3 * k], y: flat[3 * k + 1], z: flat[3 * k + 2] });
  return out;
}

/** Invert a 3×3 (row-major) via cofactors; throws on a singular matrix. */
function mat3Inverse(m: number[][]): number[][] {
  const [a, b, c] = m[0]; const [d, e, f] = m[1]; const [g, h, i] = m[2];
  const A = e * i - f * h; const B = c * h - b * i; const C = b * f - c * e;
  const D = f * g - d * i; const E = a * i - c * g; const Fc = c * d - a * f;
  const G = d * h - e * g; const H = b * g - a * h; const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) throw new Error('singular 3x3 matrix (degenerate axis set)');
  return [[A / det, B / det, C / det], [D / det, E / det, Fc / det], [G / det, H / det, I / det]];
}

/**
 * @description Recover a body vector from per-axis scalar projections: least squares
 * (AᵀA)⁻¹Aᵀy over the sensing axes (exact when three axes are orthogonal). The shared kernel
 * behind gyro-rate and magnetometer-field reconstruction.
 * @param axes - Sensing axes in the body frame. @param readings - One scalar per axis.
 * @returns The recovered body vector.
 */
export function solveVectorFromAxisScalars(axes: Vec3[], readings: number[]): Vec3 {
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const atr = [0, 0, 0];
  axes.forEach((a, k) => {
    const v = [a.x, a.y, a.z];
    for (let i = 0; i < 3; i++) {
      atr[i] += v[i] * readings[k];
      for (let j = 0; j < 3; j++) ata[i][j] += v[i] * v[j];
    }
  });
  const inv = mat3Inverse(ata);
  return {
    x: inv[0][0] * atr[0] + inv[0][1] * atr[1] + inv[0][2] * atr[2],
    y: inv[1][0] * atr[0] + inv[1][1] * atr[1] + inv[1][2] * atr[2],
    z: inv[2][0] * atr[0] + inv[2][1] * atr[1] + inv[2][2] * atr[2],
  };
}

/**
 * @description Solve the body rate from per-gyro rate measurements (delegates to
 * {@link solveVectorFromAxisScalars} — byte-identical result).
 * @param axes - Gyro axes in the body frame. @param rates - Measured rates (rad/s), one per gyro.
 * @returns Body angular velocity, rad/s.
 */
export function solveOmegaFromGyros(axes: Vec3[], rates: number[]): Vec3 {
  return solveVectorFromAxisScalars(axes, rates);
}

/**
 * @description Reconstruct the body magnetic field from per-axis magnetometer scalars.
 * @param axes - Magnetometer axes in the body frame. @param fieldScalarsT - Per-axis reads (T).
 * @returns The body-frame field vector (T).
 */
export function solveFieldFromMags(axes: Vec3[], fieldScalarsT: number[]): Vec3 {
  return solveVectorFromAxisScalars(axes, fieldScalarsT);
}

/**
 * @description Minimum-norm torque distribution for an N-wheel cluster: returns the N×3
 * pseudo-inverse Aᵀ(AAᵀ)⁻¹ of the 3×N axis matrix, so `wheelTorques = M · bodyClusterTorque`
 * reproduces the requested cluster torque exactly (N ≥ 3, axes spanning).
 * @param axes - Wheel spin axes in the body frame.
 * @returns N rows of 3 weights each.
 */
export function wheelDistribution(axes: Vec3[]): number[][] {
  const aat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const a of axes) {
    const v = [a.x, a.y, a.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) aat[i][j] += v[i] * v[j];
  }
  const inv = mat3Inverse(aat);
  return axes.map((a) => {
    const v = [a.x, a.y, a.z];
    return [0, 1, 2].map((j) => v[0] * inv[0][j] + v[1] * inv[1][j] + v[2] * inv[2][j]);
  });
}

/**
 * @description Total wheel-cluster momentum in the body frame: Σ axis_k · H_k.
 * @param axes - Wheel spin axes. @param momenta - Per-wheel momenta (N·m·s).
 * @returns Cluster momentum vector.
 */
export function clusterMomentum(axes: Vec3[], momenta: number[]): Vec3 {
  const out = { x: 0, y: 0, z: 0 };
  axes.forEach((a, k) => {
    out.x += a.x * momenta[k];
    out.y += a.y * momenta[k];
    out.z += a.z * momenta[k];
  });
  return out;
}

/**
 * @description Decide how 42's measured quaternion maps onto the sat-ops body→inertial
 * convention, from two consecutive free-drift measurements plus the gyro rate: predict the
 * second attitude from the first under both candidate mappings (direct vs conjugate) and
 * pick the one with the smaller residual. Deterministic instrument bring-up, no guessing.
 * @param prev - First measured quaternion (wire order already converted, convention unknown).
 * @param next - Second measured quaternion, `dtSeconds` later.
 * @param omega - Body rate during the interval, rad/s.
 * @param dtSeconds - Interval length.
 * @returns 'conjugate' when conj(measured) is body→inertial (42's qbn), else 'direct'.
 */
export function detectQuatConvention(prev: Quat, next: Quat, omega: Vec3, dtSeconds: number): 'direct' | 'conjugate' {
  const angle = vNorm(omega) * dtSeconds;
  const delta = angle < 1e-12 ? { w: 1, x: 0, y: 0, z: 0 } : quatFromAxisAngle(omega, angle);
  const residual = (map: (q: Quat) => Quat): number =>
    attitudeSeparationDeg(map(next), quatMultiply(map(prev), delta));
  const direct = residual((q) => q);
  const conjugate = residual(quatConjugate);
  return conjugate <= direct ? 'conjugate' : 'direct';
}
