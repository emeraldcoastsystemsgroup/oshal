/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for RCA analysis services
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the honest-failure error types + RcaExecutor seam (no-mock remediation)
 */

export { RcaEngine, RcaEngineDisabledError, RcaEngineUnavailableError } from './rca-engine';
export type { RcaExecutor } from './rca-engine';