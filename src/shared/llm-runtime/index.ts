/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the shared LLM-runtime rules — the per-bot provider precedence resolver. Shared (bottom) layer on purpose: the agent-profile feature computes it at read time and the Utilities panel renders it, and both must get the SAME answer from the SAME code.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export checkModelAgainstCatalog + UnknownModelId, so the api route and the operator-key lane measure a configured model against the catalog through the same rule rather than each re-deriving it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export botNodeCanRunProvider so the settings surface can ask whether a provider id has a bot-node runtime behind it before offering it, without a deep import and without keeping a second copy of the answer.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export anyBotImageTurnToolFor, the per-harness image tool an image turn's authority names (ADR-130 amendment 2026-10-02), so the bot-node handler reads it without a deep import.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Export ANY_BOT_IMAGE_TURN_DIAGNOSTIC_MARKER: the bot-node handler and the api's antigravity render provider share the marker between an image-turn refusal's own words and its untrusted diagnostic (clearer Guard A refusals, 2026-10-03).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Export ANY_BOT_IMAGE_TURN_ERROR_REFUSAL and ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY: Guard A's fixed ERROR words and its [backoff] category, which the api's antigravity render provider matches to retry a render as a fresh turn (operator decision 2026-10-03).
 */

/**
 * @description Runtime rules about how a bot's LLM provider is chosen, shared by every layer that
 * needs to REPORT that choice rather than make it.
 * @module shared/llm-runtime
 */

export {
  ANY_BOT_COMPLETION_SCOPE,
  ANY_BOT_COMPLETION_TOOL,
  ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY,
  ANY_BOT_IMAGE_TURN_DIAGNOSTIC_MARKER,
  ANY_BOT_IMAGE_TURN_ERROR_REFUSAL,
  anyBotImageTurnToolFor,
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
  botNodeCanRunProvider,
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
