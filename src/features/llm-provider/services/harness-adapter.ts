/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | HarnessAdapter contract — formal interface for all agent runtime harnesses (Cline, Codex CLI, Claude Code)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: HarnessTask.creds carries the caller's short-lived per-user access tokens (OSHAL_CRED_*) written into the workspace as .oshal-cred-<provider> files, so shelled tools use a provided token instead of decrypting oshal_connections with SESSION_SECRET.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | HarnessFactoryConfig gains container + allowedTools + scrubEnvKeys so resolveHarnessForAgent can hand a CONTROLLER-INLINE bot a least-privilege harness (BACKLOG "Harden inline controller bots"): no shell tool, and the platform-plane credentials the api container holds deleted from the child env. All three are optional and absent for bot-node bots, so their harnesses are built byte-identically.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added 'a2a' to the HarnessType union (outbound A2A gateway, BACKLOG Plan F item 3) — an external A2A agent as a dispatch target; the typed HARNESS_FACTORIES record forces its factory entry. HarnessFactoryConfig gains botName + a2aEndpointEnv so the a2a factory can derive the per-bot credential env (A2A_OUTBOUND_TOKEN_<BOTKEY>) and the registry-declared endpoint env without hardcoding either.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove generic connector credentials from HarnessTask and fail closed before unattended Cline, Codex, Claude Code, or Gemini CLI execution until an audited OSHAL brokered sandbox exists.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Move unattended-provider denial into a dependency-free policy module, preserving this compatibility export without pulling the harness runtime into controller preflight callers.
 */

import { createChildLogger } from '@/shared/logger';
import { assertAuditedAutonomousHarness } from './unattended-provider-policy';
export { assertAuditedAutonomousHarness } from './unattended-provider-policy';
import {
  LLMService,
  type SendRequestOptions,
  type LLMResponse,
  type TokenUsage,
} from './llm-service';
import type { AgentCapabilityResolver } from './tool-capability-scope';

const logger = createChildLogger({ module: 'harness-adapter' });

// ── Core harness types ────────────────────────────────────────────────────────

/**
 * @description The harness type identifier. Each value names a concrete runtime
 * that OSHAL can spawn or delegate to when executing bot work items.
 *
 * - `cline`       — Cline CLI subprocess (`cline --json`)
 * - `codex-cli`   — OpenAI Codex CLI subprocess (`codex`)
 * - `claude-code` — Claude Code CLI subprocess (`claude`)
 * - `gemini-cli`  — Google Gemini CLI subprocess (`gemini`)
 * - `a2a`         — External A2A agent over JSON-RPC HTTP (outbound gateway, Plan F)
 * - `noop`        — No-op stub harness for test / local dev
 */
export type HarnessType = 'cline' | 'codex-cli' | 'claude-code' | 'gemini-cli' | 'a2a' | 'noop';

/**
 * @description Normalised input handed to a harness for one unit of work.
 * Maps directly to a single `sendRequest()` invocation on the harness LLMService.
 */
export interface HarnessTask {
  /** Free-form prompt given to the agent runtime. */
  prompt: string;

  /** Optional system / persona instructions. */
  systemPrompt?: string;

  /** OSHAL task ID for cost tracking and workspace isolation. */
  taskId?: string;

  /** OSHAL agent ID for per-bot provider selection. */
  agentId?: string;

  /** Authenticated caller's OIDC sub. Written into the task workspace as
   *  `.oshal-user-sub` so shelled-out tools (oshal-gmail.js) act ONLY for this user. */
  userSub?: string;

  /**
   * Provider / model hint forwarded verbatim to the harness.
   * Cline: written to session globalState; Codex: `--model`.
   */
  model?: string;

  /** Whether this is a chat turn or a background swarm task. */
  interactionMode?: 'chat' | 'task';

  /** Child/review scope isolation key (IMP-2). */
  executionScopeId?: string;

  /**
   * Prior conversation turns for this task — lets one-and-done CLI harnesses
   * include conversation context in the prompt even though they don't maintain
   * a persistent session.
   */
  conversationHistory?: Array<{ role: string; content: string }>;
}

/**
 * @description Result returned by a harness after executing a task.
 */
export interface HarnessResult {
  /** Full text output produced by the agent runtime. */
  text: string;

  /** Token telemetry (may be zero if the runtime does not report usage). */
  usage: TokenUsage;

  /** Model identifier as reported by the runtime (e.g. `gpt-4.1`, `claude-sonnet-5`). */
  model: string;

  /** Stop / finish reason. Default `end_turn`. */
  stopReason?: string;
}

// ── HarnessAdapter interface ──────────────────────────────────────────────────

/**
 * @description Formal contract that every agent runtime harness must satisfy.
 *
 * A harness wraps one agent runtime (Cline CLI, Codex CLI,
 * Claude Code CLI) and exposes it as a simple `run()` method.  The rest of OSHAL
 * does not need to know which runtime is in use — it calls `run()` and gets a
 * `HarnessResult` back.
 *
 * Harnesses are registered in the `HARNESS_FACTORIES` map and instantiated by
 * `createRuntimeProvider()` / `createRuntimeProviderWithManifest()`.
 *
 * @example Implementing a custom harness
 * ```ts
 * export class MyCustomHarness implements HarnessAdapter {
 *   readonly harnessType: HarnessType = 'codex-cli';
 *   async run(task: HarnessTask): Promise<HarnessResult> { ... }
 *   async healthCheck(): Promise<boolean> { return true; }
 * }
 * ```
 */
export interface HarnessAdapter {
  /** Identifies which runtime this adapter wraps. */
  readonly harnessType: HarnessType;

  /**
   * @description Execute one unit of work through the agent runtime.
   * @param task - Normalised harness task.
   * @returns Result produced by the runtime.
   */
  run(task: HarnessTask): Promise<HarnessResult>;

  /**
   * @description Optional liveness/readiness probe for the harness runtime.
   * Returns `true` when the runtime is ready to accept tasks.
   * Defaults to `true` when not implemented.
   */
  healthCheck?(): Promise<boolean>;
}

// ── HarnessLLMBridge ──────────────────────────────────────────────────────────

/**
 * @description Adapter that wraps a `HarnessAdapter` as a standard `LLMService`.
 *
 * This lets the rest of OSHAL (SwarmAgentWorker, chat routes, etc.) treat any
 * harness as a drop-in replacement for a direct LLM provider, without needing
 * to know they are talking to an external agent runtime.
 *
 * The bridge translates `SendRequestOptions → HarnessTask` and
 * `HarnessResult → LLMResponse`.
 */
export class HarnessLLMBridge extends LLMService {
  private readonly adapter: HarnessAdapter;

  constructor(adapter: HarnessAdapter) {
    super(`harness:${adapter.harnessType}`, {});
    this.adapter = adapter;
    logger.info({ harnessType: adapter.harnessType }, 'HarnessLLMBridge initialized');
  }

  /**
   * @description Translates a standard LLMService request into a HarnessTask,
   * delegates to the wrapped adapter, and maps the result back to LLMResponse.
   */
  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    assertAuditedAutonomousHarness(this.adapter.harnessType);
    this.requestCount++;

    // Extract the prompt from the last user message
    const lastMessage = options.messages[options.messages.length - 1];
    const rawContent = lastMessage?.content ?? '';
    const prompt = typeof rawContent === 'string'
      ? rawContent
      : JSON.stringify(rawContent);

    // Pass prior conversation turns so CLI harnesses can include context
    const priorMessages = options.messages.slice(0, -1);
    const conversationHistory = priorMessages.length > 0
      ? priorMessages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }))
      : undefined;

    const task: HarnessTask = {
      prompt,
      systemPrompt: options.systemPrompt,
      taskId: options.taskId,
      agentId: options.agentId,
      userSub: options.userSub,
      model: options.model,
      interactionMode: options.interactionMode,
      executionScopeId: options.executionScopeId,
      conversationHistory,
    };

    logger.info(
      {
        harnessType: this.adapter.harnessType,
        taskId: task.taskId,
        agentId: task.agentId,
        promptLength: prompt.length,
      },
      'HarnessLLMBridge: delegating to harness adapter',
    );

    const result = await this.adapter.run(task);

    return {
      content: [{ type: 'text', text: result.text }],
      usage: result.usage,
      model: result.model,
      stopReason: result.stopReason ?? 'end_turn',
    };
  }

  getProviderName(): string {
    return `harness:${this.adapter.harnessType}`;
  }
}

// ── HarnessFactory type ───────────────────────────────────────────────────────

/**
 * @description Factory function signature for creating a harness-backed `LLMService`.
 * Each entry in `HARNESS_FACTORIES` must conform to this type.
 *
 * @param config - Resolved runtime config (provider name, model, manifests, etc.)
 */
/**
 * @description Builds a context-enriched prompt by prepending prior conversation turns.
 * Used by CLI harness adapters (claude-code, codex, cline) that spawn a one-shot subprocess
 * and need the full conversation threaded into a single prompt string.
 *
 * Returns the original prompt unchanged when there is no history.
 */
export function buildConversationAwarePrompt(task: HarnessTask): string {
  const history = task.conversationHistory;
  if (!history || history.length === 0) {
    return task.prompt;
  }

  const contextLines = history.map((turn) => {
    const label = turn.role === 'assistant' ? 'Assistant' : 'User';
    return `[${label}]\n${turn.content}`;
  });

  return `## Prior conversation context\n${contextLines.join('\n\n')}\n\n## Current request\n${task.prompt}`;
}

/**
 * @description Factory function signature for creating a harness-backed `LLMService`.
 * Each entry in `HARNESS_FACTORIES` must conform to this type, taking a resolved
 * runtime configuration and returning a ready-to-use LLMService instance.
 * @param config - Resolved runtime config (provider name, model, manifests, etc.).
 * @returns An LLMService backed by the selected harness runtime.
 */
export type HarnessFactory = (config: HarnessFactoryConfig) => LLMService;

/**
 * @description Configuration bag passed to every `HarnessFactory`.
 * All fields are optional — factories should gracefully handle absent values.
 */
export interface HarnessFactoryConfig {
  /** Resolved provider name (e.g. 'openai-codex', 'anthropic'). */
  providerId?: string;

  /**
   * The API/provider declared in the bot's registry entry (SwarmBotDefinition.apiType).
   * Validated against harnessType at factory creation time.
   * For 'cline' harness: overrides FORCE_LLM_PROVIDER as the bot-level provider.
   */
  apiType?: string;

  /** Resolved model name (e.g. 'gpt-4.1', 'claude-opus-4-6'). */
  modelId?: string;

  /** Path or name of the CLI binary. */
  cliBinaryPath?: string;

  /**
   * The compose container the bot's registry entry declares. Present so a factory can tell a
   * CONTROLLER-INLINE bot (container 'oshal-api' — runs inside the api process's container,
   * which holds the platform's own credentials) from a bot-node bot, and scope it accordingly.
   * See services/controller-inline-scope.ts for the policy.
   */
  container?: string;

  /**
   * Explicit tool allowlist for tool-gated CLIs (claude-code `--allowedTools`). When set it
   * OVERRIDES the process-level CLAUDE_ALLOWED_TOOLS — that is what lets an inline bot run
   * without a shell on a deployment whose env grants one to every bot node.
   */
  allowedTools?: string;

  /**
   * Extra environment keys the adapter must delete from the spawned CLI's environment, on top
   * of the always-scrubbed master/connector secrets. Used to keep platform-plane credentials
   * out of an inline bot's subprocess.
   */
  scrubEnvKeys?: readonly string[];

  /** API key / bearer token (provider-specific). */
  apiKey?: string;

  /** Optional agent runtime selection resolver for per-bot overrides. */
  resolveAgentRuntimeSelection?: (agentId: string) => Promise<{ providerId?: string; modelId?: string } | null>;

  /** Optional agent capability resolver for scoped tool/MCP exposure. */
  resolveAgentCapabilities?: AgentCapabilityResolver;

  /** Optional startup manifest service (Cline-specific). */
  manifestService?: unknown;

  /**
   * The bot's registry name (SwarmBotDefinition.name). The a2a harness derives
   * its per-bot outbound credential env var from it (A2A_OUTBOUND_TOKEN_<BOTKEY>)
   * so tokens never live in code or registry entries. Harmless for other harnesses.
   */
  botName?: string;

  /**
   * Name of the env var carrying the external A2A agent's endpoint URL, declared
   * on the bot's registry entry (a2aEndpointEnv). Indirection keeps deployment
   * URLs out of source while letting each a2a bot point at a different remote.
   */
  a2aEndpointEnv?: string;
}
