/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 direct-import lane guard — proves the .ply/.splat -> .splat converter and the ImportReconstructionProvider actually work: an ASCII point cloud, a binary_little_endian point cloud, and a trained-3DGS .ply each convert to a valid 32-byte-stride splat with the right count/colour; a raw .splat passes through; malformed/unsupported input throws; and the provider reads a file and returns a providerKind='import' artifact. Guards against a regression that would ship an import path the WebGL viewer can't load.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { convertToSplat, IMPORT_EXTENSIONS, ImportReconstructionProvider } from '@/features/spatial-mapping';

const STRIDE = 32;

/** An ASCII point-cloud PLY: 3 coloured points forming a right triangle. */
const ASCII_POINTS = [
  'ply', 'format ascii 1.0', 'element vertex 3',
  'property float x', 'property float y', 'property float z',
  'property uchar red', 'property uchar green', 'property uchar blue', 'end_header',
  '0 0 0 255 0 0', '1 0 0 0 255 0', '0 1 0 0 0 255', '',
].join('\n');

/** An ASCII trained-3DGS PLY: one gaussian with SH colour, log-scale, opacity, rotation. */
const ASCII_3DGS = [
  'ply', 'format ascii 1.0', 'element vertex 1',
  'property float x', 'property float y', 'property float z',
  'property float f_dc_0', 'property float f_dc_1', 'property float f_dc_2', 'property float opacity',
  'property float scale_0', 'property float scale_1', 'property float scale_2',
  'property float rot_0', 'property float rot_1', 'property float rot_2', 'property float rot_3', 'end_header',
  '0.5 0.5 0.5 1.0 0.0 -1.0 2.0 -3.0 -3.0 -3.0 1 0 0 0', '',
].join('\n');

/** Build a binary_little_endian point-cloud PLY: N vertices of float x,y,z + uchar r,g,b. */
function binaryPointsPly(pts: Array<{ p: [number, number, number]; c: [number, number, number] }>): Buffer {
  const header = Buffer.from(
    ['ply', 'format binary_little_endian 1.0', `element vertex ${pts.length}`,
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue', 'end_header', ''].join('\n'),
    'ascii',
  );
  const body = Buffer.alloc(pts.length * 15);
  pts.forEach((v, i) => {
    const o = i * 15;
    body.writeFloatLE(v.p[0], o); body.writeFloatLE(v.p[1], o + 4); body.writeFloatLE(v.p[2], o + 8);
    body[o + 12] = v.c[0]; body[o + 13] = v.c[1]; body[o + 14] = v.c[2];
  });
  return Buffer.concat([header, body]);
}

describe('spatial-import: .ply point cloud -> .splat', () => {
  it('converts an ASCII point cloud to one 32-byte record per point with its colour', () => {
    const { buffer, count } = convertToSplat(Buffer.from(ASCII_POINTS, 'ascii'), '.ply');
    expect(count).toBe(3);
    expect(buffer.length).toBe(3 * STRIDE);
    expect(buffer.readFloatLE(STRIDE + 0)).toBeCloseTo(1, 5); // 2nd point x = 1
    expect(buffer[24]).toBe(255); // 1st point red
    expect(buffer[26]).toBe(0);   // 1st point blue
    expect(buffer[27]).toBe(255); // opaque
  });

  it('converts a binary_little_endian point cloud', () => {
    const ply = binaryPointsPly([
      { p: [0, 0, 0], c: [10, 20, 30] },
      { p: [2, 0, 0], c: [40, 50, 60] },
    ]);
    const { buffer, count } = convertToSplat(ply, '.ply');
    expect(count).toBe(2);
    expect(buffer.length).toBe(2 * STRIDE);
    expect(buffer.readFloatLE(STRIDE)).toBeCloseTo(2, 5); // 2nd point x = 2
    expect(buffer[24]).toBe(10); // 1st point red
  });
});

describe('spatial-import: trained-3DGS .ply -> .splat', () => {
  it('maps SH colour, exp(scale) and the rotation quaternion into the record', () => {
    const { buffer, count } = convertToSplat(Buffer.from(ASCII_3DGS, 'ascii'), '.ply');
    expect(count).toBe(1);
    expect(buffer.length).toBe(STRIDE);
    expect(buffer.readFloatLE(0)).toBeCloseTo(0.5, 5); // position x
    // rgb = 0.5 + 0.28209*f_dc  ->  R (f_dc_0=1) is the brightest channel, B (f_dc_2=-1) the dimmest
    expect(buffer[24]).toBeGreaterThan(buffer[26]);
    expect(buffer.readFloatLE(12)).toBeCloseTo(Math.exp(-3), 3); // scale = exp(scale_0)
    expect(buffer[28]).toBe(255); // identity-ish quat w (rot_0=1) packs to 255
  });
});

describe('spatial-import: .splat passthrough + rejects', () => {
  it('passes a well-formed .splat through unchanged', () => {
    const raw = Buffer.alloc(2 * STRIDE, 7);
    const { buffer, count } = convertToSplat(raw, '.splat');
    expect(count).toBe(2);
    expect(buffer.equals(raw)).toBe(true);
  });

  it('rejects a malformed .splat (not a multiple of 32)', () => {
    expect(() => convertToSplat(Buffer.alloc(31), '.splat')).toThrow();
  });

  it('rejects an unsupported extension', () => {
    expect(() => convertToSplat(Buffer.from('x'), '.obj')).toThrow(/unsupported/i);
  });

  it('rejects a non-PLY passed as .ply', () => {
    expect(() => convertToSplat(Buffer.from('not a ply at all'), '.ply')).toThrow();
  });

  it('exposes the accepted extensions', () => {
    expect(IMPORT_EXTENSIONS).toContain('.ply');
    expect(IMPORT_EXTENSIONS).toContain('.splat');
  });
});

describe('spatial-import: ImportReconstructionProvider', () => {
  const tmp = path.join(os.tmpdir(), `oshal-import-test-${randomUUID()}`);
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('is always available (no GPU box)', async () => {
    expect((await new ImportReconstructionProvider().probe()).available).toBe(true);
  });

  it('reads a stored .ply and returns a valid import artifact', async () => {
    await fs.mkdir(tmp, { recursive: true });
    const src = path.join(tmp, 'source.ply');
    await fs.writeFile(src, ASCII_POINTS, 'ascii');
    const artifact = await new ImportReconstructionProvider().reconstruct({
      scanId: 's1', userSub: 'u|1', sourceKind: 'model', sourcePath: src, sourceName: 'my-room.ply',
    });
    expect(artifact.providerKind).toBe('import');
    expect(artifact.splat.length % STRIDE).toBe(0);
    expect(artifact.gaussianCount).toBe(artifact.splat.length / STRIDE);
    expect(artifact.gaussianCount).toBe(3);
  });

  it('throws a ReconstructionError (not a raw throw) on a missing source file', async () => {
    await expect(new ImportReconstructionProvider().reconstruct({
      scanId: 's2', userSub: 'u|1', sourceKind: 'model',
      sourcePath: path.join(tmp, 'does-not-exist.ply'), sourceName: 'x.ply',
    })).rejects.toThrow(/import:/);
  });
});
