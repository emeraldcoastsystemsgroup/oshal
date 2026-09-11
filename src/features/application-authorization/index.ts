/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
export { ApplicationAuthorizationService, type ApplicationAuthorizationServiceOptions } from './service';
export { MemoryAuthorizationStore, PostgresAuthorizationStore, ensureApplicationAuthorizationSchema } from './store';
export { ApplicationAuthorizationError, type AuthorizationStore, type AuthorizationAssignment } from './types';
export { parseAuthorizationChange, parseAuthorizationApply } from './change-validation';
export { APP_ADMIN_ROLE } from './policy';
export type * from '@/shared/application-authorization';
