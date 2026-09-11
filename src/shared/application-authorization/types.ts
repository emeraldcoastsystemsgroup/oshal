/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded, redacted applied authorization history under current application and tenant authority.
 */
/** ADR-149: versioned application permission contract. Routing metadata never grants authority. */
export type AuthorizationTier = 'deny' | 'viewer' | 'editor' | 'admin';
export type AuthorizationEffect = 'read' | 'write' | 'export' | 'execute' | 'administer';
export type AuthorizationScope = 'own' | 'team' | 'tenant';
export type AuthorizationBindingKind = 'http' | 'tools' | 'bots' | 'jobs' | 'artifactActions';
export interface AuthorizationGrant { permission: string; scope: AuthorizationScope; fields?: string }
export interface AuthorizationCatalog {
  version: 1;
  resources: Record<string, { scopes: AuthorizationScope[]; fieldSets?: Record<string, string[]> }>;
  permissions: Record<string, { resource: string; effect: AuthorizationEffect; minimumTier: AuthorizationTier }>;
  roles: Record<string, { tier: AuthorizationTier; grants: AuthorizationGrant[]; sensitive?: boolean }>;
  bindings: Partial<Record<AuthorizationBindingKind, Array<{ id: string; allOf: string[]; method?: string; path?: string }>>>;
}
export interface ApplicationAuthorizationDeclaration { version: 1; catalog: string }
export interface AuthorizationManagementScope {
  app: string; tenantId?: string; permissions: Array<'read' | 'assign' | 'directory'>;
}
/** Only authentication/composition code constructs actors; never deserialize one from tool/body input. */
export interface AuthorizationActor {
  sub: string;
  issuer: string;
  isActive: boolean;
  isSwarmAdmin: boolean;
  tenantIds?: string[];
  managementScopes?: AuthorizationManagementScope[];
  /** Already verified source-qualified evidence. Incomplete/stale evidence cannot erase a deny. */
  directory?: Array<{ issuer: string; tenantId: string; audience?: string; objectId?: string; groups: string[]; observedAt: string; complete: boolean }>;
  allowedPermissions?: string[];
}
export interface AuthorizationTarget { app: string; targetSub?: string; targetIssuer?: string; tenantId?: string }
export interface AuthorizationOperation {
  app: string;
  permission?: string;
  kind?: AuthorizationBindingKind;
  operation?: string;
  method?: string;
  path?: string;
  tenantId?: string;
  resourceId?: string;
  fields?: string[];
}
export interface AuthorizationResourceAdapter {
  /** Must load authoritative records and constrain list queries; caller supplied attributes are not evidence. */
  authorize(input: { actor: AuthorizationActor; operation: AuthorizationOperation; grant: AuthorizationGrant; fields: string[] }): Promise<boolean>;
}
export interface AuthorizationAppRegistration {
  app: string;
  source: string;
  version: string;
  catalog: AuthorizationCatalog | null;
  mountPaths?: string[];
  agentIds?: string[];
  toolNames?: string[];
  /** Catalogs always enforce. Missing catalogs enforce only in explicit fallback rollout. */
  mode: 'legacy' | 'enforce';
  access?: { supported: AuthorizationTier[]; defaultTier: AuthorizationTier };
  adapters?: Record<string, AuthorizationResourceAdapter>;
}
export interface AuthorizationAppSummary {
  app: string; source: string; version: string; catalogRevision: string;
  mode: 'legacy' | 'enforce'; status: 'legacy' | 'admin-required' | 'catalog';
  catalog: AuthorizationCatalog | null; missingAdapters: string[];
  managementScopes?: AuthorizationManagementScope[];
}
export interface AuthorizationDecision {
  allowed: boolean; reason: string; decisionId: string; revision: number;
  app: string; catalogRevision?: string; tier?: AuthorizationTier;
  grants: AuthorizationGrant[];
}
export interface AuthorizationChange {
  action: 'grant' | 'revoke' | 'deny' | 'clear-deny' | 'group-map' | 'group-unmap';
  app: string; targetSub?: string; targetIssuer?: string; tenantId?: string;
  role?: string; permission?: string; expiresAt?: string; reason: string; expectedRevision: number;
  group?: { issuer: string; tenantId: string; id: string };
}
export interface AuthorizationPreview {
  previewId: string; expiresAt: string; revision: number; catalogRevision: string;
  change: AuthorizationChange; requiresApproval: boolean;
}
export interface AuthorizationApplyInput { previewId: string; idempotencyKey: string; approvalReference?: string }
export interface AuthorizationReceipt { previewId: string; revision: number; auditId: string; applied: true }
export interface AuthorizationEffective {
  app: string; targetSub: string; targetIssuer: string; tenantId?: string;
  revision: number; catalogRevision: string; tier: AuthorizationTier;
  roles: string[]; denied: boolean; permissions: AuthorizationGrant[];
  status: AuthorizationAppSummary['status'];
}
export interface AuthorizationInventory {
  users: Array<{ sub: string; issuer: string; label: string }>;
  groups: Array<{ issuer: string; tenantId: string; id: string; label: string }>;
}
export interface AuthorizationCatalogResult extends AuthorizationInventory {
  revision: number; apps: AuthorizationAppSummary[];
  canReadGlobalAudit?: boolean;
  assignments: Array<{ id: string; app: string; targetSub?: string; targetIssuer?: string; tenantId?: string;
    role?: string; permission?: string; deny: boolean; expiresAt?: string;
    group?: { issuer: string; tenantId: string; id: string } }>;
}
export interface ApplicationAuthorizationManagementService {
  /** @description Read redacted applied changes after current caller revalidation.
   * @param actor Verified caller. @param input Application/tenant filters and cursor. @returns A bounded history page.
   */
  auditHistory(actor: AuthorizationActor, input: AuthorizationAuditInput): Promise<AuthorizationAuditPage>;
  catalog(actor: AuthorizationActor): Promise<AuthorizationCatalogResult>;
  ownCatalog?(actor: AuthorizationActor): Promise<AuthorizationCatalogResult>;
  effective(actor: AuthorizationActor, target: AuthorizationTarget): Promise<AuthorizationEffective>;
  explain(actor: AuthorizationActor, input: AuthorizationOperation & { targetSub?: string; targetIssuer?: string }): Promise<AuthorizationDecision>;
  previewChange(actor: AuthorizationActor, input: AuthorizationChange): Promise<AuthorizationPreview>;
  applyChange(actor: AuthorizationActor, input: AuthorizationApplyInput): Promise<AuthorizationReceipt>;
}
/** @description Read-only history filters. Omitting app requests swarm-wide history, requiring swarm administration. */
export interface AuthorizationAuditInput { app?: string; tenantId?: string; limit?: number; cursor?: string }
/** @description Explicit projection with no freeform reasons, approvals, resource values, credentials or raw payloads. */
export interface AuthorizationAuditEntry {
  id: string; revision: number; at: string; actor: { sub: string; issuer: string };
  app: string; action: AuthorizationChange['action']; tenantId?: string;
  targetSub?: string; targetIssuer?: string; group?: { issuer: string; tenantId: string; id: string };
  role?: string; permission?: string;
}
/** @description A bounded revision snapshot; a continuation carries pagination state, never authority. */
export interface AuthorizationAuditPage { entries: AuthorizationAuditEntry[]; snapshotRevision: number; nextCursor: string | null }
