/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist observed provider-qualified principals without changing existing accounts or granting roles.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Export separate reviewed roster metadata and bounded historical references.
 */
export { PrincipalDirectoryStore, ensurePrincipalDirectorySchema } from './store';
export type { VerifiedPrincipal, PrincipalObservation } from './store';
export { PrincipalRegistrationStore, requireRosterAdmin, RosterError, RosterImportSchema, RosterApplySchema } from './registration-store';
export { ensurePrincipalRegistrationSchema } from './registration-schema';
export { historicalPrincipalReferences } from './historical-references';
