/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "The api can boot healthy with ZERO connector tools (ENOMEM)": the process-wide record of what each catalog-backed subsystem actually loaded at boot. Observed live 2026-08-01 — the api booted with `ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'`, registered ZERO connector tools, and served /api/health AND /api/readiness as fine. A capability that silently loaded nothing must not report ready, and readiness cannot know that unless the loader says so. Deliberately generic (any catalog: connector specs, webhook events, …) and deliberately NOT a metric — it is a boot fact readiness reads, and a catalog whose SOURCE was unreadable is degraded even when nobody can say how many entries it should have had.
 */

/**
 * The catalog-load registry — "did this subsystem load its catalog, or nothing at all?"
 *
 * A subsystem that reads a directory of definitions at boot (connector specs, webhook
 * event specs, …) records one entry here per source. Readiness reads the entries and
 * fails when a catalog is DEGRADED: its source was unreadable for a reason other than
 * "it isn't there", or the source offered entries and none of them loaded.
 *
 * The distinction that matters, and the one the ENOMEM incident turned on:
 *   - source missing entirely  → `absent`  — a legitimate deployment shape, NOT a failure.
 *   - source unreadable        → `unreadable` — ENOMEM/EACCES/EMFILE; the box cannot say
 *                                what it should have loaded, which is precisely why it
 *                                must not claim ready.
 *   - source readable, offered N > 0, loaded 0 → `empty` — advertised and dead.
 *
 * @module shared/observability/catalog-load-registry
 */

/** @description How a catalog source resolved at load time. */
export type CatalogSourceState = 'ok' | 'empty' | 'unreadable' | 'absent';

/** @description One subsystem's load outcome for one catalog source. */
export interface CatalogLoadRecord {
  /** Catalog identity, e.g. `connector-specs`. Several sources may share it. */
  catalog: string;
  /** The source that was read (a directory path). */
  source: string;
  state: CatalogSourceState;
  /** Entries the source offered (files matched). 0 when unreadable/absent. */
  discovered: number;
  /** Entries that actually loaded. */
  loaded: number;
  /** Short reason for a non-ok state (error message, truncated). */
  detail?: string;
  /** How many read attempts it took (retry telemetry; 1 = first try). */
  attempts: number;
  recordedAt: string;
}

/** Max characters kept from an error message — details are logged, not stored whole. */
const DETAIL_MAX = 300;

/** Process-wide store, keyed `catalog source` so a re-load overwrites its own entry. */
const records = new Map<string, CatalogLoadRecord>();

/**
 * @description Records (or replaces) one catalog source's load outcome.
 * @param record - The outcome, minus `recordedAt` which is stamped here.
 * @returns The stored record.
 */
export function recordCatalogLoad(record: Omit<CatalogLoadRecord, 'recordedAt'>): CatalogLoadRecord {
  const stored: CatalogLoadRecord = {
    ...record,
    detail: record.detail ? record.detail.slice(0, DETAIL_MAX) : undefined,
    recordedAt: new Date().toISOString(),
  };
  records.set(`${record.catalog} ${record.source}`, stored);
  return stored;
}

/**
 * @description Every recorded catalog-load outcome, newest write per source.
 * @returns A snapshot array (callers may not mutate the registry through it).
 */
export function listCatalogLoads(): CatalogLoadRecord[] {
  return Array.from(records.values());
}

/**
 * @description The records that mean "this capability is advertised and loaded nothing":
 * an unreadable source, or a readable source that offered entries and produced none.
 * `absent` and `ok` are never degraded — a box with no connector directory is a
 * deployment choice, not a defect.
 * @returns The degraded records (empty when every catalog is fine).
 */
export function degradedCatalogs(): CatalogLoadRecord[] {
  return listCatalogLoads().filter((r) => r.state === 'unreadable' || r.state === 'empty');
}

/**
 * @description Clears the registry. Guards only — production never resets boot facts.
 * @returns void
 */
export function resetCatalogLoads(): void {
  records.clear();
}
