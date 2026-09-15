/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Host side of the off-loop .ply conversion: spawns ply-convert-worker in a node:worker_threads Worker with a resourceLimits old-generation heap cap, resolves with the transferred .splat bytes, and rejects with a reason that names the cause when the worker dies (ERR_WORKER_OUT_OF_MEMORY becomes "ran out of memory (heap cap N MB, OSHAL_SPACES_PLY_WORKER_HEAP_MB)"; a parse error keeps its message; a silent exit names the code). A .ts entry is loaded through the tsx CJS hook when it resolves (esbuild, about 10 MB of worker heap) and through ts-node transpile-only + tsconfig-paths otherwise; a compiled .js entry needs no loader. Measured on this box: 400 000 ASCII vertices under a 48 MB cap die in 431 ms with the OOM code and the api process is untouched.
 */

import { Worker } from 'node:worker_threads';
import { createChildLogger } from '@/shared/logger';
import { plyWorkerEntry, type PlyWorkerOutput } from './ply-convert-worker';
import { PLY_IMPORT_ENV } from './import-limits';

const logger = createChildLogger({ module: 'ply-convert-host' });

/** Evaluated inside the worker: register the TypeScript loader(s) a .ts entry needs, then run the entry. */
const BOOTSTRAP = [
  "const { workerData } = require('node:worker_threads');",
  'for (const preload of workerData.preload) require(preload);',
  'require(workerData.entry);',
].join('\n');

/** How the conversion is bounded: the worker's old-generation heap cap in MiB. */
export interface OffLoopConvertOptions {
  workerHeapMb: number;
}

/** The converted artifact as the main thread receives it: a Buffer view over the transferred bytes. */
export interface OffLoopConvertResult {
  splat: Buffer;
  count: number;
}

/** Resolve an optional loader package from this module's resolution root; null when it is not installed. */
function resolveOptional(id: string): string | null {
  try {
    return require.resolve(id);
  } catch (err) {
    logger.warn({ err, id }, 'loader not resolvable for the .ts conversion worker; trying the next one');
    return null;
  }
}

/**
 * @description The modules the worker must `require` before the entry. A compiled `.js` entry
 * needs none. A `.ts` entry (ts-node/tsx hot-swap, vitest) is loaded through tsx's CJS hook
 * when it resolves, else through ts-node transpile-only plus tsconfig-paths (the `@/` aliases).
 * @param entry - The worker entry path
 * @returns The absolute preload module paths, in order
 */
function loaderPreloads(entry: string): string[] {
  if (!entry.endsWith('.ts')) return [];
  const tsx = resolveOptional('tsx/cjs');
  if (tsx) return [tsx];
  const tsNode = resolveOptional('ts-node/register/transpile-only');
  const tsconfigPaths = resolveOptional('tsconfig-paths/register');
  if (tsNode && tsconfigPaths) return [tsNode, tsconfigPaths];
  throw new Error('no TypeScript loader (tsx or ts-node) is available for the .ply conversion worker');
}

/** Turn a worker 'error' into a reason the scan row can carry — naming the knob when it was the heap cap. */
function describeWorkerDeath(err: Error & { code?: string }, opts: OffLoopConvertOptions): Error {
  if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return new Error(`PLY conversion worker ran out of memory (heap cap ${opts.workerHeapMb} MB, ${PLY_IMPORT_ENV.workerHeapMb})`);
  }
  return new Error(`PLY conversion failed: ${err.message}`);
}

/**
 * @description Convert a stored `.ply` to packed `.splat` bytes in a worker thread so the api's
 * event loop keeps serving while a multi-megabyte parse runs, and so the parse's memory is bounded
 * by `workerHeapMb` instead of by the process. Rejects, never hangs, when the worker dies.
 * @param sourcePath - The stored source file
 * @param ext - Its lower-cased, dotted extension (`.ply`)
 * @param opts - The heap cap for the worker
 * @returns The packed bytes and the gaussian count
 */
export function convertPlyOffLoop(sourcePath: string, ext: string, opts: OffLoopConvertOptions): Promise<OffLoopConvertResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const entry = plyWorkerEntry;
    const preload = loaderPreloads(entry);
    const worker = new Worker(BOOTSTRAP, {
      eval: true,
      workerData: { sourcePath, ext, entry, preload },
      resourceLimits: { maxOldGenerationSizeMb: opts.workerHeapMb },
    });
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      outcome();
    };
    worker.once('message', (msg: PlyWorkerOutput) => settle(() => {
      logger.info({ sourcePath, ext, count: msg.count, ms: Date.now() - started }, 'ply converted off the event loop');
      resolve({ splat: Buffer.from(msg.splat.buffer, msg.splat.byteOffset, msg.splat.byteLength), count: msg.count });
    }));
    worker.once('error', (err: Error & { code?: string }) => settle(() => {
      logger.error({ err, sourcePath, ext, heapMb: opts.workerHeapMb, ms: Date.now() - started }, 'ply conversion worker died');
      reject(describeWorkerDeath(err, opts));
    }));
    worker.once('exit', (code) => settle(() => {
      logger.error({ code, sourcePath, ext, ms: Date.now() - started }, 'ply conversion worker exited without a result');
      reject(new Error(`PLY conversion worker exited with code ${code} before producing a result`));
    }));
  });
}
