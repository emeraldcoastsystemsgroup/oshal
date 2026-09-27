/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded, redacted applied authorization history under current application and tenant authority.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Read actor-bound previews before approval and writer-lock acquisition.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: an assignment may carry `grantSource`, the provenance of a kernel-written grant (today only `service-activation:<id>`). `source` stays the app's installation source because matchingAssignments binds on it; the tag is what lets a deactivation revoke exactly the assignments its activation created.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07: durable catalog snapshots keyed by catalog revision (so an upgrade can classify the catalog its assignments were granted under after the old files are gone), reviewable catalog migration records in the locked policy state, a transaction port that records the activating catalog, and a `catalog-migration` audit event carrying who, when, from/to revision and the change summary.
 */
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationCatalogChange, AuthorizationChange, AuthorizationPreview, AuthorizationReceipt } from '@/shared/application-authorization';
export interface AuthorizationAssignment {
  id: string; app: string; source: string; catalogRevision: string;
  /** ADR-157 provenance of a kernel-written grant, e.g. `service-activation:<activation id>`.
   *  Absent on every assignment an administrator made through /access. Never an authority: it
   *  identifies which act created the row so exactly that act can undo it. */
  grantSource?: string;
  targetSub?: string; targetIssuer?: string; tenantId?: string;
  group?: { issuer: string; tenantId: string; id: string };
  role?: string; permission?: string; deny: boolean; expiresAt?: string;
}
export interface StoredAuthorizationPreview extends AuthorizationPreview {
  actor: { sub: string; issuer: string }; receipt?: AuthorizationReceipt; idempotencyKey?: string;
}
export interface AuthorizationState {
  revision: number; assignments: AuthorizationAssignment[]; previews: StoredAuthorizationPreview[];
  /** AUTH-07 reviewable catalog migrations. Loaded with the writer lock; absent on unlocked reads. */
  migrations?: StoredCatalogMigration[];
}
/** The catalog one application was registered with, keyed by the revision it hashes to. */
export interface AuthorizationCatalogSnapshot {
  catalogRevision: string; app: string; source: string; version: string;
  catalog: AuthorizationCatalog | null; mountPaths: string[];
}
/** A reviewable migration an installation refusal created, and its approval once applied. */
export interface StoredCatalogMigration {
  id: string; app: string; source: string; fromRevisions: string[]; fromVersions: string[];
  toRevision: string; toVersion: string; classification: 'widening' | 'breaking';
  changes: AuthorizationCatalogChange[]; omittedChanges: number;
  /** Stale assignments the migration re-stamps and, of those, the grants it removes. */
  assignmentIds: string[]; removedIds: string[];
  /** Roles sensitive in either catalog; decide whether applying needs an approval reference. */
  sensitiveRoles: string[];
  createdAt: string; expiresAt: string;
  approval?: { actor: { sub: string; issuer: string }; at: string; idempotencyKey: string; revision: number };
  appliedAt?: string; appliedRevision?: number;
}
/** What one catalog migration did, recorded in the applied-change history. */
export interface AuthorizationCatalogMigrationAudit {
  source: string; fromRevisions: string[]; fromVersions: string[]; toRevision: string; toVersion: string;
  classification: 'non-widening' | 'widening' | 'breaking'; changes: AuthorizationCatalogChange[]; omittedChanges: number;
  assignmentIds: string[]; removedIds: string[]; reviewId?: string; approvedBy?: { sub: string; issuer: string };
}
export interface AuthorizationAudit {
  id: string; actor: Pick<AuthorizationActor, 'sub' | 'issuer'>; at: string;
  change: Omit<AuthorizationChange, 'action'> & { action: AuthorizationChange['action'] | 'catalog-migration' };
  revision: number; previewId: string; migration?: AuthorizationCatalogMigrationAudit;
}
export interface AuthorizationTransaction {
  state: AuthorizationState; audit(event: AuthorizationAudit): void;
  /** Record the catalog an application activates with; committed with the transaction. */
  catalog(snapshot: AuthorizationCatalogSnapshot): void;
}
export interface AuthorizationStore {
  /** Content-addressed catalog snapshots for the given revisions; unknown revisions are omitted. */
  readCatalogSnapshots(revisions: readonly string[]): Promise<AuthorizationCatalogSnapshot[]>;
  /** Reviewable catalog migrations, filtered by application and/or id, without the writer lock. */
  readCatalogMigrations(filter: { app?: string; id?: string }): Promise<StoredCatalogMigration[]>;
  /** Read one preview without holding the policy writer lock during approval or account refresh. */
  readPreview(id: string): Promise<StoredAuthorizationPreview | null>;
  readAudit(input: AuthorizationAuditQuery): Promise<{ events: AuthorizationAudit[]; snapshotRevision: number }>;
  publishAppPosture(app: string, protectedApp: boolean, agentIds: readonly string[], toolNames?: readonly string[]): Promise<void>;
  read(): Promise<AuthorizationState>;
  transaction<T>(operation: (transaction: AuthorizationTransaction) => Promise<T>): Promise<T>;
}
/** @description Internal repository query after service authorization; never constructed from a request actor. */
export interface AuthorizationAuditQuery {
  app?: string; tenantId?: string; limit: number; snapshotRevision?: number;
  before?: { revision: number; id: string };
}
/** Structured expected denial; HTTP/tool adapters should preserve status/code, not expose stacks. */
export class ApplicationAuthorizationError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); this.name = 'ApplicationAuthorizationError'; }
}
