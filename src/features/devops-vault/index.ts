/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel — the DevOps/Vault console feature (ADR-040 activation): VaultConsoleService + its input types.
 */

export {
  VaultConsoleService,
  type VaultScopePath,
  type VaultIssueInput,
  type VaultRevokeInput,
  type VaultSetupDbInput,
  type VaultConsoleConfig,
} from './services/vault-console-service';
export {
  DevopsTraceHub, devopsTraceHub,
  type TraceFrame, type TraceLevel, type TraceSink,
} from './services/devops-trace-hub';
