/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | C2: Barrel export for workspace-sandbox feature
 */

/**
 * @description Barrel export for the workspace-sandbox feature.
 * Provides workspace boundary enforcement and sandboxed filesystem access.
 */
export {
  WorkspaceSandboxService,
  type PathValidationResult,
  type SandboxedFs,
} from './workspace-sandbox-service';
