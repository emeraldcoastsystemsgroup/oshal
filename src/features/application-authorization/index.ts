/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Expose the transaction port for isolated current-management concurrency verification.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Export the package grant plan resolver and its ports so composition can supply the installed-package reader and isolated tests can drive the pure resolution directly.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Export the AUTH-07 catalog diff classifier and catalog migration lifecycle (installer principal, refusal error, review TTL) and their store types.
 */
export { ApplicationAuthorizationService, type ApplicationAuthorizationServiceOptions } from './service';
export { buildPackageGrantPlan, classifyPackageGrantEntry, resolvePackageClosure,
  type PackageClosure, type PackageDependencyFacts, type PackageGrantAppFacts,
  type PackageGrantPlanPorts, type PackageGrantSubjectFacts } from './package-grant-plan';
export { AUTHORIZATION_SCHEMA, MemoryAuthorizationStore, PostgresAuthorizationStore, ensureApplicationAuthorizationSchema } from './store';
export { ApplicationAuthorizationError, type AuthorizationStore, type AuthorizationAssignment, type AuthorizationTransaction,
  type AuthorizationCatalogSnapshot, type StoredCatalogMigration, type AuthorizationAudit } from './types';
export { diffAuthorizationCatalogs } from './catalog-diff';
export { CATALOG_MIGRATION_INSTALLER, CATALOG_MIGRATION_REVIEW_TTL_MS, CatalogMigrationRequiredError } from './catalog-migration';
export { parseAuthorizationChange, parseAuthorizationApply, parsePackageGrantPlanInput } from './change-validation';
export { APP_ADMIN_ROLE, resolveOperationPermissions } from './policy';
export {
  APPLICATION_SERVICE_ACTIVATION_SCHEMA, ensureApplicationServiceActivationSchema,
  MemoryApplicationServiceActivationStore, PostgresApplicationServiceActivationStore,
} from './service-activation-store';
export {
  ApplicationServiceActivationService, type ApplicationServiceActivationOptions,
  type ApplicationServiceDeactivation, type ApplicationServiceDeclaration,
  type ApplicationServiceState, type ApplicationServicesView,
} from './service-activation-service';
export {
  APPLICATION_SERVICE_PRINCIPAL_ISSUER, applicationServicePrincipalSub, serviceActivationGrantSource,
  type ApplicationServiceActivation, type ApplicationServiceActivationKey,
  type ApplicationServiceActivationStore, type ApplicationServiceRunsAs,
} from './service-activation-types';
export type * from '@/shared/application-authorization';
