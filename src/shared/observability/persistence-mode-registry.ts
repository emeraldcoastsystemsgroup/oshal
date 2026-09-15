/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | BACKLOG "One slow boot drops the task, message and memory stores to in-memory for the life of the process": the process-wide record of which durable stores are actually durable right now. Observed live 2026-09-15 - three stores lost one pool acquire during the boot migration burst, fell back to memory, and the ONLY signal was three ERROR lines in a boot log nobody reads. A store that is advertised as durable and is serving from memory has to be visible where an operator looks, not only where a log rotates.
 */

/**
 * The persistence-mode registry - "is this store durable right now, or is it a Map?"
 *
 * A store that can fall back to in-memory storage records one entry here per store and
 * updates it on every mode change. Readiness reads the entries and fails when a store is
 * DEGRADED: Postgres is configured for it and it is nevertheless serving from memory.
 *
 * The distinction that matters, and the one the 2026-09-15 boot turned on:
 *   - no Postgres configured   -> `unconfigured` - a deliberate deployment shape (a box with
 *                                 no database), NOT a failure.
 *   - configured and durable   -> `persistent`.
 *   - configured and in memory -> `memory` - advertised durable, writing to a Map that dies
 *                                 with the process. This is the state that must be visible.
 *
 * Deliberately a boot/runtime FACT rather than a metric: readiness reads it directly, and it
 * carries the attempt count and the last failure so the reason is on the line.
 *
 * @module shared/observability/persistence-mode-registry
 */

/** @description How one store's storage resolved at the time it was last recorded. */
export type PersistenceMode = 'persistent' | 'memory' | 'unconfigured';

/** @description One store's current storage mode. */
export interface PersistenceModeRecord {
  /** Store identity, e.g. `task-store`. One entry per store; a mode change overwrites it. */
  store: string;
  mode: PersistenceMode;
  /** Activation attempts made so far (0 = never attempted, e.g. `unconfigured`). */
  attempts: number;
  /** Short reason the store is in memory (last activation error, truncated). */
  detail?: string;
  recordedAt: string;
}

/** Max characters kept from an error message - details are logged whole, stored short. */
const DETAIL_MAX = 300;

/** Process-wide store, keyed by store identity so a mode change overwrites its own entry. */
const records = new Map<string, PersistenceModeRecord>();

/**
 * @description Records (or replaces) one store's current persistence mode.
 * @param record - The mode, minus `recordedAt` which is stamped here.
 * @returns The stored record.
 */
export function recordPersistenceMode(record: Omit<PersistenceModeRecord, 'recordedAt'>): PersistenceModeRecord {
  const stored: PersistenceModeRecord = {
    ...record,
    detail: record.detail ? record.detail.slice(0, DETAIL_MAX) : undefined,
    recordedAt: new Date().toISOString(),
  };
  records.set(record.store, stored);
  return stored;
}

/**
 * @description Every store's current persistence mode.
 * @returns A snapshot array (callers may not mutate the registry through it).
 */
export function listPersistenceModes(): PersistenceModeRecord[] {
  return Array.from(records.values());
}

/**
 * @description The records that mean "this store is advertised durable and is not":
 * Postgres is configured for it and it is serving from memory. `unconfigured` is never
 * degraded - a box with no database is a deployment choice, not a defect.
 * @returns The degraded records (empty when every configured store is persistent).
 */
export function degradedPersistence(): PersistenceModeRecord[] {
  return listPersistenceModes().filter((r) => r.mode === 'memory');
}

/**
 * @description Clears the registry. Guards only - production never resets runtime facts.
 * @returns void
 */
export function resetPersistenceModes(): void {
  records.clear();
}
