/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve exact member roles, reserve reviewed constituents, and apply or revoke one provenance source atomically through the existing authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Extract constituent review and pre-apply authority checks to keep lifecycle functions within repository size limits.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Review complete installed required dependency coverage for native applications and experience hosts without guessing component roles.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuthorizationActor, AuthorizationApplyInput, AuthorizationChange, AuthorizationEffective, AuthorizationPreview, AuthorizationReceipt, AuthorizationTarget } from '@/shared/application-authorization';
import type { CompositeRoleApplyInput, CompositeRoleAssignmentView, CompositeRoleCatalog, CompositeRoleInput, CompositeRoleMemberReview, CompositeRolePreview, CompositeRoleReceipt } from '@/shared/application-authorization';
import type { ExperienceRoleTemplate } from '@/shared/experience-contract';
import { applicationManagementRole } from '@/shared/application-authorization';
import { canonical, managementAllowed, matchingAssignments, requireManagement, type RegisteredAuthorizationApp } from './policy';
import { ApplicationAuthorizationError, type AuthorizationState, type AuthorizationStore, type AuthorizationTransaction,
  type CompositeRoleBinding, type StoredCompositeRoleAssignment, type StoredCompositeRolePreview } from './types';
import { parseCompositeRoleApply, parseCompositeRoleInput, parseCompositeRoleList } from './composite-role-validation';
import { resolveCompositeRoleCoverage, type CompositeCoveragePorts } from './composite-role-coverage';

/** @description Trusted service-only provenance context; closed request parsers cannot supply it. */
export interface CompositeConstituentContext { id: string; revokeGrantSource?: string; sensitive?: boolean }
/** @description Existing policy, transaction and current-identity ports used to compose member changes without a second authority. */
export interface CompositeRolePorts extends CompositeCoveragePorts {
  store: AuthorizationStore;
  now(): number;
  current(actor: AuthorizationActor): Promise<AuthorizationActor>;
  withState(actor: AuthorizationActor, state: AuthorizationState): AuthorizationActor;
  names(): string[];
  app(name: string): RegisteredAuthorizationApp | null;
  subject(actor: AuthorizationActor, target: AuthorizationTarget): Promise<AuthorizationActor>;
  effective(actor: AuthorizationActor, target: AuthorizationTarget): Promise<AuthorizationEffective>;
  preview(actor: AuthorizationActor, change: AuthorizationChange, context: CompositeConstituentContext): Promise<AuthorizationPreview>;
  prepare(actor: AuthorizationActor, input: AuthorizationApplyInput, compositeId: string): Promise<AuthorizationActor>;
  apply(actor: AuthorizationActor, input: AuthorizationApplyInput, transaction: AuthorizationTransaction,
    context: { id: string; baseRevision: number; grantSource: string }): AuthorizationReceipt;
}
/** @description Name one server-generated assignment source; independent sources remain distinct.
 * @param id Opaque assignment id. @returns Durable provenance key. */
export const compositeGrantSource = (id: string): string => `experience-composite:${id}`;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const TTL = 600_000;
function binding(app: string, registered: RegisteredAuthorizationApp | null): CompositeRoleBinding {
  return { app, source: registered?.source ?? null, version: registered?.version ?? null,
    catalogRevision: registered?.catalogRevision ?? null,
    ...(registered ? { declarationDigest: digest({ roles: registered.compositeRoles, requiredApps: registered.requiredApps }) } : {}) };
}
function target(existing: StoredCompositeRoleAssignment | undefined, input: CompositeRoleInput) {
  return existing ? { targetSub: existing.targetSub, targetIssuer: existing.targetIssuer, group: existing.group, tenantId: existing.tenantId }
    : { targetSub: input.targetSub, targetIssuer: input.targetIssuer, group: input.group, tenantId: input.tenantId ?? input.group?.tenantId };
}
function readAssignment(state: AuthorizationState, input: CompositeRoleInput): StoredCompositeRoleAssignment | undefined {
  if (input.action === 'assign') return undefined;
  const row = state.compositeAssignments?.find(item => item.id === input.assignmentId && item.app === input.app && item.status === 'active');
  if (!row) throw new ApplicationAuthorizationError(404, 'composite_assignment_unavailable');
  return row;
}
/** @description Compose reviewed member changes through existing authority while keeping effective-access and resource policy in their current owners. */
export class CompositeRoleEngine {
  /** @description Bind the existing current-authority and atomic persistence boundaries.
   * @param ports Trusted service composition ports. */
  constructor(private readonly ports: CompositeRolePorts) {}
  /** @description Read only templates and assignments the current caller can administer.
   * @param actor Verified caller. @param input Optional app and tenant filters. @returns Redacted lifecycle catalog. */
  async list(actor: AuthorizationActor, input: { app?: string; tenantId?: string } = {}): Promise<CompositeRoleCatalog> {
    input = parseCompositeRoleList(input);
    actor = await this.ports.current(actor);
    const state = await this.ports.store.read(); actor = this.ports.withState(actor, state);
    if (input.app) requireManagement(actor, input.app, input.tenantId, 'read');
    const experiences = this.ports.names().flatMap(name => {
      const app = this.ports.app(name);
      return app?.compositeRoles && (!input.app || input.app === name) && managementAllowed(actor, name, input.tenantId, 'read')
        ? [{ app: name, version: app.version, templates: structuredClone(app.compositeRoles.templates), optionalApps: [...app.compositeRoles.optionalApps] }] : [];
    });
    const assignments: CompositeRoleAssignmentView[] = [];
    for (const row of state.compositeAssignments ?? []) {
      if ((input.app && row.app !== input.app) || (input.tenantId !== undefined && row.tenantId !== input.tenantId)) continue;
      if (![row.app, ...row.members.map(member => member.app)].every(app => managementAllowed(actor, app, row.tenantId, 'read'))) continue;
      const current = this.ports.app(row.app)?.compositeRoles?.templates.find(template => template.id === row.template.id);
      assignments.push({ id: row.id, app: row.app, templateId: row.template.id, templateVersion: row.template.version, templateLabel: row.template.label,
        targetSub: row.targetSub, targetIssuer: row.targetIssuer, group: structuredClone(row.group), tenantId: row.tenantId,
        optionalApps: [...row.optionalApps], expiresAt: row.expiresAt,
        status: row.status === 'revoked' ? 'revoked' : row.expiresAt && Date.parse(row.expiresAt) <= this.ports.now() ? 'expired' : 'active',
        upgradeAvailable: Boolean(current && digest(current) !== row.templateDigest), members: row.members.map(({ app, role }) => ({ app, role })) });
    }
    return { revision: state.revision, experiences, assignments };
  }

  /** @description Reserve exact existing-policy changes without creating human grants.
   * @param original Verified caller. @param raw Explicit lifecycle selection. @returns Bound member review or blocked reasons. */
  async preview(original: AuthorizationActor, raw: CompositeRoleInput): Promise<CompositeRolePreview> {
    const input = parseCompositeRoleInput(raw), actor = await this.ports.current(original);
    const state = await this.ports.store.read();
    if (state.revision !== input.expectedRevision) throw new ApplicationAuthorizationError(409, 'authorization_revision_conflict');
    const current = this.ports.withState(actor, state), existing = readAssignment(state, input), selected = target(existing, input);
    requireManagement(current, input.app, selected.tenantId, 'read'); requireManagement(current, input.app, selected.tenantId, 'assign');
    const host = this.ports.app(input.app);
    const template = input.action === 'revoke' ? existing!.template : host?.compositeRoles?.templates.find(row => row.id === (input.template ?? existing?.template.id));
    if (!template) throw new ApplicationAuthorizationError(404, 'composite_template_unavailable');
    const optionalApps = input.action === 'revoke' ? [] : input.optionalApps ?? existing?.optionalApps ?? [];
    if (input.action !== 'revoke' && optionalApps.some(app => !host?.compositeRoles?.optionalApps.includes(app) || !template.members.some(member => member.app === app))) {
      throw new ApplicationAuthorizationError(400, 'composite_optional_selection_invalid');
    }
    const expiresAt = input.expiresAt === null ? undefined : input.expiresAt ?? existing?.expiresAt;
    if (input.action !== 'revoke' && expiresAt && Date.parse(expiresAt) <= this.ports.now()) throw new ApplicationAuthorizationError(400, 'authorization_expiry_invalid');
    const coverage = input.action === 'revoke' ? undefined : await resolveCompositeRoleCoverage(this.ports, input.app, template, optionalApps);
    const desired = coverage?.desired ?? [];
    const removals = existing?.members ?? [];
    const members: CompositeRoleMemberReview[] = [];
    const desiredSet = [...removals.map(row => ({ ...row, action: 'revoke' as const })), ...desired.map(row => ({ ...row, action: 'grant' as const, sensitive: false }))];
    const assignmentId = existing?.id ?? randomUUID(), reviewId = randomUUID();
    const bindings = [...new Set([input.app, ...desiredSet.map(row => row.app)])].map(app => binding(app, this.ports.app(app)));
    const subject = selected.group ? undefined : await this.ports.subject(current, { app: input.app, ...selected });
    for (const row of desiredSet) members.push(await this.reviewMember(row,
      { current, state, selected, subject, input, expiresAt, assignmentId, reviewId }));
    members.push(...(coverage?.blocked ?? []));
    const review: CompositeRolePreview = { ready: members.every(row => !row.blocked), revision: state.revision, action: input.action, app: input.app,
      template: structuredClone(template), templateDigest: digest(template), assignmentId, ...selected, optionalApps: [...optionalApps], members,
      ...(expiresAt ? { assignmentExpiresAt: expiresAt } : {}) };
    if (!review.ready) return review;
    review.previewId = reviewId; review.expiresAt = new Date(this.ports.now() + TTL).toISOString();
    await this.ports.store.transaction(async transaction => {
      if (transaction.state.revision !== state.revision || bindings.some(row => canonical(row) !== canonical(binding(row.app, this.ports.app(row.app))))) {
        throw new ApplicationAuthorizationError(409, 'authorization_revision_conflict');
      }
      this.requireAuthorities(this.ports.withState(current, transaction.state), review);
      transaction.state.compositePreviews = (transaction.state.compositePreviews ?? []).filter(row => row.receipt || Date.parse(row.review.expiresAt!) > this.ports.now());
      if (transaction.state.compositePreviews.length >= 10_000) throw new ApplicationAuthorizationError(503, 'authorization_preview_capacity');
      transaction.state.compositePreviews.push({ id: reviewId, actor: { sub: current.sub, issuer: current.issuer }, input, review: structuredClone(review),
        assignmentId, bindings, childPreviewIds: members.map(row => row.preview!.previewId), dependencyDigest: coverage?.dependencyDigest });
    });
    return review;
  }

  /** @description Commit the reviewed set, provenance and receipt in one existing policy transaction.
   * @param original Verified caller. @param raw Review id, retry key and existing approval references. @returns Durable idempotent receipt. */
  async apply(original: AuthorizationActor, raw: CompositeRoleApplyInput): Promise<CompositeRoleReceipt> {
    const input = parseCompositeRoleApply(raw);
    let current = await this.ports.current(original);
    if (!this.ports.store.readCompositePreview) throw new ApplicationAuthorizationError(503, 'composite_store_unavailable');
    const initial = await this.ports.store.readCompositePreview(input.previewId);
    this.requireReview(initial, current); this.requireAuthorities(current, initial!.review);
    current = await this.prepareApply(current, input, initial!);
    current = await this.ports.current(original);
    return this.ports.store.transaction(async transaction => {
      const actor = this.ports.withState(current, transaction.state);
      const parent = transaction.state.compositePreviews?.find(row => row.id === input.previewId);
      this.requireReview(parent, actor); this.requireAuthorities(actor, parent!.review);
      if (transaction.state.compositePreviews?.some(row => row.id !== parent!.id && row.actor.sub === actor.sub && row.actor.issuer === actor.issuer && row.idempotencyKey === input.idempotencyKey)) {
        throw new ApplicationAuthorizationError(409, 'authorization_idempotency_conflict');
      }
      if (parent!.receipt) {
        if (parent!.idempotencyKey !== input.idempotencyKey) throw new ApplicationAuthorizationError(409, 'authorization_preview_consumed');
        return structuredClone(parent!.receipt);
      }
      if (parent!.review.revision !== transaction.state.revision || parent!.bindings.some(row => canonical(row) !== canonical(binding(row.app, this.ports.app(row.app))))) {
        throw new ApplicationAuthorizationError(409, 'authorization_revision_conflict');
      }
      if (Date.parse(parent!.review.expiresAt!) <= this.ports.now()) throw new ApplicationAuthorizationError(409, 'authorization_preview_expired');
      const receipts = parent!.childPreviewIds.map(id => this.ports.apply(actor, this.childInput(input, id), transaction,
        { id: parent!.id, baseRevision: parent!.review.revision, grantSource: compositeGrantSource(parent!.assignmentId) }));
      const review = parent!.review, now = new Date(this.ports.now()).toISOString();
      transaction.state.compositeAssignments ??= [];
      const previous = transaction.state.compositeAssignments.find(row => row.id === parent!.assignmentId);
      if (review.action === 'revoke') {
        if (!previous || previous.status !== 'active') throw new ApplicationAuthorizationError(409, 'composite_assignment_changed');
        previous.status = 'revoked'; previous.updatedAt = now;
      } else {
        const assignment: StoredCompositeRoleAssignment = { id: parent!.assignmentId, app: review.app, template: structuredClone(review.template!), templateDigest: review.templateDigest!,
          targetSub: review.targetSub, targetIssuer: review.targetIssuer, group: structuredClone(review.group), tenantId: review.tenantId,
          optionalApps: [...review.optionalApps], expiresAt: review.assignmentExpiresAt, status: 'active', createdAt: previous?.createdAt ?? now, updatedAt: now,
          members: review.members.filter(row => row.action === 'grant').map(row => ({ app: row.app, role: row.role, sensitive: Boolean(this.ports.app(row.app)?.catalog?.roles[row.role]?.sensitive) })) };
        transaction.state.compositeAssignments = transaction.state.compositeAssignments.filter(row => row.id !== assignment.id);
        transaction.state.compositeAssignments.push(assignment);
      }
      const receipt: CompositeRoleReceipt = { previewId: parent!.id, assignmentId: parent!.assignmentId, revision: transaction.state.revision,
        applied: true, status: review.action === 'revoke' ? 'revoked' : 'active', auditIds: receipts.map(row => row.auditId) };
      parent!.receipt = receipt; parent!.idempotencyKey = input.idempotencyKey;
      return structuredClone(receipt);
    });
  }
  private async reviewMember(row: { app: string; role: string; action: 'grant' | 'revoke'; sensitive?: boolean }, context: {
    current: AuthorizationActor; state: AuthorizationState; selected: ReturnType<typeof target>; subject?: AuthorizationActor;
    input: CompositeRoleInput; expiresAt?: string; assignmentId: string; reviewId: string;
  }): Promise<CompositeRoleMemberReview> {
    const { current, state, selected, subject, input, expiresAt, assignmentId, reviewId } = context;
    const review: CompositeRoleMemberReview = { app: row.app, role: row.role, action: row.action };
    try {
      requireManagement(current, row.app, selected.tenantId, 'read'); requireManagement(current, row.app, selected.tenantId, 'assign');
      if (selected.group) requireManagement(current, row.app, selected.tenantId, 'directory');
      const app = this.ports.app(row.app), role = app?.catalog?.roles[row.role];
      if (role || row.role === '@app-admin') { review.tier = role?.tier ?? 'admin'; review.permissions = structuredClone(role?.grants ?? []); }
      if (row.action === 'grant') {
        if (!subject?.isActive && !selected.group) throw new ApplicationAuthorizationError(403, 'composite_subject_inactive');
        if (selected.tenantId && subject && !subject.tenantIds?.includes(selected.tenantId)) throw new ApplicationAuthorizationError(403, 'composite_subject_tenant_denied');
        if (!app) throw new ApplicationAuthorizationError(409, 'composite_member_unavailable');
        if (applicationManagementRole(row.role) || (!role && (app.catalog || row.role !== '@app-admin'))) throw new ApplicationAuthorizationError(400, 'composite_member_role_unavailable');
        if (subject) {
          const access = await this.ports.effective(current, { app: row.app, ...selected });
          review.alreadyHeld = access.roles.includes(row.role);
          const matched = matchingAssignments(state, app, subject, selected.tenantId, this.ports.now()).rows;
          if (access.denied || matched.some(edge => edge.deny && (!edge.permission || role?.grants.some(grant => grant.permission === edge.permission)))) {
            throw new ApplicationAuthorizationError(403, 'composite_member_denied');
          }
        } else if (state.assignments.some(edge => edge.app === row.app && edge.source === app.source && edge.deny
          && canonical(edge.group) === canonical(selected.group) && (edge.tenantId === undefined || edge.tenantId === selected.tenantId)
          && (!edge.expiresAt || Date.parse(edge.expiresAt) > this.ports.now()) && (!edge.permission || role?.grants.some(grant => grant.permission === edge.permission)))) {
          throw new ApplicationAuthorizationError(403, 'composite_member_denied');
        }
      }
      const change: AuthorizationChange = { action: selected.group ? row.action === 'grant' ? 'group-map' : 'group-unmap' : row.action,
        app: row.app, ...selected, role: row.role, ...(row.action === 'grant' && expiresAt ? { expiresAt } : {}), reason: input.reason, expectedRevision: input.expectedRevision };
      review.preview = await this.ports.preview(current, change, { id: reviewId,
        ...(row.action === 'revoke' ? { revokeGrantSource: compositeGrantSource(assignmentId), sensitive: row.sensitive } : {}) });
      review.requiresApproval = review.preview.requiresApproval;
    } catch (error) {
      if (!(error instanceof ApplicationAuthorizationError) || error.status === 401 || error.code === 'authorization_revision_conflict') throw error;
      delete review.permissions; delete review.tier; delete review.alreadyHeld;
      review.blocked = error.code;
    }
    return review;
  }
  private async prepareApply(current: AuthorizationActor, input: CompositeRoleApplyInput,
    initial: StoredCompositeRolePreview): Promise<AuthorizationActor> {
    if (!initial.receipt) {
      if (Date.parse(initial.review.expiresAt!) <= this.ports.now()) throw new ApplicationAuthorizationError(409, 'authorization_preview_expired');
      await this.requireCurrentCoverage(initial);
      if (Object.keys(input.approvals ?? {}).some(key => !initial.childPreviewIds.includes(key))) throw new ApplicationAuthorizationError(400, 'composite_approval_reference_invalid');
      for (const id of initial.childPreviewIds) current = await this.ports.prepare(current, this.childInput(input, id), initial.id);
      const selected = initial.review;
      if (selected.action !== 'revoke' && !selected.group) {
        const subject = await this.ports.subject(current, selected);
        if (!subject.isActive || (selected.tenantId && !subject.tenantIds?.includes(selected.tenantId))) throw new ApplicationAuthorizationError(403, 'composite_subject_unavailable');
        for (const member of selected.members.filter(row => row.action === 'grant')) {
          const app = this.ports.app(member.app);
          if (!app) throw new ApplicationAuthorizationError(409, 'composite_member_unavailable');
          const access = await this.ports.effective(current, { app: member.app, targetSub: selected.targetSub, targetIssuer: selected.targetIssuer, tenantId: selected.tenantId });
          const state = await this.ports.store.read();
          if (access.denied || matchingAssignments(state, app, subject, selected.tenantId, this.ports.now()).rows.some(edge => edge.deny
            && (!edge.permission || member.permissions?.some(grant => grant.permission === edge.permission)))) throw new ApplicationAuthorizationError(403, 'composite_member_denied');
        }
      }
    }
    return current;
  }
  /** Re-read installed dependency declarations before writer acquisition; never nest package DB reads in its transaction. */
  private async requireCurrentCoverage(initial: StoredCompositeRolePreview): Promise<void> {
    if (initial.review.action === 'revoke') return;
    const coverage = await resolveCompositeRoleCoverage(this.ports, initial.review.app, initial.review.template!, initial.review.optionalApps);
    const reviewed = initial.review.members.filter(member => member.action === 'grant').map(({ app, role }) => ({ app, role }));
    if (coverage.blocked.length || canonical(coverage.desired) !== canonical(reviewed)
      || (initial.dependencyDigest !== undefined && coverage.dependencyDigest !== initial.dependencyDigest)) {
      throw new ApplicationAuthorizationError(409, 'authorization_revision_conflict');
    }
  }
  private childInput(input: CompositeRoleApplyInput, id: string): AuthorizationApplyInput {
    return { previewId: id, idempotencyKey: digest([input.idempotencyKey, id]), ...(input.approvals?.[id] ? { approvalReference: input.approvals[id] } : {}) };
  }
  private requireReview(review: StoredCompositeRolePreview | null | undefined, actor: AuthorizationActor): void {
    if (!review || review.actor.sub !== actor.sub || review.actor.issuer !== actor.issuer) throw new ApplicationAuthorizationError(404, 'composite_preview_unavailable');
  }
  private requireAuthorities(actor: AuthorizationActor, review: CompositeRolePreview): void {
    for (const app of new Set([review.app, ...review.members.map(row => row.app)])) {
      requireManagement(actor, app, review.tenantId, 'read'); requireManagement(actor, app, review.tenantId, 'assign');
      if (review.group) requireManagement(actor, app, review.tenantId, 'directory');
    }
  }
}
