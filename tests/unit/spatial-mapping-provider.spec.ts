/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 guard — the reconstruction provider contract: packSplat writes the exact 32-byte .splat record layout, the SimReconstructionProvider always produces a valid, non-trivial, viewer-loadable splat, and its output is deterministic in the scan id (so a scan always re-renders the same room and the pipeline is testable without a GPU). Guards against a regression that would ship a malformed splat the WebGL viewer can't parse.
 */

import { describe, expect, it } from 'vitest';
import {
  packSplat,
  generateRoomSplat,
  SimReconstructionProvider,
  type Gaussian,
} from '@/features/spatial-mapping';

describe('spatial-mapping: .splat packing', () => {
  it('writes exactly one 32-byte record per gaussian in the documented layout', () => {
    const g: Gaussian = { pos: [1, 2, 3], scale: [0.04, 0.05, 0.06], color: [10, 20, 30, 255] };
    const buf = packSplat([g]);
    expect(buf.length).toBe(32);
    expect(buf.readFloatLE(0)).toBeCloseTo(1, 5); // position x
    expect(buf.readFloatLE(8)).toBeCloseTo(3, 5); // position z
    expect(buf.readFloatLE(12)).toBeCloseTo(0.04, 5); // scale sx (written directly, not log)
    expect(buf[24]).toBe(10); // color R
    expect(buf[27]).toBe(255); // color A (opacity)
    expect(buf[28]).toBe(255); // identity quaternion default: [255,128,128,128]
    expect(buf[29]).toBe(128);
    expect(buf[30]).toBe(128);
    expect(buf[31]).toBe(128);
  });

  it('clamps out-of-range colour bytes to 0..255', () => {
    const buf = packSplat([{ pos: [0, 0, 0], scale: [0.01, 0.01, 0.01], color: [-5, 300, 128.7, 255] }]);
    expect(buf[24]).toBe(0);
    expect(buf[25]).toBe(255);
    expect(buf[26]).toBe(129);
  });
});

describe('spatial-mapping: synthetic room generator', () => {
  it('produces a valid, non-trivial splat (length divisible by 32, count matches)', () => {
    const { buffer, count } = generateRoomSplat('scan-abc');
    expect(buffer.length % 32).toBe(0);
    expect(buffer.length / 32).toBe(count);
    expect(count).toBeGreaterThan(1000); // a recognizable room, not a stub
  });

  it('is deterministic in the seed', () => {
    const a = generateRoomSplat('scan-xyz').buffer;
    const b = generateRoomSplat('scan-xyz').buffer;
    expect(a.equals(b)).toBe(true);
  });

  it('varies by seed', () => {
    const a = generateRoomSplat('scan-1').buffer;
    const b = generateRoomSplat('scan-2').buffer;
    expect(a.equals(b)).toBe(false);
  });
});

describe('spatial-mapping: SimReconstructionProvider', () => {
  it('is always available', async () => {
    const status = await new SimReconstructionProvider().probe();
    expect(status.available).toBe(true);
  });

  it('reconstructs a valid splat artifact deterministic in the scan id', async () => {
    const provider = new SimReconstructionProvider();
    const spec = { scanId: 'scan-42', userSub: 'u|1', sourceKind: 'video' as const, sourcePath: '/tmp/x.mp4', sourceName: 'x.mp4' };
    const first = await provider.reconstruct(spec);
    const second = await provider.reconstruct(spec);
    expect(first.providerKind).toBe('sim');
    expect(first.splat.length % 32).toBe(0);
    expect(first.gaussianCount).toBe(first.splat.length / 32);
    expect(first.gaussianCount).toBeGreaterThan(1000);
    expect(first.splat.equals(second.splat)).toBe(true); // same scan id -> same room
  });
});
