/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Split Cline launch prompts by interactionMode so chat stays conversational while swarm/task execution preserves the strict workspace and handover workflow
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Relaxed default Cline launch prompt so bot-scoped chat no longer assumes every task should read README/PROJECT-PLAN/developer handovers before responding
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Resolved per-agent runtime selection from saved bot profiles so bot-scoped chat launches honor persisted provider/model overrides
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ClineHarnessProvider (CLI agent wrapper for Claude Code Haiku)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Switched provider execution to Cline CLI with -y, workspace/config directory wiring, and JSON-line response parsing
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Synced runtime provider/model from saved global config and added verbose Cline subprocess diagnostics with fail-fast retry detection
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Synced OpenAI Codex OAuth credentials from app secrets into Cline secrets.json using Cline-compatible key and token schema
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Removed per-request runtime file writes; provider now reads selection only while save/auth routes perform centralized runtime sync
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added per-task startup manifest persistence and runtime env handoff for live agent startup context
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Raised DEFAULT_TIMEOUT_MS from 300000 to 600000 (10 min) for complex task execution
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Added info-level log line when Cline CLI process is spawned (taskId, binaryPath, argCount, timeoutMs)
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | IMP-2: Context file name now scope-aware — uses executionScopeId to prevent sibling child/review context bleed in shared workspaces
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Raised DEFAULT_TIMEOUT_MS from 600000 to 900000 (15 min) — K8s memory pressure RCA finished all deliverables but timed out 14s before signalling completion
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import type {
  SendRequestOptions,
  LLMResponse,
  TokenUsage,
} from './llm-service';
import type { ClineHarnessProviderConfig } from '@/shared/types';
import { LLMService } from './llm-service';
import { ClineRuntimeConfigSyncService } from './cline-runtime-config-sync-service';
import type { AgentStartupManifestService } from './agent-startup-manifest-service';
import { ClineSessionRuntimeService, type ClineSessionRuntime } from './cline-session-runtime-service';
import type { AgentCapabilityResolver, AgentSelectorResolution, ToolCapabilityScope } from './tool-capability-scope';

const logger = createChildLogger({ module: 'claude-code-provider' });
const DEFAULT_MODEL = 'gpt-5.3-codex';
const DEFAULT_TIMEOUT_MS = 900000;

interface OutputSummary {
  totalLines: number;
  eventCounts: Record<string, number>;
  hasCompletionResult: boolean;
  failedRetryMessage: string | null;
}

interface ClineHarnessProviderDeps {
  manifestService?: AgentStartupManifestService;
  resolveAgentRuntimeSelection?: (agentId: string) => Promise<{
    providerId?: string;
    modelId?: string;
  } | null>;
  resolveAgentCapabilities?: AgentCapabilityResolver;
}

/**
 * @description
 * ClineHarnessProvider — LLMService adapter for invoking Cline CLI as the agent runtime.
 * Runs `cline --json -y` in a task-specific workspace and parses JSON-line output
 * into the unified LLMResponse contract used by orchestration.
 */
export class ClineHarnessProvider extends LLMService {
  private binaryPath: string;
  private model: string;
  private configDir: string;
  private workspaceRoot: string;
  private timeoutMs: number;
  private runtimeSyncService: ClineRuntimeConfigSyncService;
  private manifestService?: AgentStartupManifestService;
  private sessionRuntimeService: ClineSessionRuntimeService;
  private resolveAgentRuntimeSelection?: ClineHarnessProviderDeps['resolveAgentRuntimeSelection'];
  private resolveAgentCapabilities?: ClineHarnessProviderDeps['resolveAgentCapabilities'];

  /** @description Accumulated token usage from Cline CLI api_req_started events across the session. */
  private sessionTokens = { inputTokens: 0, outputTokens: 0, cacheWrites: 0, cacheReads: 0, apiCalls: 0 };
  /** @description Last workspace path used for Cline execution — for reading task files after completion. */
  private lastWorkspacePath: string | null = null;
  /** @description Last per-agent session runtime directory — the real path for session artifacts. */
  private lastSessionConfigDir: string | null = null;
  /** @description Real API call count from the last Cline session. */
  private lastSessionApiCalls = 0;

  /**
   * @description Construct a ClineHarnessProvider instance.
   * @param config - ClineHarnessProviderConfig object
   */
  /** @description Bot-level provider override from registry apiType — takes priority over FORCE_LLM_PROVIDER. */
  private configuredProvider: string | undefined;

  constructor(config: ClineHarnessProviderConfig, deps: ClineHarnessProviderDeps = {}) {
    super('claude-code', config);
    this.binaryPath = this.resolveBinaryPath(config);
    this.model = this.resolveModel(config.model);
    this.configDir = this.resolveConfigDir();
    this.workspaceRoot = this.resolveWorkspaceRoot();
    this.timeoutMs = this.resolveTimeoutMs();
    this.configuredProvider = typeof config.configuredProvider === 'string' && config.configuredProvider.trim()
      ? config.configuredProvider.trim()
      : undefined;
    this.runtimeSyncService = new ClineRuntimeConfigSyncService(this.configDir);
    this.manifestService = deps.manifestService;
    this.sessionRuntimeService = new ClineSessionRuntimeService(this.runtimeSyncService, this.configDir);
    this.resolveAgentRuntimeSelection = deps.resolveAgentRuntimeSelection;
    this.resolveAgentCapabilities = deps.resolveAgentCapabilities;
    logger.info(
      {
        binaryPath: this.binaryPath,
        model: this.model,
        configDir: this.configDir,
        workspaceRoot: this.workspaceRoot,
        timeoutMs: this.timeoutMs,
        hasManifestService: Boolean(this.manifestService),
        configuredProvider: this.configuredProvider ?? '(process-level)',
      },
      'ClineHarnessProvider initialized with Cline runtime',
    );
  }

  /**
   * @description Send a request through Cline CLI and map the result to LLMResponse.
   * @param options - SendRequestOptions
   * @returns LLMResponse
   * @throws Error if Cline invocation fails or response cannot be parsed
   */
  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    this.requestCount += 1;
    const runtimeSelection = await this.resolveRuntimeSelection(options);
    const prompt = this.buildPrompt(options);
    const workspacePath = this.ensureWorkspacePath(options.taskId);
    const capabilityScope = await this.resolveCapabilityScope(options.agentId);
    const sessionRuntime = this.sessionRuntimeService.prepareSessionRuntime(
      workspacePath,
      runtimeSelection,
      options.agentId,
      capabilityScope,
    );
    this.lastSessionConfigDir = sessionRuntime.configDir;
    const manifestPath = await this.prepareStartupManifest(options, workspacePath, runtimeSelection, sessionRuntime);
    const args = this.buildArgs(prompt, workspacePath, runtimeSelection.model, sessionRuntime.configDir);
    const env = this.buildRuntimeEnv(workspacePath, manifestPath, sessionRuntime.configDir);

    logger.info(
      {
        binaryPath: this.binaryPath,
        args,
        taskId: options.taskId,
        agentId: options.agentId ?? null,
        workspacePath,
        sessionConfigDir: sessionRuntime.configDir,
        manifestPath,
        runtimeProvider: runtimeSelection.provider,
        runtimeModel: runtimeSelection.model,
        runtimeMode: runtimeSelection.mode,
        scopedCapabilityCount: capabilityScope.capabilities?.length ?? 0,
        interactionMode: options.interactionMode ?? 'chat',
      },
      'Invoking Cline CLI runtime',
    );

    const maxAttempts = 2;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.executeCline(args, options.taskId, env);
        const responseText = this.extractCompletionText(result.stdout);

        // Real token usage from Cline session artifacts — not string-length estimates.
        // Per spec: response.usage must be finalized with real session totals before returning.
        const sessionUsage = this.getSessionTokenUsage();
        this.lastSessionApiCalls = sessionUsage.apiCalls;
        const usage = sessionUsage.apiCalls > 0
          ? {
              inputTokens: sessionUsage.inputTokens,
              outputTokens: sessionUsage.outputTokens,
              totalTokens: sessionUsage.inputTokens + sessionUsage.outputTokens,
              cacheReadTokens: sessionUsage.cacheReads,
              cacheWriteTokens: sessionUsage.cacheWrites,
            }
          : this.estimateUsage(prompt, responseText); // degraded fallback — log it

        if (sessionUsage.apiCalls === 0) {
          logger.warn(
            { taskId: options.taskId, agentId: options.agentId },
            'Token telemetry degraded — no real session tokens captured, using estimated fallback',
          );
        }

        return {
          content: [{ type: 'text', text: responseText }],
          usage,
          model: runtimeSelection.model,
          stopReason: 'end_turn',
        };
      } catch (error) {
        lastError = error as Error;
        const msg = lastError.message || '';
        // Only retry on exit code 1 (no completion_result) — skip retry for timeouts and fatal failures
        const isRetryable = msg.includes('exited with code 1') && !msg.includes('timed out');
        if (isRetryable && attempt < maxAttempts) {
          logger.warn(
            { taskId: options.taskId, attempt, maxAttempts, error: msg },
            'Cline CLI exited with code 1 — retrying',
          );
          continue;
        }
        throw lastError;
      }
    }
    throw lastError!;
  }

  /**
   * @description Resolve runtime provider/model for this request, preferring per-agent overrides.
   * @param options - Current request options.
   * @returns Runtime selection for the task-scoped Cline session.
   */
  private async resolveRuntimeSelection(
    options: SendRequestOptions,
  ): Promise<ReturnType<ClineRuntimeConfigSyncService['readRuntimeSelection']>> {
    const persisted = this.runtimeSyncService.readRuntimeSelection(this.model);
    const rawRequestProvider = typeof options.providerId === 'string' ? options.providerId.trim() : '';
    const rawRequestModel = typeof options.model === 'string' ? options.model.trim() : '';
    const requestProvider = rawRequestProvider === 'auto' ? '' : rawRequestProvider;
    const requestModel = rawRequestModel === 'auto' ? '' : rawRequestModel;
    const agentId = typeof options.agentId === 'string' ? options.agentId.trim() : '';
    const agentSelection = (!requestProvider && !requestModel && agentId && this.resolveAgentRuntimeSelection)
      ? await this.resolveAgentRuntimeSelection(agentId).catch((error) => {
        logger.warn({ err: error, agentId }, 'Failed to resolve saved agent runtime selection');
        return null;
      })
      : null;
    // Ignore agent-level provider/model if set to 'auto' — means "use global config"
    const rawAgentProvider = typeof agentSelection?.providerId === 'string' ? agentSelection.providerId.trim() : '';
    const rawAgentModel = typeof agentSelection?.modelId === 'string' ? agentSelection.modelId.trim() : '';
    const agentProvider = rawAgentProvider === 'auto' ? '' : rawAgentProvider;
    const agentModel = rawAgentModel === 'auto' ? '' : rawAgentModel;

    if (!requestProvider && !requestModel && !agentProvider && !agentModel && !this.configuredProvider) {
      return persisted;
    }

    const selection = {
      // Priority: request > agent profile > bot registry apiType > persisted global config
      provider: requestProvider || agentProvider || this.configuredProvider || persisted.provider,
      model: requestModel || agentModel || persisted.model,
      mode: persisted.mode,
    };

    logger.info(
      {
        agentId: agentId || null,
        requestProvider: requestProvider || null,
        requestModel: requestModel || null,
        agentProvider: agentProvider || null,
        agentModel: agentModel || null,
        persistedProvider: persisted.provider,
        persistedModel: persisted.model,
        resolvedProvider: selection.provider,
        resolvedModel: selection.model,
      },
      'Resolved task runtime selection',
    );

    return selection;
  }

  /**
   * @description Resolves optional bot capabilities for scoped MCP session startup.
   */
  private async resolveCapabilityScope(agentId?: string): Promise<ToolCapabilityScope> {
    const normalizedAgentId = typeof agentId === 'string' && agentId.trim().length > 0
      ? agentId.trim()
      : undefined;
    if (!normalizedAgentId || !this.resolveAgentCapabilities) {
      return { agentId: normalizedAgentId };
    }

    const resolved = await Promise.resolve(this.resolveAgentCapabilities(normalizedAgentId)).catch((error) => {
      logger.warn({ err: error, agentId: normalizedAgentId }, 'Failed to resolve agent capabilities for scoped Cline runtime');
      return null;
    });
    const resolution = normalizeAgentSelectorResolution(resolved);

    return {
      agentId: normalizedAgentId,
      capabilities: resolution?.capabilities ?? null,
      routingKeywords: resolution?.routingKeywords ?? null,
      selectorDescriptor: resolution?.selectorDescriptor ?? null,
    };
  }

  /**
   * @description Override cost calculation for Claude Code CLI (returns zero).
   * @param usage - TokenUsage
   * @returns CostResult
   */
  calculateCost(usage: TokenUsage) {
    logger.debug({ usage }, 'Claude Code cost calculation (always $0)');
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
  }

  /**
   * @description Resolve CLI binary path with environment override support.
   * @param config - Provider config object
   * @returns CLI binary path to execute
   */
  private resolveBinaryPath(config: ClineHarnessProviderConfig): string {
    const configPath = typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0
      ? config.baseUrl.trim()
      : undefined;
    return configPath || process.env.CLINE_CLI_PATH || 'cline';
  }

  /**
   * @description Resolve model identifier, preferring explicit runtime config.
   * @param model - Optional model id from provider config
   * @returns Normalized model identifier
   */
  private resolveModel(model: string): string {
    const trimmed = typeof model === 'string' ? model.trim() : '';
    return trimmed.length > 0 ? trimmed : DEFAULT_MODEL;
  }

  /**
   * @description Resolve Cline configuration directory from environment or default user path.
   * @returns Absolute path to Cline configuration root
   */
  private resolveConfigDir(): string {
    const configuredPath = process.env.CLINE_CONFIG_DIR;
    if (configuredPath && configuredPath.trim().length > 0) {
      return path.resolve(configuredPath);
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      return path.resolve(homeDir, '.cline');
    }

    return path.resolve(process.cwd(), '.cline');
  }

  /**
   * @description Resolve the workspace root used for per-task Cline execution.
   * @returns Absolute workspace root path
   */
  private resolveWorkspaceRoot(): string {
    const configuredRoot = process.env.CLINE_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
    if (configuredRoot && configuredRoot.trim().length > 0) {
      return path.resolve(configuredRoot);
    }
    return path.resolve(process.cwd(), 'workspace');
  }

  /**
   * @description Resolve runtime timeout for Cline command execution.
   * @returns Timeout in milliseconds
   */
  private resolveTimeoutMs(): number {
    const rawTimeout = process.env.CLINE_COMMAND_TIMEOUT_MS;
    if (!rawTimeout) {
      return DEFAULT_TIMEOUT_MS;
    }

    const parsedTimeout = parseInt(rawTimeout, 10);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
      logger.warn({ rawTimeout }, 'Invalid CLINE_COMMAND_TIMEOUT_MS, using default');
      return DEFAULT_TIMEOUT_MS;
    }

    return parsedTimeout;
  }

  /**
   * @description Build Cline prompt from current request payload.
   * @param options - LLM request options
   * @returns Prompt string for Cline CLI invocation
   */
  /**
   * @description Builds the prompt for Cline CLI execution.
   * Matches the legacy ClineProvider._messagesToTask() pattern:
   *   1. Write persona + task to a context file in the workspace
   *   2. Return a tiny prompt: "Read your context file, then do the work"
   *   3. Cline starts in --cwd workspace, reads the file, sees ALL existing code, builds on it
   *
   * This is THE critical difference from chat-mode prompting. The agent starts by
   * reading the workspace — it sees what other agents built and adds to it.
   */
  private buildPrompt(options: SendRequestOptions): string {
    const agentId = options.agentId || 'agent';
    const scopeId = options.executionScopeId || '';
    const contextFileName = scopeId
      ? `${scopeId}--${agentId}-context.md`
      : `${agentId}-context.md`;

    // Write context file to workspace (legacy PHASE_63 pattern)
    // The llm-execution-handler already writes persona context, but we also need
    // the task message in the same file so Cline reads everything from disk.
    try {
      const workspacePath = this.ensureWorkspacePath(options.taskId);
      const fs = require('fs');
      const path = require('path');

      if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }

      const contextParts: string[] = [];

      // Persona
      if (options.systemPrompt && options.systemPrompt.trim().length > 0) {
        contextParts.push(options.systemPrompt.trim());
      }

      // Conversation history for context continuity
      const allMessages = options.messages || [];
      const userMessages = allMessages.filter((m: { role: string }) => m.role === 'user');
      const taskMessage = userMessages.length > 0
        ? (typeof userMessages[userMessages.length - 1].content === 'string'
          ? userMessages[userMessages.length - 1].content
          : JSON.stringify(userMessages[userMessages.length - 1].content))
        : '';

      // Include prior conversation turns so the bot has memory across one-and-done calls
      const priorTurns = allMessages.slice(0, -1);
      if (priorTurns.length > 0) {
        const historyLines = priorTurns.map((m: { role: string; content: unknown }) => {
          const label = m.role === 'assistant' ? 'Assistant' : 'User';
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `[${label}]\n${text}`;
        });
        contextParts.push(`## Prior conversation context\n${historyLines.join('\n\n')}`);
      }

      if (taskMessage) {
        contextParts.push(`## Current Task\n\n${taskMessage}`);
      }

      const contextFilePath = path.join(workspacePath, contextFileName);
      fs.writeFileSync(contextFilePath, contextParts.join('\n\n'), 'utf-8');

      logger.info(
        { agentId, contextFile: contextFilePath, contentLength: contextParts.join('').length },
        'Wrote agent context file to workspace (legacy pattern)',
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message, agentId }, 'Failed to write context file — falling back to inline prompt');
      // Fallback: return inline prompt if file write fails
      const parts: string[] = [];
      if (options.systemPrompt) parts.push(options.systemPrompt.trim());
      const userMsgs = options.messages.filter((m: { role: string }) => m.role === 'user');
      if (userMsgs.length > 0) {
        const content = typeof userMsgs[userMsgs.length - 1].content === 'string'
          ? userMsgs[userMsgs.length - 1].content
          : JSON.stringify(userMsgs[userMsgs.length - 1].content);
        parts.push(`## Current Task\n\n${content}`);
      }
      return parts.join('\n\n');
    }

    if (options.interactionMode === 'task') {
      return this.buildTaskExecutionPrompt(contextFileName);
    }

    return this.buildConversationPrompt(contextFileName);
  }

  /**
   * @description Builds the conversational startup prompt for bot-scoped chat.
   * @param contextFileName - Name of the workspace context file to read first.
   * @returns Prompt string for conversational launches.
   */
  private buildConversationPrompt(contextFileName: string): string {
    return `IMPORTANT: Before doing anything, read the file "${contextFileName}" in this workspace for your identity and conversational context. Default to having a conversation with the user. Do not proactively inspect the repository, read project docs, modify files, or start task execution unless the user explicitly asks you to investigate or work on something. If the user asks about the project, inspect only the files needed to answer that request. Use attempt_completion when done.`;
  }

  /**
   * @description Builds the stricter workspace-oriented startup prompt for swarm/task execution.
   * @param contextFileName - Name of the workspace context file to read first.
   * @returns Prompt string for execution launches.
   */
  private buildTaskExecutionPrompt(contextFileName: string): string {
    return `IMPORTANT: Before doing anything, read the file "${contextFileName}" in this workspace for your identity, role, and task assignment. Then inspect the workspace like an active execution run: read README.md, PROJECT-PLAN.md, and developer-handovers/ when they exist and are relevant, understand the current state before changing anything, continue prior work instead of starting from scratch, and complete the assigned task. Use attempt_completion when done.`;
  }

  /**
   * @description Convert a single conversation message into text prompt format.
   * @param role - Message role
   * @param content - Message content
   * @returns Prompt-friendly message line
   */
  private formatPromptMessage(role: string, content: unknown): string {
    const value = typeof content === 'string' ? content : JSON.stringify(content);
    return `${role.toUpperCase()}: ${value}`;
  }

  /**
   * @description Ensure per-task workspace directory exists and return its path.
   * @param taskId - Task identifier from orchestration context
   * @returns Absolute workspace path for current invocation
   */
  private ensureWorkspacePath(taskId?: string): string {
    const workspaceId = this.normalizeWorkspaceId(taskId);
    const workspacePath = path.join(this.workspaceRoot, workspaceId);
    logger.info({ path: workspacePath, operation: 'mkdir' }, 'Ensuring Cline workspace directory');
    fs.mkdirSync(workspacePath, { recursive: true });
    this.lastWorkspacePath = workspacePath;
    return workspacePath;
  }

  /**
   * @description Normalize task identifier for safe filesystem path usage.
   * @param taskId - Optional task identifier
   * @returns Sanitized workspace folder identifier
   */
  private normalizeWorkspaceId(taskId?: string): string {
    const raw = taskId && taskId.trim().length > 0 ? taskId.trim() : `task-${Date.now()}`;
    // Strip ::agentId suffix — all bots write to the shared ticket workspace, not per-agent dirs.
    // taskId format is "{ticketId}::{agentId}" — we only want the ticketId part for the workspace.
    const stripped = raw.includes('::') ? raw.split('::')[0] : raw;
    return stripped.replaceAll(/[^a-zA-Z0-9-_]/g, '_');
  }

  /**
   * @description Build CLI args for JSON-mode, yolo-mode Cline execution.
   * @param prompt - Prompt to execute
   * @param workspacePath - Workspace directory for this task
   * @param model - Runtime-selected model id
   * @param configDir - Session-specific Cline config directory
   * @returns CLI argument list
   */
  private buildArgs(prompt: string, workspacePath: string, model: string, configDir: string): string[] {
    const args = ['--json', '-y', '--cwd', workspacePath, '--config', configDir];
    if (model.length > 0) {
      args.push('--model', model);
    }
    args.push(prompt);
    return args;
  }

  /**
   * @description Persist the startup manifest for the current request when manifest support is available.
   * @param options - Current provider request options.
   * @param workspacePath - Task workspace path.
   * @param runtimeSelection - Active runtime selection.
   * @returns Absolute manifest path or null when manifest support is unavailable.
   */
  private async prepareStartupManifest(
    options: SendRequestOptions,
    workspacePath: string,
    runtimeSelection: ReturnType<ClineRuntimeConfigSyncService['readRuntimeSelection']>,
    sessionRuntime: ClineSessionRuntime,
  ): Promise<string | null> {
    if (!this.manifestService) {
      return null;
    }

    return this.manifestService.prepareManifest({
      taskId: options.taskId,
      agentId: options.agentId,
      workspacePath,
      binaryPath: this.binaryPath,
      configDir: sessionRuntime.configDir,
      runtimeSelection,
      systemPrompt: options.systemPrompt,
      callableTools: options.tools,
      mcpSettingsOverride: sessionRuntime.mcpSettings,
      mcpSettingsPathOverride: sessionRuntime.mcpSettingsPath,
    });
  }

  /**
   * @description Build environment variables for the Cline child process.
   * @param workspacePath - Task workspace path.
   * @param manifestPath - Optional startup manifest path.
   * @returns Environment map for the child process.
   */
  private buildRuntimeEnv(
    workspacePath: string,
    manifestPath: string | null,
    sessionConfigDir: string,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLINE_WORKSPACE_ROOT: this.workspaceRoot,
      CLINE_CONFIG_DIR: sessionConfigDir,
      OSHAL_TASK_WORKSPACE: workspacePath,
    };
    if (manifestPath) {
      env.OSHAL_SESSION_MANIFEST_PATH = manifestPath;
    }
    return env;
  }

  /**
   * @description Execute Cline CLI process and collect stdout/stderr.
   * @param args - CLI argument list
   * @param taskId - Current task id for logs
   * @returns Process output and exit code
   */
  private executeCline(
    args: string[],
    taskId?: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      logger.info({ taskId, binaryPath: this.binaryPath, argCount: args.length, timeoutMs: this.timeoutMs }, 'Spawning Cline CLI process');
      const child = spawn(this.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      let stdout = ''; let stderr = ''; let timedOut = false; let fatalFailure: string | null = null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        logger.error({ taskId, timeoutMs: this.timeoutMs }, 'Cline CLI execution timed out');
      }, this.timeoutMs);
      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        const retryFailure = this.processChunk('stdout', chunk, taskId);
        if (retryFailure && !fatalFailure) {
          fatalFailure = retryFailure;
          logger.error({ taskId, retryFailure }, 'Cline CLI emitted terminal retry failure');
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        this.processChunk('stderr', chunk, taskId);
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        logger.error({ err: error, taskId }, 'Failed to start Cline CLI process');
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        const normalizedCode = code ?? 1;
        const error = this.buildProcessCloseError(normalizedCode, stderr, taskId, timedOut, fatalFailure, stdout.length, stderr.length, stdout);
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: normalizedCode });
      });
    });
  }

  /**
   * @description Process a Cline subprocess chunk for diagnostics and retry-failure detection.
   * @param stream - Output stream source
   * @param chunk - Raw stream chunk
   * @param taskId - Optional task identifier for logging context
   * @returns Retry-failure message when a fatal retry marker is detected
   */
  private processChunk(stream: 'stdout' | 'stderr', chunk: string, taskId?: string): string | null {
    logger.debug(
      {
        taskId,
        stream,
        bytes: chunk.length,
        preview: this.compactForLog(chunk),
      },
      'Cline CLI stream chunk received',
    );
    if (stream === 'stderr') {
      return null;
    }

    // Accumulate token usage from Cline api_req_started events
    if (chunk.includes('api_req_started')) {
      // Log the first 200 chars after api_req_started to see token data format
      const idx = chunk.indexOf('api_req_started');
      const textStart = chunk.indexOf('"text"', idx);
      const sample = textStart > 0 ? chunk.substring(textStart, textStart + 200) : chunk.substring(idx, idx + 200);
      logger.info({ chunkLen: chunk.length, hasTokensIn: chunk.includes('tokensIn'), sample }, 'RAW api_req_started chunk');
    }
    this.accumulateTokenUsage(chunk);

    return this.detectFatalRetryFailure(chunk);
  }

  /**
   * @description Parses Cline JSON events for api_req_started and accumulates token counts.
   * Cline emits {tokensIn, tokensOut, cacheWrites, cacheReads} per API call.
   */
  private accumulateTokenUsage(chunk: string): void {
    try {
      // Fast path: search for tokensIn/tokensOut in the raw chunk.
      // Cline JSON has these inside nested escaped strings — could be:
      //   "tokensIn":6220  OR  \"tokensIn\":6220  OR  \\\"tokensIn\\\":6220
      // Use a loose pattern that matches any escaping variant.
      const tokenPattern = /tokensIn[\\"]?\s*:\s*(\d+)[^}]*?tokensOut[\\"]?\s*:\s*(\d+)/g;
      let match;
      while ((match = tokenPattern.exec(chunk)) !== null) {
        const tokensIn = parseInt(match[1], 10);
        const tokensOut = parseInt(match[2], 10);
        if (tokensIn > 0 || tokensOut > 0) {
          this.sessionTokens.inputTokens += tokensIn;
          this.sessionTokens.outputTokens += tokensOut;
          this.sessionTokens.apiCalls++;
          if (this.sessionTokens.apiCalls <= 3 || this.sessionTokens.apiCalls % 5 === 0) {
            logger.info({ apiCall: this.sessionTokens.apiCalls, totalIn: this.sessionTokens.inputTokens, totalOut: this.sessionTokens.outputTokens }, 'Accumulated Cline session tokens');
          }
        }
      }
      // Also try to get cacheWrites/cacheReads
      const cachePattern = /cacheWrites[\\"]?\s*:\s*(\d+)[^}]*?cacheReads[\\"]?\s*:\s*(\d+)/g;
      let cacheMatch;
      while ((cacheMatch = cachePattern.exec(chunk)) !== null) {
        this.sessionTokens.cacheWrites += parseInt(cacheMatch[1], 10);
        this.sessionTokens.cacheReads += parseInt(cacheMatch[2], 10);
      }
    } catch { /* chunk parse failed */ }
  }

  /**
   * @description Returns accumulated session token usage and resets the counters.
   * Called after a Cline CLI process completes to capture real token costs.
   */
  /** @description Returns the real API call count from the last session. */
  getLastSessionApiCalls(): number { return this.lastSessionApiCalls; }

  getSessionTokenUsage(): { inputTokens: number; outputTokens: number; cacheWrites: number; cacheReads: number; apiCalls: number } {
    // If stream-based accumulation didn't capture tokens, read from saved Cline task files.
    // Cline saves token data to ui_messages.json AFTER API calls complete, but doesn't re-emit on stdout.
    if (this.sessionTokens.apiCalls === 0 && (this.lastSessionConfigDir || this.lastWorkspacePath)) {
      try {
        // Phase 3: Use the real per-agent session runtime path, not the old shared path.
        const tasksDir = this.lastSessionConfigDir
          ? path.join(this.lastSessionConfigDir, 'data', 'tasks')
          : path.join(this.lastWorkspacePath!, '.oshal', 'cline-runtime', 'data', 'tasks');
        if (fs.existsSync(tasksDir)) {
          const taskDirs = fs.readdirSync(tasksDir).sort().reverse(); // newest first
          for (const taskDir of taskDirs.slice(0, 1)) {
            const msgFile = path.join(tasksDir, taskDir, 'ui_messages.json');
            if (!fs.existsSync(msgFile)) continue;
            const msgs = JSON.parse(fs.readFileSync(msgFile, 'utf8'));
            for (const msg of msgs) {
              if (msg?.say !== 'api_req_started' || !msg?.text) continue;
              try {
                const data = JSON.parse(msg.text);
                if (typeof data.tokensIn === 'number' && data.tokensIn > 0) {
                  this.sessionTokens.inputTokens += data.tokensIn;
                  this.sessionTokens.outputTokens += (data.tokensOut || 0);
                  this.sessionTokens.cacheWrites += (data.cacheWrites || 0);
                  this.sessionTokens.cacheReads += (data.cacheReads || 0);
                  this.sessionTokens.apiCalls++;
                }
              } catch { /* parse failed */ }
            }
            logger.info({ ...this.sessionTokens, source: 'ui_messages.json' }, 'Read session tokens from Cline task file');
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Failed to read Cline task file for token data');
      }
    }

    const usage = { ...this.sessionTokens };
    logger.info({ ...usage }, 'Returning session token usage (will reset counters)');
    this.sessionTokens = { inputTokens: 0, outputTokens: 0, cacheWrites: 0, cacheReads: 0, apiCalls: 0 };
    return usage;
  }

  /**
   * @description Build the final process-close error when Cline exits with timeout/failure conditions.
   * @param code - Process exit code
   * @param stderr - Full stderr output
   * @param taskId - Optional task identifier
   * @param timedOut - Whether timeout handling killed the process
   * @param fatalFailure - Retry-failure message detected from stdout
   * @param stdoutBytes - Total stdout bytes captured
   * @param stderrBytes - Total stderr bytes captured
   * @returns Error to reject with, or null when process is successful
   */
  private buildProcessCloseError(
    code: number,
    stderr: string,
    taskId: string | undefined,
    timedOut: boolean,
    fatalFailure: string | null,
    stdoutBytes: number,
    stderrBytes: number,
    stdout?: string,
  ): Error | null {
    logger.info(
      {
        code,
        taskId,
        timedOut,
        fatalFailure: fatalFailure ?? undefined,
        stdoutBytes,
        stderrBytes,
      },
      'Cline CLI process completed',
    );
    if (timedOut) {
      return new Error(`Cline CLI timed out after ${this.timeoutMs}ms`);
    }
    if (fatalFailure) {
      return new Error(`Cline runtime failed before completion: ${fatalFailure}`);
    }
    if (code !== 0) {
      // Cline often exits with code 1 after a successful completion_result when it
      // emits a resume_task ask and gets no response (normal in --json -y mode).
      // Check stdout for completion_result before treating as failure.
      if (stdout && this.hasCompletionResult(stdout)) {
        logger.info({ code, taskId }, 'Cline exited non-zero but stdout contains completion_result — treating as success');
        return null;
      }
      logger.error({ code, stderr, taskId }, 'Cline CLI exited with non-zero code');
      return new Error(`Cline CLI exited with code ${code}: ${stderr}`);
    }
    return null;
  }

  /**
   * @description Parse Cline JSON-line output and extract final completion text.
   * @param stdout - Raw process stdout
   * @returns Final completion text
   */
  private extractCompletionText(stdout: string): string {
    const summary = this.summarizeOutput(stdout);
    logger.info({ summary }, 'Parsed Cline stdout summary');

    const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    let completionText = '';

    for (const line of lines) {
      const event = this.parseOutputEvent(line);
      if (event && event.type === 'say' && event.say === 'completion_result' && typeof event.text === 'string') {
        completionText = event.text;
      }
    }

    if (completionText.length === 0) {
      const retryFailure = summary.failedRetryMessage;
      logger.error(
        { retryFailure, stdoutPreview: this.compactForLog(stdout, 2000) },
        'Cline output missing completion_result',
      );
      if (retryFailure) {
        throw new Error(`Cline runtime failed before completion_result: ${retryFailure}`);
      }
      throw new Error('Cline output did not include a completion_result event');
    }

    return completionText;
  }

  /**
   * @description Normalize unknown values into non-empty strings.
   * @param value - Candidate value
   * @returns Trimmed string when valid, otherwise null
   */
  private readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  /**
   * @description Compact long output for structured logs without dumping full payloads.
   * @param value - Raw output chunk
   * @param maxLength - Max characters to keep
   * @returns Sanitized preview string
   */
  /**
   * @description Check if stdout contains a completion_result event, indicating the task completed
   * successfully even if the process exited with a non-zero code (e.g. resume_task ask timeout).
   */
  private hasCompletionResult(stdout: string): boolean {
    const lines = stdout.split('\n');
    for (const line of lines) {
      const event = this.parseOutputEvent(line.trim());
      if (event && event.type === 'say' && event.say === 'completion_result') {
        return true;
      }
    }
    return false;
  }

  private compactForLog(value: string, maxLength = 500): string {
    const compact = value.replaceAll(/\s+/g, ' ').trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
  }

  /**
   * @description Detect terminal retry failures emitted by Cline in streamed JSON output.
   * @param outputChunk - Raw stdout chunk to inspect
   * @returns Failure message when retries are exhausted; otherwise null
   */
  private detectFatalRetryFailure(outputChunk: string): string | null {
    const lines = outputChunk.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    for (const line of lines) {
      const event = this.parseOutputEvent(line);
      const failure = this.extractRetryFailureMessage(event);
      if (failure) {
        return failure;
      }
    }
    return null;
  }

  /**
   * @description Extract terminal retry error details from a parsed Cline event.
   * @param event - Parsed Cline output event
   * @returns Human-readable failure message when event indicates retry exhaustion
   */
  private extractRetryFailureMessage(event: Record<string, unknown> | null): string | null {
    if (!event || event.type !== 'say' || event.say !== 'error_retry' || typeof event.text !== 'string') {
      return null;
    }
    const parsed = this.parseOutputEvent(event.text);
    if (!parsed || parsed.failed !== true) {
      return null;
    }
    const nested = typeof parsed.errorMessage === 'string' ? this.parseOutputEvent(parsed.errorMessage) : null;
    if (nested && typeof nested.message === 'string' && nested.message.trim().length > 0) {
      return nested.message.trim();
    }
    if (typeof parsed.errorMessage === 'string' && parsed.errorMessage.trim().length > 0) {
      return parsed.errorMessage.trim();
    }
    return 'Cline exhausted retry attempts';
  }

  /**
   * @description Summarize parsed Cline output events for post-run diagnostics.
   * @param stdout - Raw stdout from the Cline subprocess
   * @returns Event summary including counts and retry-failure signals
   */
  private summarizeOutput(stdout: string): OutputSummary {
    const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    const eventCounts: Record<string, number> = {};
    let hasCompletionResult = false;
    let failedRetryMessage: string | null = null;

    for (const line of lines) {
      const event = this.parseOutputEvent(line);
      if (!event) {
        continue;
      }
      const eventType = this.readNonEmptyString(event.type) || 'unknown';
      eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;
      if (eventType === 'say' && event.say === 'completion_result') {
        hasCompletionResult = true;
      }
      failedRetryMessage = failedRetryMessage || this.extractRetryFailureMessage(event);
    }

    return {
      totalLines: lines.length,
      eventCounts,
      hasCompletionResult,
      failedRetryMessage,
    };
  }

  /**
   * @description Parse a single Cline JSON output line.
   * @param line - Raw stdout line
   * @returns Parsed event object or null when line is not JSON
   */
  private parseOutputEvent(line: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch (_error) {
      logger.debug({ linePreview: this.compactForLog(line, 120) }, 'Skipping non-JSON Cline output line');
      return null;
    }
  }

  /**
   * @description Estimate token usage for unified response payload.
   * @param prompt - Prompt text sent to Cline
   * @param responseText - Completion text from Cline
   * @returns Estimated token usage
   */
  private estimateUsage(prompt: string, responseText: string): TokenUsage {
    const estimate = (value: string) => Math.max(1, Math.ceil(value.length / 4));
    return {
      inputTokens: estimate(prompt),
      outputTokens: estimate(responseText),
    };
  }
}

function normalizeAgentSelectorResolution(value: unknown): AgentSelectorResolution | null {
  if (Array.isArray(value)) {
    const capabilities = readStringArray(value);
    return capabilities.length > 0 ? { capabilities } : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const capabilities = readStringArray(record.capabilities);
  const routingKeywords = readStringArray(record.routingKeywords);
  const selectorDescriptor = readNonEmptyString(record.selectorDescriptor);
  if (capabilities.length === 0 && routingKeywords.length === 0 && !selectorDescriptor) {
    return null;
  }
  return {
    capabilities: capabilities.length > 0 ? capabilities : null,
    routingKeywords: routingKeywords.length > 0 ? routingKeywords : null,
    selectorDescriptor: selectorDescriptor ?? null,
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
