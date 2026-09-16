/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the import engine blocking the api's event loop: a 44 MB .ply held the loop for 14 s and a 117 MB one collapsed the Docker VM (2026-09-14) because convertPly ran on the main thread. The spec generates a multi-megabyte point cloud, measures how long the conversion holds the thread when run on it (the control, and what the loop lost before the fix), then runs the real ImportReconstructionProvider while sampling event-loop lag with a 5 ms timer. Red on the on-thread provider (the largest gap equals the whole conversion); green once the provider converts in a worker thread. Uses only the provider's public contract, so it is the same test on both sides of the fix.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { convertToSplat, ImportReconstructionProvider } from '@/features/spatial-mapping';
import { asciiPointCloudPly } from '../fixtures/ply-point-cloud';

/** Enough vertices (about 6.6 MB of ASCII) that the conversion takes hundreds of milliseconds. */
const VERTICES = 300_000;

/** Largest gap between 5 ms timer ticks while `work` is pending — how long the loop was held. */
async function largestLoopGapMs(work: Promise<unknown>): Promise<number> {
  let last = performance.now();
  let largest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    largest = Math.max(largest, now - last);
    last = now;
  }, 5);
  try {
    await work.catch(() => undefined);
  } finally {
    clearInterval(timer);
    // The tick starved by a synchronous conversion never fires: settling resumes this function on a
    // microtask first. Fold in the gap since the last tick so a held loop is measured, not hidden.
    largest = Math.max(largest, performance.now() - last);
  }
  return largest;
}

describe('spatial-import: the .ply conversion stays off the event loop', () => {
  const tmp = path.join(os.tmpdir(), `oshal-import-loop-${randomUUID()}`);
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('converts a multi-megabyte .ply without holding the loop for the length of the conversion', async () => {
    await fs.mkdir(tmp, { recursive: true });
    const ply = Buffer.from(asciiPointCloudPly(VERTICES), 'ascii');
    const source = path.join(tmp, 'room.ply');
    await fs.writeFile(source, ply);

    // The control: the same bytes converted on this thread. Before the fix the provider did exactly
    // this, so the loop was unavailable for onThreadMs; the assertion below is relative to it.
    const started = performance.now();
    const control = convertToSplat(ply, '.ply');
    const onThreadMs = performance.now() - started;
    expect(control.count).toBe(VERTICES);
    expect(onThreadMs).toBeGreaterThan(100);

    const run = new ImportReconstructionProvider().reconstruct({
      scanId: 'loop-1', userSub: 'u|loop', sourceKind: 'model', sourcePath: source, sourceName: 'room.ply',
    });
    const largestGapMs = await largestLoopGapMs(run);
    const artifact = await run;

    expect(artifact.gaussianCount).toBe(VERTICES);
    expect(artifact.splat.equals(control.buffer)).toBe(true);
    expect(largestGapMs, `loop held ${largestGapMs.toFixed(0)} ms while the on-thread conversion takes ${onThreadMs.toFixed(0)} ms`)
      .toBeLessThan(Math.max(100, onThreadMs / 3));
  }, 120_000);
});
