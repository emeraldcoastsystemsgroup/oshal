/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The .ply import limits, read from the environment through the slice's resolver pattern (the same shape as resolveScansRoot): the byte gate a .ply upload is refused above (OSHAL_SPACES_PLY_MAX_BYTES, default 50 MiB) and the heap cap of the conversion worker (OSHAL_SPACES_PLY_WORKER_HEAP_MB, default 1024 MiB). A 117 MB .ply converted on the api's event loop collapsed the 7 GB Docker VM on 2026-09-14 and a 44 MB one blocked the loop for 14 s. The store's spaces route (the 413 while the upload streams) and the import engine (the worker cap and its own refusal) both read the numbers from here, so neither carries them as a literal.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'import-limits' });

/** Environment variable names the resolver reads — exported so refusals can name the knob. */
export const PLY_IMPORT_ENV = {
  maxBytes: 'OSHAL_SPACES_PLY_MAX_BYTES',
  workerHeapMb: 'OSHAL_SPACES_PLY_WORKER_HEAP_MB',
} as const;

/** Defaults when the environment is silent: a 50 MiB .ply gate and a 1 GiB conversion-worker heap. */
export const PLY_IMPORT_DEFAULTS = {
  plyMaxBytes: 50 * 1024 * 1024,
  workerHeapMb: 1024,
} as const;

/** The resolved limits: the .ply byte gate and the conversion worker's old-generation heap cap (MiB). */
export interface PlyImportLimits {
  plyMaxBytes: number;
  workerHeapMb: number;
}

/** Parse one positive-integer knob; a missing value is the default, a malformed one is logged and defaulted. */
function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn({ name, raw, fallback }, 'ignoring a non-positive-integer import limit; using the default');
    return fallback;
  }
  return value;
}

/**
 * @description Resolve the .ply import limits from the environment. Read at the point of use
 * (per upload, per conversion) rather than cached at module load, so an operator change to the
 * env takes effect on the next request and a test can exercise both sides of the gate in one
 * process.
 * @param env - The environment to read (defaults to process.env; tests pass an explicit object)
 * @returns The byte gate for a .ply upload and the heap cap for its conversion worker
 */
export function resolvePlyImportLimits(env: NodeJS.ProcessEnv = process.env): PlyImportLimits {
  return {
    plyMaxBytes: positiveInteger(PLY_IMPORT_ENV.maxBytes, env[PLY_IMPORT_ENV.maxBytes], PLY_IMPORT_DEFAULTS.plyMaxBytes),
    workerHeapMb: positiveInteger(PLY_IMPORT_ENV.workerHeapMb, env[PLY_IMPORT_ENV.workerHeapMb], PLY_IMPORT_DEFAULTS.workerHeapMb),
  };
}

/**
 * @description Render a byte limit the way an operator reads it ("50 MB", "1.5 MB", "256 KB"),
 * binary units, so a 413 body and a failed-scan reason name the limit rather than a raw number.
 * @param bytes - The limit in bytes
 * @returns A short human label
 */
export function formatByteLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MB`;
  const kib = bytes / 1024;
  if (kib >= 1) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KB`;
  return `${bytes} bytes`;
}
