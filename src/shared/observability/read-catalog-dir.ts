/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "The api can boot healthy with ZERO connector tools (ENOMEM)": the retrying, loud directory read every catalog loader uses. The shipped loaders did ONE readdirSync inside a try/catch and logged a warn — so a transient `ENOMEM: scandir '/app/swarm-apps/connectors'` during the bot-recreate storm permanently cost the box its entire connector catalog until someone bounced the api. Transient POSIX codes (ENOMEM/EMFILE/ENFILE/EAGAIN/EBUSY/EINTR) now retry with a bounded synchronous backoff (boot-time, before the event loop matters), ENOENT stays a first-class "absent" answer rather than an error, and every outcome — including success — is recorded in the catalog-load registry so readiness can refuse to call the box ready.
 */

/**
 * Resilient catalog-directory read.
 *
 * One `readdirSync` at boot is a single point of failure for a whole capability: the
 * failure is transient, the log line is a warn, and the process then serves traffic
 * advertising a catalog it never loaded. This module makes the read retry, makes the
 * outcome a recorded fact, and keeps "the directory is not there" distinct from "the
 * directory could not be read".
 *
 * @module shared/observability/read-catalog-dir
 */

import { existsSync, readdirSync } from 'node:fs';
import { createChildLogger } from '@/shared/logger';
import { recordCatalogLoad, type CatalogSourceState } from './catalog-load-registry';

const logger = createChildLogger({ module: 'read-catalog-dir' });

/**
 * @description POSIX error codes worth retrying: resource exhaustion and interruption,
 * all of which clear on their own. Everything else (ENOTDIR, EACCES, …) is a standing
 * condition a retry cannot fix, so it fails immediately and loudly.
 */
export const TRANSIENT_DIR_READ_CODES: ReadonlySet<string> = new Set([
  'ENOMEM', 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR',
]);

/** Default attempts for a transient failure (1 initial + 2 retries). */
const DEFAULT_ATTEMPTS = 3;
/** Default pause between attempts, in ms. */
const DEFAULT_BACKOFF_MS = 250;

/** @description Options for {@link readCatalogDir}. */
export interface ReadCatalogDirOptions {
  /** Catalog identity recorded in the registry, e.g. `connector-specs`. */
  catalog: string;
  /** Keep only entries this predicate accepts (e.g. `.yaml` files). */
  filter?: (entry: string) => boolean;
  /** Total attempts on a transient error. Default 3. */
  attempts?: number;
  /** Pause between attempts in ms. Default 250. */
  backoffMs?: number;
  /** Injected for guards; defaults to `fs.readdirSync`. */
  readdir?: (dir: string) => string[];
  /** Injected for guards; defaults to `fs.existsSync`. */
  exists?: (dir: string) => boolean;
  /** Injected for guards so the backoff does not really sleep. */
  sleep?: (ms: number) => void;
}

/** @description What a catalog-directory read produced. */
export interface CatalogDirRead {
  /** Matching entry names (not full paths). Empty on absent/unreadable. */
  entries: string[];
  state: Extract<CatalogSourceState, 'ok' | 'absent' | 'unreadable'>;
  attempts: number;
  detail?: string;
}

/**
 * @description Blocks the current thread for `ms`. Boot-time only — a catalog load
 * happens before the process serves traffic, and an async retry would force every
 * caller of a synchronous loader to become async for a path that almost never runs.
 * @param ms - Milliseconds to pause.
 * @returns void
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @description Reads a catalog directory with bounded retry on transient POSIX errors,
 * and records the outcome so readiness can see a capability that loaded nothing.
 *
 * The caller still records the FINAL load count (how many entries parsed) via
 * `recordCatalogLoad`; this function records the SOURCE read. On `ok` it stores a
 * provisional record with `loaded: 0`, which the caller overwrites once parsing is done —
 * so a loader that reads the directory and then throws away everything still shows up.
 *
 * @param dir - Directory to read.
 * @param options - Catalog identity, filter and injected seams.
 * @returns The matching entries plus the resolved source state.
 */
export function readCatalogDir(dir: string, options: ReadCatalogDirOptions): CatalogDirRead {
  const {
    catalog,
    filter = () => true,
    attempts: maxAttempts = DEFAULT_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    readdir = readdirSync,
    exists = existsSync,
    sleep = sleepSync,
  } = options;

  let attempts = 0;
  let lastError: NodeJS.ErrnoException | null = null;

  while (attempts < Math.max(1, maxAttempts)) {
    attempts += 1;
    try {
      const entries = readdir(dir).filter(filter);
      recordCatalogLoad({ catalog, source: dir, state: 'ok', discovered: entries.length, loaded: 0, attempts });
      return { entries, state: 'ok', attempts };
    } catch (error) {
      lastError = error as NodeJS.ErrnoException;
      const code = lastError.code ?? '';
      if (code === 'ENOENT' || !exists(dir)) {
        // Not a failure: a deployment that ships no catalog of this kind.
        recordCatalogLoad({ catalog, source: dir, state: 'absent', discovered: 0, loaded: 0, attempts, detail: 'directory not present' });
        return { entries: [], state: 'absent', attempts, detail: 'directory not present' };
      }
      if (!TRANSIENT_DIR_READ_CODES.has(code) || attempts >= Math.max(1, maxAttempts)) break;
      logger.warn(
        { catalog, dir, code, attempt: attempts, of: maxAttempts },
        'Catalog directory read hit a transient error — retrying (a one-shot read is how a whole capability silently loads nothing)',
      );
      sleep(backoffMs);
    }
  }

  const detail = `${lastError?.code ?? 'ERR'}: ${lastError?.message ?? 'unreadable'}`;
  logger.error(
    { catalog, dir, code: lastError?.code, attempts, err: lastError },
    'Catalog directory UNREADABLE after retries — this capability has loaded nothing and the box is NOT ready',
  );
  recordCatalogLoad({ catalog, source: dir, state: 'unreadable', discovered: 0, loaded: 0, attempts, detail });
  return { entries: [], state: 'unreadable', attempts, detail };
}
