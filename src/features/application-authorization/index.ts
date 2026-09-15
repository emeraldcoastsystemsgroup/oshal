/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Expose the transaction port for isolated current-management concurrency verification.
 */
export { ApplicationAuthorizationService, type ApplicationAuthorizationServiceOptions } from './service';
export { AUTHORIZATION_SCHEMA, MemoryAuthorizationStore, PostgresAuthorizationStore, ensureApplicationAuthorizationSchema } from './store';
export { ApplicationAuthorizationError, type AuthorizationStore, type AuthorizationAssignment, type AuthorizationTransaction } from './types';
export { parseAuthorizationChange, parseAuthorizationApply } from './change-validation';
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
