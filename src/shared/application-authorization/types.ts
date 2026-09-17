/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded, redacted applied authorization history under current application and tenant authority.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Expose distinct core access-management role templates and effective capabilities.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Add the read-only "configure by package" grant plan: one application plus the applications it declares it cannot run without, each classified into the ONE change /access would make for it. A plan is a description, never a grant — it creates no assignment, bumps no revision and writes no audit entry.
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
/** A core-defined access-management template, assigned separately from application business roles. */
export interface AuthorizationManagementRoleDefinition {
  id: '@access-admin' | '@access-auditor'; label: string; description: string;
  scope: 'application'; permissions: AuthorizationManagementScope['permissions'];
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
  /** Whether this caller may delegate core-defined access-management roles for this application. */
  canDelegateManagement?: boolean;
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
  /** Separate from business permissions: these roles govern access administration only. */
  managementRoles?: string[];
  managementPermissions?: AuthorizationManagementScope['permissions'];
}
/** What the ONE /access change for a single application in a package grant plan would be. */
export type PackageGrantAction =
  /** Catalog-less application in enforce mode: `@app-admin` is the only grantable role. */
  | 'grant-app-admin'
  /** Catalogued application: the caller must name one of `candidateRoles`; the plan never picks. */
  | 'choose-role'
  /** The subject already holds a non-deny tier here. */
  | 'already-granted'
  /** Legacy application with no catalog: reachable with no assignment at all. */
  | 'no-grant-required'
  /** An explicit deny stands for this subject; a grant would not take effect until it is cleared. */
  | 'blocked-explicit-deny'
  /** Nothing is installed under this name, so there is nothing to grant. */
  | 'blocked-not-installed'
  /** Installed but not active, so no authority holds its catalog and no grant can be previewed. */
  | 'blocked-inactive'
  /** This caller holds no management read on this application; nothing else about it is reported. */
  | 'blocked-management-denied'
  /** The subject's account is not active; access granted to it would not resolve. */
  | 'blocked-subject-inactive'
  /** The subject is not a member of the requested business tenant. */
  | 'blocked-tenant';

/** One application in a resolved package grant plan. */
export interface PackageGrantPlanEntry {
  app: string;
  /** 0 for the requested package, 1+ for something it requires (transitively). */
  depth: number;
  /** The applications that require this one, nearest requirer first; empty for the requested package. */
  requiredBy: string[];
  action: PackageGrantAction;
  /** Only when this caller may read this application's access. */
  status?: AuthorizationAppSummary['status'];
  /** The declared roles a `choose-role` entry may be granted. The plan never guesses one. */
  candidateRoles?: string[];
  /** The subject's current tier here, when this caller may read it. */
  currentTier?: AuthorizationTier;
  /** How many assignments this subject holds for this application that the RUNNING installation no
   *  longer matches — a reinstall changed the installation source, so the row grants nothing and
   *  `effective()` reports neither stale nor denied, it simply does not see it. A count, never a
   *  source value: the source is a hash of an install path or repository. */
  inertAssignments?: number;
}

/** A package plus everything it declares it cannot run without, as one reviewable list. */
export interface PackageGrantPlan {
  app: string; targetSub: string; targetIssuer: string; tenantId?: string;
  /** The policy revision the plan was resolved against; a change to it invalidates the plan. */
  revision: number;
  /** The requested package first, then its required applications in resolution order. */
  entries: PackageGrantPlanEntry[];
  /** Optional dependencies anywhere in the set. Install-time offers, never members (ADR-141) —
   *  they are listed so an administrator can add one deliberately, never fanned out into. */
  offers: Array<{ app: string; offeredBy: string }>;
  /** Required tools and connectors the set declares. Not assignments: a connector is a credential
   *  the subject connects themselves. Reported verbatim, with no claim that they are unmet. */
  declaredNeeds: Array<{ kind: 'tool' | 'connector'; id: string; declaredBy: string }>;
  /** Dependency cycles found and cut. The closure is still complete; each cycle is reported once. */
  cycles: string[][];
  /** How many entries would produce an /access change (`grant-app-admin` or `choose-role`). */
  actionable: number;
}

/** Read-only plan request. Authority always comes from the server actor, never these fields. */
export interface PackageGrantPlanInput { app: string; targetSub?: string; targetIssuer?: string; tenantId?: string }

export interface AuthorizationInventory {
  users: Array<{ sub: string; issuer: string; label: string }>;
  groups: Array<{ issuer: string; tenantId: string; id: string; label: string }>;
}
export interface AuthorizationCatalogResult extends AuthorizationInventory {
  revision: number; apps: AuthorizationAppSummary[];
  managementRoles?: AuthorizationManagementRoleDefinition[];
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
  /** @description Resolve one package and everything it requires into the changes /access would make.
   * @param actor Verified caller. @param input Requested package and subject. @returns A read-only plan; nothing is granted. */
  packageGrantPlan?(actor: AuthorizationActor, input: PackageGrantPlanInput): Promise<PackageGrantPlan>;
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
