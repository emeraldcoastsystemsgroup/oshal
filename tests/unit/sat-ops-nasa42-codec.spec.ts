/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1 round 2: codec proofs for the 42 standalone-AC
 *                     |                             | IPC — hand-computed layout lengths for the CfsSat
 *                     |                             | vehicle, encode/decode round trip, endianness, wheel
 *                     |                             | pyramid distribution, gyro solve, and quaternion
 *                     |                             | convention detection cross-validated against the RK4 sim.
 */

import { describe, expect, it } from 'vitest';
import {
  IN_LAYOUT,
  OUT_LAYOUT,
  Rk4PropagatorSim,
  clusterMomentum,
  detectQuatConvention,
  layoutLength,
  parseAcArraySizes,
  parseAcBufLens,
  quatConjugate,
  readLayout,
  scalarLastToQuat,
  solveOmegaFromGyros,
  vNorm,
  vSub,
  wheelDistribution,
  writeLayout,
  type AcArraySizes,
  type Vec3,
} from '@/features/sat-ops';

/** The stock CfsSat vehicle from 42's Standalone case — the config the container runs. */
const CFSSAT: AcArraySizes = { nb: 2, ng: 1, nwhl: 4, nmtb: 3, nthr: 0, ngyro: 3, nmag: 3, ncss: 8, nfss: 1, nst: 1, ngps: 1, nacc: 0 };

describe('sat-ops NASA 42 codec', () => {
  it('computes the CfsSat In/Out lengths that 42 itself reports', () => {
    // Hand-derived from the transcribed field lists (8 bytes/field element + 1 NUL pad):
    // In:  gimbal (3+4+4)*8=88, gyro 24, mag 24, css 64+64, fss 8+16, st 8+32,
    //      gps 24 longs + 8 + 4*24 + 48 = 176, whlH 32, cmd 32+32  -> 600 + 1 = 601
    // Out: svb/bvb/hvb 72, gimbal (4+4+3+3+3+3)*8=160, whl 32, mtb 24,
    //      cmd (4+4+3+3+3+3)*8=160 -> 448 + 1 = 449
    expect(layoutLength(IN_LAYOUT, CFSSAT)).toBe(601);
    expect(layoutLength(OUT_LAYOUT, CFSSAT)).toBe(449);
  });

  it('parses the sizes and buf-lens handshake messages (LE int64)', () => {
    const sizes = Buffer.alloc(96);
    const vals = [2n, 1n, 4n, 3n, 0n, 3n, 3n, 8n, 1n, 1n, 1n, 0n];
    vals.forEach((v, i) => sizes.writeBigInt64LE(v, i * 8));
    expect(parseAcArraySizes(sizes)).toEqual(CFSSAT);
    const lens = Buffer.alloc(24);
    lens.writeBigInt64LE(601n, 0);
    lens.writeBigInt64LE(449n, 8);
    lens.writeBigInt64LE(4242n, 16);
    expect(parseAcBufLens(lens)).toEqual({ inLen: 601, outLen: 449, tblLen: 4242 });
  });

  it('round-trips a message through writeLayout/readLayout, zero-filling absent fields', () => {
    const values = { whlTcmd: [0.01, -0.02, 0.03, -0.04], cmdQrl: [0, 0, 0, 1], hvb: [1.5, -2.5, 3.5] };
    const buf = writeLayout(OUT_LAYOUT, CFSSAT, values);
    expect(buf.length).toBe(449);
    expect(buf[448]).toBe(0); // the NUL pad
    const back = readLayout(buf, OUT_LAYOUT, CFSSAT);
    expect(back.whlTcmd).toEqual(values.whlTcmd);
    expect(back.cmdQrl).toEqual(values.cmdQrl);
    expect(back.hvb).toEqual(values.hvb);
    expect(back.mtbMcmd).toEqual([0, 0, 0]);
  });

  it('maps 42 scalar-last wire order to scalar-first quaternions', () => {
    expect(scalarLastToQuat([0.1, 0.2, 0.3, 0.9])).toEqual({ w: 0.9, x: 0.1, y: 0.2, z: 0.3 });
  });

  it('distributes cluster torque across the 4-wheel pyramid exactly (minimum-norm)', () => {
    const s = 1 / Math.sqrt(3);
    const axes: Vec3[] = [
      { x: s, y: s, z: s }, { x: -s, y: s, z: s }, { x: -s, y: -s, z: s }, { x: s, y: -s, z: s },
    ];
    const m = wheelDistribution(axes);
    const want: Vec3 = { x: 0.011, y: -0.007, z: 0.005 };
    const wheels = m.map((row) => row[0] * want.x + row[1] * want.y + row[2] * want.z);
    const got = clusterMomentum(axes, wheels); // Σ axis·w reproduces the request
    expect(vNorm(vSub(got, want))).toBeLessThan(1e-12);
  });

  it('recovers the body rate from gyro axis measurements', () => {
    const axes: Vec3[] = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
    const omega: Vec3 = { x: 0.02, y: -0.01, z: 0.015 };
    const rates = axes.map((a) => a.x * omega.x + a.y * omega.y + a.z * omega.z);
    expect(vNorm(vSub(solveOmegaFromGyros(axes, rates), omega))).toBeLessThan(1e-12);
  });

  it('detects the quaternion convention from free drift, cross-validated by the RK4 sim', async () => {
    const sim = new Rk4PropagatorSim();
    const omega: Vec3 = { x: 0.2, y: -0.1, z: 0.15 };
    const s0 = await sim.reset({ q: { w: 0.8, x: 0.2, y: -0.4, z: 0.4 }, omega });
    const s1 = await sim.step(0.5, { x: 0, y: 0, z: 0 });
    // 42 reports qbn (inertial→body) = conjugate of our body→inertial state, scalar-last.
    const asWire = (q: { w: number; x: number; y: number; z: number }): number[] => [q.x, q.y, q.z, q.w];
    const qbn0 = scalarLastToQuat(asWire(quatConjugate(s0.q)));
    const qbn1 = scalarLastToQuat(asWire(quatConjugate(s1.q)));
    expect(detectQuatConvention(qbn0, qbn1, s1.omega, 0.5)).toBe('conjugate');
    // And a sim that already reports body→inertial is detected as direct.
    const direct0 = scalarLastToQuat(asWire(s0.q));
    const direct1 = scalarLastToQuat(asWire(s1.q));
    expect(detectQuatConvention(direct0, direct1, s1.omega, 0.5)).toBe('direct');
  });
});
