/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for RCA analysis feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the honest-failure error types + RcaExecutor seam (no-mock remediation)
 */

export { RcaEngine, RcaEngineDisabledError, RcaEngineUnavailableError } from './services';
export type { RcaExecutor } from './services';