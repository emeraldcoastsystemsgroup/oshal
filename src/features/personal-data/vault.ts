/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-057 scaffold: Personal Data Vault layout (per-user, sovereign, exportable)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Map exact OIDC subjects to bound digest directories beneath a validated tenant root, retain only unambiguous link-free legacy directories, and reject linked vault leaves.
 */

/**
 * The Personal Data Vault (ADR-057 section 6) is the user's data on their own storage.
 *
 * One vault exists per exact user identity. The physical owner component is a fixed-length digest,
 * while logical graph/vector/metric scopes retain the exact OIDC subject. A pluggable store root can
 * point at the platform partition or user-owned storage without changing the schema.
 */
import path from 'path';
import {
  resolveExactSubjectStoreDirectory,
  resolveLinkFreeStoreSubdirectory,
} from '@/shared/security/exact-subject-store';

/** @description Where an exact user's vault physically lives and the names of its three stores. */
export interface VaultLayout {
  /** Absolute configured storage root. */
  storeRoot: string;
  /** Validated tenant component used to re-verify the layout before opening storage. */
  tenant: string;
  /** Canonical or conservatively accepted legacy owner directory. */
  subjectDir: string;
  /** Root dir for this user's vault under the resolved exact-owner directory. */
  vaultDir: string;
  /** Graph partition key for the per-user tier of the two-tier graph. */
  graphPartition: string;
  /** Chroma collection holding this user's unstructured chunks. */
  vectorCollection: string;
  /** Namespace/prefix for this user's rows in the metric/feature store. */
  metricNamespace: string;
  /** Path to the exportable vault manifest. */
  manifestPath: string;
}

/**
 * @description Resolve an exact user's vault layout without creating it. Opaque subjects never
 * become raw path syntax; a safe exact-name legacy directory remains readable only while no
 * canonical alias exists.
 * @param storeRoot - Base storage root, either a platform partition or user-owned location.
 * @param tenant - Portable tenant identifier.
 * @param ownerSub - The user's exact OIDC subject and broker scope handle.
 * @returns The owner-bound filesystem and logical store layout.
 */
export function resolveVault(storeRoot: string, tenant: string, ownerSub: string): VaultLayout {
  const subjectStore = resolveExactSubjectStoreDirectory(storeRoot, tenant, ownerSub);
  const vaultDir = resolveLinkFreeStoreSubdirectory(subjectStore.subjectDir, 'vault');
  return {
    storeRoot: subjectStore.storeRoot,
    tenant,
    subjectDir: subjectStore.subjectDir,
    vaultDir,
    graphPartition: `pkg:${ownerSub}`,
    vectorCollection: `vault_${ownerSub}`,
    metricNamespace: ownerSub,
    manifestPath: path.join(vaultDir, 'vault.manifest.json'),
  };
}

/** @description The exportable bundle shape produced by the vault portability boundary. */
export interface VaultExportManifest {
  /** Exact owner identity represented by the export. */
  ownerSub: string;
  /** Tenant whose private partition holds the vault. */
  tenant: string;
  /** Personal-schema version needed by an importer. */
  schemaVersion: string;
  /** ISO timestamp at which the bundle was assembled. */
  exportedAt: string;
  /** Logical record counts included in the bundle. */
  counts: { entities: number; edges: number; vectors: number; metrics: number };
  /** Relative data files carried by the bundle. */
  files: {
    graph: string;
    vectors: string;
    metrics: string;
  };
  /** Shared world references the private vault points at but does not copy. */
  worldRefs: string[];
}

/** @description Current personal-schema version used for export compatibility. */
export const PERSONAL_SCHEMA_VERSION = '0.1.0';
