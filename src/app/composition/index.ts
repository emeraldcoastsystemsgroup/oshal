/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added barrel exports for decomposed app-composition helpers
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported provider manifest runtime helper for live startup manifest assembly
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported dedicated agent-profile runtime helper
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported HARNESS_FACTORIES and the provider switch installer so server.ts builds the switch catalog from the real factory keys without a new direct edge onto provider-runtime (the controller-runtime-boundary guard pins those edges).
 */

export type { AppContext } from './app-context';
export {
  HARNESS_FACTORIES,
  runtimeDefaults,
  createProviderResolver,
  readJsonConfig,
  readChatAgentProfileConfig,
  parseSelectorSkills,
  readNonEmptyString,
} from './provider-runtime';
export { createAgentStartupManifestService } from './provider-manifest-runtime';
export { installProviderSwitchSnapshot } from './provider-switch-runtime';
export { createAgentProfileComponents } from './agent-profile-runtime';
export { createAgentSelectorCapabilityResolver } from './agent-capability-resolver';
export type { AgentCapabilityResolver, AgentSelectorResolution } from './agent-capability-resolver';
export {
  createToolResolver,
  createSystemPromptResolver,
} from './tool-runtime-context';
export {
  createDatabasePool,
  createOrchestrator,
  type OrchestratorServices,
  createToolFramework,
  createVerificationComponents,
  initializeToolRegistry,
  isBootstrapComplete,
  waitForBootstrapComplete,
} from './app-runtime-factory';
