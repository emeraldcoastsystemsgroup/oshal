/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New harness entry point (barrel split, TODO-BOUNDARY-FINDING 2026-07-19). The main llm-provider barrels re-exported the harness runtime, so ANY controller import of '@/features/llm-provider' (types, cost resolver, credentials) statically loaded the whole harness stack — violating the two-runtimes doctrine (CLAUDE.md: the controller orchestrates, bot nodes own LLM execution). This second sanctioned entry point ('@/features/llm-provider/harness', mirroring the existing governance/ sub-entry) carries the harness stack for its ONE legitimate consumer: the harness composition root (src/app/composition/provider-runtime.ts). Controller consumers keep using '@/features/llm-provider' and never touch this path. Guarded by tests/unit/controller-runtime-boundary.spec.ts, which pins provider-runtime.ts as this barrel's sole importer.
 */

/**
 * @description Harness-stack entry point for bot-node/composition consumers.
 * Everything the HARNESS_FACTORIES registry needs: the HarnessAdapter contract
 * + HarnessLLMBridge, the three CLI-spawn adapters, and the outbound A2A
 * adapter. Do NOT import this from controller
 * routes/features — the controller never calls an LLM.
 */

export {
  HarnessLLMBridge,
  buildConversationAwarePrompt,
  type HarnessAdapter,
  type HarnessTask,
  type HarnessResult,
  type HarnessType,
  type HarnessFactory,
  type HarnessFactoryConfig,
} from '../services/harness-adapter';
export {
  CodexCliHarnessAdapter,
  type CodexCliHarnessConfig,
} from '../services/codex-cli-harness-adapter';
export {
  ClaudeCodeCliHarnessAdapter,
  type ClaudeCodeCliHarnessConfig,
} from '../services/claude-code-cli-harness-adapter';
export {
  GeminiCliHarnessAdapter,
  type GeminiCliHarnessConfig,
} from '../services/gemini-cli-harness-adapter';
export {
  A2AHarnessAdapter,
  deriveA2ATokenEnvName,
  readRemoteUsage,
  type A2AHarnessAdapterConfig,
} from '../services/a2a-harness-adapter';
export type {
  A2ACostEvent,
  A2ARecordCostFn,
  A2ARemoteUsage,
} from '../services/a2a-cost-events';
