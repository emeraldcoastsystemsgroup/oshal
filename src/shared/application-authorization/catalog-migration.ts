/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07 reviewed catalog migration contract: the classified difference between two imported permission catalogs, the reviewable migration record an installation refusal produces, and the receipt its approval returns. Types only; the classifier and the lifecycle live in the application-authorization feature.
 */
import type { AuthorizationBindingKind } from './types';

/**
 * What one catalog difference does to the assignments that already exist.
 * - `additive`: something new that no existing assignment reaches without an operation being
 *   bound to permissions the previous catalog already defined.
 * - `narrowing`: an existing grant can do less (an operation became unbound or requires more).
 * - `widening`: an existing grant could do more, or the catalog gained a permission or role.
 * - `breaking`: an existing grant loses a meaning a reviewer has to map (removed, renamed or
 *   re-scoped permission, role or resource).
 */
export type AuthorizationCatalogChangeEffect = 'additive' | 'narrowing' | 'widening' | 'breaking';

/** One classified difference between the previous and the next catalog. */
export interface AuthorizationCatalogChange {
  area: 'catalog' | 'resource' | 'permission' | 'role' | 'binding';
  /** Resource, permission or role name; binding id (`METHOD /path` for HTTP). */
  id: string;
  kind?: AuthorizationBindingKind;
  change: 'added' | 'removed' | 'changed';
  effect: AuthorizationCatalogChangeEffect;
  /** Plain explanation for the reviewer. Names catalog identifiers only, never assignment targets. */
  detail: string;
}

/**
 * The whole difference. `non-widening` carries existing assignments without review;
 * `widening` and `breaking` require an administrator to apply a reviewed migration.
 */
export interface AuthorizationCatalogDiff {
  classification: 'unchanged' | 'non-widening' | 'widening' | 'breaking';
  changes: AuthorizationCatalogChange[];
}

/** A reviewable catalog migration, created when an installation refused a changed catalog. */
export interface AuthorizationCatalogMigrationPreview {
  previewId: string;
  app: string;
  /** Catalog revisions the existing assignments are stamped with. */
  fromRevisions: string[];
  /** The package versions last registered at those revisions, when recorded. */
  fromVersions: string[];
  toRevision: string;
  toVersion: string;
  classification: 'widening' | 'breaking';
  changes: AuthorizationCatalogChange[];
  /** Changes beyond the stored bound; the classification still covers all of them. */
  omittedChanges: number;
  /** Assignments the migration re-stamps; a count, so the preview names no subject. */
  affectedAssignments: number;
  /** Grants the next catalog no longer defines. Removed on activation so they can never revive. */
  removedGrants: number;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'applied' | 'expired';
  approvedAt?: string;
  appliedRevision?: number;
}

/** Approval of one reviewed migration. The re-stamp itself happens when the package activates. */
export interface AuthorizationCatalogMigrationReceipt {
  previewId: string;
  app: string;
  toRevision: string;
  approved: true;
  approvedAt: string;
  /** Policy revision observed at approval; activation bumps it when it re-stamps. */
  revision: number;
}
