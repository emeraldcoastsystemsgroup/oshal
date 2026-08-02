/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of server-side tool executor for chat orchestration
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Per-user task storage (ADR-060): ensureWorkspacePath now places NEW task workspaces under the owning user's namespace (<root>/users/<owner>/<taskId>, or <root>/_shared for ownerless system tasks), resolving the owner via the task's ticket. Pre-existing legacy flat dirs are detected and kept so existing work is not orphaned. Bot files (and brokered .oshal-cred-* drops) are now written into the owner's directory.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added follow-up question interrupt semantics for true orchestration pause/resume
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added internal RagService fallback so rag-ingestion works with compose ChromaDB when no external ingestion endpoint is configured
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added Presentron endpoint resolution from tool input and persisted runtime settings
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added RAG ingestion endpoint/default-collection resolution from persisted runtime settings
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added direct Chroma-backed rag-query tool for agent retrieval without MCP dependency
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Replaced localhost Presentron fallback with deployable service default
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added optional workspaceService for ticket→workspace resolution before per-task fallback
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Re-pointed the presentron tool at the in-repo deck engine (BACKLOG "Re-point the presentron chat tool at the real deck renderer"): handlePresentron now renders a real themed .pptx via @/features/presentation-generation renderPptx into the task workspace instead of POSTing to the retired Presentron sidecar; dropped the PresentronIntegrationService/readPresentronRuntimeSettings/endpoint-resolution plumbing from this executor.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Change-log accuracy: entry 2 above claims the ADR-060 per-user namespace is in force here, but that layout was REVERTED (see the note in ensureWorkspacePath) — this file writes the flat <root>/<taskId> and the orphaned userScopedWorkspacePath helper it was to call has been deleted. Entry 2 stands as history; this entry is the correction. No behavior change.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: model-supplied `headers` in a route-backed api tool's input could OVERRIDE the framework's own trust headers. They were spread LAST over X-Service-Secret and X-OSHAL-User-Sub, and toolInput is the raw tool_use block from the LLM (agentic-loop passes block.input straight through, unvalidated against inputSchema) — so a prompt injection could pick which user the service-secret call acted for. buildDynamicApiHeaders now spreads the model's record FIRST and strips every trust header from it case-insensitively; identity and the service secret are never the model's to set. Guarded by tests/unit/tool-executor-api-route.spec.ts.
 */

import fs from 'fs';
import path from 'path';
import { exec as execCallback, execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { createChildLogger } from '@/shared/logger';
import { readRagRuntimeSettings } from '@/shared/services';
import { RagService, type RagPermissionContext } from '@/features/rag';
import { StreamManager } from '@/features/streaming';
import { renderPptx, isThemeId, isLayoutId, type RenderableSlide } from '@/features/presentation-generation';
import {
  RAGIngestionIntegrationService,
  GoogleWorkspaceCliIntegration,
  PersonalFinanceIntegrationService,
  WorkflowStudioIntegrationService,
} from '@/features/tool-integrations';
import type { WorkspaceService } from '@/features/ticketing';
import type { AgentConfigService } from '@/features/agent-management';
import type { DynamicToolExecutorRegistry, ToolExecutorDescriptor } from '@/features/tool-registry';
import { serviceSecretHeaders } from '@/shared/middleware/authz';
import { FollowupQuestionSignal } from './followup-question-signal';
import { guardTemplateValue } from './runtime-template-guard';

const execAsync = promisify(execCallback);
const execFileAsync = promisify(execFileCallback);
const logger = createChildLogger({ module: 'tool-executor-service' });

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Headers that carry TRUST and are therefore owned exclusively by the framework, never by tool
 * input. Lowercased because HTTP header names are case-insensitive: a model writing
 * `x-oshal-user-sub` must not be able to sit beside the framework's `X-OSHAL-User-Sub` and win on
 * insertion order. Keep this list in sync with `serviceSecretHeaders()` + `getTrustedServiceUserSub()`.
 */
const TRUST_HEADER_NAMES = new Set(['x-service-secret', 'x-oshal-user-sub']);
const DEFAULT_OUTPUT_LIMIT = 12_000;
const DEFAULT_READ_LIMIT_BYTES = 256 * 1024;
const DEFAULT_BOT_RUNTIME_ROOT = path.resolve(process.cwd(), 'output', 'bot-runtime');

/**
 * @description Constructor dependencies for the tool executor service, supplying the
 * stream broadcaster plus optional services for workspace, agent config, and dynamic tools.
 */
export interface ToolExecutorServiceDeps {
  streamManager: StreamManager;
  /** Optional workspace service for ticket→workspace resolution */
  workspaceService?: WorkspaceService;
  /** Optional agent config service for bot-specific credentials/runtime settings */
  agentConfigService?: AgentConfigService;
  /** Optional runtime executor registry for dynamically registered tools */
  dynamicToolExecutorRegistry?: DynamicToolExecutorRegistry;
  /** Optional in-process connector executor for ADR-065 spec tools. */
  connectorToolExecutor?: {
    executeTool(
      descriptor: ToolExecutorDescriptor,
      inputs: Record<string, unknown>,
      userSub?: string,
    ): Promise<string>;
  };
}

/**
 * @description Executes supported server-side tools for the non-Cline orchestration loop.
 * File and shell tools are scoped to the task workspace to prevent cross-task access.
 */
export class ToolExecutorService {
  private readonly streamManager: StreamManager;
  private readonly workspaceRoot: string;
  private readonly workspaceService?: WorkspaceService;
  private readonly agentConfigService?: AgentConfigService;
  private readonly dynamicToolExecutorRegistry?: DynamicToolExecutorRegistry;
  private readonly connectorToolExecutor?: ToolExecutorServiceDeps['connectorToolExecutor'];

  /**
   * @description Wire up injected dependencies and resolve the workspace root so all
   * file and shell tool execution stays scoped to a known directory.
   *
   * @param deps - Stream manager plus optional workspace, agent config, and dynamic tool services
   */
  constructor(deps: ToolExecutorServiceDeps) {
    this.streamManager = deps.streamManager;
    this.workspaceService = deps.workspaceService;
    this.agentConfigService = deps.agentConfigService;
    this.dynamicToolExecutorRegistry = deps.dynamicToolExecutorRegistry;
    this.connectorToolExecutor = deps.connectorToolExecutor;
    this.workspaceRoot = this.resolveWorkspaceRoot();
    logger.info({ workspaceRoot: this.workspaceRoot }, 'ToolExecutorService initialized');
  }

  /**
   * @description Execute a named tool in the context of a task workspace.
   * Broadcasts SSE tool status events before and after execution.
   *
   * @param taskId - Current task identifier
   * @param toolName - Tool name requested by the agent
   * @param toolInput - Tool input payload
   * @returns Stringified tool result for the agentic loop
   */
  async executeTool(
    taskId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    agentId?: string,
    userSub?: string,
  ): Promise<string> {
    const startedAt = Date.now();
    this.streamManager.broadcastToolExecution(taskId, { name: toolName, input: toolInput }, 'started');

    try {
      const result = await this.dispatchTool(taskId, toolName, toolInput, agentId, userSub);
      this.streamManager.broadcastToolExecution(
        taskId,
        { name: toolName, durationMs: Date.now() - startedAt },
        'completed',
      );
      return result;
    } catch (error) {
      if (error instanceof FollowupQuestionSignal) {
        this.streamManager.broadcastToolExecution(
          taskId,
          { name: toolName, durationMs: Date.now() - startedAt, question: error.question },
          'waiting_for_input',
        );
        throw error;
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      this.streamManager.broadcastToolExecution(
        taskId,
        { name: toolName, durationMs: Date.now() - startedAt, error: errMsg },
        'failed',
      );
      throw error;
    }
  }

  /**
   * @description Route an execution request to the concrete tool handler.
   *
   * @param taskId - Current task identifier
   * @param toolName - Tool name requested by the agent
   * @param toolInput - Tool input payload
   * @returns Tool result string
   */
  private async dispatchTool(
    taskId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    agentId?: string,
    userSub?: string,
  ): Promise<string> {
    const descriptor = this.dynamicToolExecutorRegistry?.resolve(toolName);
    if (descriptor && descriptor.executorType !== 'builtin') {
      return this.handleDynamicExecutor(taskId, descriptor, toolInput, agentId, userSub);
    }

    const dispatchName = descriptor?.builtinKey ?? toolName;
    switch (dispatchName) {
      case 'list_directory':
        return this.handleListDirectory(taskId, toolInput);
      case 'read_file':
        return this.handleReadFile(taskId, toolInput);
      case 'search_files':
        return this.handleSearchFiles(taskId, toolInput);
      case 'write_to_file':
        return this.handleWriteToFile(taskId, toolInput);
      case 'replace_in_file':
        return this.handleReplaceInFile(taskId, toolInput);
      case 'execute_command':
        return this.handleExecuteCommand(taskId, toolInput);
      case 'ask_followup_question':
        return this.handleAskFollowupQuestion(toolInput);
      case 'presentron':
        return this.handlePresentron(taskId, toolInput);
      case 'rag-ingestion':
        return this.handleRagIngestion(toolInput);
      case 'rag-query':
        return this.handleRagQuery(toolInput, userSub);
      case 'gogcli':
      case 'google-workspace':
        return this.handleGogCli(taskId, toolInput, agentId);
      case 'finance-import':
        return this.handleFinanceImport(taskId, toolInput, agentId);
      case 'finance-report':
        return this.handleFinanceReport(taskId, toolInput, agentId);
      case 'analyze-spending':
        return this.handleAnalyzeSpending(toolInput, agentId);
      case 'check-budget':
        return this.handleCheckBudget(toolInput, agentId);
      case 'workflow-studio':
        return this.handleWorkflowStudio(toolInput);
      case 'browser_action':
      case 'use_mcp_tool':
      case 'list_mcp_resources':
      case 'read_mcp_resource':
        throw new Error(`Tool "${toolName}" is only available through the Cline runtime today.`);
      default:
        throw new Error(`Tool "${toolName}" is not supported by the server-side executor.`);
    }
  }

  /**
   * @description Execute a descriptor contributed at runtime or by a swarm-app manifest.
   */
  private async handleDynamicExecutor(
    taskId: string,
    descriptor: ToolExecutorDescriptor,
    toolInput: Record<string, unknown>,
    agentId?: string,
    userSub?: string,
  ): Promise<string> {
    switch (descriptor.executorType) {
      case 'cli':
        return this.handleDynamicCliExecutor(taskId, descriptor, toolInput, agentId, userSub);
      case 'api':
        return this.handleDynamicApiExecutor(taskId, descriptor, toolInput, agentId, userSub);
      case 'connector':
        return this.handleDynamicConnectorExecutor(descriptor, toolInput, userSub);
      case 'mcp':
        throw new Error(`Tool "${descriptor.toolName}" is registered as MCP server "${descriptor.mcpServerName}", which is only available through the Cline runtime today.`);
      case 'builtin':
        throw new Error(`Builtin runtime descriptor "${descriptor.toolName}" should be dispatched through the builtin switch.`);
      default:
        throw new Error(`Unsupported executor type for tool "${descriptor.toolName}".`);
    }
  }

  private async handleDynamicConnectorExecutor(
    descriptor: ToolExecutorDescriptor,
    toolInput: Record<string, unknown>,
    userSub?: string,
  ): Promise<string> {
    if (!this.connectorToolExecutor) {
      throw new Error(`Connector tool "${descriptor.toolName}" is registered but no connector executor is configured.`);
    }
    return this.connectorToolExecutor.executeTool(descriptor, toolInput, userSub);
  }

  private async handleDynamicCliExecutor(
    taskId: string,
    descriptor: ToolExecutorDescriptor,
    toolInput: Record<string, unknown>,
    agentId?: string,
    userSub?: string,
  ): Promise<string> {
    if (!descriptor.cliCommand) {
      throw new Error(`CLI tool "${descriptor.toolName}" is missing cliCommand.`);
    }
    const timeoutMs = this.readPositiveInteger(toolInput.timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS;
    const workspacePath = await this.ensureWorkspacePath(taskId);
    const command = this.renderRuntimeTemplate(descriptor.cliCommand, toolInput, taskId, agentId);
    // Per-user scoping for cli tools (career DB, gmail, …): dual-channel like the harness
    // wrappers — OSHAL_USER_SUB in the env AND a .oshal-user-sub file in the workspace cwd,
    // so the tool reads whichever it supports. No-op for system dispatches (no userSub).
    const env = userSub ? { ...process.env, OSHAL_USER_SUB: userSub } : process.env;
    if (userSub) {
      try { fs.writeFileSync(path.join(workspacePath, '.oshal-user-sub'), userSub, 'utf8'); } catch { /* best-effort */ }
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workspacePath,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env,
      });

      return this.limitOutput(this.formatCommandResult(command, String(stdout), String(stderr), 0));
    } catch (error) {
      const failure = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        signal?: NodeJS.Signals;
      };

      throw new Error(
        this.limitOutput(
          this.formatCommandResult(
            command,
            String(failure.stdout || ''),
            String(failure.stderr || failure.message),
            typeof failure.code === 'number' ? failure.code : 1,
            failure.signal,
          ),
        ),
      );
    }
  }

  private async handleDynamicApiExecutor(
    taskId: string,
    descriptor: ToolExecutorDescriptor,
    toolInput: Record<string, unknown>,
    agentId?: string,
    userSub?: string,
  ): Promise<string> {
    if (!descriptor.apiEndpoint) {
      throw new Error(`API tool "${descriptor.toolName}" is missing apiEndpoint.`);
    }

    const renderedEndpoint = this.renderRuntimeTemplate(descriptor.apiEndpoint, toolInput, taskId, agentId, false);
    const parsedEndpoint = this.parseApiEndpoint(renderedEndpoint);
    const endpoint = this.resolveApiEndpoint(parsedEndpoint.endpoint);
    const method = (this.readOptionalString(toolInput.method) || parsedEndpoint.method || 'POST').toUpperCase();
    const timeoutMs = this.readPositiveInteger(toolInput.timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS;
    const headers = this.buildDynamicApiHeaders(toolInput, userSub);
    const bodySource = this.readRecord(toolInput.body) ?? toolInput;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(bodySource),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
      }
      return this.limitOutput(text || `HTTP ${response.status} ${response.statusText}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @description Build the outbound header set for a route-backed `api` tool, keeping the
   * framework's trust headers unforgeable.
   *
   * WHY the ordering and the strip are both required: `toolInput` is the raw `tool_use` block the
   * MODEL emitted — the agentic loop hands `block.input` straight to executeTool and nothing
   * validates it against the tool's declared inputSchema. A tool call is therefore attacker-shaped
   * whenever any untrusted text reached the prompt. The old code spread `toolInput.headers` LAST,
   * so a block carrying `{"headers":{"X-OSHAL-User-Sub":"<somebody else>"}}` chose which user the
   * service-secret call acted for — an identity swap on an internal route that trusts that header
   * absolutely (getTrustedServiceUserSub). Spreading first fixes precedence; stripping is what
   * makes it hold under HTTP's case-insensitive header names, where `x-oshal-user-sub` would
   * otherwise sit alongside the framework's `X-OSHAL-User-Sub` and win by insertion order.
   * @param toolInput - The raw, untrusted tool input from the model.
   * @param userSub - The accountable owner resolved by the framework, if any.
   * @returns The header record actually sent, with trust headers owned by the framework.
   */
  private buildDynamicApiHeaders(
    toolInput: Record<string, unknown>,
    userSub?: string,
  ): Record<string, string> {
    const supplied = this.readRecord(toolInput.headers) ?? {};
    const safe: Record<string, string> = {};
    for (const [name, value] of Object.entries(supplied)) {
      if (TRUST_HEADER_NAMES.has(name.toLowerCase())) {
        logger.warn({ header: name }, 'Dropped a trust header supplied by tool input — identity is never the model\'s to set');
        continue;
      }
      if (value === undefined || value === null) continue;
      safe[name] = String(value);
    }
    return {
      'Content-Type': 'application/json',
      ...safe,
      ...serviceSecretHeaders(),
      ...(userSub ? { 'X-OSHAL-User-Sub': userSub } : {}),
    };
  }

  private resolveApiEndpoint(endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) {
      return endpoint;
    }

    if (!endpoint.startsWith('/')) {
      throw new Error(`API tool endpoint "${endpoint}" must be absolute or start with "/".`);
    }

    const configuredBase = this.readOptionalString(process.env.OSHAL_INTERNAL_API_BASE_URL)
      || this.readOptionalString(process.env.API_TOOL_INTERNAL_BASE_URL);
    const base = configuredBase
      || `http://127.0.0.1:${this.readOptionalString(process.env.PORT) || '5000'}`;
    return `${base.replace(/\/+$/, '')}${endpoint}`;
  }

  private parseApiEndpoint(endpoint: string): { method?: string; endpoint: string } {
    const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(.+)$/i.exec(endpoint.trim());
    if (!match) return { endpoint };
    return { method: match[1].toUpperCase(), endpoint: match[2].trim() };
  }

  /**
   * @description List files and folders beneath a workspace-relative path.
   */
  private async handleListDirectory(taskId: string, toolInput: Record<string, unknown>): Promise<string> {
    const targetPath = this.readOptionalString(toolInput.path) || '.';
    const { resolvedPath, displayPath } = await this.resolveWorkspacePath(taskId, targetPath);
    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => `${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}${entry.isDirectory() ? '/' : ''}`);

    if (entries.length === 0) {
      return `Directory "${displayPath}" is empty.`;
    }

    return this.limitOutput(`Contents of "${displayPath}":\n${entries.join('\n')}`);
  }

  /**
   * @description Read a UTF-8 file from the task workspace.
   */
  private async handleReadFile(taskId: string, toolInput: Record<string, unknown>): Promise<string> {
    const requestedPath = this.readRequiredString(toolInput.path, 'path');
    const { resolvedPath, displayPath } = await this.resolveWorkspacePath(taskId, requestedPath);
    const stat = fs.statSync(resolvedPath);

    if (!stat.isFile()) {
      throw new Error(`Path "${displayPath}" is not a file.`);
    }
    if (stat.size > DEFAULT_READ_LIMIT_BYTES) {
      throw new Error(`File "${displayPath}" is too large to read (${stat.size} bytes).`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    return this.limitOutput(`File "${displayPath}":\n${content}`);
  }

  /**
   * @description Search files under the task workspace with ripgrep when available,
   * otherwise fall back to a small recursive text scan.
   */
  private async handleSearchFiles(taskId: string, toolInput: Record<string, unknown>): Promise<string> {
    const pattern = this.readRequiredString(toolInput.pattern, 'pattern');
    const targetPath = this.readOptionalString(toolInput.path) || '.';
    const { workspacePath, resolvedPath, displayPath } = await this.resolveWorkspacePath(taskId, targetPath);

    const ripgrepResult = await this.searchWithRipgrep(workspacePath, resolvedPath, pattern);
    if (ripgrepResult !== null) {
      return ripgrepResult;
    }

    const fallbackMatches = this.searchWithNodeFallback(resolvedPath, pattern, workspacePath);
    if (fallbackMatches.length === 0) {
      return `No matches found for "${pattern}" under "${displayPath}".`;
    }

    return this.limitOutput(
      `Matches for "${pattern}" under "${displayPath}":\n${fallbackMatches.join('\n')}`,
    );
  }

  /**
   * @description Create or overwrite a file under the task workspace.
   */
  private async handleWriteToFile(taskId: string, toolInput: Record<string, unknown>): Promise<string> {
    const requestedPath = this.readRequiredString(toolInput.path, 'path');
    const content = this.readRequiredString(toolInput.content, 'content');
    const { resolvedPath, displayPath } = await this.resolveWorkspacePath(taskId, requestedPath);

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, content, 'utf8');

    return `Wrote ${content.length} characters to "${displayPath}".`;
  }

  /**
   * @description Replace all occurrences of a string within an existing file.
   */
  private async handleReplaceInFile(taskId: string, toolInput: Record<string, unknown>): Promise<string> {
    const requestedPath = this.readRequiredString(toolInput.path, 'path');
    const search = this.readRequiredString(toolInput.search, 'search');
    const replace = this.readRequiredString(toolInput.replace, 'replace');
    const { resolvedPath, displayPath } = await this.resolveWorkspacePath(taskId, requestedPath);

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const matchCount = (content.match(new RegExp(this.escapeRegex(search), 'g')) || []).length;
    if (matchCount === 0) {
      throw new Error(`Search text was not found in "${displayPath}".`);
    }

    const updated = content.split(search).join(replace);
    fs.writeFileSync(resolvedPath, updated, 'utf8');

    return `Replaced ${matchCount} occurrence(s) in "${displayPath}".`;
  }

  /**
   * @description Run a shell command inside the task workspace.
   */
  private async handleExecuteCommand(taskId: string, toolInput: Record<string, unknown>): Promise<string> {
    const command = this.readRequiredString(toolInput.command, 'command');
    const timeoutMs = this.readPositiveInteger(toolInput.timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS;
    const workspacePath = await this.ensureWorkspacePath(taskId);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workspacePath,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      });

      return this.limitOutput(this.formatCommandResult(command, String(stdout), String(stderr), 0));
    } catch (error) {
      const failure = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        signal?: NodeJS.Signals;
      };

      throw new Error(
        this.limitOutput(
          this.formatCommandResult(
            command,
            String(failure.stdout || ''),
            String(failure.stderr || failure.message),
            typeof failure.code === 'number' ? failure.code : 1,
            failure.signal,
          ),
        ),
      );
    }
  }

  /**
   * @description Return a follow-up question marker for providers that support
   * multi-turn clarification through tool results.
   */
  private async handleAskFollowupQuestion(toolInput: Record<string, unknown>): Promise<string> {
    const question = this.readRequiredString(toolInput.question, 'question');
    throw new FollowupQuestionSignal(question);
  }

  /**
   * @description Render a presentation with the in-repo deck engine
   * (`@/features/presentation-generation`). Replaces the retired Presentron sidecar
   * call: slides render locally via `renderPptx` (ten themes / twenty layouts) and
   * the resulting .pptx is written into the task workspace — a real editable deck,
   * never mock data, and no dead-host dependency.
   *
   * @param taskId - Current task identifier (scopes the output file)
   * @param toolInput - `{ title, slides|sections: [{title, content?, notes?, layout?, subtitle?, image?}],
   *   theme?, subtitle?, byline?, outputPath? }`
   * @returns JSON summary with the workspace-relative deck path
   */
  private async handlePresentron(taskId: string, toolInput: Record<string, unknown>): Promise<string> {
    const title = this.readOptionalString(toolInput.title) || 'Presentation';
    const slides = this.readPresentronSlides(toolInput);
    if (slides.length === 0) {
      throw new Error('Tool input must include a non-empty "slides" array of { title, content?, notes?, layout? } objects.');
    }

    const requestedTheme = this.readOptionalString(toolInput.theme)
      || this.readOptionalString(toolInput.templateId);
    const buffer = await renderPptx(title, slides, {
      theme: isThemeId(requestedTheme) ? requestedTheme : undefined,
      subtitle: this.readOptionalString(toolInput.subtitle),
      byline: this.readOptionalString(toolInput.byline),
    });

    const requestedOutput = this.readOptionalString(toolInput.outputPath)
      || `presentations/${this.normalizeWorkspaceId(title).slice(0, 64) || 'deck'}.pptx`;
    const { resolvedPath, displayPath } = await this.resolveWorkspacePath(taskId, requestedOutput);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, buffer);

    return this.limitOutput(JSON.stringify({
      success: true,
      renderer: 'in-repo:presentation-generation',
      title,
      theme: isThemeId(requestedTheme) ? requestedTheme : 'default',
      slides: slides.length,
      bytes: buffer.length,
      path: displayPath,
    }, null, 2));
  }

  /**
   * @description Normalize presentron tool input into renderable slides. Accepts the
   * current `slides` shape and the older `sections` shape so callers built against
   * the sidecar contract keep working.
   */
  private readPresentronSlides(toolInput: Record<string, unknown>): RenderableSlide[] {
    const raw = Array.isArray(toolInput.slides)
      ? toolInput.slides
      : Array.isArray(toolInput.sections) ? toolInput.sections : [];
    const slides: RenderableSlide[] = [];

    for (const value of raw) {
      const record = this.readRecord(value);
      if (!record) {
        continue;
      }
      const slideTitle = this.readOptionalString(record.title) || this.readOptionalString(record.heading);
      const content = this.readOptionalString(record.content) || this.readOptionalString(record.body);
      if (!slideTitle && !content) {
        continue;
      }
      const layout = this.readOptionalString(record.layout);
      slides.push({
        title: slideTitle || '',
        content,
        notes: this.readOptionalString(record.notes) || this.readOptionalString(record.speakerNotes),
        subtitle: this.readOptionalString(record.subtitle),
        image: this.readOptionalString(record.image),
        ...(isLayoutId(layout) ? { layout } : {}),
      });
    }
    return slides;
  }

  /**
   * @description Call the Workflow Studio API to design, validate, or compile workflow definitions.
   */
  private async handleWorkflowStudio(toolInput: Record<string, unknown>): Promise<string> {
    const port = process.env.PORT || '3456';
    const baseUrl = `http://127.0.0.1:${port}/api/workflow-studio`;
    const service = new WorkflowStudioIntegrationService({ baseUrl });
    const result = await service.execute(toolInput);
    return this.limitOutput(JSON.stringify(result, null, 2));
  }

  /**
   * @description Call the RAG ingestion integration.
   */
  private async handleRagIngestion(toolInput: Record<string, unknown>): Promise<string> {
    const format = this.readRequiredString(toolInput.format, 'format');
    const content = this.readRequiredString(toolInput.content, 'content');
    const metadata = this.readRecord(toolInput.metadata) || {};
    const ragConfig = readRagRuntimeSettings();
    const configuredEndpoint = this.readOptionalString(process.env.RAG_INGESTION_ENDPOINT)
      || this.readOptionalString(ragConfig.endpoint);

    if (configuredEndpoint) {
      const service = new RAGIngestionIntegrationService({
        endpoint: configuredEndpoint,
        supportedFormats: ['pdf', 'txt', 'md'],
        maxFileSizeMB: 50,
      });
      const result = await service.ingest({ format, content, metadata });
      return this.limitOutput(JSON.stringify(result, null, 2));
    }

    const collection = this.readOptionalString(toolInput.collection)
      || this.readOptionalString(ragConfig.defaultCollection)
      || 'default';
    const ragService = new RagService();
    const normalizedMetadata = this.normalizeMetadata({
      ...metadata,
      format,
      source: this.readOptionalString(metadata.source) || 'rag-ingestion-tool',
      embeddingProviderId: this.readOptionalString(metadata.embeddingProviderId) || ragConfig.embeddingProviderId || '',
      embeddingModelId: this.readOptionalString(metadata.embeddingModelId) || ragConfig.embeddingModelId || '',
    });
    const result = await ragService.ingest([content], collection, normalizedMetadata);
    return this.limitOutput(JSON.stringify(result, null, 2));
  }

  /**
   * @description Query the built-in Chroma-backed RAG service directly.
   */
  private async handleRagQuery(toolInput: Record<string, unknown>, userSub?: string): Promise<string> {
    const query = this.readRequiredString(toolInput.query, 'query');
    const requestedCollection = this.readOptionalString(toolInput.collection);
    const topK = this.readPositiveInteger(toolInput.topK) || 5;
    const ragConfig = readRagRuntimeSettings();
    const collection = requestedCollection || this.readOptionalString(ragConfig.defaultCollection);
    const ragService = new RagService();

    // Scope retrieval to the user the bot is acting for: their own ACL-tagged chunks plus shared
    // (public) corpus. A system dispatch with no userSub keeps the unfiltered behavior.
    const context: RagPermissionContext | undefined = userSub
      ? { userSub, allowPublic: true }
      : undefined;
    const results = collection
      ? await ragService.search(query, collection, topK, context)
      : await ragService.searchAllCollections(query, topK, context);

    return this.limitOutput(JSON.stringify({
      query,
      collection: collection || 'all',
      topK,
      count: results.length,
      results,
    }, null, 2));
  }

  /**
   * @description Execute gogcli commands for the Google Workspace bot.
   */
  private async handleGogCli(
    taskId: string,
    toolInput: Record<string, unknown>,
    agentId?: string,
  ): Promise<string> {
    const resolvedAgentId = this.requireAgentId(agentId, 'gogcli');
    const workspacePath = await this.ensureWorkspacePath(taskId);
    const configValues = await this.readAgentConfigValues(resolvedAgentId);
    const integration = new GoogleWorkspaceCliIntegration({
      agentId: resolvedAgentId,
      homeDir: this.ensureBotRuntimeDir(resolvedAgentId, 'google-workspace'),
      clientId: this.readOptionalString(configValues.GOOGLE_CLIENT_ID),
      clientSecret: this.readOptionalString(configValues.GOOGLE_CLIENT_SECRET),
      accountEmail: this.readOptionalString(configValues.GOOGLE_ACCOUNT_EMAIL),
      defaultAccount: this.readOptionalString(configValues.GOG_ACCOUNT)
        || this.readOptionalString(configValues.GOOGLE_ACCOUNT_EMAIL),
      serviceAccountJson: this.readOptionalString(configValues.GOOGLE_SERVICE_ACCOUNT_JSON),
      serviceAccountSubject: this.readOptionalString(configValues.GOOGLE_SERVICE_ACCOUNT_SUBJECT),
      redirectPort: this.readOptionalString(configValues.GOOGLE_REDIRECT_PORT),
      scopes: this.readOptionalString(configValues.GOOGLE_SCOPES),
    });

    const args = Array.isArray(toolInput.args)
      ? toolInput.args.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : undefined;
    const command = this.readOptionalString(toolInput.command);
    const json = toolInput.json === true || (args?.includes('--json') ?? false) || command?.includes('--json') === true;
    const timeoutMs = this.readPositiveInteger(toolInput.timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS;
    const result = await integration.execute({
      args,
      command,
      json,
      cwd: workspacePath,
      timeoutMs,
    });

    return this.limitOutput(JSON.stringify({
      agentId: resolvedAgentId,
      authConfigured: Boolean(
        (
          this.readOptionalString(configValues.GOOGLE_CLIENT_ID)
          && this.readOptionalString(configValues.GOOGLE_CLIENT_SECRET)
        )
        || this.readOptionalString(configValues.GOOGLE_SERVICE_ACCOUNT_JSON),
      ),
      command: `oshal-google-workspace ${result.args.join(' ')}`.trim(),
      stdout: result.stdout,
      stderr: result.stderr,
      json: result.json,
    }, null, 2));
  }

  /**
   * @description Import transaction data into the personal finance bot ledger.
   */
  private async handleFinanceImport(
    taskId: string,
    toolInput: Record<string, unknown>,
    agentId?: string,
  ): Promise<string> {
    const integration = await this.createPersonalFinanceIntegration(agentId);
    const filePaths = await this.resolveToolFilePaths(taskId, toolInput);
    const transactions = Array.isArray(toolInput.transactions)
      ? toolInput.transactions.filter((value): value is Record<string, unknown> => Boolean(this.readRecord(value)))
        .map((value) => this.readRecord(value) as Record<string, unknown>)
      : [];

    const result = integration.importTransactions({
      transactions,
      filePaths,
      source: this.readOptionalString(toolInput.source),
    });

    return this.limitOutput(JSON.stringify(result, null, 2));
  }

  /**
   * @description Analyze imported transactions and optionally write a Markdown report.
   */
  private async handleFinanceReport(
    taskId: string,
    toolInput: Record<string, unknown>,
    agentId?: string,
  ): Promise<string> {
    const integration = await this.createPersonalFinanceIntegration(agentId);
    const requestedOutputPath = this.readOptionalString(toolInput.outputPath);
    const resolvedOutput = requestedOutputPath
      ? await this.resolveWorkspacePath(taskId, requestedOutputPath)
      : await this.resolveWorkspacePath(taskId, `reports/finance-report-${new Date().toISOString().slice(0, 10)}.md`);
    const result = integration.generateReport({
      title: this.readOptionalString(toolInput.title),
      category: this.readOptionalString(toolInput.category),
      lookbackDays: this.readPositiveInteger(toolInput.lookbackDays),
      alertThreshold: this.readPositiveInteger(toolInput.alertThreshold),
      outputPath: resolvedOutput.resolvedPath,
    });

    return this.limitOutput(JSON.stringify({
      ...result,
      reportPath: resolvedOutput.displayPath,
    }, null, 2));
  }

  /**
   * @description Run spend analysis without writing a report file.
   */
  private async handleAnalyzeSpending(
    toolInput: Record<string, unknown>,
    agentId?: string,
  ): Promise<string> {
    const integration = await this.createPersonalFinanceIntegration(agentId);
    const result = integration.analyzeSpending({
      category: this.readOptionalString(toolInput.category),
      lookbackDays: this.readPositiveInteger(toolInput.lookbackDays),
      alertThreshold: this.readPositiveInteger(toolInput.alertThreshold),
    });
    return this.limitOutput(JSON.stringify(result, null, 2));
  }

  /**
   * @description Return a budget-focused summary for the imported finance ledger.
   */
  private async handleCheckBudget(
    toolInput: Record<string, unknown>,
    agentId?: string,
  ): Promise<string> {
    const integration = await this.createPersonalFinanceIntegration(agentId);
    const result = integration.checkBudget({
      category: this.readOptionalString(toolInput.category),
      lookbackDays: this.readPositiveInteger(toolInput.lookbackDays),
      alertThreshold: this.readPositiveInteger(toolInput.alertThreshold),
    });
    return this.limitOutput(JSON.stringify(result, null, 2));
  }

  /**
   * @description Attempt a ripgrep-based search. Returns null when rg is unavailable.
   */
  private async searchWithRipgrep(
    workspacePath: string,
    resolvedPath: string,
    pattern: string,
  ): Promise<string | null> {
    const relativeTarget = path.relative(workspacePath, resolvedPath) || '.';

    try {
      const { stdout } = await execFileAsync(
        'rg',
        ['--line-number', '--no-heading', pattern, relativeTarget],
        { cwd: workspacePath, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      );

      const trimmed = String(stdout).trim();
      if (trimmed.length === 0) {
        return `No matches found for "${pattern}" under "${relativeTarget}".`;
      }

      return this.limitOutput(`Matches for "${pattern}" under "${relativeTarget}":\n${trimmed}`);
    } catch (error) {
      const failure = error as Error & { code?: number | string };
      if (failure.code === 1) {
        return `No matches found for "${pattern}" under "${relativeTarget}".`;
      }
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn('ripgrep is not available; falling back to Node file search');
        return null;
      }
      throw failure;
    }
  }

  /**
   * @description Recursive text search fallback used when ripgrep is unavailable.
   */
  private searchWithNodeFallback(targetPath: string, pattern: string, workspacePath: string): string[] {
    const matcher = this.createSearchMatcher(pattern);
    const matches: string[] = [];
    const files = this.collectFiles(targetPath);

    for (const filePath of files) {
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        logger.debug({ err: error, filePath }, 'Skipping unreadable file during fallback search');
        continue;
      }

      const lines = content.split('\n');

      for (let index = 0; index < lines.length; index++) {
        if (matcher(lines[index])) {
          matches.push(`${path.relative(workspacePath, filePath)}:${index + 1}:${lines[index]}`);
        }
      }
    }

    return matches;
  }

  /**
   * @description Collect files from a directory tree, skipping common noise directories.
   */
  private collectFiles(targetPath: string): string[] {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      return [targetPath];
    }

    const files: string[] = [];
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }

      const entryPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectFiles(entryPath));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }

    return files;
  }

  /**
   * @description Build a line matcher from a string pattern.
   */
  private createSearchMatcher(pattern: string): (value: string) => boolean {
    try {
      const regex = new RegExp(pattern, 'i');
      return (value: string) => regex.test(value);
    } catch (_error) {
      const needle = pattern.toLowerCase();
      return (value: string) => value.toLowerCase().includes(needle);
    }
  }

  /**
   * @description Format shell command output for the agentic loop.
   */
  private formatCommandResult(
    command: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    signal?: NodeJS.Signals,
  ): string {
    const signalText = signal ? `\nsignal: ${signal}` : '';
    return [
      `command: ${command}`,
      `exitCode: ${exitCode}${signalText}`,
      `stdout:\n${stdout.trim() || '(empty)'}`,
      `stderr:\n${stderr.trim() || '(empty)'}`,
    ].join('\n\n');
  }

  /**
   * @description Resolve the task workspace root.
   */
  private resolveWorkspaceRoot(): string {
    const configuredRoot = process.env.CLINE_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
    if (configuredRoot && configuredRoot.trim().length > 0) {
      return path.resolve(configuredRoot);
    }
    return path.resolve(process.cwd(), 'workspace');
  }

  /**
   * @description Ensure the task workspace directory exists.
   * Checks ticket→workspace links first; falls back to per-task workspace.
   */
  private async ensureWorkspacePath(taskId: string): Promise<string> {
    if (this.workspaceService) {
      try {
        const ticketPath = await this.workspaceService.resolveTaskWorkspace(taskId);
        if (ticketPath) {
          fs.mkdirSync(ticketPath, { recursive: true });
          logger.debug({ taskId, ticketPath }, 'Using ticket-linked workspace');
          return ticketPath;
        }
      } catch (error) {
        logger.error({ err: error, taskId }, 'Ticket workspace resolution failed; using per-task fallback');
      }
    }
    // NOTE (ADR-060 reverted): bot task files use the flat <root>/<taskId> layout. Per-user
    // file partitioning was reverted because the swarm's verifier/handover/deliverable readers
    // assume this flat path in ~10 places; isolation is enforced at the API/DB/route layer
    // instead (owner_sub columns + the IDOR guards), by the task owner binding on the bot path,
    // and by the ADR-040 credential lease/wipe. Per-user FILE storage needs a dedicated pass that
    // routes every reader AND writer through one resolver — and a real boundary under it, since
    // every bot mounts this root read-write. Done-when: ADR-060 "Reverted: where the isolation
    // actually lives".
    const workspacePath = path.join(this.workspaceRoot, this.normalizeWorkspaceId(taskId));
    fs.mkdirSync(workspacePath, { recursive: true });
    return workspacePath;
  }

  /**
   * @description Resolve and validate a workspace-scoped path.
   */
  private async resolveWorkspacePath(
    taskId: string,
    requestedPath: string,
  ): Promise<{ workspacePath: string; resolvedPath: string; displayPath: string }> {
    const workspacePath = await this.ensureWorkspacePath(taskId);
    const resolvedPath = path.resolve(workspacePath, requestedPath);
    if (resolvedPath !== workspacePath && !resolvedPath.startsWith(`${workspacePath}${path.sep}`)) {
      throw new Error(`Path "${requestedPath}" escapes the task workspace.`);
    }

    return {
      workspacePath,
      resolvedPath,
      displayPath: path.relative(workspacePath, resolvedPath) || '.',
    };
  }

  /**
   * @description Normalize task identifiers for filesystem usage.
   */
  private normalizeWorkspaceId(taskId: string): string {
    return taskId.trim().replaceAll(/[^a-zA-Z0-9-_]/g, '_');
  }

  /**
   * @description Require agent identity for agent-scoped tool execution.
   */
  private requireAgentId(agentId: string | undefined, toolName: string): string {
    if (!agentId || agentId.trim().length === 0) {
      throw new Error(`Tool "${toolName}" requires an agentId in the execution context.`);
    }
    return agentId;
  }

  /**
   * @description Read a required string input field.
   */
  private readRequiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Tool input field "${fieldName}" must be a non-empty string.`);
    }
    return value;
  }

  /**
   * @description Read an optional string input field.
   */
  private readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  /**
   * @description Read persisted config values for an agent when available.
   */
  private async readAgentConfigValues(agentId: string): Promise<Record<string, unknown>> {
    if (!this.agentConfigService) {
      return {};
    }

    const config = await this.agentConfigService.getConfig(agentId);
    return config?.values || {};
  }

  /**
   * @description Ensure an agent-scoped runtime directory exists for persistent tool state.
   */
  private ensureBotRuntimeDir(agentId: string, scope: string): string {
    const root = process.env.BOT_RUNTIME_ROOT
      ? path.resolve(process.env.BOT_RUNTIME_ROOT)
      : DEFAULT_BOT_RUNTIME_ROOT;
    const resolved = path.join(root, this.normalizeWorkspaceId(agentId), scope);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  /**
   * @description Create a configured personal finance integration for the active agent.
   */
  private async createPersonalFinanceIntegration(agentId?: string): Promise<PersonalFinanceIntegrationService> {
    const resolvedAgentId = this.requireAgentId(agentId, 'personal-finance');
    const configValues = await this.readAgentConfigValues(resolvedAgentId);
    return new PersonalFinanceIntegrationService({
      agentId: resolvedAgentId,
      storageDir: this.ensureBotRuntimeDir(resolvedAgentId, 'personal-finance'),
      budgetTargets: this.readJsonRecord(configValues.BUDGET_TARGETS) as Record<string, number> | undefined,
      alertThreshold: this.readNumericValue(configValues.ALERT_THRESHOLD),
      lookbackDays: this.readNumericValue(configValues.LOOKBACK_DAYS),
      savingsGoal: this.readNumericValue(configValues.SAVINGS_GOAL),
    });
  }

  /**
   * @description Resolve optional file path inputs relative to the current task workspace.
   */
  private async resolveToolFilePaths(taskId: string, toolInput: Record<string, unknown>): Promise<string[]> {
    const candidates: string[] = [];
    const singlePath = this.readOptionalString(toolInput.path);
    if (singlePath) {
      candidates.push(singlePath);
    }

    if (Array.isArray(toolInput.paths)) {
      for (const value of toolInput.paths) {
        if (typeof value === 'string' && value.trim().length > 0) {
          candidates.push(value);
        }
      }
    }

    const resolved: string[] = [];
    for (const candidate of candidates) {
      const pathInfo = await this.resolveWorkspacePath(taskId, candidate);
      resolved.push(pathInfo.resolvedPath);
    }
    return resolved;
  }

  /**
   * @description Read an optional positive integer.
   */
  private readPositiveInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number.parseInt(value.trim(), 10);
        return parsed > 0 ? parsed : undefined;
      }
      return undefined;
    }
    return value;
  }

  /**
   * @description Read an optional numeric config/tool input.
   */
  private readNumericValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number.parseFloat(value.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  /**
   * @description Read a record-like tool input value.
   */
  private readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  /**
   * @description Parse JSON-like config payloads, or return record values directly.
   */
  private readJsonRecord(value: unknown): Record<string, unknown> | undefined {
    if (this.readRecord(value)) {
      return this.readRecord(value);
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return this.readRecord(parsed);
    } catch (_error) {
      return undefined;
    }
  }

  /**
   * @description Normalize metadata values to string form for RagService ingestion.
   */
  private normalizeMetadata(value: Record<string, unknown>): Record<string, string> {
    const metadata: Record<string, string> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (fieldValue === undefined || fieldValue === null) {
        continue;
      }
      if (typeof fieldValue === 'string') {
        metadata[key] = fieldValue;
        continue;
      }
      try {
        metadata[key] = JSON.stringify(fieldValue);
      } catch (error) {
        logger.error({ err: error, key }, 'Failed to stringify metadata field value');
        metadata[key] = String(fieldValue);
      }
    }
    return metadata;
  }

  /**
   * @description Render runtime executor templates such as
   * `{input.query}`, `{taskId}`, and `{agentId}`.
   */
  private renderRuntimeTemplate(
    template: string,
    toolInput: Record<string, unknown>,
    taskId: string,
    agentId?: string,
    shellEscape = true,
  ): string {
    return template.replace(/\{([^}]+)\}/g, (_match, token: string) => {
      const value = this.resolveRuntimeTemplateToken(token, toolInput, taskId, agentId);
      const rendered = this.stringifyTemplateValue(value);
      guardTemplateValue(rendered, token);
      return shellEscape ? this.shellQuote(rendered) : encodeURIComponent(rendered);
    });
  }

  private resolveRuntimeTemplateToken(
    token: string,
    toolInput: Record<string, unknown>,
    taskId: string,
    agentId?: string,
  ): unknown {
    if (token === 'taskId') return taskId;
    if (token === 'agentId') return agentId ?? '';
    if (token === 'input') return toolInput;
    if (!token.startsWith('input.')) {
      throw new Error(`Unsupported runtime tool template token "{${token}}". Use {input.field}, {taskId}, or {agentId}.`);
    }

    const pathParts = token.slice('input.'.length).split('.');
    let current: unknown = toolInput;
    for (const part of pathParts) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`Runtime tool template token "{${token}}" did not resolve to a value.`);
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined || current === null) {
      throw new Error(`Runtime tool template token "{${token}}" did not resolve to a value.`);
    }
    return current;
  }

  private stringifyTemplateValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }

  private shellQuote(value: string): string {
    if (process.platform === 'win32') {
      return `"${value.replaceAll('"', '\\"')}"`;
    }
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  /**
   * @description Escape a plain string for regex use.
   */
  private escapeRegex(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * @description Limit long outputs so tool results stay prompt-safe.
   */
  private limitOutput(value: string): string {
    if (value.length <= DEFAULT_OUTPUT_LIMIT) {
      return value;
    }
    return `${value.slice(0, DEFAULT_OUTPUT_LIMIT)}\n\n[output truncated]`;
  }
}
