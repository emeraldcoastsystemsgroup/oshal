/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07 catalog migration lifecycle. When an installation activates a catalog revision its existing assignments were not granted under, classify the change against the recorded previous catalog: a non-widening change re-stamps the assignments inside the policy transaction with a durable audit event; a widening or breaking change keeps the refusal and records one reviewable migration an administrator approves before the next activation applies it. Grants the next catalog does not define are removed rather than carried, so they can never revive.
 */
import { randomUUID } from 'node:crypto';
import {
  applicationManagementRole, validateAuthorizationCatalog,
  type AuthorizationCatalog, type AuthorizationCatalogChange, type AuthorizationCatalogDiff,
  type AuthorizationCatalogMigrationPreview,
} from '@/shared/application-authorization';
import { createChildLogger } from '@/shared/logger';
import { diffAuthorizationCatalogs } from './catalog-diff';
import { APP_ADMIN_ROLE, catalogRevision, type RegisteredAuthorizationApp } from './policy';
import {
  ApplicationAuthorizationError, type AuthorizationAssignment, type AuthorizationCatalogSnapshot,
  type AuthorizationState, type AuthorizationTransaction, type StoredCatalogMigration,
} from './types';

const logger = createChildLogger({ module: 'authorization-catalog-migration' });
/** The principal an installation-time re-stamp is attributed to when no reviewer approved it. */
export const CATALOG_MIGRATION_INSTALLER = Object.freeze({ sub: 'oshal-package-installer', issuer: 'oshal:installer' });
/** How long a pending review, or an approval awaiting activation, stays usable. */
export const CATALOG_MIGRATION_REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound on stored change entries; the classification still covers every change. */
const MAX_STORED_CHANGES = 200;
/** Bound on retained reviews per application; the audit history keeps every applied migration. */
const MAX_REVIEWS_PER_APP = 20;

/** What an activation must do about assignments stamped with another catalog revision. */
export interface CatalogMigrationPlan {
  status: 'current' | 'migrate' | 'refuse-source' | 'review';
  fromRevisions: string[]; fromVersions: string[]; diff: AuthorizationCatalogDiff;
  assignmentIds: string[]; removedIds: string[]; sensitiveRoles: string[];
  approved?: StoredCatalogMigration;
}

/** The installation refused a catalog change; the message names the review to approve. */
export class CatalogMigrationRequiredError extends ApplicationAuthorizationError {
  constructor(readonly previewId: string | null, readonly classification: string, app: string) {
    super(409, 'authorization_catalog_migration_required');
    this.message = previewId
      ? `authorization_catalog_migration_required: ${classification} catalog change for ${app} awaits review ${previewId} (GET /api/authorization/catalog-migrations?app=${app}, then POST /api/authorization/catalog-migrations/apply)`
      : `authorization_catalog_migration_required: ${app} assignments belong to a different installation source`;
  }
}

/**
 * @description Keep only snapshots whose content still hashes to the revision they are filed
 * under, for this application and source, with a catalog the current contract accepts.
 * @param snapshots - Rows read from the store.
 * @param app - The registration being activated.
 * @returns Verified snapshots keyed by catalog revision.
 */
export function verifiedSnapshots(snapshots: AuthorizationCatalogSnapshot[], app: RegisteredAuthorizationApp): Map<string, AuthorizationCatalogSnapshot> {
  const verified = new Map<string, AuthorizationCatalogSnapshot>();
  for (const snapshot of snapshots) {
    try {
      if (snapshot.app !== app.app || snapshot.source !== app.source) continue;
      const catalog = snapshot.catalog === null ? null : validateAuthorizationCatalog(snapshot.catalog);
      if (catalogRevision({ app: snapshot.app, source: snapshot.source, version: snapshot.version, catalog, mode: 'enforce' }) !== snapshot.catalogRevision) continue;
      verified.set(snapshot.catalogRevision, { ...snapshot, catalog, mountPaths: Array.isArray(snapshot.mountPaths) ? [...snapshot.mountPaths] : [] });
    } catch (error) { logger.error({ err: error, app: app.app }, 'Recorded catalog snapshot failed validation; treating it as unrecorded'); }
  }
  return verified;
}

/**
 * @description The catalog revisions this application's same-source assignments are stamped with,
 * other than the one being activated. These are the snapshots a plan needs.
 * @param state - Current policy snapshot. @param app - Registration being activated.
 * @returns Distinct stale revisions, sorted.
 */
export function staleCatalogRevisions(state: AuthorizationState, app: RegisteredAuthorizationApp): string[] {
  return [...new Set(state.assignments.filter(row => row.app === app.app && row.source === app.source
    && row.catalogRevision !== app.catalogRevision).map(row => row.catalogRevision))].sort();
}

/**
 * @description Decide what activating `app` does to the assignments already stored for it.
 * @param state - Policy snapshot; `migrations` present only under the writer lock.
 * @param app - The registration being activated, with its catalog revision.
 * @param snapshots - Verified previous catalogs keyed by revision.
 * @param now - Current clock in milliseconds.
 * @returns `current` (nothing to do), `migrate` (re-stamp now), `refuse-source` or `review`.
 */
export function planCatalogMigration(state: AuthorizationState, app: RegisteredAuthorizationApp,
  snapshots: Map<string, AuthorizationCatalogSnapshot>, now: number): CatalogMigrationPlan {
  const rows = state.assignments.filter(row => row.app === app.app);
  const empty: CatalogMigrationPlan = { status: 'current', fromRevisions: [], fromVersions: [], diff: { classification: 'unchanged', changes: [] },
    assignmentIds: [], removedIds: [], sensitiveRoles: [] };
  if (rows.some(row => row.source !== app.source)) return { ...empty, status: 'refuse-source' };
  const stale = rows.filter(row => row.catalogRevision !== app.catalogRevision);
  if (!stale.length) return empty;
  const fromRevisions = [...new Set(stale.map(row => row.catalogRevision))].sort();
  const previous = fromRevisions.map(revision => ({ revision, snapshot: snapshots.get(revision) }));
  const diff = combineDiffs(previous.map(({ revision, snapshot }) => snapshot
    ? diffAuthorizationCatalogs(snapshot.catalog, app.catalog, { mountPaths: [...snapshot.mountPaths, ...(app.mountPaths ?? [])] })
    : unrecordedCatalog(revision)));
  const plan: CatalogMigrationPlan = { ...empty, status: 'review', fromRevisions, diff,
    fromVersions: [...new Set(previous.flatMap(({ snapshot }) => snapshot ? [snapshot.version] : []))],
    assignmentIds: stale.map(row => row.id).sort(),
    removedIds: stale.filter(row => !carried(row, app.catalog, snapshots.get(row.catalogRevision))).map(row => row.id).sort(),
    sensitiveRoles: sensitiveRoles([app.catalog, ...previous.map(({ snapshot }) => snapshot?.catalog ?? null)]) };
  if (diff.classification === 'non-widening' || diff.classification === 'unchanged') return { ...plan, status: 'migrate' };
  const approved = (state.migrations ?? []).find(review => sameReview(review, app, plan) && review.approval
    && !review.appliedAt && Date.parse(review.expiresAt) > now);
  return approved ? { ...plan, status: 'migrate', approved } : plan;
}

/** @description Merge the diffs from every stale revision; the worst classification wins. */
function combineDiffs(diffs: AuthorizationCatalogDiff[]): AuthorizationCatalogDiff {
  const order = ['unchanged', 'non-widening', 'widening', 'breaking'] as const;
  const seen = new Set<string>(); const changes: AuthorizationCatalogChange[] = [];
  for (const change of diffs.flatMap(diff => diff.changes)) {
    const key = JSON.stringify(change);
    if (!seen.has(key)) { seen.add(key); changes.push(change); }
  }
  const classification = diffs.map(diff => diff.classification).reduce((worst, item) => order.indexOf(item) > order.indexOf(worst) ? item : worst, 'unchanged' as AuthorizationCatalogDiff['classification']);
  return { classification, changes };
}

/** @description A revision whose catalog was never recorded cannot be proven non-widening. */
function unrecordedCatalog(revision: string): AuthorizationCatalogDiff {
  return { classification: 'breaking', changes: [{ area: 'catalog', id: revision.slice(0, 16), change: 'changed', effect: 'breaking',
    detail: 'The catalog these assignments were granted under was not recorded, so the change cannot be proven non-widening; a reviewer maps the grants onto the new catalog.' }] };
}

/**
 * @description Whether one assignment carries onto the next catalog. Denies always carry. A grant
 * carries only when the next catalog defines what it names and, when the previous catalog is
 * known, the previous one did too; otherwise it is removed so it can never revive later.
 */
function carried(row: AuthorizationAssignment, next: AuthorizationCatalog | null, previous: AuthorizationCatalogSnapshot | undefined): boolean {
  if (row.deny) return true;
  const defines = (catalog: AuthorizationCatalog | null): boolean => {
    if (row.role) return Boolean(applicationManagementRole(row.role)) || (catalog ? Object.prototype.hasOwnProperty.call(catalog.roles, row.role) : row.role === APP_ADMIN_ROLE);
    return Boolean(row.permission && catalog && Object.prototype.hasOwnProperty.call(catalog.permissions, row.permission));
  };
  return defines(next) && (previous === undefined || defines(previous.catalog));
}

function sensitiveRoles(catalogs: Array<AuthorizationCatalog | null>): string[] {
  return [...new Set(catalogs.flatMap(catalog => Object.entries(catalog?.roles ?? {}).filter(([, role]) => role.sensitive).map(([name]) => name)))].sort();
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, i) => item === b[i]);
/** @description A review covers a plan only for the same package source, revisions and assignment set. */
function sameReview(review: StoredCatalogMigration, app: RegisteredAuthorizationApp, plan: CatalogMigrationPlan): boolean {
  return review.app === app.app && review.source === app.source && review.toRevision === app.catalogRevision
    && sameList(review.fromRevisions, plan.fromRevisions) && sameList(review.assignmentIds, plan.assignmentIds);
}

/**
 * @description Re-stamp the stale assignments onto the activating revision, remove the grants it no
 * longer defines, bump the policy revision and record one audit event. Runs inside the policy
 * transaction, so the re-stamp, the audit event and the catalog snapshot commit together.
 * @param transaction - The open policy transaction. @param app - Registration being activated.
 * @param plan - A `migrate` plan computed against this transaction's state. @param now - Clock in ms.
 * @returns The audit event id.
 */
export function applyCatalogMigrationPlan(transaction: AuthorizationTransaction, app: RegisteredAuthorizationApp,
  plan: CatalogMigrationPlan, now: number): string {
  const { state } = transaction;
  const stale = new Set(plan.assignmentIds); const removed = new Set(plan.removedIds);
  state.assignments = state.assignments.filter(row => !removed.has(row.id))
    .map(row => stale.has(row.id) ? { ...row, catalogRevision: app.catalogRevision } : row);
  state.revision += 1;
  const at = new Date(now).toISOString(); const auditId = randomUUID(); const approval = plan.approved?.approval;
  const kept = plan.diff.changes.slice(0, MAX_STORED_CHANGES);
  transaction.audit({ id: auditId, actor: approval ? approval.actor : { ...CATALOG_MIGRATION_INSTALLER }, at, revision: state.revision,
    previewId: plan.approved?.id ?? `catalog-migration:${app.catalogRevision}`,
    change: { action: 'catalog-migration', app: app.app, reason: migrationSummary(app, plan), expectedRevision: state.revision - 1 },
    migration: { source: app.source, fromRevisions: plan.fromRevisions, fromVersions: plan.fromVersions, toRevision: app.catalogRevision,
      toVersion: app.version, classification: plan.diff.classification === 'unchanged' ? 'non-widening' : plan.diff.classification,
      changes: kept, omittedChanges: plan.diff.changes.length - kept.length, assignmentIds: plan.assignmentIds, removedIds: plan.removedIds,
      ...(plan.approved ? { reviewId: plan.approved.id, approvedBy: plan.approved.approval!.actor } : {}) } });
  const review = plan.approved && state.migrations?.find(row => row.id === plan.approved!.id);
  if (review) { review.appliedAt = at; review.appliedRevision = state.revision; }
  return auditId;
}

function migrationSummary(app: RegisteredAuthorizationApp, plan: CatalogMigrationPlan): string {
  const counts = new Map<string, number>();
  for (const change of plan.diff.changes) counts.set(change.effect, (counts.get(change.effect) ?? 0) + 1);
  const effects = [...counts].map(([effect, count]) => `${count} ${effect}`).join(', ') || 'no catalog differences';
  const from = plan.fromVersions.length ? plan.fromVersions.join('/') : 'unrecorded';
  return `${app.app} ${from} -> ${app.version} ${plan.approved ? 'reviewed' : 'non-widening'} catalog migration (${effects}); `
    + `${plan.assignmentIds.length - plan.removedIds.length} assignments carried, ${plan.removedIds.length} removed.`;
}

/**
 * @description Record the review a refused activation needs, or return the pending one that
 * already describes exactly this transition. Expired and long-applied reviews are pruned.
 * @param state - Locked policy state. @param app - Refused registration. @param plan - Its `review` plan.
 * @param now - Clock in ms. @returns The stored review.
 */
export function recordCatalogMigrationReview(state: AuthorizationState, app: RegisteredAuthorizationApp,
  plan: CatalogMigrationPlan, now: number): StoredCatalogMigration {
  const live = (row: StoredCatalogMigration) => row.appliedAt
    ? Date.parse(row.appliedAt) + CATALOG_MIGRATION_REVIEW_TTL_MS > now : Date.parse(row.expiresAt) > now;
  state.migrations = (state.migrations ?? []).filter(live);
  const existing = state.migrations.find(row => sameReview(row, app, plan) && !row.appliedAt);
  if (existing) return existing;
  const kept = plan.diff.changes.slice(0, MAX_STORED_CHANGES);
  const review: StoredCatalogMigration = { id: randomUUID(), app: app.app, source: app.source, fromRevisions: plan.fromRevisions,
    fromVersions: plan.fromVersions, toRevision: app.catalogRevision, toVersion: app.version,
    classification: plan.diff.classification === 'breaking' ? 'breaking' : 'widening', changes: kept,
    omittedChanges: plan.diff.changes.length - kept.length, assignmentIds: plan.assignmentIds, removedIds: plan.removedIds,
    sensitiveRoles: plan.sensitiveRoles, createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CATALOG_MIGRATION_REVIEW_TTL_MS).toISOString() };
  const others = state.migrations.filter(row => row.app !== app.app);
  const mine = [...state.migrations.filter(row => row.app === app.app), review].slice(-MAX_REVIEWS_PER_APP);
  state.migrations = [...others, ...mine];
  return review;
}

/**
 * @description Whether approving this review would change what the approver's own grants, or a
 * directory group's sensitive grants, mean. Mirrors the self/group sensitive rule of an access
 * change: those need an approval reference an independent verifier accepts.
 * @param review - The stored review. @param rows - Its current assignments. @param actor - The approver.
 * @returns True when an approval reference is required.
 */
export function catalogMigrationNeedsApproval(review: StoredCatalogMigration, rows: AuthorizationAssignment[],
  actor: { sub: string; issuer: string }): boolean {
  const sensitive = (role: string | undefined) => Boolean(role && (applicationManagementRole(role) || review.sensitiveRoles.includes(role)));
  return rows.some(row => !row.deny && ((row.group && sensitive(row.role))
    || (row.targetSub === actor.sub && row.targetIssuer === actor.issuer && sensitive(row.role))));
}

/**
 * @description The redacted reviewer view of one stored migration: catalog identifiers and counts,
 * never an assignment target.
 * @param review - Stored review. @param now - Clock in ms. @returns The public preview.
 */
export function publicCatalogMigration(review: StoredCatalogMigration, now: number): AuthorizationCatalogMigrationPreview {
  const status = review.appliedAt ? 'applied' : Date.parse(review.expiresAt) <= now ? 'expired' : review.approval ? 'approved' : 'pending';
  return { previewId: review.id, app: review.app, fromRevisions: [...review.fromRevisions], fromVersions: [...review.fromVersions],
    toRevision: review.toRevision, toVersion: review.toVersion, classification: review.classification,
    changes: structuredClone(review.changes), omittedChanges: review.omittedChanges, affectedAssignments: review.assignmentIds.length,
    removedGrants: review.removedIds.length, createdAt: review.createdAt, expiresAt: review.expiresAt, status,
    ...(review.approval ? { approvedAt: review.approval.at } : {}),
    ...(review.appliedRevision !== undefined ? { appliedRevision: review.appliedRevision } : {}) };
}
