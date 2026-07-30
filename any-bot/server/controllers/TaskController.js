/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BYO-LLM execution: processMessage now honors options.byoLlmConnection — when the caller threads a per-user OpenAI-compatible endpoint, inference runs on THEIR endpoint+key+model via a per-request OpenAIProvider (_buildByoLlm), bypassing agentic mode. This is the execution half of the BYO-LLM connector (the seam getUserLlmConnection now feeds).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: rebranded legacy "Kevin" agent identity/namespace to neutral OSHAL
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Per-user task storage (ADR-060): createTask now honors options.userSub and places a NEW task workspace under the owner's namespace (<base>/users/<sub>/<taskId>) via resolveUserTaskDir, instead of a flat shared root. Pre-existing flat dirs are detected and reused so existing work is not orphaned. Owner is threaded from bot-node-execution-handler (payload.userSub).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Persist task owner binding and reject task-id reuse across owned, ownerless, and anonymous identity boundaries.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Explicit agentic-mode marker (BACKLOG "BYO / free-tier connections bypass the agentic loop"): processMessage routing now honors options.toolLess (with env OSHAL_TOOL_LESS as the process-level default) via resolveToolLessMarker instead of silently inferring tool-less mode from BYO status alone; when the marker is absent the legacy derivation (BYO connection => tool-less) still applies, and direct-path responses now carry toolLess: true so callers can surface the degraded mode.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Change-log accuracy: entry 4 above claims createTask places NEW workspaces under <base>/users/<sub>/<taskId> via resolveUserTaskDir, but that layout was REVERTED (see the per-branch notes in createTask) — all three branches join the flat root, and the orphaned resolveUserTaskDir helper has been deleted. What options.userSub still does is STAMP the owner on the task record, which is what assertTaskOwnerBinding (and the bot-node handler's pre-createTask check) compare on reuse. Entry 4 stands as history; this entry is the correction. No behavior change.
 */

/**
 * Task Controller - Manages task lifecycle and LLM interaction
 * Coordinates between UI, LLM service, and tools
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../utils/config');
const CheckpointValidator = require('../stores/CheckpointValidator');
const AgenticController = require('./AgenticController');
const GitLabService = require('../services/GitLabService');
const ClineCLIWrapper = require('../services/codebase/ClineCLIWrapper');

function normalizeTaskOwner(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, 512)
    : null;
}

function normalizeRuntimeIdentity(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

/**
 * @description Resolve the explicit tool-less (agentic-bypass) marker for a request.
 * Precedence: options.toolLess (boolean or 'true'/'false' string, threaded from the
 * caller) wins; then the process-level env default OSHAL_TOOL_LESS; when neither is
 * set, fall back to the legacy derivation — a BYO-LLM connection implies the
 * tool-less direct path, because no vendor CLI harness can target an arbitrary
 * endpoint. The fallback keeps existing callers behaviorally unchanged.
 * @param {Object} [options] - processMessage options (may carry toolLess)
 * @param {Object|null} byoLlm - the per-request BYO provider, or null
 * @returns {boolean} true when this request must bypass the agentic loop
 */
function resolveToolLessMarker(options, byoLlm) {
  const explicit = options ? options.toolLess : undefined;
  if (explicit === true || explicit === 'true') return true;
  if (explicit === false || explicit === 'false') return false;
  const envDefault = process.env.OSHAL_TOOL_LESS;
  if (envDefault === 'true') return true;
  if (envDefault === 'false') return false;
  return Boolean(byoLlm);
}

function assertTaskOwnerBinding(task, requestedUserSub) {
  const taskOwner = normalizeTaskOwner(task && task.userSub);
  const requestedOwner = normalizeTaskOwner(requestedUserSub);
  if (taskOwner === requestedOwner) return task;
  const error = new Error('Task owner mismatch');
  error.code = 'TASK_OWNER_MISMATCH';
  throw error;
}

class TaskController {
  constructor(taskStore, messageStore, checkpointStore, llmService, mcpService, streamController = null, toolRegistry = null) {
    this.taskStore = taskStore;
    this.messageStore = messageStore;
    this.checkpointStore = checkpointStore;
    this.llm = llmService;
    this.mcp = mcpService;
    this.stream = streamController;
    this.activeTasks = new Map();
    this.toolRegistry = toolRegistry || new Map();
    this.gitlabService = new GitLabService();

    if (this.llm && this.toolRegistry) {
      this.agenticController = new AgenticController(this.llm, this.toolRegistry, this.stream, this);
      logger.info('AgenticController initialized');
    }

    this.clineCLI = new ClineCLIWrapper({
      clineCommand: process.env.HOME + '/.local/bin/cline',
      timeout: (config.clineAgent && config.clineAgent.timeout) || 300,
    });

    const clineAgentEnabled = config.clineAgent && config.clineAgent.enabled === true;
    this.useClineCLI = clineAgentEnabled;
    logger.info(`ClineCLIWrapper initialized (toggle: ${this.useClineCLI ? 'CLINE_CLI' : 'BEDROCK'})`);
  }

  assertTaskOwner(task, userSub) {
    return assertTaskOwnerBinding(task, userSub);
  }

  async createTask(text, mode = 'act', options = {}) {
    // Use ticket-based workspace naming for stable directories
    // If ticketId provided, use short hash of ticket UUID for deterministic naming
    // If parentWorkspaceDir provided (subtask), nest under parent
    const { ticketId, parentWorkspaceDir, forceTaskId, userSub } = options;
    let taskId;
    let workspaceDir;

    // ⭐ PHASE_44B: Force a specific taskId (shared workspace from project-manager)
    if (forceTaskId) {
      taskId = forceTaskId;
      // ADR-060 reverted to flat: the swarm's deliverable/handover readers assume <base>/<taskId>.
      workspaceDir = path.join(config.filesystem.workspaceDir, taskId);
      logger.info(`📂 PHASE_44B: Forced taskId=${taskId} for shared workspace reuse`);
      // Don't return early if workspace exists — we need a new task object in the local store
    } else if (ticketId && parentWorkspaceDir) {
      // Child subtask: nest under parent workspace
      // ⭐ PHASE_67: Use full ticket UUID as folder name for direct ticket→workspace binding
      taskId = ticketId;
      workspaceDir = path.join(parentWorkspaceDir, `subtask_${ticketId.substring(0, 8)}`);
    } else if (ticketId) {
      // ⭐ PHASE_67: Use ticket UUID directly as task ID and folder name
      // This eliminates the fragile qm:ticket_task Redis mapping (24h TTL)
      // and makes workspace folders directly discoverable by ticket ID
      taskId = ticketId;
      // ADR-060 reverted to flat (readers assume <base>/<ticketId>).
      workspaceDir = path.join(config.filesystem.workspaceDir, ticketId);

      // Backward compat: check if old-style task_XXXXXXXX folder exists and reuse it
      const legacyTaskId = `task_${ticketId.substring(0, 8)}`;
      const legacyDir = path.join(config.filesystem.workspaceDir, legacyTaskId);
      if (fs.existsSync(legacyDir) && !fs.existsSync(workspaceDir)) {
        taskId = legacyTaskId;
        workspaceDir = legacyDir;
        logger.info(`♻️ PHASE_67: Using legacy workspace ${legacyTaskId} for ticket ${ticketId}`);
      }
      
      // Check if workspace already exists (phase reuse)
      if (fs.existsSync(workspaceDir)) {
        // Reuse existing workspace - check if task already in store
        const existingTask = this.taskStore ? await this.taskStore.loadTask(taskId) : null;
        if (existingTask) {
          assertTaskOwnerBinding(existingTask, userSub);
          logger.info(`♻️ Reusing existing workspace ${taskId} for ticket ${ticketId}`);
          return existingTask;
        }
        logger.info(`♻️ Reusing existing workspace directory ${workspaceDir} for ticket ${ticketId}`);
      }
    } else {
      // ⭐ PHASE_00_SESSION_06: Use UUID for SOP-compliant workspace structure
      // Generate UUID for non-ticket tasks (dashboard chat)
      taskId = crypto.randomUUID();
      // SOP-compliant path: /app/swarm-workspace/UUID/
      const swarmWorkspaceRoot = path.join(path.dirname(config.filesystem.workspaceDir), 'swarm-workspace');
      // ADR-060 reverted to flat.
      workspaceDir = path.join(swarmWorkspaceRoot, taskId);
      logger.info(`📂 PHASE_00_SESSION_06: Created UUID-based workspace: ${taskId}`);
    }

    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
      // ⭐ PHASE_00_SESSION_06: Create SOP-compliant folder structure
      // Standard folders: notes/, deliverables/, developer-handovers/
      fs.mkdirSync(path.join(workspaceDir, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, 'deliverables'), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, 'developer-handovers'), { recursive: true });
      
      // ⭐ PHASE_00_SESSION_06: Generate _meta.json with task metadata
      const metaData = {
        taskId: taskId,
        ticketId: ticketId || null,
        createdAt: new Date().toISOString(),
        taskDescription: text.substring(0, 500), // Truncate long descriptions
        assignedAgent: process.env.AGENT_ID || 'any-bot',
        status: 'created',
        workspaceVersion: '1.0-sop-compliant',
      };
      fs.writeFileSync(
        path.join(workspaceDir, '_meta.json'),
        JSON.stringify(metaData, null, 2)
      );
      
      logger.info(`Created SOP-compliant workspace for task: ${workspaceDir} (with notes/, deliverables/, developer-handovers/, _meta.json)`);
    }

    const task = {
      id: taskId,
      text,
      userSub: normalizeTaskOwner(userSub),
      status: 'created',
      mode,
      workspace_dir: workspaceDir,
      ts: Date.now(),
      apiMetrics: {
        totalTokens: 0,
        totalCost: 0,
        requestCount: 0,
        cacheHits: 0,
      },
      progress: {
        checklist: [],
        completed: [],
      },
    };

    if (config.gitlab && config.gitlab.enabled) {
      try {
        const gitlabResult = await this.gitlabService.createTaskProject(taskId, text, workspaceDir);
        if (gitlabResult.success) {
          task.gitlab_url = gitlabResult.projectUrl;
          logger.info(`GitLab project created: ${gitlabResult.projectUrl}`);
        } else {
          logger.warn(`GitLab project creation failed for ${taskId}: ${gitlabResult.error}`);
        }
      } catch (err) {
        logger.error(`GitLab setup error for ${taskId}: ${err.message}`);
      }
    } else {
      logger.info(`GitLab integration disabled, skipping project creation for task: ${taskId}`);
    }

    await this.taskStore.saveTask(task);

    const taskMessage = {
      type: 'task',
      say: 'task',
      text: task.text,
      ts: Date.now(),
    };

    await this.messageStore.saveMessage(task.id, taskMessage);

    this.activeTasks.set(task.id, {
      ...task,
      messages: [taskMessage],
    });

    logger.info(`Task created: ${task.id}`);
    return task;
  }

  async getTask(taskId) {
    if (this.activeTasks.has(taskId)) {
      return this.activeTasks.get(taskId);
    }

    const task = await this.taskStore.loadTask(taskId);
    if (!task) {
      return null;
    }

    const messages = await this.messageStore.getMessages(taskId);
    task.messages = messages;
    this.activeTasks.set(taskId, task);
    return task;
  }

  async updateTask(taskId, updates) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    Object.assign(task, updates);
    await this.taskStore.saveTask(task);
    this.activeTasks.set(taskId, task);
    logger.debug(`Task updated: ${taskId}`);
    return task;
  }

  async processMessage(taskId, userMessage, options = {}) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const commandRegex = /^`([^`]+)`$/;
    const match = userMessage.text.match(commandRegex);

    if (match) {
      const command = match[1];
      return this.executeTool(taskId, 'execute_command', { command }, options.autoApprove);
    }

    // Bring-Your-Own-LLM: when the caller threaded a per-user OpenAI-compatible
    // connection, this request runs inference on THEIR endpoint+key+model instead of
    // the bot's configured provider. BYO is a reasoning path (no vendor CLI harness
    // can target an arbitrary endpoint), so it bypasses agentic mode and uses the
    // direct generateResponse path below with a per-request provider.
    const byoLlm = this._buildByoLlm(options.byoLlmConnection);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE_42: Always use AgenticController (no dual routing)
    // Provider selection (Bedrock vs Cline CLI) happens in AgenticController
    // ═══════════════════════════════════════════════════════════════════
    // Explicit marker replaces the old silent `!byoLlm` inference: callers state
    // intent via options.toolLess (or OSHAL_TOOL_LESS); when absent, the legacy
    // BYO-implies-tool-less derivation applies (see resolveToolLessMarker).
    const toolLess = resolveToolLessMarker(options, byoLlm);
    const useAgenticMode = !toolLess && options.agenticMode !== false && this.agenticController;

    if (useAgenticMode) {
      return this.processWithAgenticMode(taskId, userMessage, options);
    }

    await this.updateTask(taskId, { status: 'running' });

    const message = {
      type: 'say',
      say: 'say',
      text: userMessage.text,
      ts: Date.now(),
      images: userMessage.images || [],
      files: userMessage.files || [],
    };

    await this.messageStore.saveMessage(taskId, message);
    task.messages.push(message);

    try {
      // ⭐ PHASE_54 FIX: Check for AgenticController, not just legacy this.llm
      // AgenticController has dual providers (Bedrock + Cline CLI). A per-request
      // BYO provider (caller's own endpoint) takes precedence when present.
      const activeLlm = byoLlm || this.llm;
      const hasLLM = activeLlm || this.agenticController;

      if (!hasLLM) {
        const response = {
          type: 'say',
          say: 'say',
          text: `Received: "${userMessage.text}"\n\n*LLM service not configured. Set ANTHROPIC_API_KEY or AWS credentials to enable AI responses.*`,
          ts: Date.now(),
        };

        await this.messageStore.saveMessage(taskId, response);
        task.messages.push(response);
        return { success: true, message: response };
      }

      if (this.stream) {
        this.stream.broadcast(taskId, 'llm_processing', {
          status: 'started',
          message: 'Sending request to LLM...',
        });
      }

      const availableTools = this.getAvailableTools();

      const formattedMessages = task.messages.map(msg => ({
        role: msg.type === 'say' && msg.text.includes('Task:') ? 'user' : 'user',
        content: msg.text || msg.say || ''
      }));

      let systemPrompt = `You are an OSHAL agent, a helpful AI coding assistant with full Cline capabilities. You have access to ${availableTools.length} tools including file operations and DevOps CLI tools. The current task is: ${task.text}`;

      if (global.PLANE_CONTEXT) {
        systemPrompt += global.PLANE_CONTEXT;
      }

      const response = await activeLlm.generateResponse(formattedMessages, {
        systemPrompt: systemPrompt,
        maxTokens: 4096,
        temperature: 0.7,
        tools: availableTools,
        extraEnv: options.extraEnv // per-request scoping (e.g. OSHAL_USER_SUB) → provider spawn
      });
      const finalText = typeof (response.content || response.text) === 'string'
        ? String(response.content || response.text).trim() : '';
      if (!finalText) {
        const emptyError = new Error('LLM endpoint returned no final answer');
        emptyError.code = 'EMPTY_FINAL_ANSWER';
        throw emptyError;
      }

      if (this.stream) {
        this.stream.broadcast(taskId, 'llm_processing', {
          status: 'completed',
          message: 'LLM response received',
        });
      }

      const messages = [];

      messages.push({
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({
          request: userMessage.text,
          cost: response.cost || 0
        }),
        ts: Date.now(),
      });

      const reasoningText = `Processing request: "${userMessage.text}"\n\nAnalyzing task requirements and determining appropriate response strategy.`;
      messages.push({
        type: 'say',
        say: 'reasoning',
        text: reasoningText,
        ts: Date.now() + 1,
      });

      messages.push({
        type: 'say',
        say: 'text',
        text: finalText,
        ts: Date.now() + 2,
      });

      for (const msg of messages) {
        await this.messageStore.saveMessage(taskId, msg);
        task.messages.push(msg);
      }

      if (response.usage) {
        await this.updateMetrics(taskId, {
          totalTokens: (task.apiMetrics.totalTokens || 0) + response.usage.totalTokens,
          totalCost: (task.apiMetrics.totalCost || 0) + (response.cost || 0),
          requestCount: (task.apiMetrics.requestCount || 0) + 1,
        });
      }

      await this.updateTask(taskId, { status: 'completed' });
      return {
        success: true,
        messages: messages,
        apiMetrics: task.apiMetrics,
        // These labels come from the provider response object, never generated text.
        provider: normalizeRuntimeIdentity(response.provider, 128),
        model: normalizeRuntimeIdentity(response.model, 256),
        // This turn ran the direct (no agentic loop, no tools) path — surfaced so
        // callers can tell a degraded reasoning-only answer from a full agentic one.
        toolLess: true,
      };

    } catch (err) {
      logger.error(`Error processing message for task ${taskId}: ${err.message}`);

      const errorMessage = {
        type: 'error',
        say: 'error',
        text: `Error: ${err.message}`,
        ts: Date.now(),
      };

      await this.messageStore.saveMessage(taskId, errorMessage);
      task.messages.push(errorMessage);
      await this.updateTask(taskId, { status: 'error' });
      throw err;
    }
  }

  async processLLMResponse(taskId, response) {
    const task = await this.getTask(taskId);

    if (response.usage) {
      await this.updateMetrics(taskId, {
        totalTokens: (task.apiMetrics.totalTokens || 0) + response.usage.inputTokens + response.usage.outputTokens,
        totalCost: (task.apiMetrics.totalCost || 0) + response.usage.cost,
        requestCount: (task.apiMetrics.requestCount || 0) + 1,
        cacheHits: (task.apiMetrics.cacheHits || 0) + (response.usage.cacheReads > 0 ? 1 : 0),
      });
    }

    for (const content of response.content) {
      if (content.type === 'text') {
        const textMessage = {
          type: 'say',
          say: 'say',
          text: content.text,
          ts: Date.now(),
        };
        await this.messageStore.saveMessage(taskId, textMessage);
        task.messages.push(textMessage);
      } else if (content.type === 'tool_use') {
        const toolResult = await this.executeTool(taskId, content.name, content.input, false);
        if (toolResult.requiresApproval) {
          logger.info(`Tool ${content.name} requires approval`);
        }
      }
    }

    logger.info(`Processed LLM response for task ${taskId}`);
  }

  async cancelTask(taskId) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    await this.updateTask(taskId, { status: 'cancelled' });

    const cancelMessage = {
      type: 'say',
      say: 'say',
      text: '_Task cancelled by user_',
      ts: Date.now(),
    };

    await this.messageStore.saveMessage(taskId, cancelMessage);
    logger.info(`Task cancelled: ${taskId}`);
    return task;
  }

  async completeTask(taskId, result = null) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    await this.updateTask(taskId, { status: 'completed' });

    if (result) {
      const completionMessage = {
        type: 'completion_result',
        say: 'completion_result',
        text: result,
        ts: Date.now(),
      };
      await this.messageStore.saveMessage(taskId, completionMessage);
    }

    logger.info(`Task completed: ${taskId}`);
    return task;
  }

  async createCheckpoint(taskId) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const checkpoint = await this.checkpointStore.createCheckpoint(
      taskId,
      task.messages,
      {
        status: task.status,
        apiMetrics: task.apiMetrics,
      }
    );

    await this.updateTask(taskId, {
      checkpoint: { id: checkpoint.id, timestamp: checkpoint.timestamp },
    });

    logger.info(`Checkpoint created for task ${taskId}: ${checkpoint.id}`);
    return checkpoint;
  }

  async restoreCheckpoint(checkpointId) {
    const checkpoint = await this.checkpointStore.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const task = await this.getTask(checkpoint.taskId);
    if (!task) {
      throw new Error(`Task not found for checkpoint: ${checkpoint.taskId}`);
    }

    const validation = CheckpointValidator.validateForRestore(checkpoint, task);
    if (!validation.valid) {
      logger.error(`Checkpoint validation failed for ${checkpointId}:`);
      validation.errors.forEach(error => logger.error(`  - ${error}`));
      throw new Error(`Checkpoint validation failed: ${validation.errors.join(', ')}`);
    }

    const sanitizedCheckpoint = CheckpointValidator.sanitize(checkpoint);

    await this.messageStore.deleteMessages(task.id);
    await this.messageStore.saveMessages(task.id, sanitizedCheckpoint.messages);

    if (sanitizedCheckpoint.metadata) {
      await this.updateTask(task.id, {
        status: sanitizedCheckpoint.metadata.status || 'running',
        apiMetrics: sanitizedCheckpoint.metadata.apiMetrics || task.apiMetrics,
      });
    }

    this.activeTasks.delete(task.id);
    const restoredTask = await this.getTask(task.id);

    logger.info(`Task restored from checkpoint: ${checkpointId} (${checkpoint.messageCount} messages)`);
    return restoredTask;
  }

  async listTasks(limit = 50, offset = 0) {
    return await this.taskStore.listTasks(limit, offset);
  }

  async deleteTask(taskId) {
    this.activeTasks.delete(taskId);
    const deleted = await this.taskStore.deleteTask(taskId);
    if (deleted) {
      logger.info(`Task deleted: ${taskId}`);
    }
    return deleted;
  }

  async getTaskMessages(taskId) {
    return await this.messageStore.getMessages(taskId);
  }

  async addMessage(taskId, message) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    await this.messageStore.saveMessage(taskId, message);
    task.messages.push(message);
    logger.debug(`Message added to task ${taskId}`);
    return message;
  }

  async updateMetrics(taskId, metrics) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.apiMetrics = {
      ...task.apiMetrics,
      ...metrics,
    };

    await this.updateTask(taskId, { apiMetrics: task.apiMetrics });
    logger.debug(`Metrics updated for task ${taskId}`);
    return task.apiMetrics;
  }

  async updateProgress(taskId, progress) {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.progress = {
      ...task.progress,
      ...progress,
    };

    await this.updateTask(taskId, { progress: task.progress });

    const progressMessage = {
      type: 'task_progress',
      say: 'task_progress',
      text: this.formatProgressChecklist(task.progress),
      ts: Date.now(),
    };

    await this.messageStore.saveMessage(taskId, progressMessage);
    logger.debug(`Progress updated for task ${taskId}`);
    return task.progress;
  }

  formatProgressChecklist(progress) {
    const lines = [];
    progress.checklist.forEach((item) => {
      const isCompleted = progress.completed.includes(item);
      lines.push(`- [${isCompleted ? 'x' : ' '}] ${item}`);
    });
    return lines.join('\n');
  }

  async processWithAgenticMode(taskId, userMessage, options = {}) {
    const task = await this.getTask(taskId);
    await this.updateTask(taskId, { status: 'running' });

    const message = {
      type: 'say',
      say: 'say',
      text: userMessage.text,
      ts: Date.now(),
      images: userMessage.images || [],
      files: userMessage.files || [],
    };

    await this.messageStore.saveMessage(taskId, message);
    task.messages.push(message);

    try {
      logger.info(`Processing message in agentic mode for task ${taskId}`);

      // ⭐ PHASE_56 FIX: Double-posting root cause
      // When provider is cline-cli, pass EMPTY history — each call is stateless.
      // The persona + current message are written to workspace README by ClineProvider._messagesToTask().
      // Passing recentMessages caused double-posting because:
      //   1. Current message was already saved to task.messages above
      //   2. recentMessages included it → AgenticController added it AGAIN to history
      //   3. Cline CLI saw the message twice → generated multiple responses
      // For Bedrock: keep passing recentMessages (needs conversation context)
      const providerName = this.agenticController.getCurrentProvider
        ? this.agenticController.getCurrentProvider()
        : 'cline-cli';

      const recentMessages = (providerName === 'cline-cli')
        ? []  // Cline CLI is stateless — persona+task go in workspace README
        : task.messages
            .filter(msg => msg.type === 'say' && msg.text)
            .slice(-10)
            .map(msg => ({
              role: 'user',
              content: msg.text,
            }));

      logger.info(`[TaskController] Provider: ${providerName}, conversation history: ${recentMessages.length} messages`);

      // ⭐ PHASE_58: Pass options to AgenticController (includes agentId for dynamic persona)
      const result = await this.agenticController.processAgenticTask(
        taskId,
        userMessage.text,
        recentMessages,
        options.autoApprove || {},
        options  // Pass full options object (includes agentId)
      );

      await this.updateTask(taskId, { status: result.success ? 'completed' : 'error' });

      logger.info(`Agentic processing completed in ${result.turns} turns with ${result.apiMetrics?.totalTokens || 0} tokens`);

      const updatedTask = await this.getTask(taskId);

      return {
        success: result.success,
        result: result.result,
        turns: result.turns,
        apiMetrics: result.apiMetrics,
        messages: updatedTask.messages,
        provider: normalizeRuntimeIdentity(result.provider, 128),
        model: normalizeRuntimeIdentity(result.model, 256),
        providerRecords: Array.isArray(result.providerRecords) ? result.providerRecords : [],
      };

    } catch (err) {
      logger.error(`Error in agentic mode for task ${taskId}: ${err.message}`);

      const errorMessage = {
        type: 'error',
        say: 'error',
        text: `Error: ${err.message}`,
        ts: Date.now(),
      };

      await this.messageStore.saveMessage(taskId, errorMessage);
      task.messages.push(errorMessage);
      await this.updateTask(taskId, { status: 'error' });
      throw err;
    }
  }

  /**
   * Map a Cline CLI NDJSON `say` field to a any-bot broadcast event type.
   * Returns null for messages that should be HIDDEN from dashboard UI.
   */
  _mapClineSayToEvent(say) {
    const mapping = {
      'api_req_started': 'api_req_started',
      'api_req_finished': 'api_req_finished',
      'text': 'text',
      'reasoning': 'reasoning',
      'tool': 'tool_use',
      'tool_use': 'tool_use',
      'tool_result': 'tool_result',
      'completion_result': 'completion_result',
      'error': 'error',
      'command': 'tool_use',
      'command_output': 'tool_result',
      'browser_action': 'tool_use',
      'browser_action_result': 'tool_result',
      // ═══════════════════════════════════════════
      // PHASE_23: Hide prompt echoes and internal messages from dashboard UI
      // These are Cline internals that should NOT appear in user chat
      // ═══════════════════════════════════════════
      'say': null,           // Prompt echo — contains full swarm context
      'task': null,          // Task prompt echo
      'user_feedback': null, // User input echo (already displayed by dashboard)
      'user_feedback_diff': null,
    };
    // If key exists in mapping, return its value (even if null)
    if (say in mapping) return mapping[say];
    // Unknown types: hide by default (safer than showing internal noise)
    logger.debug(`[ClineCLI] Unknown say type hidden from UI: ${say}`);
    return null;
  }

  /**
   * Process message with Cline CLI using real-time streaming.
   * Each NDJSON line from Cline CLI stdout is broadcast via SSE/Socket.IO
   * and stored in MessageStore for history.
   */
  async processWithClineCLI(taskId, userMessage, options = {}) {
    const task = await this.getTask(taskId);
    await this.updateTask(taskId, { status: 'running' });

    const message = {
      type: 'say',
      say: 'say',
      text: userMessage.text,
      ts: Date.now(),
    };
    await this.messageStore.saveMessage(taskId, message);
    task.messages.push(message);

    try {
      logger.info(`Processing message via CLINE CLI (streaming) for task ${taskId}`);

      if (this.stream) {
        this.stream.broadcast(taskId, 'llm_processing', {
          status: 'started',
          message: 'Sending to Cline CLI (v2.0.5 + GovCloud patch, streaming)...',
          provider: 'cline-cli',
        });
      }

      const startMsg = {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ request: userMessage.text, provider: 'cline-cli' }),
        ts: Date.now(),
      };
      await this.messageStore.saveMessage(taskId, startMsg);
      task.messages.push(startMsg);

      if (this.stream) {
        this.stream.broadcast(taskId, 'api_req_started', {
          ts: startMsg.ts,
          provider: 'cline-cli',
        });
      }

      const workspaceDir = task.workspace_dir || path.join(process.env.WORKSPACE_DIR || '/app/workspace', task.id);  // Task-specific directory — bot works HERE
      let messageCount = 0;

      // ═══════════════════════════════════════════════════════════
      // PHASE_15: Inject bot persona context into Cline CLI prompts
      // Without this, dashboard chat runs as generic assistant
      // ═══════════════════════════════════════════════════════════
      let clinePrompt = userMessage.text;
      const personaFile = process.env.BOT_PERSONA_FILE;
      const agentId = process.env.AGENT_ID || 'agent';
      const capabilities = process.env.AGENT_CAPABILITIES || 'general';
      
      // Build rich context: persona + swarm awareness + tools + process
      try {
        const fs = require('fs');
        let perspective = '';
        
        if (personaFile && fs.existsSync(personaFile)) {
          const personaContent = fs.readFileSync(personaFile, 'utf8');
          const match = personaContent.match(/perspective:\s*\|\n([\s\S]*?)(?=\ncapabilities:|$)/);
          if (match) perspective = match[1].replace(/^  /gm, '').substring(0, 4000);
        }

        // Detect if this is dashboard chat vs automated ticket processing
        const isDashboardChat = options.source === 'dashboard' || !task.ticketId;
        
        // Count prior user messages to detect follow-ups vs first message
        const priorUserMessages = task.messages.filter(m => m.type === 'say' && m.say === 'say').length;
        const isFollowUp = priorUserMessages > 1; // >1 because current message already added
        
        // ═══════════════════════════════════════════════════════
        // FOLLOW-UP: Lightweight context — include conversation history summary
        // ═══════════════════════════════════════════════════════
        if (isFollowUp) {
          // ═══════════════════════════════════════════════════════
          // PHASE_23 FIX: Full conversation history — NO truncation
          // Cline has 200K context. Truncating to 500 chars/msg was destroying
          // conversation continuity. Pass FULL messages so the bot actually
          // remembers what was said. Filter out hidden/internal noise messages.
          // ═══════════════════════════════════════════════════════
          const recentHistory = task.messages
            .filter(m => m.text && m.text.length > 0 && !m.hidden && !m.text.startsWith('{'))
            .slice(-20)  // Last 20 messages (full conversation, not truncated)
            .map(m => {
              const role = (m.type === 'say' && m.say === 'say') ? 'User' : 
                           (m.say === 'completion_result') ? 'You (final answer)' :
                           (m.say === 'text') ? 'You' : 
                           (m.say === 'reasoning') ? 'You (thinking)' : 'System';
              // NO truncation — pass full message content
              return `${role}: ${m.text}`;
            })
            .join('\n\n');

          clinePrompt = `You are **${agentId}**. Continue the conversation. Work in: ${workspaceDir}
${isDashboardChat ? 'You CAN read /app/server/ for self-reference. Create files in your workspace.' : 'SANDBOX: Work only in your workspace.'}
${perspective ? `\nYour specialist persona: ${perspective.substring(0, 2000)}\n` : ''}

## CONVERSATION HISTORY (FULL — do NOT repeat or summarize this, just continue)
${recentHistory}

## NEW MESSAGE FROM USER
${userMessage.text}

IMPORTANT: Respond directly to the user's new message. Do NOT re-introduce yourself or repeat the conversation.`;
          logger.info(`[ClineCLI] Follow-up message #${priorUserMessages} for ${agentId} — FULL history (${clinePrompt.length} chars, ${task.messages.filter(m => !m.hidden).length} visible msgs)`);
        } else {
        // ═══════════════════════════════════════════════════════
        // FIRST MESSAGE: Full swarm context injection
        // ═══════════════════════════════════════════════════════
        const swarmContext = `You are **${agentId}**, a specialist bot in an AI agent swarm.

## WHO YOU ARE
- Agent ID: ${agentId}
- Capabilities: ${capabilities}
- Persona: ${personaFile ? 'loaded' : 'none'}
- Dashboard: http://localhost:${process.env.PORT || 5000}/dashboard

## YOUR WORKING DIRECTORY
**You MUST work in: ${workspaceDir}**
- All files you create go in this directory (or subdirectories of it)
- Use \`notes/\` for analysis, plans, and scratch work
- Use \`deliverables/\` for final output the user wants
- Task ID: ${taskId}
${isDashboardChat ? `
## CODEBASE ACCESS (READ-ONLY for reference)
Your server code is at /app/server/ (bind-mounted from host). You can READ these to understand yourself:
- /app/server/app.js — Main application (routes, initialization)
- /app/server/controllers/ — API controllers (TaskController, AgenticController, etc.)
- /app/server/services/ — Business logic, tools, queue manager
- /app/server/services/tools/ — Tool implementations
- /app/bot-configs/ — All bot persona YAML files
- /app/server/utils/config.js — Configuration

⚠️ **SAFETY RULES FOR CODEBASE:**
- You CAN read any file under /app/ to understand your own API, config, and capabilities
- You SHOULD NOT modify files under /app/server/ unless the user EXPLICITLY asks you to edit your own code
- If the user asks you to "fix yourself" or "update your config" — THEN you may write to /app/server/
- For all normal work, create files in your working directory: ${workspaceDir}
` : `
## WORKSPACE SANDBOX
⚠️ **STRICT SANDBOX MODE** — This is automated ticket processing.
- Work ONLY within: ${workspaceDir}
- Do NOT read or modify anything under /app/server/
- Do NOT modify your own code or configuration
- All output goes in your working directory
`}
## THE SWARM
You are one of 18+ bots in an autonomous agent swarm. Each bot has a specialty:
- project-manager (port 3010): Queue owner, orchestration, ticket routing
- Other bots: task-manager, worker-general, code-reviewer, research-bot, devops-bot, etc.
- Factory-created bots: security-auditor, email-bot, video-bot, data-extraction-bot, etc.

## PLANE (Ticket System)
Tickets come from Plane (project management). The lifecycle is:
INTAKE → PLANNING → EXECUTION → TESTING → REVIEW → DELIVERY
Each phase routes to the best-fit agent via Mesh Broadcast (LLM-based bidding).
- Plane workspace slug: ${process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00'}
- Plane project ID: ${process.env.PLANE_PROJECT_ID || '(check /app/server/utils/config.js)'}
- To create tickets: Use the Plane MCP tool \`create_work_item\` or the Plane API at http://host.docker.internal:8000/api/v1/workspaces/${process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00'}/projects/
- To list tickets: Use \`execute_command\` with \`curl\` to query the Plane API, or use the Plane MCP \`list_work_items\` tool

## YOUR TOOLS
You have access to: execute_command, read_file, write_to_file, list_files, search_files, google_search, and more.
- Use execute_command to run any CLI tool (git, docker, kubectl, aws, gcloud, curl, etc.)
- Use write_to_file to create deliverables in ${workspaceDir}/deliverables/
- Use read_file to examine files${isDashboardChat ? ' (including your own codebase at /app/server/)' : ' in your workspace'}

## HOW TO HELP THE USER
1. If they ask about your capabilities — tell them specifically what you can do
2. If they want something built — create it in ${workspaceDir}/deliverables/
3. If they have a complex request — break it down, do each part, verify
4. If it's outside your specialty — recommend creating a Plane ticket for the right bot
${isDashboardChat ? '5. If they ask about your own API — read /app/server/ to answer accurately\n6. If they explicitly ask you to modify your own code — you may write to /app/server/' : ''}

${perspective ? `## YOUR SPECIALIST PERSONA\n${perspective}\n` : ''}`;

        clinePrompt = `${swarmContext}\n## USER REQUEST\n${userMessage.text}`;
        logger.info(`[ClineCLI] Injected full swarm context (${swarmContext.length} chars) for ${agentId}`);
        } // end else (first message)
      } catch (personaErr) {
        logger.debug(`[ClineCLI] Context injection skipped: ${personaErr.message}`);
      }

      const result = await this.clineCLI.executeTaskStreaming(clinePrompt, workspaceDir, {
        timeout: (config.clineAgent && config.clineAgent.timeout) || 300,

        onMessage: (parsed) => {
          messageCount++;
          const say = parsed.say || 'text';
          const eventType = this._mapClineSayToEvent(say);
          const text = parsed.text || '';
          const ts = parsed.ts || Date.now();

          // ═══════════════════════════════════════════
          // PHASE_23: Filter internal/noise messages from UI broadcast
          // eventType === null means this message should be hidden from dashboard
          // Still save to MessageStore for history/debugging, but don't broadcast
          // ═══════════════════════════════════════════
          if (eventType === null) {
            logger.debug(`ClineCLI stream [${messageCount}]: HIDDEN ${say} (${text.substring(0, 60)}...)`);
            // Still save internally for debugging, but don't broadcast to UI
            const msg = {
              type: parsed.type || 'say',
              say: say,
              text: text,
              ts: ts,
              hidden: true,  // Mark as hidden for history filtering
              modelInfo: parsed.modelInfo || { providerId: 'cline-cli' },
            };
            Promise.resolve(this.messageStore.saveMessage(taskId, msg)).catch(err => {
              logger.error(`Failed to save hidden Cline CLI message: ${err.message}`);
            });
            task.messages.push(msg);
            return; // Don't broadcast to UI
          }

          logger.info(`ClineCLI stream [${messageCount}]: ${say} → ${eventType} (${text.substring(0, 80)}...)`);

          const msg = {
            type: parsed.type || 'say',
            say: say,
            text: text,
            ts: ts,
            modelInfo: parsed.modelInfo || { providerId: 'cline-cli' },
            partial: parsed.partial || false,
          };

          // Fire-and-forget save — wrap in Promise.resolve in case saveMessage doesn't return a promise
          Promise.resolve(this.messageStore.saveMessage(taskId, msg)).catch(err => {
            logger.error(`Failed to save Cline CLI message: ${err.message}`);
          });
          task.messages.push(msg);

          if (this.stream) {
            this.stream.broadcast(taskId, eventType, {
              text: text,
              ts: ts,
              say: say,
              modelInfo: parsed.modelInfo,
              partial: parsed.partial,
              provider: 'cline-cli',
              conversationHistoryIndex: parsed.conversationHistoryIndex,
            });
          }
        },

        onError: (stderrText) => {
          logger.warn(`ClineCLI stderr during streaming: ${stderrText.substring(0, 200)}`);
        },
      });

      if (this.stream) {
        this.stream.broadcast(taskId, 'api_req_finished', {
          ts: Date.now(),
          provider: 'cline-cli',
          messageCount: messageCount,
          success: result.success,
        });
      }

      if (messageCount === 0) {
        const stderrInfo = result.stderr ? `\n\nStderr: ${result.stderr.substring(0, 500)}` : '';
        const exitInfo = result.exitCode !== 0 ? ` (exit code: ${result.exitCode})` : '';
        const fallbackMsg = {
          type: 'say',
          say: 'text',
          text: `Cline CLI returned no streaming output${exitInfo}.${stderrInfo}`,
          ts: Date.now(),
          modelInfo: { providerId: 'cline-cli' },
        };
        await this.messageStore.saveMessage(taskId, fallbackMsg);
        task.messages.push(fallbackMsg);

        if (this.stream) {
          this.stream.broadcast(taskId, 'text', {
            text: fallbackMsg.text,
            ts: fallbackMsg.ts,
            provider: 'cline-cli',
          });
        }
      }

      if (this.stream) {
        this.stream.broadcast(taskId, 'llm_processing', {
          status: 'completed',
          message: `Cline CLI streaming complete (${messageCount} messages)`,
          provider: 'cline-cli',
        });
      }

      await this.updateTask(taskId, { status: 'completed' });
      logger.info(`Cline CLI streaming complete for task ${taskId}: ${messageCount} messages`);
      // PHASE_23: Filter hidden messages from HTTP response so dashboard renderMessagesSequentially
      // doesn't re-display prompt echoes, swarm context, and other internal noise
      const visibleMessages = task.messages.filter(m => !m.hidden);
      return { success: true, messages: visibleMessages, provider: 'cline-cli', messageCount };

    } catch (err) {
      logger.error(`Cline CLI streaming error for task ${taskId}: ${err.message}`);

      const errorMessage = {
        type: 'error',
        say: 'error',
        text: `Cline CLI Error: ${err.message}`,
        ts: Date.now(),
      };
      await this.messageStore.saveMessage(taskId, errorMessage);
      task.messages.push(errorMessage);

      if (this.stream) {
        this.stream.broadcast(taskId, 'error', {
          text: errorMessage.text,
          ts: errorMessage.ts,
          provider: 'cline-cli',
        });
      }

      await this.updateTask(taskId, { status: 'error' });
      throw err;
    }
  }

  /**
   * @description Build a per-request OpenAI-compatible provider from a caller's
   * Bring-Your-Own-LLM connection ({ baseUrl, apiKey, model }), or null if none was
   * threaded. Lazily requires OpenAIProvider so the dependency only loads on the BYO
   * path. Failures return null (fall back to the bot's configured provider) rather
   * than throwing, so a malformed connection never breaks an otherwise-valid request.
   * @param {{baseUrl?:string,apiKey?:string,model?:string}} [conn] - the BYO connection
   * @returns {Object|null} an OpenAIProvider instance, or null
   */
  _buildByoLlm(conn) {
    if (!conn) return null;
    if (!conn.baseUrl || !conn.apiKey || !conn.model) {
      throw new Error('Invalid BYO-LLM configuration');
    }
    try {
      const OpenAIProvider = require('../services/llm/OpenAIProvider');
      const provider = new OpenAIProvider({ apiKey: conn.apiKey, model: conn.model, baseUrl: conn.baseUrl });
      logger.info(`[TaskController] BYO-LLM provider active: ${conn.model}`);
      return provider;
    } catch (err) {
      logger.warn(`[TaskController] BYO-LLM provider init failed (${err.message})`);
      throw new Error('Invalid BYO-LLM configuration');
    }
  }

  setLLMProvider(provider) {
    if (provider === 'cline-cli') {
      this.useClineCLI = true;
      logger.info('LLM provider switched to: CLINE CLI');
    } else {
      this.useClineCLI = false;
      logger.info('LLM provider switched to: BEDROCK (built-in)');
    }
    return { provider: this.useClineCLI ? 'cline-cli' : 'bedrock', active: true };
  }

  getLLMProvider() {
    return { provider: this.useClineCLI ? 'cline-cli' : 'bedrock' };
  }

  registerTool(name, handler, options = {}) {
    if (typeof this.toolRegistry.register === 'function') {
      this.toolRegistry.register({
        name,
        handler,
        requiresApproval: options.requiresApproval !== false,
        description: options.description || '',
        inputSchema: options.inputSchema || {},
      });
    } else {
      this.toolRegistry.set(name, {
        handler,
        requiresApproval: options.requiresApproval !== false,
        description: options.description || '',
        inputSchema: options.inputSchema || {},
      });
    }
    logger.debug(`Tool registered: ${name}`);
  }

  getAvailableTools() {
    if (typeof this.toolRegistry.getAll === 'function') {
      return this.toolRegistry.getAll().map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    } else if (this.toolRegistry instanceof Map) {
      return Array.from(this.toolRegistry.entries()).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }
    return [];
  }

  async executeTool(taskId, toolName, toolInput, approved = false) {
    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const task = await this.getTask(taskId);

    if (tool.requiresApproval && !approved) {
      return {
        requiresApproval: true,
        tool: {
          name: toolName,
          input: toolInput,
        },
      };
    }

    const toolUseMessage = {
      type: 'tool_use',
      say: 'tool_use',
      text: `Using tool: ${toolName}`,
      ts: Date.now(),
      tool: {
        name: toolName,
        input: toolInput,
        approved,
      },
    };

    await this.addMessage(taskId, toolUseMessage);

    try {
      const toolInputWithWorkspace = {
        ...toolInput,
        taskWorkspace: task.workspace_dir,
      };

      const result = await tool.handler(toolInputWithWorkspace);

      const resultMessage = {
        type: 'tool_result',
        say: 'tool_result',
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        ts: Date.now(),
        tool: {
          name: toolName,
          success: true,
        },
      };

      await this.addMessage(taskId, resultMessage);
      logger.info(`Tool executed: ${toolName} for task ${taskId}`);
      return result;

    } catch (err) {
      logger.error(`Tool execution failed: ${toolName} - ${err.message}`);

      const errorMessage = {
        type: 'tool_result',
        say: 'tool_result',
        text: `Error: ${err.message}`,
        ts: Date.now(),
        tool: {
          name: toolName,
          success: false,
          error: err.message,
        },
      };

      await this.addMessage(taskId, errorMessage);
      throw err;
    }
  }
}

module.exports = TaskController;
module.exports.assertTaskOwnerBinding = assertTaskOwnerBinding;
module.exports.normalizeTaskOwner = normalizeTaskOwner;
module.exports.resolveToolLessMarker = resolveToolLessMarker;
