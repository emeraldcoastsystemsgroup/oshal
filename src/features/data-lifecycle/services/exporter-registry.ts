/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Data-lifecycle exporter registry: the uniform export/delete contract over every per-user store (DataExporter), honest per-store aggregation for GET /api/me/export (a failing store is FLAGGED in the manifest, never silently dropped and never a whole-export 500), the two-step delete executor, and the operator-sub refusal guard (OSHAL_OPERATOR_SUBS/EMAILS accounts can never be self-service-deleted).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (honesty gap): KnownDataGap contract + manifest.knownGaps — per-user data the platform holds that this surface does NOT yet export/delete (Chroma collections, Arango person graph, ...) is now declared IN the bundle and in the delete responses instead of living only in builder notes.
 */

/**
 * The exporter registry is the single inventory of the per-user data the platform holds.
 * Each store registers one {@link DataExporter}; the /api/me surface only ever talks to the
 * registry, so adding a new per-user store = adding one exporter entry, nothing else.
 *
 * Design rules (workstream contract):
 *  - Export is honest: per-store failures are recorded in the manifest with the error,
 *    not swallowed and not fatal to the other stores.
 *  - Delete is opt-in per store (`deletable`): a store too risky to delete mechanically
 *    stays export-only and its skip reason is reported in the outcome — honestly flagged.
 *  - Operator accounts (the OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS allowlist) are
 *    REFUSED deletion outright — losing the operator would orphan the deployment.
 *
 * @module features/data-lifecycle/services/exporter-registry
 */

import { createChildLogger } from '@/shared/logger';
import { isOperatorIdentity } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'data-lifecycle:registry' });

/**
 * @description One per-user store's export/delete contract. `exportRows` returns every row
 * the given user owns in that store (already sanitized — e.g. connector tokens are NEVER
 * included); `deleteRows` (present only when `deletable`) removes them and returns how many
 * went away. Both are scoped by the caller-supplied `userSub` — the registry never widens scope.
 */
export interface DataExporter {
  /** Stable store key — becomes the JSON section name in the export bundle. */
  store: string;
  /** Human sentence: what this store holds and any export caveat (e.g. "tokens excluded"). */
  describe: string;
  /** False = export-only; the delete pass reports it as skipped with {@link deleteNote}. */
  deletable: boolean;
  /** Why this store is export-only (required reading when deletable=false). */
  deleteNote?: string;
  /**
   * @description Read every row this user owns in the store.
   * @param userSub - The owner's OIDC subject.
   * @returns The user's rows, sanitized for export.
   */
  exportRows(userSub: string): Promise<unknown[]>;
  /**
   * @description Delete every row this user owns in the store (only when deletable).
   * @param userSub - The owner's OIDC subject.
   * @returns Number of rows/files removed.
   */
  deleteRows?(userSub: string): Promise<number>;
}

/** One store's line in the export manifest — success or an honestly-reported failure. */
export interface StoreExportEntry {
  store: string;
  describe: string;
  deletable: boolean;
  deleteNote?: string;
  ok: boolean;
  count: number;
  error?: string;
}

/**
 * @description One honestly-declared coverage gap: per-user data the platform holds in a store
 * this surface does not yet export or delete. Declared in the export manifest AND in both
 * delete responses so "success" never implies these were touched.
 */
export interface KnownDataGap {
  /** Stable identifier for the uncovered store (e.g. 'chromadb_collections'). */
  store: string;
  /** What per-user data lives there. */
  holds: string;
  /** Why it is not covered yet / what happens to it. */
  status: string;
}

/** The full export payload: manifest + one rows section per store. */
export interface ExportBundle {
  manifest: {
    generatedAt: string;
    userSub: string;
    stores: StoreExportEntry[];
    counts: Record<string, number>;
    /** Stores the platform holds that this bundle does NOT cover — the honesty contract. */
    knownGaps: KnownDataGap[];
  };
  stores: Record<string, unknown[]>;
}

/** What happened to one store during the delete pass. */
export interface StoreDeleteOutcome {
  store: string;
  action: 'deleted' | 'skipped' | 'failed';
  deleted?: number;
  reason?: string;
  error?: string;
}

/**
 * @description Run every exporter for one user and assemble the export bundle. Per-store
 * failures (missing table, unreadable file) are logged at ERROR and recorded in the manifest
 * entry (`ok:false`, `error`) so the download is honest about gaps instead of failing whole
 * or silently omitting a store.
 * @param exporters - The registered exporters, in registry order.
 * @param userSub - The exporting user's OIDC subject (self-scope only — the route enforces it).
 * @param knownGaps - Uncovered stores to declare in the manifest (honesty contract; default none).
 * @returns The bundle: manifest {generatedAt, stores, counts, knownGaps} + per-store row sections.
 */
export async function buildExportBundle(exporters: DataExporter[], userSub: string, knownGaps: KnownDataGap[] = []): Promise<ExportBundle> {
  const stores: Record<string, unknown[]> = {};
  const entries: StoreExportEntry[] = [];
  const counts: Record<string, number> = {};
  for (const exporter of exporters) {
    const base = {
      store: exporter.store,
      describe: exporter.describe,
      deletable: exporter.deletable,
      ...(exporter.deleteNote ? { deleteNote: exporter.deleteNote } : {}),
    };
    try {
      const rows = await exporter.exportRows(userSub);
      stores[exporter.store] = rows;
      counts[exporter.store] = rows.length;
      entries.push({ ...base, ok: true, count: rows.length });
    } catch (err) {
      logger.error({ err, store: exporter.store, stack: (err as Error).stack }, 'export failed for store');
      stores[exporter.store] = [];
      counts[exporter.store] = 0;
      entries.push({ ...base, ok: false, count: 0, error: (err as Error).message });
    }
  }
  return {
    manifest: { generatedAt: new Date().toISOString(), userSub, stores: entries, counts, knownGaps },
    stores,
  };
}

/**
 * @description Execute the delete pass over every registered store for one user. Export-only
 * stores are skipped with their deleteNote (honest flag); a store whose delete throws is
 * reported as failed with the error, and the pass CONTINUES so one bad store can't leave the
 * rest of the account half-deleted silently. Every outcome is logged.
 * @param exporters - The registered exporters, in registry order (children before parents).
 * @param userSub - The user whose data is being deleted (already confirmed via signed token).
 * @returns One outcome per store, in registry order.
 */
export async function executeDeleteAll(exporters: DataExporter[], userSub: string): Promise<StoreDeleteOutcome[]> {
  const outcomes: StoreDeleteOutcome[] = [];
  for (const exporter of exporters) {
    if (!exporter.deletable || !exporter.deleteRows) {
      const reason = exporter.deleteNote ?? 'export-only store';
      logger.info({ store: exporter.store, userSub, reason }, 'delete pass: store skipped (export-only)');
      outcomes.push({ store: exporter.store, action: 'skipped', reason });
      continue;
    }
    try {
      const deleted = await exporter.deleteRows(userSub);
      logger.info({ store: exporter.store, userSub, deleted }, 'delete pass: store deleted');
      outcomes.push({ store: exporter.store, action: 'deleted', deleted });
    } catch (err) {
      logger.error({ err, store: exporter.store, userSub, stack: (err as Error).stack }, 'delete pass: store FAILED');
      outcomes.push({ store: exporter.store, action: 'failed', error: (err as Error).message });
    }
  }
  return outcomes;
}

/**
 * @description The operator-refusal guard: self-service deletion is REFUSED for any account on
 * the OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS allowlist — deleting the operator would orphan
 * the deployment (nobody left to administer it), so it must be an out-of-band decision, never a
 * two-click API call. Returns the human-readable refusal reason, or null when deletion may proceed.
 * @param sub - The caller's OIDC subject.
 * @param email - The caller's email (the allowlist also matches emails).
 * @returns Refusal reason string, or null when the account is deletable.
 */
export function isDeleteRefused(sub: string | null, email: string | null): string | null {
  if (isOperatorIdentity(sub, email)) {
    return 'This account is on the operator allowlist (OSHAL_OPERATOR_SUBS/OSHAL_OPERATOR_EMAILS). Operator accounts cannot be deleted via self-service — remove it from the allowlist first, or handle deletion out-of-band.';
  }
  return null;
}
