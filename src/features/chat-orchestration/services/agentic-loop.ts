/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Threaded interactionMode through the loop so conversational chat and swarm/task execution can launch the Cline runtime with different startup behavior
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — agentic loop ported from any-bot AgenticController.js
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Passed taskId through loop provider calls for workspace-aware CLI execution
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added optional tool execution context so orchestrator can pass task workspace identity into tool callbacks
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added follow-up question interrupt handling so the loop pauses cleanly for user input
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added per-turn usage/cost aggregation so agentic results persist model-level token and cost telemetry
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Passed agentId through provider calls so live startup manifests can resolve the active bot profile and tool context
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Routed per-turn cost through shared resolver so token-bearing zero-cost providers still contribute estimated model-level telemetry
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove generic connector credentials from the model-provider loop; credentials are resolved only inside audited server-side operations.
 */

import { createChildLogger } from '@/shared/logger';
import type { LLMMessage, ContentBlock, ModelUsageStats, ProcessResult, TaskUsageSummary } from '@/shared/types';
import { resolveUsageCost, type LLMService, type LLMToolDefinition, type LLMResponse, type StreamCallback } from '@/features/llm-provider';
import { FollowupQuestionSignal } from './followup-question-signal';
import { FatalToolError } from './fatal-tool-error';

const logger = createChildLogger({ module: 'agentic-loop' });

/**
 * @description Configuration for the agentic loop.
 */
export interface AgenticLoopConfig {
  maxTurns: number;
  streamCallback?: StreamCallback;
  taskId?: string;
  agentId?: string;
  interactionMode?: 'chat' | 'task';
  providerId?: string;
  model?: string;
  /** Authenticated caller's OIDC sub — scopes the bot's per-user data access. */
  userSub?: string;
}

/**
 * @description Callback for executing a tool use request.
 * Returns the tool result as a string (or throws on failure).
 */
export interface ToolExecutionContext {
  taskId?: string;
  agentId?: string;
  /** OIDC sub of the signed-in caller — threaded to cli tools as OSHAL_USER_SUB so
   *  per-user tools (career DB, gmail, …) run scoped. Absent for system dispatches. */
  userSub?: string;
}

/**
 * @description Callback signature used by the loop to dispatch a tool invocation to the orchestrator,
 * resolving the tool result string the model needs to continue (or throwing/signaling on failure or interrupt).
 * @param toolName - Name of the tool the model requested
 * @param toolInput - Parsed input arguments for the tool
 * @param context - Optional task/agent identity for workspace-aware execution
 * @returns The tool result rendered as a string
 */
export type ToolExecutionCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<string>;

/**
 * @description Default agentic loop configuration.
 */
const DEFAULT_CONFIG: AgenticLoopConfig = {
  maxTurns: 25,
};

/**
 * @description Runs a multi-turn agentic loop against an LLM provider.
 * Ported from any-bot's AgenticController.processAgenticTask().
 *
 * The loop:
 * 1. Sends conversation history + tools to the LLM
 * 2. Checks response for tool_use blocks
 * 3. If tool use found → executes tool, adds result to history, loops
 * 4. If no tool use or attempt_completion → returns final response
 * 5. Stops at maxTurns to prevent infinite loops
 *
 * @param provider - The LLM service instance to use
 * @param messages - Initial conversation history
 * @param systemPrompt - System prompt for the conversation
 * @param tools - Available tools for the LLM to call
 * @param executeTool - Callback to execute tool use requests
 * @param config - Loop configuration (max turns, streaming)
 * @returns Process result with response and metadata
 */
export async function runAgenticLoop(
  provider: LLMService,
  messages: LLMMessage[],
  systemPrompt: string,
  tools: LLMToolDefinition[],
  executeTool: ToolExecutionCallback,
  config: AgenticLoopConfig = DEFAULT_CONFIG,
): Promise<ProcessResult> {
  const loopConfig = { ...DEFAULT_CONFIG, ...config };
  const history = [...messages];
  const toolsUsed: string[] = [];
  let usageSummary = createEmptyUsageSummary();
  let turnCount = 0;

  logger.info(
    { provider: provider.getProviderName(), maxTurns: loopConfig.maxTurns, toolCount: tools.length },
    'Agentic loop started',
  );

  while (turnCount < loopConfig.maxTurns) {
    turnCount++;
    const turnResult = await executeTurn(
      provider, history, systemPrompt, tools, executeTool, toolsUsed, turnCount, loopConfig,
    );
    usageSummary = mergeUsageSummaries(usageSummary, turnResult.usageSummary);

    if (turnResult.done) {
      return buildResult(true, turnResult.response, turnCount, toolsUsed, turnResult.completionType, usageSummary);
    }
  }

  logger.warn({ turnCount: loopConfig.maxTurns }, 'Agentic loop hit max turns');
  return buildResult(true, extractLastResponse(history), turnCount, toolsUsed, 'tool_limit', usageSummary);
}

/**
 * @description Execute a single turn of the agentic loop.
 *
 * @param provider - LLM service
 * @param history - Mutable conversation history
 * @param systemPrompt - System prompt
 * @param tools - Available tools
 * @param executeTool - Tool execution callback
 * @param toolsUsed - Mutable list of tools used (for tracking)
 * @param turnNumber - Current turn number
 * @param config - Loop config
 * @returns Turn outcome — whether loop should continue or stop
 */
async function executeTurn(
  provider: LLMService,
  history: LLMMessage[],
  systemPrompt: string,
  tools: LLMToolDefinition[],
  executeTool: ToolExecutionCallback,
  toolsUsed: string[],
  turnNumber: number,
  config: AgenticLoopConfig,
): Promise<{ done: boolean; response?: string; completionType?: string; usageSummary: TaskUsageSummary }> {
  logger.debug({ turn: turnNumber }, 'Executing agentic turn');

  const response = await callProvider(
    provider,
    history,
    systemPrompt,
    tools,
    config.taskId,
    config.agentId,
    config.interactionMode,
    config.providerId,
    config.model,
    config.userSub,
  );
  const usageSummary = buildTurnUsageSummary(provider, response);
  const toolUseBlocks = extractToolUseBlocks(response.content);

  if (toolUseBlocks.length === 0) {
    const textResponse = extractTextFromBlocks(response.content);
    addAssistantMessage(history, response.content);
    return { done: true, response: textResponse, completionType: 'natural', usageSummary };
  }

  // Check for attempt_completion tool
  const completion = toolUseBlocks.find((b) => b.name === 'attempt_completion');
  if (completion) {
    const textResponse = extractTextFromBlocks(response.content);
    addAssistantMessage(history, response.content);
    return { done: true, response: textResponse, completionType: 'natural', usageSummary };
  }

  // Execute tools and continue loop
  addAssistantMessage(history, response.content);
  try {
    await executeToolBlocks(toolUseBlocks, executeTool, history, toolsUsed, config);
  } catch (error) {
    if (error instanceof FollowupQuestionSignal) {
      return { done: true, response: error.question, completionType: 'waiting_for_input', usageSummary };
    }
    throw error;
  }

  return { done: false, usageSummary };
}

/**
 * @description Call the LLM provider with conversation history and tools.
 *
 * @param provider - LLM service
 * @param history - Conversation messages
 * @param systemPrompt - System prompt
 * @param tools - Available tools
 * @returns LLM response
 */
async function callProvider(
  provider: LLMService,
  history: LLMMessage[],
  systemPrompt: string,
  tools: LLMToolDefinition[],
  taskId?: string,
  agentId?: string,
  interactionMode?: 'chat' | 'task',
  providerId?: string,
  model?: string,
  userSub?: string,
): Promise<LLMResponse> {
  try {
    return await provider.sendRequest({
      messages: history,
      systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      taskId,
      agentId,
      interactionMode,
      providerId,
      model,
      userSub,
    });
  } catch (error) {
    logger.error({ err: error, provider: provider.getProviderName() }, 'LLM request failed');
    throw error;
  }
}

/**
 * @description Extract tool_use content blocks from a response.
 *
 * @param blocks - Content blocks from LLM response
 * @returns Array of tool use blocks
 */
function extractToolUseBlocks(blocks: ContentBlock[]): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return blocks
    .filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

/**
 * @description Extract concatenated text from content blocks.
 *
 * @param blocks - Content blocks
 * @returns Combined text content
 */
function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * @description Extract the last assistant text response from history.
 *
 * @param history - Conversation history
 * @returns Last response text or empty string
 */
function extractLastResponse(history: LLMMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return '';
}

/**
 * @description Add an assistant message with content blocks to history.
 *
 * @param history - Mutable conversation history
 * @param content - Content blocks from the LLM response
 */
function addAssistantMessage(history: LLMMessage[], content: ContentBlock[]): void {
  history.push({ role: 'assistant', content });
}

/**
 * @description Execute all tool use blocks and add results to history.
 *
 * @param toolBlocks - Tool use requests from the LLM
 * @param executeTool - Tool execution callback
 * @param history - Mutable conversation history
 * @param toolsUsed - Mutable tracking list
 * @param config - Loop config (for stream callback)
 */
async function executeToolBlocks(
  toolBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  executeTool: ToolExecutionCallback,
  history: LLMMessage[],
  toolsUsed: string[],
  config: AgenticLoopConfig,
): Promise<void> {
  for (const block of toolBlocks) {
    const result = await executeAndTrack(block, executeTool, toolsUsed);
    addToolResultToHistory(history, block.id, result.content, result.isError);
  }
}

/**
 * @description Execute a single tool and track it.
 *
 * @param block - Tool use block
 * @param executeTool - Execution callback
 * @param toolsUsed - Tracking list
 * @returns Tool result content and error status
 */
async function executeAndTrack(
  block: { id: string; name: string; input: Record<string, unknown> },
  executeTool: ToolExecutionCallback,
  toolsUsed: string[],
): Promise<{ content: string; isError: boolean }> {
  logger.info({ tool: block.name, toolUseId: block.id }, 'Executing tool');
  toolsUsed.push(block.name);

  try {
    const content = await executeTool(block.name, block.input);
    logger.info({ tool: block.name }, 'Tool execution succeeded');
    return { content, isError: false };
  } catch (error) {
    if (error instanceof FollowupQuestionSignal) {
      logger.info({ tool: block.name }, 'Tool execution paused for follow-up question');
      throw error;
    }
    if (error instanceof FatalToolError) {
      // Non-recoverable (policy/security/integrity). Halt the loop instead of
      // feeding the message back as retryable text — re-throw to the caller.
      logger.error(
        { tool: block.name, reason: error.reason },
        'Tool execution failed fatally — halting task',
      );
      throw error;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, tool: block.name }, 'Tool execution failed');
    return { content: `Error: ${errMsg}`, isError: true };
  }
}

/**
 * @description Add a tool result to the conversation history.
 *
 * @param history - Mutable conversation history
 * @param toolUseId - ID of the tool use request
 * @param content - Result content
 * @param isError - Whether the result is an error
 */
function addToolResultToHistory(
  history: LLMMessage[],
  toolUseId: string,
  content: string,
  isError: boolean,
): void {
  history.push({
    role: 'user',
    content: [{ type: 'tool_result', toolUseId, content, isError }],
  });
}

/**
 * @description Build a standardized process result.
 *
 * @param success - Whether processing succeeded
 * @param response - Final response text
 * @param turnCount - Number of turns executed
 * @param toolsUsed - List of tools that were called
 * @param completionType - How the loop ended
 * @returns ProcessResult
 */
function buildResult(
  success: boolean,
  response: string | undefined,
  turnCount: number,
  toolsUsed: string[],
  completionType?: string,
  usageSummary?: TaskUsageSummary,
): ProcessResult {
  logger.info({ success, turnCount, toolCount: toolsUsed.length, completionType }, 'Agentic loop completed');
  return {
    success,
    response,
    turnCount,
    toolsUsed,
    usageSummary: usageSummary ?? createEmptyUsageSummary(),
    completionType: completionType as ProcessResult['completionType'],
  };
}

/**
 * @description Build usage summary for a single provider turn.
 *
 * @param provider - Active provider instance
 * @param response - Provider response containing usage + model
 * @returns Usage summary for this turn
 */
function buildTurnUsageSummary(provider: LLMService, response: LLMResponse): TaskUsageSummary {
  const inputTokens = normalizeInt(response.usage.inputTokens);
  const outputTokens = normalizeInt(response.usage.outputTokens);
  const totalTokens = inputTokens + outputTokens;
  const cost = resolveUsageCost({
    providerCost: provider.calculateCost(response.usage),
    usage: response.usage,
    providerId: provider.getProviderName(),
    modelId: response.model,
  });
  const model = readModelName(response.model);
  const byModel: Record<string, ModelUsageStats> = {
    [model]: {
      inputTokens,
      outputTokens,
      totalTokens,
      inputCost: normalizeFloat(cost.inputCost),
      outputCost: normalizeFloat(cost.outputCost),
      totalCost: normalizeFloat(cost.totalCost),
      requestCount: 1,
    },
  };
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputCost: normalizeFloat(cost.inputCost),
    outputCost: normalizeFloat(cost.outputCost),
    totalCost: normalizeFloat(cost.totalCost),
    currency: cost.currency || 'USD',
    requestCount: 1,
    byModel,
  };
}

/**
 * @description Merge two usage summaries into one aggregate summary.
 *
 * @param base - Existing usage summary
 * @param delta - Incoming usage summary
 * @returns Merged usage summary
 */
function mergeUsageSummaries(base: TaskUsageSummary, delta: TaskUsageSummary): TaskUsageSummary {
  const baseByModel = base.byModel || {};
  const deltaByModel = delta.byModel || {};
  const byModel: Record<string, ModelUsageStats> = { ...baseByModel };
  for (const [model, stats] of Object.entries(deltaByModel)) {
    const existing = byModel[model] || createEmptyModelUsage();
    byModel[model] = {
      inputTokens: normalizeInt(existing.inputTokens) + normalizeInt(stats.inputTokens),
      outputTokens: normalizeInt(existing.outputTokens) + normalizeInt(stats.outputTokens),
      totalTokens: normalizeInt(existing.totalTokens) + normalizeInt(stats.totalTokens),
      inputCost: normalizeFloat(existing.inputCost) + normalizeFloat(stats.inputCost),
      outputCost: normalizeFloat(existing.outputCost) + normalizeFloat(stats.outputCost),
      totalCost: normalizeFloat(existing.totalCost) + normalizeFloat(stats.totalCost),
      requestCount: normalizeInt(existing.requestCount) + normalizeInt(stats.requestCount),
    };
  }
  return {
    inputTokens: normalizeInt(base.inputTokens) + normalizeInt(delta.inputTokens),
    outputTokens: normalizeInt(base.outputTokens) + normalizeInt(delta.outputTokens),
    totalTokens: normalizeInt(base.totalTokens) + normalizeInt(delta.totalTokens),
    inputCost: normalizeFloat(base.inputCost) + normalizeFloat(delta.inputCost),
    outputCost: normalizeFloat(base.outputCost) + normalizeFloat(delta.outputCost),
    totalCost: normalizeFloat(base.totalCost) + normalizeFloat(delta.totalCost),
    currency: delta.currency || base.currency || 'USD',
    requestCount: normalizeInt(base.requestCount) + normalizeInt(delta.requestCount),
    byModel,
  };
}

/**
 * @description Create a zeroed usage summary object.
 *
 * @returns Empty usage summary
 */
function createEmptyUsageSummary(): TaskUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    currency: 'USD',
    requestCount: 0,
    byModel: {},
  };
}

/**
 * @description Create a zeroed per-model usage object.
 *
 * @returns Empty model usage stats
 */
function createEmptyModelUsage(): ModelUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    requestCount: 0,
  };
}

/**
 * @description Normalize model names for usage-key consistency.
 *
 * @param model - Raw model identifier
 * @returns Normalized model identifier
 */
function readModelName(model: string): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed.length > 0 ? trimmed : 'unknown-model';
}

/**
 * @description Normalize non-negative integer values.
 *
 * @param value - Raw number value
 * @returns Non-negative integer
 */
function normalizeInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Normalize non-negative float values.
 *
 * @param value - Raw number value
 * @returns Non-negative float
 */
function normalizeFloat(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
