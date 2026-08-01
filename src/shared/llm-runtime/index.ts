/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the shared LLM-runtime rules — the per-bot provider precedence resolver. Shared (bottom) layer on purpose: the agent-profile feature computes it at read time and the Utilities panel renders it, and both must get the SAME answer from the SAME code.
 */

/**
 * @description Runtime rules about how a bot's LLM provider is chosen, shared by every layer that
 * needs to REPORT that choice rather than make it.
 * @module shared/llm-runtime
 */

export {
  resolveEffectiveBotProvider,
  type BotProviderInputs,
  type BotProviderSource,
  type EffectiveBotProvider,
} from './bot-provider-precedence';
