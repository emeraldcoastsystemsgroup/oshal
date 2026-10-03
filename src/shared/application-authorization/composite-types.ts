/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reviewable experience role lifecycle over the existing application authority; installation and membership grant nothing.
 */
import type { AuthorizationChange, AuthorizationGrant, AuthorizationPreview, AuthorizationTier } from './types';
import type { ExperienceRoleTemplate } from '@/shared/experience-contract';

/** @description Closed lifecycle selection; current server authority supplies provenance and member tiers. */
export interface CompositeRoleInput {
  action: 'assign' | 'upgrade' | 'revoke';
  app: string;
  template?: string;
  assignmentId?: string;
  targetSub?: string;
  targetIssuer?: string;
  group?: AuthorizationChange['group'];
  tenantId?: string;
  optionalApps?: string[];
  /** null is an explicitly reviewed removal of an existing expiry during upgrade. */
  expiresAt?: string | null;
  reason: string;
  expectedRevision: number;
}
/** @description Show exact existing-policy constituent effects and blocked reasons before any grant is committed. */
export interface CompositeRoleMemberReview {
  app: string;
  role: string;
  action: 'grant' | 'revoke';
  tier?: AuthorizationTier;
  permissions?: AuthorizationGrant[];
  alreadyHeld?: boolean;
  requiresApproval?: boolean;
  /** Only present when the caller may review this constituent change. */
  preview?: AuthorizationPreview;
  blocked?: string;
}
/** @description Bind selected member effects and expiry to a reviewable template and one current policy revision. */
export interface CompositeRolePreview {
  previewId?: string;
  expiresAt?: string;
  revision: number;
  ready: boolean;
  action: CompositeRoleInput['action'];
  app: string;
  template?: ExperienceRoleTemplate;
  templateDigest?: string;
  assignmentId?: string;
  targetSub?: string;
  targetIssuer?: string;
  group?: AuthorizationChange['group'];
  tenantId?: string;
  optionalApps: string[];
  members: CompositeRoleMemberReview[];
  assignmentExpiresAt?: string;
}
/** @description Reference a server-created review, stable retry key and existing constituent approvals without caller-built authority. */
export interface CompositeRoleApplyInput {
  previewId: string;
  idempotencyKey: string;
  /** References bound to the exact constituent previews, verified by the existing approval policy. */
  approvals?: Record<string, string>;
}
/** @description Confirm one atomic provenance source and its audit rows, with a durable receipt for retries. */
export interface CompositeRoleReceipt {
  previewId: string;
  assignmentId: string;
  revision: number;
  applied: true;
  status: 'active' | 'revoked';
  auditIds: string[];
}
/** @description Safe assignment projection for administrators; installation source values remain server-private. */
export interface CompositeRoleAssignmentView {
  id: string;
  app: string;
  templateId: string;
  templateVersion: number;
  templateLabel: string;
  targetSub?: string;
  targetIssuer?: string;
  group?: AuthorizationChange['group'];
  tenantId?: string;
  optionalApps: string[];
  expiresAt?: string;
  status: 'active' | 'revoked' | 'expired';
  upgradeAvailable: boolean;
  members: Array<{ app: string; role: string }>;
}
/** @description Expose only current templates and assignments the caller can administer, at one policy revision. */
export interface CompositeRoleCatalog {
  revision: number;
  experiences: Array<{ app: string; version: string; templates: ExperienceRoleTemplate[]; optionalApps: string[] }>;
  assignments: CompositeRoleAssignmentView[];
}
