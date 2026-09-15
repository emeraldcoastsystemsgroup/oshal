/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Worker-thread entry for the .ply -> .splat conversion. Runs convertToSplat over the stored source in its own V8 isolate (spawned by ply-convert-host under a resourceLimits heap cap) so a large import can neither block the api's event loop nor take the process down: an out-of-memory here ends this thread only, and the host turns it into a failed scan with the reason. The packed bytes travel back as a transferred ArrayBuffer (one copy, never a structured clone of a multi-megabyte Buffer). The module exports its own file path as the worker entry and runs the conversion only off the main thread, so the host's value import both locates the entry for every runtime (compiled dist .js, ts-node, tsx, vitest) and guarantees tsc emits this file. No parse error is caught on purpose: an uncaught throw reaches the host's 'error' listener with its message intact.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { convertToSplat } from './import-format';

/** What the host hands the worker: the stored source file and its lower-cased, dotted extension. */
export interface PlyWorkerInput {
  sourcePath: string;
  ext: string;
}

/** What the worker posts back: the packed .splat bytes (transferred) and the gaussian count. */
export interface PlyWorkerOutput {
  splat: Uint8Array;
  count: number;
}

/**
 * @description The path of this module in the runtime that loaded it — `.js` under the compiled
 * dist, `.ts` under ts-node/tsx/vitest — which is exactly what `new Worker()` must be pointed at.
 */
export const plyWorkerEntry: string = __filename;

/** Read, convert, and hand the packed bytes back to the host thread. */
function run(input: PlyWorkerInput): void {
  const { buffer, count } = convertToSplat(readFileSync(input.sourcePath), input.ext);
  const splat = new Uint8Array(buffer.byteLength);
  splat.set(buffer);
  const out: PlyWorkerOutput = { splat, count };
  parentPort?.postMessage(out, [splat.buffer]);
}

if (!isMainThread && parentPort) {
  run(workerData as PlyWorkerInput);
}
