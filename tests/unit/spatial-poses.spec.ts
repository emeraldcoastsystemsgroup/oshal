/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 pose persistence (increment A) guard — the Sim engine emits a valid ScanPoses set (camera-to-world keyframes + intrinsics, honestly non-metric opengl) so the RF overlay + relocalization are exercisable with no GPU; an IMPORTED capture emits NO poses (no camera trajectory); and posesPath resolves under the owner-scoped scan dir. Guards against a regression that would ship poses the overlay can't consume, or claim poses for a pose-less import.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Audit-fix guard: every sim keyframe must sit INSIDE the seeded room (the old orbit circled the corner-origin and put ~3/4 of the keyframes — and the RF demo's heat — outside the walls).
 */

import { describe, expect, it, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  SimReconstructionProvider,
  ImportReconstructionProvider,
  posesPath,
  scanDir,
  roomDims,
} from '@/features/spatial-mapping';

const SPEC = { scanId: 'scan-p', userSub: 'u|1', sourceKind: 'video' as const, sourcePath: '/tmp/x.mp4', sourceName: 'x.mp4' };

describe('spatial-poses: Sim engine emits camera poses', () => {
  it('produces a ScanPoses set with keyframe poses + intrinsics', async () => {
    const artifact = await new SimReconstructionProvider().reconstruct(SPEC);
    expect(artifact.poses).toBeDefined();
    const poses = artifact.poses!;
    expect(poses.scanId).toBe('scan-p');
    expect(poses.keyframes.length).toBe(8);
    const k = poses.keyframes[0];
    expect(k.center).toHaveLength(3);
    expect(k.quat).toHaveLength(4);
    expect(k.fx).toBeGreaterThan(0);
    expect(k.width).toBe(1920);
  });

  it('labels the frame honestly (opengl, non-metric until anchored)', async () => {
    const poses = (await new SimReconstructionProvider().reconstruct(SPEC)).poses!;
    expect(poses.frame.convention).toBe('opengl');
    expect(poses.frame.metric).toBe(false);
    expect(poses.frame.scaleSource).toBe('none');
  });

  it('orbits INSIDE the seeded room (room corner is the origin, not its centre)', async () => {
    const poses = (await new SimReconstructionProvider().reconstruct(SPEC)).poses!;
    const { w, d, h } = roomDims(SPEC.scanId);
    for (const k of poses.keyframes) {
      expect(k.center[0]).toBeGreaterThan(0);
      expect(k.center[0]).toBeLessThan(w);
      expect(k.center[1]).toBeGreaterThan(0);
      expect(k.center[1]).toBeLessThan(h);
      expect(k.center[2]).toBeGreaterThan(0);
      expect(k.center[2]).toBeLessThan(d);
    }
  });
});

describe('spatial-poses: imported captures carry no poses', () => {
  const tmp = path.join(os.tmpdir(), `oshal-poses-test-${randomUUID()}`);
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('ImportReconstructionProvider leaves poses undefined (no camera trajectory)', async () => {
    await fs.mkdir(tmp, { recursive: true });
    const src = path.join(tmp, 'source.ply');
    const ply = ['ply', 'format ascii 1.0', 'element vertex 1',
      'property float x', 'property float y', 'property float z', 'end_header', '0 0 0', ''].join('\n');
    await fs.writeFile(src, ply, 'ascii');
    const artifact = await new ImportReconstructionProvider().reconstruct({
      scanId: 's1', userSub: 'u|1', sourceKind: 'model', sourcePath: src, sourceName: 'room.ply',
    });
    expect(artifact.providerKind).toBe('import');
    expect(artifact.poses).toBeUndefined();
  });
});

describe('spatial-poses: sidecar path is owner-scoped', () => {
  it('posesPath resolves to poses.json inside the scan dir', () => {
    const p = posesPath('u|1', 'scan-9');
    expect(p.endsWith('poses.json')).toBe(true);
    expect(p.startsWith(scanDir('u|1', 'scan-9'))).toBe(true);
  });
});
