/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-057 scaffold: Personal Data Vault layout (per-user, sovereign, exportable)
 */

/**
 * The Personal Data Vault (ADR-057 §6) — the user's data on their own storage.
 *
 * One vault per user, rooted at a storage root. Default = the platform's per-tenant encrypted
 * partition (the existing career-hunter / ownerSub dir pattern); PLUGGABLE to the user's own storage
 * (their device, their bucket) without a schema change — just a different root resolver.
 *
 * Sole accessor is the broker (ADR-056). No bot holds vault creds directly. The vault is EXPORTABLE
 * (graph + vectors + metrics + manifest) — portability is the sovereignty promise.
 */
import path from 'path';

/** Where a user's vault physically lives + the names of its three stores. */
export interface VaultLayout {
  /** Root dir for this user's vault (under the resolved store root). */
  vaultDir: string;
  /** Graph partition key — the per-user tier of the ADR-045 two-tier graph. */
  graphPartition: string;
  /** Chroma collection holding this user's unstructured chunks. */
  vectorCollection: string;
  /** Namespace/prefix for this user's rows in the metric/feature store. */
  metricNamespace: string;
  /** Path to the exportable vault manifest (portability bundle index). */
  manifestPath: string;
}

/**
 * Resolve a user's vault layout. `storeRoot` defaults to the platform per-tenant partition; pass a
 * user-owned root to put their data on their own storage.
 * @param storeRoot - Base storage root (platform partition or the user's own).
 * @param tenant - Tenant id (default 'default').
 * @param ownerSub - The user's OIDC sub — the vault owner + the broker's scope handle.
 */
export function resolveVault(storeRoot: string, tenant: string, ownerSub: string): VaultLayout {
  const vaultDir = path.join(storeRoot, tenant, ownerSub, 'vault');
  return {
    vaultDir,
    graphPartition: `pkg:${ownerSub}`,                 // personal knowledge graph partition
    vectorCollection: `vault_${ownerSub}`,
    metricNamespace: ownerSub,
    manifestPath: path.join(vaultDir, 'vault.manifest.json'),
  };
}

/** The exportable bundle shape — what "take your world and leave" produces (ADR-057 §6). */
export interface VaultExportManifest {
  ownerSub: string;
  tenant: string;
  schemaVersion: string;
  exportedAt: string;
  counts: { entities: number; edges: number; vectors: number; metrics: number };
  files: {
    graph: string;     // node/edge dump (e.g. graph.jsonl)
    vectors: string;   // embeddings + chunk metadata (e.g. vectors.jsonl)
    metrics: string;   // metric rows (e.g. metrics.jsonl)
  };
  /** World refs this vault points at — referenced, NOT included (world data is shared/read-only). */
  worldRefs: string[];
}

/** Current personal-schema version (bump when the ontology changes shape, for export compatibility). */
export const PERSONAL_SCHEMA_VERSION = '0.1.0';
