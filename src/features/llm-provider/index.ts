/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for LLM provider feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the deterministic no-op provider export
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added ProviderDropdown and AuthPopup component exports
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Removed React component exports - backend doesn't need them
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported usage-cost resolver for shared estimated-cost rollups
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exported A2AHarnessAdapter + cost-event types (outbound A2A gateway harness, Plan F item 3)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Exported gemini connect-state probe (Plan E residual — status-only; the host runs the vendor's own CLI login)
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Barrel split (TODO-BOUNDARY-FINDING 2026-07-19): removed harness runtime exports (A2AHarnessAdapter and peers) so controller imports of this barrel no longer load the harness stack; A2A cost-event types now re-export from the pure-types a2a-cost-events module. Harness consumers use the new '@/features/llm-provider/harness' entry point.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced the PURE governance/config/data members consumers were reaching via deep paths (tool-capability-scope, provider-catalog, cline-config-builder, governance gate/budget/quota/fallback-routing). Deliberately NOT re-exported here: the LLM-EXECUTION provider runtimes (GovernedProvider, ProviderFailoverService, CodexHarnessProvider, ClaudeCodeCliProvider, ClineHarnessProvider / AgentStartup* aggregate) — adding them would pull the execution stack onto this controller-graph barrel, regressing the two-runtimes split above.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export the credential-free live Codex availability probe for controller UI metadata.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Surface the dependency-free unattended-provider denial through the feature barrel for FSD-compliant controller preflight imports.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 inline hosted brain: export ByoHostedProvider + createGovernedByoHostedProvider (hosted OpenAI-compatible reasoning — no harness module on its graph, verified against the controller-runtime-boundary barrel scan) and the isUnbrokeredAutonomousProvider predicate the chat entry points share.
 */

export {
  CONTROLLER_INLINE_CONTAINERS,
  CONTROLLER_INLINE_SCRUB_ENV_KEYS,
  DEFAULT_INLINE_ALLOWED_TOOLS,
  SHELL_TOOL_NAMES,
  isControllerInlineContainer,
  resolveControllerInlineScope,
  stripShellTools,
  type ControllerInlineScope,
} from './services/controller-inline-scope';

export {
  LLMService,
  type TokenUsage,
  type CostResult,
  type LLMToolDefinition,
  type SendRequestOptions,
  type LLMResponse,
  type StreamCallback,
} from './services/llm-service';

export {
  ProviderRegistry,
  type ModelPricing,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderInfo,
} from './services/provider-registry';

export {
  resolveUsageCost,
  type ResolvedUsageCost,
} from './services/usage-cost-resolver';

// The swarm's own provider credentials — the ONE resolver. A feature that reads a vendor key out of
// process.env creates a second, invisible credential path the operator never configured.
export {
  getSwarmApiKey,
  hasSwarmApiKey,
  hasLiveCodexAuth,
  extractOpenAiCodexAccessToken,
  resolveSeedSecretsPath,
  type SwarmCredentialProvider,
} from './services/swarm-credentials';

export { NoopProvider } from './services/noop-provider';
export { AnthropicProvider, type AnthropicProviderConfig } from './services/anthropic-provider';
export {
  assertAuditedAutonomousHarness,
  isUnbrokeredAutonomousProvider,
} from './services/unattended-provider-policy';
// Hosted OpenAI-compatible reasoning on a caller-resolved connection (ADR-127). This is a
// HOSTED provider, not a harness: its module graph is llm-service + governed-provider only,
// so exporting it here keeps the barrel-split boundary intact (see the barrel scan in
// tests/unit/controller-runtime-boundary.spec.ts).
export {
  ByoHostedProvider,
  createGovernedByoHostedProvider,
  type ByoHostedConnection,
} from './services/byo-hosted-provider';

// A2A cost-event TYPES only, from the pure-types module — the harness runtime
// itself (adapters, HarnessLLMBridge) is deliberately NOT
// exported here. This barrel is on the controller graph (two-runtimes doctrine:
// the controller never calls an LLM); harness consumers use the dedicated
// '@/features/llm-provider/harness' entry point instead.
export type {
  A2ACostEvent,
  A2ARecordCostFn,
  A2ARemoteUsage,
} from './services/a2a-cost-events';

// Gemini connect-state probe (Plan E residual). Status-only by doctrine: the
// vendor's OWN CLI login runs host-side (Connect-AI.bat / `gemini`); the
// platform never brokers Google OAuth. The /api/gemini/auth route reads this.
export {
  getGeminiAuthStatus,
  resolveGeminiCredsPath,
  type GeminiAuthMethod,
  type GeminiAuthProbeOptions,
  type GeminiAuthReason,
  type GeminiAuthStatus,
} from './services/gemini-auth-status-service';

// FSD deep-import burn-down (2026-07-24). ONLY pure governance / config / data
// members are surfaced here — verified (scratchpad boundary probe) to add NO new
// LLM-execution/harness module to this controller-graph barrel. The execution
// provider runtimes stay off this barrel by design (see the barrel-split note above);
// their deep importers are recorded as intentionally-unresolved (Phase-1 stillMissing).
export {
  filterRegistryToolsByCapabilities,
  filterRuntimeToolDefinitionsByCapabilities,
  type AgentCapabilityResolver,
  type AgentSelectorResolution,
  type ToolCapabilityScope,
} from './services/tool-capability-scope';
export {
  getAllProviders,
  getProvider,
  getProvidersForAgent,
  getDefaultModel,
} from './services/provider-catalog';
export {
  buildClineConfig,
  buildClineGlobalState,
} from './services/cline-config-builder';
export { governLlmCall } from './governance';
export { gateLlmCall, recordGateUsage, estimateProjectedCostUsd } from './governance/gate';
export { BudgetService, readBudgetConfig, type BudgetScope } from './governance/budget-service';
export { readQuotaConfig } from './governance/quota-service';
export { readRoutingConfig } from './governance/fallback-routing';
