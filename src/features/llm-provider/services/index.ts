/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for llm-provider/services (FSD compliance)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added ClineRuntimeConfigSyncService barrel export for centralized save-time runtime sync
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added AgentStartupManifestService barrel export for live agent startup manifest assembly
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added ClineSessionRuntimeService barrel export for session-specific MCP/runtime config generation
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported usage-cost resolver for shared estimated-cost telemetry rollups
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Barrel-export swarm-credentials (file landed 2026-07-12 without its FSD barrel entry)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Barrel-export A2AHarnessAdapter + its config/cost-event types (outbound A2A gateway harness, Plan F item 3)
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Barrel-export gemini-auth-status-service (Plan E residual: gemini connect-state probe for the /api/gemini/auth/status route)
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Barrel split (TODO-BOUNDARY-FINDING 2026-07-19): removed every harness runtime re-export (HarnessLLMBridge/harness-adapter types, CodexCliHarnessAdapter, A2AHarnessAdapter, ClaudeCodeCliHarnessAdapter) so controller imports of this barrel stop loading the harness stack; A2A cost-event types stay available via the pure-types a2a-cost-events module. Harness consumers use '@/features/llm-provider/harness'.
 */

/**
 * @description Barrel file for llm-provider/services. Re-exports all public services.
 */

export * from './swarm-credentials';
export { LLMService } from './llm-service';
export { NoopProvider } from './noop-provider';
export { ProviderRegistry } from './provider-registry';
export { resolveUsageCost, type ResolvedUsageCost } from './usage-cost-resolver';

export { ClineHarnessProvider } from './claude-code-provider';
export { ClineCLIWrapper } from './cline-cli-wrapper';
export {
  ClineSessionRuntimeService,
  type ClineSessionRuntime,
} from './cline-session-runtime-service';
export {
  AgentStartupManifestService,
  type AgentStartupProfile,
  type AgentStartupManifestDeps,
  type PrepareAgentStartupManifestInput,
} from './agent-startup-manifest-service';
export {
  ClineRuntimeConfigSyncService,
  type ClineRuntimeSelection,
} from './cline-runtime-config-sync-service';
export {
  filterMcpSettingsByCapabilities,
  filterRegistryToolsByCapabilities,
  filterRuntimeToolDefinitionsByCapabilities,
  hasCapabilityScope,
  normalizeCapability,
  type ToolCapabilityScope,
} from './tool-capability-scope';
export { AnthropicProvider, type AnthropicProviderConfig } from './anthropic-provider';
// NOTE (barrel-boundary, 2026-07-24): harness runtime modules (HarnessLLMBridge,
// HarnessLLMBridge/harness-adapter, the CLI adapters, A2AHarnessAdapter) are deliberately
// NOT re-exported here — this barrel is reached from the controller graph, and the
// two-runtimes doctrine keeps the harness stack off it. Harness consumers import the
// dedicated '@/features/llm-provider/harness' entry point (see harness/index.ts).
export type {
  A2ACostEvent,
  A2ARecordCostFn,
  A2ARemoteUsage,
} from './a2a-cost-events';
export {
  getGeminiAuthStatus,
  resolveGeminiCredsPath,
  type GeminiAuthMethod,
  type GeminiAuthProbeOptions,
  type GeminiAuthReason,
  type GeminiAuthStatus,
} from './gemini-auth-status-service';
export {
  PROVIDER_CATALOG,
  getAllProviders,
  getProvider,
  getDefaultModel,
  getClineProviderMapping,
  getProvidersForAgent,
  type ProviderDefinition,
  type ProviderModelOption,
  type ProviderModelGroup,
} from './provider-catalog';
export {
  buildClineConfig,
  buildClineGlobalState,
} from './cline-config-builder';
export {
  isProviderRecoverableRuntimeFailure,
  isProviderRuntimeStall,
  ProviderFailoverService,
  type ProviderFailoverPredicate,
  type ProviderFailoverServiceConfig,
} from './provider-failover-service';
