/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the off-loop .ply conversion contract: the limits resolve from the environment with sane defaults and labels; the worker produces byte-identical output to the on-thread converter; a worker that overruns its heap cap dies with a reason naming the knob (a REAL node:worker_threads Worker under resourceLimits, not a doubled spawn); a non-PLY keeps its parse error; the provider refuses a .ply over the gate naming the limit while the .splat passthrough stays ungated; and the real SpatialMappingService, fed a real oversized source through a pool double, writes the worker's reason onto the failed row and never marks it ready. The database is doubled because it is not the boundary that failed — the thread and heap boundaries are real.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import {
  convertPlyOffLoop, convertToSplat, formatByteLimit, ImportReconstructionProvider,
  PLY_IMPORT_DEFAULTS, PLY_IMPORT_ENV, resolvePlyImportLimits, SpatialMappingService,
} from '@/features/spatial-mapping';
import { asciiPointCloudPly } from '../fixtures/ply-point-cloud';

/** A cloud this size needs well over 24 MB of worker heap to parse (records + gaussians), so it dies under that cap. */
const OVERRUN_VERTICES = 200_000;
/** The cap the overrun fixture must not fit in; the tsx loader itself needs about 11 MB. */
const TINY_HEAP_MB = 24;

/** An ASCII trained-3DGS PLY: one gaussian with SH colour, log-scale, opacity, rotation. */
const ASCII_3DGS = [
  'ply', 'format ascii 1.0', 'element vertex 1',
  'property float x', 'property float y', 'property float z',
  'property float f_dc_0', 'property float f_dc_1', 'property float f_dc_2', 'property float opacity',
  'property float scale_0', 'property float scale_1', 'property float scale_2',
  'property float rot_0', 'property float rot_1', 'property float rot_2', 'property float rot_3', 'end_header',
  '0.5 0.5 0.5 1.0 0.0 -1.0 2.0 -3.0 -3.0 -3.0 1 0 0 0', '',
].join('\n');

/** Poll until `done` is true or the deadline passes. */
async function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Set (or clear) one env var for a test and restore it afterwards. */
function withEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

describe('resolvePlyImportLimits', () => {
  it('defaults to a 50 MiB gate and a 1 GiB worker heap when the env is silent', () => {
    expect(resolvePlyImportLimits({})).toEqual({ plyMaxBytes: 50 * 1024 * 1024, workerHeapMb: 1024 });
    expect(PLY_IMPORT_DEFAULTS.plyMaxBytes).toBe(52_428_800);
  });

  it('reads both knobs from the environment', () => {
    expect(resolvePlyImportLimits({
      [PLY_IMPORT_ENV.maxBytes]: '1048576', [PLY_IMPORT_ENV.workerHeapMb]: '256',
    })).toEqual({ plyMaxBytes: 1_048_576, workerHeapMb: 256 });
  });

  it('falls back to the default on a malformed or non-positive value', () => {
    for (const bad of ['abc', '0', '-5', '1.5', ' ']) {
      expect(resolvePlyImportLimits({ [PLY_IMPORT_ENV.maxBytes]: bad, [PLY_IMPORT_ENV.workerHeapMb]: bad }))
        .toEqual({ plyMaxBytes: PLY_IMPORT_DEFAULTS.plyMaxBytes, workerHeapMb: PLY_IMPORT_DEFAULTS.workerHeapMb });
    }
  });

  it('labels a limit in binary units the way an operator reads it', () => {
    expect(formatByteLimit(52_428_800)).toBe('50 MB');
    expect(formatByteLimit(1_572_864)).toBe('1.5 MB');
    expect(formatByteLimit(1024)).toBe('1 KB');
    expect(formatByteLimit(512)).toBe('512 bytes');
  });
});

describe('convertPlyOffLoop', () => {
  const tmp = path.join(os.tmpdir(), `oshal-import-worker-${randomUUID()}`);
  beforeAll(async () => { await fs.mkdir(tmp, { recursive: true }); });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('produces the same bytes as the on-thread converter for a point cloud and a trained 3DGS', async () => {
    for (const [name, text] of [['cloud.ply', asciiPointCloudPly(2000)], ['gs.ply', ASCII_3DGS]] as const) {
      const file = path.join(tmp, name);
      await fs.writeFile(file, text, 'ascii');
      const expected = convertToSplat(Buffer.from(text, 'ascii'), '.ply');
      const actual = await convertPlyOffLoop(file, '.ply', { workerHeapMb: 256 });
      expect(actual.count).toBe(expected.count);
      expect(actual.splat.equals(expected.buffer)).toBe(true);
    }
  }, 60_000);

  it('rejects with an out-of-memory reason that names the cap and the knob when the worker overruns its heap', async () => {
    const file = path.join(tmp, 'overrun.ply');
    await fs.writeFile(file, asciiPointCloudPly(OVERRUN_VERTICES), 'ascii');
    await expect(convertPlyOffLoop(file, '.ply', { workerHeapMb: TINY_HEAP_MB }))
      .rejects.toThrow(new RegExp(`ran out of memory \\(heap cap ${TINY_HEAP_MB} MB, ${PLY_IMPORT_ENV.workerHeapMb}\\)`));
  }, 60_000);

  it('keeps the parse error when the source is not a PLY', async () => {
    const file = path.join(tmp, 'not.ply');
    await fs.writeFile(file, 'definitely not a ply', 'ascii');
    await expect(convertPlyOffLoop(file, '.ply', { workerHeapMb: 256 })).rejects.toThrow(/not a PLY file/);
  }, 60_000);
});

describe('ImportReconstructionProvider .ply gate', () => {
  const tmp = path.join(os.tmpdir(), `oshal-import-gate-${randomUUID()}`);
  let restore: () => void = () => undefined;
  beforeAll(async () => { await fs.mkdir(tmp, { recursive: true }); });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
  beforeEach(() => { restore = withEnv(PLY_IMPORT_ENV.maxBytes, '1024'); });
  afterEach(() => { restore(); });

  it('refuses a .ply over the configured gate with a ReconstructionError naming the limit and the knob', async () => {
    const file = path.join(tmp, 'over.ply');
    await fs.writeFile(file, asciiPointCloudPly(200), 'ascii');
    expect((await fs.stat(file)).size).toBeGreaterThan(1024);
    await expect(new ImportReconstructionProvider().reconstruct({
      scanId: 'g1', userSub: 'u|gate', sourceKind: 'model', sourcePath: file, sourceName: 'over.ply',
    })).rejects.toThrow(/import: \.ply source is \d+ bytes, over the 1 KB gate \(OSHAL_SPACES_PLY_MAX_BYTES\)/);
  });

  it('leaves the .splat passthrough ungated', async () => {
    const file = path.join(tmp, 'big.splat');
    await fs.writeFile(file, Buffer.alloc(64 * 32, 7));
    const artifact = await new ImportReconstructionProvider().reconstruct({
      scanId: 'g2', userSub: 'u|gate', sourceKind: 'model', sourcePath: file, sourceName: 'big.splat',
    });
    expect(artifact.gaussianCount).toBe(64);
  });
});

/** Row shape the store maps; the pool double fills it from the INSERT it received. */
interface ScanRowLike { [column: string]: unknown }

describe('SpatialMappingService records the worker death as the failed reason', () => {
  const tmp = path.join(os.tmpdir(), `oshal-import-fail-${randomUUID()}`);
  const restores: Array<() => void> = [];
  beforeAll(async () => {
    await fs.mkdir(tmp, { recursive: true });
    restores.push(withEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only'));
    restores.push(withEnv('OSHAL_SPACES_ROOT', tmp));
    restores.push(withEnv(PLY_IMPORT_ENV.workerHeapMb, String(TINY_HEAP_MB)));
  });
  afterAll(async () => {
    restores.reverse().forEach((r) => r());
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('marks the scan failed with the out-of-memory reason and never ready', async () => {
    const source = path.join(tmp, 'huge.ply');
    await fs.writeFile(source, asciiPointCloudPly(OVERRUN_VERTICES), 'ascii');
    let row: ScanRowLike | null = null;
    const statuses: string[] = [];
    let failedReason: string | undefined;
    let readyCalls = 0;
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/to_regclass/i.test(sql)) return { rows: [{ exists: true }] };
        if (/information_schema\.columns/i.test(sql)) return { rows: [{ column_name: 'x' }] };
        if (/^\s*INSERT INTO spatial_scans/i.test(sql)) {
          row = {
            id: params[0], user_sub: params[1], title: params[2], status: 'queued', source_kind: params[3],
            source_name: params[4], source_ref: params[5], source_bytes: params[6], provider: null,
            artifact_ref: null, gaussian_count: null, error: null, created_at: new Date(), updated_at: new Date(),
          };
          return { rows: [row], rowCount: 1 };
        }
        if (/SET status='failed', error=\$3/i.test(sql)) { failedReason = String(params[2]); statuses.push('failed'); return { rows: [], rowCount: 1 }; }
        if (/SET status='ready'/i.test(sql)) { readyCalls += 1; statuses.push('ready'); return { rows: [], rowCount: 1 }; }
        if (/SET status=\$3/i.test(sql)) { statuses.push(String(params[2])); return { rows: [], rowCount: 1 }; }
        if (/FROM spatial_scans WHERE user_sub=\$1 AND id=\$2/is.test(sql)) return { rows: row ? [row] : [] };
        return { rows: [] };
      },
    } as unknown as Pool;

    const service = new SpatialMappingService(pool);
    const scan = await service.registerAndStart({
      id: randomUUID(), userSub: 'u|fail', title: 'huge', sourceKind: 'model',
      sourceName: 'huge.ply', sourceRef: source, sourceBytes: (await fs.stat(source)).size,
    });
    expect(scan.status).toBe('queued');
    await waitFor(() => failedReason !== undefined, 60_000);

    expect(statuses).toEqual(['reconstructing', 'failed']);
    expect(readyCalls).toBe(0);
    expect(failedReason).toMatch(/^import: PLY conversion worker ran out of memory \(heap cap 24 MB, OSHAL_SPACES_PLY_WORKER_HEAP_MB\)$/);
  }, 90_000);
});
