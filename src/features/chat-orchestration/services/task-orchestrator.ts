/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — task orchestration ported from any-bot TaskController.js
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Integrated ToolAuthInterceptor for auth mode enforcement
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed task auto-create path to preserve requested taskId and prevent task-store mismatch warnings
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Passed taskId through provider sendRequest options for workspace-aware CLI adapters
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Changed tool resolver dependency to async so orchestration can load runtime tool definitions for Cline-style system prompt/tool awareness
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Bound tool execution callbacks to the current taskId so server-side tools execute inside the correct workspace
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added waiting-for-input task transitions and async system prompt resolution for follow-up and Layer-1 prompt context
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added durable usage/cost aggregation updates per task so total tokens and cost stats persist across restarts
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Passed agentId into provider calls so startup manifest assembly can bind runtime state to the active bot
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Improved error message extraction for AggregateError (ECONNREFUSED) to surface meaningful diagnostics
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Threaded taskId into getSystemPrompt calls so persona context files are written to the per-task workspace directory
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added optional ticketService to deps for automatic ticket→task linking when ticketId is provided in options
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Appended canonical internal ticket context to orchestration prompts when a conversation is backed by a real ticket record
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Marked task-orchestrator provider calls as interactionMode=chat so direct bot conversations stop inheriting swarm-style workspace execution behavior
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Routed direct-mode token telemetry through shared usage-cost resolver so zero-cost providers still persist estimated per-model usage
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Allow trusted internal direct-mode callers to bypass filesystem persona discovery with an explicit system prompt.
 */

import { createChildLogger } from '@/shared/logger';
import type {
  ProcessMessageOptions,
  ProcessResult,
  LLMMessage,
  TaskUsageSummary,
} from '@/shared/types';
import type { ITaskStore } from '@/entities/task';
import type { IMessageStore } from '@/entities/message';
import { resolveUsageCost, type LLMService, type LLMToolDefinition, type LLMResponse } from '@/features/llm-provider';
import { StreamManager } from '@/features/streaming';
import type { ToolAuthInterceptor } from '@/features/tool-approval';
import type { MemoryLayerService } from '@/features/memory';
import type { TicketService } from '@/features/ticketing';
import { runAgenticLoop, type ToolExecutionCallback } from './agentic-loop';
import { DEFAULT_CHAT_AGENT_ID } from '../constants/default-chat-agent';

const logger = createChildLogger({ module: 'task-orchestrator' });

/**
 * @description Dependencies injected into the TaskOrchestrator.
 * Follows dependency injection pattern — no hard-wired imports.
 */
export interface TaskOrchestratorDeps {
  taskStore: ITaskStore;
  messageStore: IMessageStore;
  streamManager: StreamManager;
  getProvider: (providerId?: string) => LLMService;
  getTools: (agentId?: string) => Promise<LLMToolDefinition[]>;
  executeTool: ToolExecutionCallback;
  getSystemPrompt: (agentId?: string, tools?: LLMToolDefinition[], taskId?: string) => Promise<string>;
  /** Optional tool auth interceptor — when provided, wraps executeTool with auth checks */
  toolAuthInterceptor?: ToolAuthInterceptor;
  /** Optional non-swarm memory layer service for checkpoints and agent memory */
  memoryService?: MemoryLayerService;
  /** Optional ticket service for automatic ticket→task linking */
  ticketService?: TicketService;
}

/**
 * @description Orchestrates the lifecycle of a chat task — from receiving
 * a user message through LLM processing to response delivery.
 *
 * Ported from any-bot's TaskController.processMessage() flow:
 * 1. Save user message to store
 * 2. Build conversation context (recent messages)
 * 3. Route to agentic loop or direct mode
 * 4. Save assistant response
 * 5. Broadcast via streaming
 *
 * @remarks
 * This is a stateless orchestrator — all state is held in the injected stores.
 * The orchestrator coordinates between stores, providers, and streaming
 * without owning any persistent state itself.
 */
export class TaskOrchestrator {
  private deps: TaskOrchestratorDeps;

  constructor(deps: TaskOrchestratorDeps) {
    this.deps = deps;
    logger.info('Task orchestrator initialized');
  }

  /**
   * @description Process a user message within a task context.
   * Main entry point — equivalent to any-bot's TaskController.processMessage().
   *
   * @param taskId - The task/conversation to process within
   * @param text - User message text
   * @param options - Processing options (mode, source, agentId, etc.)
   * @returns Processing result with response and metadata
   */
  async processMessage(
    taskId: string,
    text: string,
    options: ProcessMessageOptions = { agenticMode: true, autoApprove: false, source: 'dashboard' },
  ): Promise<ProcessResult> {
    const startTime = Date.now();
    logger.info({ taskId, source: options.source, agenticMode: options.agenticMode }, 'Processing message');

    try {
      const isNewThread = await this.ensureTaskExists(taskId, options.agentId, options.userSub);
      await this.ensureChatTicket(taskId, text, options, isNewThread);
      await this.saveUserMessage(taskId, text);
      this.deps.streamManager.associateTaskWithSession(taskId);
      await this.deps.taskStore.updateStatus(taskId, 'processing');
      this.deps.streamManager.broadcastTaskUpdate(taskId, { status: 'processing' });

      const result = options.agenticMode
        ? await this.processAgentic(taskId, text, options)
        : await this.processDirect(taskId, text, options);

      await this.handleResult(taskId, result, startTime);
      await this.linkTicketIfRequested(taskId, options.ticketId);
      return result;
    } catch (error) {
      return this.handleError(taskId, error, startTime);
    }
  }

  /**
   * @description Ensure the task exists, creating it if needed.
   *
   * @param taskId - Task identifier
   */
  private async ensureTaskExists(taskId: string, agentId?: string, ownerSub?: string): Promise<boolean> {
    const existing = await this.deps.taskStore.get(taskId);
    if (existing) {
      return false;
    }
    const created = await this.deps.taskStore.create({
      taskId,
      title: '',
      processingMode: 'agentic',
      agentId,
      ownerSub, // per-owner budget attribution (Phase 2)
      metadata: {},
    });
    logger.info(
      { requestedTaskId: taskId, storedTaskId: created.taskId },
      'Auto-created task',
    );
    return true;
  }

  /**
   * @description Opens a workflow-less chat-ticket the FIRST time a chat thread is created, so the
   * conversation shows on the queue board and stays open until the user closes it. Only fires for
   * chat-mode turns owned by a signed-in user (interactionMode !== 'task' && userSub present).
   * Status `in_process` keeps it out of the swarm queue. Best-effort — a failure never blocks chat.
   *
   * @param taskId - The chat thread's task id.
   * @param text - The opening user message (used for the ticket title).
   * @param options - Processing options (userSub owner, agentId target bot, interactionMode).
   * @param isNewThread - True only when this call just created the task (one ticket per thread).
   */
  private async ensureChatTicket(
    taskId: string,
    text: string,
    options: ProcessMessageOptions,
    isNewThread: boolean,
  ): Promise<void> {
    if (!isNewThread || !this.deps.ticketService) {
      return;
    }
    const ownerSub = options.userSub;
    const interactionMode = (options as { interactionMode?: string }).interactionMode;
    if (!ownerSub || interactionMode !== 'chat') {
      // Only genuine, user-owned chat turns (interactionMode 'chat') open a chat-ticket. This
      // positively EXCLUDES app flows (eats/purchasing/rides call processMessage directly with no
      // interactionMode) and Jarvis's internal classify/delegate steps — none of which are chat.
      return;
    }
    try {
      await this.deps.ticketService.openChatTicket({
        taskId,
        ownerSub,
        agentId: options.agentId ?? null,
        text,
        targetBot: (options as { targetBot?: string }).targetBot ?? null,
      });
    } catch (err) {
      logger.warn({ err, taskId }, 'chat-ticket open skipped (non-fatal)');
    }
  }

  /**
   * @description Save the user's message to the message store.
   *
   * @param taskId - Task identifier
   * @param text - Message text
   */
  private async saveUserMessage(taskId: string, text: string): Promise<void> {
    await this.deps.messageStore.save({
      taskId,
      role: 'user',
      type: 'task',
      text,
      contentBlocks: [],
      metadata: {},
    });
    await this.deps.taskStore.incrementMessageCount(taskId);
    logger.debug({ taskId }, 'User message saved');
  }

  /**
   * @description Process a message using the agentic (multi-turn) loop.
   *
   * @param taskId - Task identifier
   * @param text - User message text
   * @param options - Processing options
   * @returns Process result
   */
  private async processAgentic(
    taskId: string,
    text: string,
    options: ProcessMessageOptions,
  ): Promise<ProcessResult> {
    const provider = this.deps.getProvider(options.agentId);
    const tools = await this.deps.getTools(options.agentId);
    const baseSystemPrompt = await this.deps.getSystemPrompt(options.agentId, tools, taskId);
    const systemPrompt = appendTicketContextNote(baseSystemPrompt, options);
    const history = await this.buildHistory(taskId, provider.getProviderName());

    logger.info(
      { taskId, provider: provider.getProviderName(), historyLength: history.length },
      'Starting agentic processing',
    );

    const executor = this.getExecutor(taskId, options.agentId, options.userSub);

    return runAgenticLoop(
      provider,
      history,
      systemPrompt,
      tools,
      executor,
      {
        maxTurns: 25,
        taskId,
        agentId: options.agentId,
        providerId: (options as { providerId?: string }).providerId,
        model: (options as { model?: string }).model,
        userSub: options.userSub,
        creds: (options as { creds?: Record<string, string> }).creds,
        interactionMode: ((options as Record<string, unknown>).interactionMode === 'task' ? 'task' : 'chat') as 'task' | 'chat',
      },
    );
  }

  /**
   * @description Process a message in direct mode (single LLM call, no tool loop).
   *
   * @param taskId - Task identifier
   * @param text - User message text
   * @param options - Processing options
   * @returns Process result
   */
  private async processDirect(
    taskId: string,
    text: string,
    options: ProcessMessageOptions,
  ): Promise<ProcessResult> {
    const provider = this.deps.getProvider(options.agentId);
    const baseSystemPrompt = options.systemPromptOverride
      ?? (await this.deps.getSystemPrompt(options.agentId, undefined, taskId));
    const systemPrompt = options.systemPromptOverride
      ? baseSystemPrompt
      : appendTicketContextNote(baseSystemPrompt, options);
    const history = await this.buildHistory(taskId, provider.getProviderName());

    logger.info({ taskId, provider: provider.getProviderName() }, 'Starting direct processing');

    try {
      const response = await provider.sendRequest({
        messages: history,
        systemPrompt,
        taskId,
        agentId: options.agentId,
        providerId: (options as { providerId?: string }).providerId,
        model: (options as { model?: string }).model,
        userSub: options.userSub,
        creds: (options as { creds?: Record<string, string> }).creds,
        interactionMode: ((options as { interactionMode?: string }).interactionMode === 'task') ? 'task' : 'chat',
      });
      const usageSummary = buildDirectUsageSummary(provider, response);

      const responseText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      return { success: true, response: responseText, turnCount: 1, toolsUsed: [], usageSummary };
    } catch (error) {
      logger.error({ err: error, taskId }, 'Direct processing failed');
      throw error;
    }
  }

  /**
   * @description Returns the tool executor, optionally wrapped with auth interceptor.
   * If a ToolAuthInterceptor is provided in deps, wraps the base executor
   * so that auth mode checks (auto/ask/off) are enforced before each tool call.
   *
   * @param taskId - Current task context
   * @param agentId - The agent requesting tool execution
   * @returns Tool execution callback (original or intercepted)
   */
  private getExecutor(taskId: string, agentId?: string, userSub?: string): ToolExecutionCallback {
    const baseExecutor: ToolExecutionCallback = (toolName, toolInput) => this.deps.executeTool(
      toolName,
      toolInput,
      { taskId, agentId, userSub },
    );

    if (!this.deps.toolAuthInterceptor) {
      return baseExecutor;
    }

    return this.deps.toolAuthInterceptor.createInterceptedExecutor(
      baseExecutor,
      agentId?.trim() || DEFAULT_CHAT_AGENT_ID,
      taskId,
    );
  }

  /**
   * @description Build conversation history from stored messages.
   * Provider-aware: some providers (like Cline CLI) are stateless
   * and should receive empty history.
   *
   * @param taskId - Task identifier
   * @param providerName - Provider name (affects history strategy)
   * @returns Array of LLM-formatted messages
   */
  private async buildHistory(taskId: string, providerName: string): Promise<LLMMessage[]> {
    // CLI harnesses (cline, codex, claude-code) are one-and-done subprocesses but
    // still benefit from conversation context — the HarnessLLMBridge serializes
    // prior turns into the prompt so the bot has memory of the conversation.
    const contextSize = providerName === 'bedrock' ? 10 : 20;
    const stored = await this.deps.messageStore.getRecent(taskId, contextSize);

    return stored.map((msg) => ({
      role: msg.role,
      content: msg.text,
    }));
  }

  /**
   * @description Handle a successful processing result.
   *
   * @param taskId - Task identifier
   * @param result - Processing result
   * @param startTime - When processing started (for duration calc)
   */
  private async handleResult(taskId: string, result: ProcessResult, startTime: number): Promise<void> {
    const durationMs = Date.now() - startTime;
    const waitingForInput = result.completionType === 'waiting_for_input';

    if (result.turnCount && result.turnCount > 0) {
      await this.deps.taskStore.incrementTurnCount(taskId, result.turnCount);
    }
    if (result.usageSummary) {
      await this.deps.taskStore.recordUsage(taskId, result.usageSummary);
    }

    if (result.response) {
      await this.saveAssistantResponse(
        taskId,
        result.response,
        waitingForInput ? 'ask' : 'say',
        result.usageSummary,
      );
    }

    const newStatus = waitingForInput
      ? 'waiting_for_input'
      : result.success
        ? 'active'
        : 'failed';
    await this.deps.taskStore.updateStatus(taskId, newStatus);
    const updatedTask = await this.deps.taskStore.get(taskId);
    if (updatedTask && this.deps.memoryService) {
      await this.deps.memoryService.captureTaskOutcome(taskId, {
        agentId: updatedTask.agentId,
        assistantResponse: result.response,
        toolsUsed: result.toolsUsed,
        completionType: result.completionType,
        checkpointTrigger: waitingForInput ? 'manual' : 'auto',
      });
    }
    this.deps.streamManager.broadcastTaskUpdate(taskId, {
      status: newStatus,
      success: result.success,
      turnCount: result.turnCount,
      completionType: result.completionType ?? null,
      taskSnapshot: updatedTask,
    });

    if (result.response) {
      this.deps.streamManager.broadcastMessage(taskId, {
        role: 'assistant',
        text: result.response,
        type: waitingForInput ? 'ask' : 'say',
        waitingForInput,
        turnCount: result.turnCount,
        toolsUsed: result.toolsUsed,
        usageSummary: result.usageSummary ?? null,
      });
    }

    logger.info({ taskId, durationMs, turnCount: result.turnCount, success: result.success }, 'Message processed');
  }

  /**
   * @description Save the assistant's response to the message store.
   *
   * @param taskId - Task identifier
   * @param text - Response text
   * @param type - Message type classification
   */
  private async saveAssistantResponse(
    taskId: string,
    text: string,
    type: 'say' | 'ask' = 'say',
    usageSummary?: TaskUsageSummary,
  ): Promise<void> {
    await this.deps.messageStore.save({
      taskId,
      role: 'assistant',
      type,
      text,
      contentBlocks: [],
      metadata: usageSummary ? { usageSummary } : {},
    });
    await this.deps.taskStore.incrementMessageCount(taskId);
  }

  /**
   * @description Links a ticket to a task when ticketId is provided in options.
   * Non-fatal: errors are logged but do not fail the request.
   *
   * @param taskId - Task identifier
   * @param ticketId - Optional ticket identifier from ProcessMessageOptions
   */
  private async linkTicketIfRequested(taskId: string, ticketId?: string): Promise<void> {
    if (!ticketId || !this.deps.ticketService) {
      return;
    }
    try {
      await this.deps.ticketService.linkTask(ticketId, taskId, 'primary');
      logger.info({ taskId, ticketId }, 'Linked task to ticket');
    } catch (error) {
      logger.error({ err: error, taskId, ticketId }, 'Failed to link task to ticket (non-fatal)');
    }
  }

  /**
   * @description Handle a processing error.
   *
   * @param taskId - Task identifier
   * @param error - The error that occurred
   * @param startTime - When processing started
   * @returns Error process result
   */
  private async handleError(taskId: string, error: unknown, startTime: number): Promise<ProcessResult> {
    const durationMs = Date.now() - startTime;
    const errMsg = extractErrorMessage(error);

    logger.error({ err: error, taskId, durationMs }, 'Message processing failed');

    await this.deps.taskStore.updateStatus(taskId, 'failed');
    this.deps.streamManager.broadcastTaskUpdate(taskId, { status: 'failed', success: false, error: errMsg });
    this.deps.streamManager.broadcastError(taskId, errMsg);

    return {
      success: false,
      error: errMsg,
      turnCount: 0,
      toolsUsed: [],
      completionType: 'error',
    };
  }
}

/**
 * @description Build request usage summary for direct-mode provider calls.
 *
 * @param provider - Active provider service
 * @param response - Provider response payload
 * @returns Usage summary for persistence and streaming
 */
function buildDirectUsageSummary(provider: LLMService, response: LLMResponse): TaskUsageSummary {
  const inputTokens = normalizeCount(response.usage.inputTokens);
  const outputTokens = normalizeCount(response.usage.outputTokens);
  const totalTokens = inputTokens + outputTokens;
  const cost = resolveUsageCost({
    providerCost: provider.calculateCost(response.usage),
    usage: response.usage,
    providerId: provider.getProviderName(),
    modelId: response.model,
  });
  const model = normalizeModel(response.model);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputCost: normalizeAmount(cost.inputCost),
    outputCost: normalizeAmount(cost.outputCost),
    totalCost: normalizeAmount(cost.totalCost),
    currency: cost.currency || 'USD',
    requestCount: 1,
    byModel: {
      [model]: {
        inputTokens,
        outputTokens,
        totalTokens,
        inputCost: normalizeAmount(cost.inputCost),
        outputCost: normalizeAmount(cost.outputCost),
        totalCost: normalizeAmount(cost.totalCost),
        requestCount: 1,
      },
    },
  };
}

function appendTicketContextNote(systemPrompt: string, options: ProcessMessageOptions): string {
  const context = options.ticketContext;
  if (!context) {
    // Chat mode — the human operator is talking to this bot directly.
    const botName = process.env.BOT_NAME || 'project-manager';
    const serviceName = process.env.SERVICE_DISPLAY_NAME || process.env.SERVICE_NAME || 'OSHAL';
    const swarmRegistry = process.env.SWARM_REGISTRY || 'local';
    const chatPreamble = [
      '',
      '## CONTEXT — HUMAN CHAT MODE',
      `You are **${botName}**, running inside the **${serviceName}** platform.`,
      'You are currently in **human chat mode** — you are NOT working a ticket.',
      'The human operator who oversees this swarm is speaking with you directly.',
      '',
      'In this mode:',
      '- Respond conversationally and naturally. Meet the operator where they are.',
      '- You can answer questions, give status updates, explain decisions, or just chat.',
      '- USE YOUR TOOLS. If the operator asks about a ticket, alarm, or incident, call fetch',
      '  immediately to get the real data. Do not describe what you would do — do it.',
      '  Return findings from the actual response, not generic advice.',
      '- Do NOT create tickets or dispatch work to the swarm — that is a separate workflow.',
      '  But you CAN and SHOULD use fetch to look up live data and answer with real information.',
      '',
      `Swarm registry: **${swarmRegistry}** — the operator can ask you about available bots,`,
      'their capabilities, or the current state of the queue.',
      '',
    ].join('\n');
    return systemPrompt + chatPreamble;
  }

  const serviceName = process.env.SERVICE_DISPLAY_NAME || process.env.SERVICE_NAME || 'OSHAL';
  const lead = context.createdFromIntake
    ? `An internal ${serviceName} ticket was already created from this intake request before you replied.`
    : `This conversation is linked to an internal ${serviceName} ticket.`;
  return `${systemPrompt}

Internal Ticket Context
- ${lead}
- Canonical ticket id: ${context.ticketId}
- Title: ${context.title}
- Status: ${context.status}
- Project: ${context.projectName}
- Markdown handovers or workspace files are supplementary artifacts, never substitutes for the internal ticket record.`.trim();
}

/**
 * @description Normalize model identifiers for aggregate keys.
 *
 * @param model - Raw model identifier
 * @returns Normalized model key
 */
function normalizeModel(model: string): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed.length > 0 ? trimmed : 'unknown-model';
}

/**
 * @description Normalize integer counters to non-negative values.
 *
 * @param value - Raw counter value
 * @returns Non-negative integer
 */
function normalizeCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Normalize monetary values to non-negative floats.
 *
 * @param value - Raw amount value
 * @returns Non-negative float
 */
function normalizeAmount(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Extract a meaningful error message from any error type, including AggregateError.
 *
 * @param error - Unknown error value
 * @returns Human-readable error message
 */
function extractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (error.message && error.message.trim().length > 0) {
    return error.message;
  }

  const aggregate = error as { aggregateErrors?: Error[] };
  if (Array.isArray(aggregate.aggregateErrors) && aggregate.aggregateErrors.length > 0) {
    const first = aggregate.aggregateErrors[0];
    return first.message || first.toString();
  }

  return error.toString();
}
