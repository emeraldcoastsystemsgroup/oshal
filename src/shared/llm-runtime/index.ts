/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the shared LLM-runtime rules — the per-bot provider precedence resolver. Shared (bottom) layer on purpose: the agent-profile feature computes it at read time and the Utilities panel renders it, and both must get the SAME answer from the SAME code.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export checkModelAgainstCatalog + UnknownModelId, so the api route and the operator-key lane measure a configured model against the catalog through the same rule rather than each re-deriving it.
 */

/**
 * @description Runtime rules about how a bot's LLM provider is chosen, shared by every layer that
 * needs to REPORT that choice rather than make it.
 * @module shared/llm-runtime
 */

export {
  ANY_BOT_COMPLETION_SCOPE,
  ANY_BOT_COMPLETION_TOOL,
  anyBotRuntimeToolFor,
  anyBotRuntimeToolScope,
} from './any-bot-runtime-capabilities';
export {
  resolveEffectiveBotProvider,
  type BotProviderInputs,
  type BotProviderSource,
  type EffectiveBotProvider,
} from './bot-provider-precedence';
export {
  FLEET_DEFAULT_SWITCH_ID,
  checkModelAgainstCatalog,
  classifyProviderId,
  requireModelForClineBackedId,
  resolveBotProviderSwitch,
  resolveProviderFallbackChain,
  type BotProviderSwitchResolution,
  type ProviderFallbackChain,
  type BotProviderSwitchSource,
  type ClassifiedProviderId,
  type ProviderIdClassification,
  type ProviderSwitchCatalog,
  type ProviderSwitchRow,
  type RefusedProviderId,
  type SwitchRegistryEntry,
  type UnknownModelId,
} from './bot-provider-switch';
