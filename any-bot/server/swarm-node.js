/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Canonicalize every legacy forceTaskId before lookup/creation, reject every supplied owner assertion on the runtime that cannot enforce owner scoping, and forbid containment refusals from falling through to a generated workspace.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: remove wildcard CORS, fail startup and all non-health requests closed behind service auth, require exact tool/scope grants, and retire unscoped legacy task/message APIs.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Reject raw credential carriers on provider mutations before changing runtime state; Cline metadata builders now receive provider/model only.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: retain exact dispatch agent identity in the authorization context; ownerless legacy nodes still cannot invoke user-bound MCP tools.
 */

/**
 * Slim any-bot runtime for swarm worker nodes.
 *
 * This is NOT the full any-bot app.js monolith. It initializes ONLY the
 * components needed for the swarm execution path:
 *   - LLM providers (ClineProvider, ClaudeCodeProvider)
 *   - TaskController + AgenticController
 *   - /api/swarm-execute endpoint (called by the swarm controller)
 *   - /api/health, /api/llm-provider endpoints
 *
 * It does NOT initialize: voice (Polly/Transcribe), Plane sync, GitLab,
 * ProvisioningManager, SlashCommandGenerator, AgentBootstrap, QueueMonitor,
 * or any other non-execution services.
 *
 * Per any-bot-swarm-separation-design.md:
 *   - The swarm controller assembles prompts and dispatches via HTTP
 *   - This node handles authorized LLM execution and provider metadata selection
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const {
  assertServiceSecretConfigured,
  authorizeAnyBotRequest,
  authorizeSwarmExecute,
} = require('./services/codebase/swarm-execute-auth');
const { canonicalWorkspaceId } = require('./services/codebase/task-workspace-scope');
const { requireDispatchAuthorityList } = require('./utils/dispatch-capabilities');
const { assertUnattendedProviderSelection } = require('./services/llm/assert-cli-tool-boundary');

// LLM providers
const ClineProvider = require('./services/llm/ClineProvider');
const ClaudeCodeProvider = require('./services/llm/ClaudeCodeProvider');
const LLMProviderRegistry = require('./services/llm/LLMProviderRegistry');
const CostCalculator = require('./services/llm/CostCalculator');

// Controllers
const TaskController = require('./controllers/TaskController');
const AgenticController = require('./controllers/AgenticController');
const StreamController = require('./controllers/StreamController');

// Stores
const TaskStore = require('./stores/TaskStore');
const MessageStore = require('./stores/MessageStore');
const SettingsStore = require('./stores/SettingsStore');

// Utils — config is a singleton instance, not a class
const config = require('./utils/config');
const logger = {
  info: (...args) => console.log(`[swarm-node]`, ...args),
  warn: (...args) => console.warn(`[swarm-node]`, ...args),
  error: (...args) => console.error(`[swarm-node]`, ...args),
  debug: (...args) => { if (process.env.LOG_LEVEL === 'debug') console.log(`[swarm-node:debug]`, ...args); },
};

/** True only for workspace security errors that must never select a fallback directory. */
function isWorkspaceBoundaryError(error) {
  return Boolean(error && error.code === 'UNSAFE_TASK_WORKSPACE');
}

/** Build a stable boundary error when TaskController violates the canonical ID contract. */
function workspaceMismatchError() {
  const error = new Error('TaskController returned a non-canonical workspace id');
  error.code = 'UNSAFE_TASK_WORKSPACE';
  return error;
}

/**
 * @description Broadcast a locally-originated bot config change up to the OSHAL controller
 * on the swarm.config-change mesh channel (ADR-034). The controller subscribes and
 * reconciles it into the authoritative per-agent record so OSHAL stays system-of-record
 * even when a change originates at the bot. Best-effort and non-fatal; the wire format
 * matches RedisMeshTransport.publish so the TS controller consumes it without coupling.
 *
 * @param {object|null} redisClient - ioredis client (no-op when absent / standalone).
 * @param {string} agentId - This bot's agent id.
 * @param {{providerId?: string, modelId?: string}} params - Changed runtime params.
 * @param {string} source - Origin tag: 'bot-local' or 'sub-swarm'.
 * @returns {Promise<void>}
 */
async function broadcastConfigChange(redisClient, agentId, params, source) {
  if (!redisClient) return;
  try {
    const { randomUUID } = require('crypto');
    const envelope = {
      correlationId: randomUUID(),
      fromAgentId: agentId,
      toAgentId: '*',
      channel: 'swarm.config-change',
      payload: { agentId, params, source, runtime: 'swarm-node', botName: process.env.BOT_NAME || agentId },
      messageType: 'broadcast',
    };
    await redisClient.xadd(
      'oshal:mesh:swarm.config-change', 'MAXLEN', '~', '10000', '*',
      'data', JSON.stringify(envelope),
    );
    logger.info(`[ADR-034] Broadcast config change up for ${agentId} (${params.providerId || '-'}/${params.modelId || '-'}) source=${source} runtime=swarm-node`);
  } catch (err) {
    logger.error(`[ADR-034] Failed to broadcast config change for ${agentId}: ${err.message}`);
  }
}

class SwarmNodeServer {
  constructor() {
    this.app = express();
    this.app.use(authorizeAnyBotRequest);
    this.app.use(express.json({ limit: '50mb' }));

    this.currentLLMProvider = 'cline-cli';
    this.clineProvider = null;
    this.claudeCodeProvider = null;
    this.taskController = null;
    this.agenticController = null;
    this.streamController = null;
  }

  async initialize() {
    assertServiceSecretConfigured();
    logger.info('Initializing swarm node runtime...');

    // Stream controller (for SSE — lightweight, no socket.io)
    this.streamController = new StreamController();

    // Task + message stores (in-memory, no DB needed for worker nodes)
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const settingsStore = new SettingsStore();
    const CheckpointStore = require('./stores/CheckpointStore');
    const checkpointStore = new CheckpointStore();

    // Initialize LLM providers based on environment
    const forcedProvider = process.env.FORCE_LLM_PROVIDER || process.env.LLM_PROVIDER || 'cline-cli';

    // Cline CLI provider (works with 22 providers via LLMProviderRegistry)
    try {
      const ClineCLIWrapper = require('./services/codebase/ClineCLIWrapper');
      const cliPath = process.env.CLINE_CLI_PATH || 'cline';
      const wrapper = new ClineCLIWrapper(cliPath, {
        timeout: parseInt(process.env.CLINE_TIMEOUT_MS || '600000', 10),
        maxConcurrent: parseInt(process.env.CLINE_MAX_CONCURRENT || '5', 10),
      });
      this.clineProvider = new ClineProvider(wrapper, config);
      logger.info(`Cline CLI provider initialized (path: ${cliPath})`);
    } catch (err) {
      logger.warn(`Cline CLI provider not available: ${err.message}`);
    }

    // Claude Code CLI provider (Anthropic models only)
    try {
      if (process.env.ANTHROPIC_API_KEY || fs.existsSync(path.join(process.env.HOME || '/root', '.claude'))) {
        const claudePath = process.env.CLAUDE_CODE_CLI_PATH || process.env.CLAUDE_CLI_PATH || 'claude';
        this.claudeCodeProvider = new ClaudeCodeProvider({ claudeCommand: claudePath });
        logger.info(`Claude Code CLI provider initialized (path: ${claudePath})`);
      }
    } catch (err) {
      logger.warn(`Claude Code CLI provider not available: ${err.message}`);
    }

    // Determine active provider
    if (forcedProvider === 'claude-code' && this.claudeCodeProvider) {
      this.currentLLMProvider = 'claude-code';
    } else if (this.clineProvider) {
      this.currentLLMProvider = 'cline-cli';
    } else if (this.claudeCodeProvider) {
      this.currentLLMProvider = 'claude-code';
    }
    logger.info(`Active LLM provider: ${this.currentLLMProvider}`);

    // Tool registry (minimal — just built-in tools)
    const ToolRegistry = require('./services/ToolRegistry');
    const toolRegistry = new ToolRegistry();

    // Agentic controller
    this.agenticController = new AgenticController(
      {
        bedrockProvider: null,
        clineProvider: this.clineProvider,
        claudeCodeProvider: this.claudeCodeProvider,
        getCurrentProvider: () => this.currentLLMProvider,
      },
      toolRegistry,
      this.streamController,
    );

    // Task controller — constructor: (taskStore, messageStore, checkpointStore, llmService, mcpService, streamController, toolRegistry)
    // llmService = the agentic controller; mcpService = null (no MCP for slim nodes)
    this.taskController = new TaskController(
      taskStore, messageStore, checkpointStore,
      this.agenticController, null, this.streamController, toolRegistry,
    );
    this.taskController.setLLMProvider(this.currentLLMProvider);

    logger.info('Swarm node runtime initialized');
  }

  setupRoutes() {
    const taskController = this.taskController;

    // ── Health check ──────────────────────────────────────────────────
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        runtime: 'swarm-node',
        provider: this.currentLLMProvider,
        botName: process.env.BOT_NAME || 'unknown',
        agentId: process.env.AGENT_ID || 'unknown',
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/health', (req, res) => res.json({ status: 'ok' }));

    // ── LLM Provider endpoints ───────────────────────────────────────
    this.app.get('/api/llm-provider', (req, res) => {
      res.json({
        provider: this.currentLLMProvider,
        model: process.env.FORCE_LLM_MODEL || process.env.LLM_MODEL || 'default',
      });
    });

    this.app.get('/api/llm-provider/registry', (req, res) => {
      res.json({
        providers: LLMProviderRegistry.getAllProviders(),
        count: Object.keys(LLMProviderRegistry.getAllProviders()).length,
      });
    });

    this.app.put('/api/llm-provider', (req, res) => {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
      if (Object.prototype.hasOwnProperty.call(body, 'credentials')) {
        res.status(400).json({
          success: false,
          error: 'credential fields are not accepted on runtime configuration mutations',
        });
        return;
      }

      const { provider, model } = body;
      if (provider === 'claude-code' && this.claudeCodeProvider) {
        this.currentLLMProvider = 'claude-code';
      } else {
        this.currentLLMProvider = 'cline-cli';
      }
      if (model) {
        process.env.FORCE_LLM_MODEL = model;
      }
      this.taskController.setLLMProvider(this.currentLLMProvider);

      // Write Cline config if using cline-cli
      if (this.currentLLMProvider === 'cline-cli' && provider) {
        try {
          const clineConfig = LLMProviderRegistry.buildClineConfig(provider, model);
          const globalState = LLMProviderRegistry.buildGlobalState(provider, model);
          if (clineConfig) {
            const configDir = process.env.CLINE_CONFIG_DIR || path.join(process.env.HOME || '/root', '.cline');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(clineConfig, null, 2));
            logger.info(`Wrote Cline config for provider ${provider}`);
          }
          if (globalState) {
            const dataDir = path.join(process.env.CLINE_CONFIG_DIR || path.join(process.env.HOME || '/root', '.cline'), 'data');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'globalState.json'), JSON.stringify(globalState, null, 2));
          }
        } catch (err) {
          logger.warn(`Failed to write Cline config: ${err.message}`);
        }
      }

      // ADR-034: broadcast this change up to the OSHAL controller for reconciliation,
      // UNLESS it came from an OSHAL push (X-Config-Source: oshal-push) — echo-loop guard.
      if (req.get('X-Config-Source') !== 'oshal-push') {
        const broadcastAgentId = process.env.AGENT_ID || process.env.BOT_NAME || 'unknown';
        broadcastConfigChange(this.redis, broadcastAgentId, { providerId: provider, modelId: model }, 'bot-local');
      }

      res.json({ provider: this.currentLLMProvider, model: model || 'default', active: true });
    });

    // ── Swarm Execute (THE critical endpoint) ────────────────────────
    this.app.post('/api/swarm-execute', authorizeSwarmExecute, async (req, res) => {
      const execStart = Date.now();
      try {
        // Legacy harness: never accept caller identity or connector tokens. The
        // supported BOT_RUNTIME=any-bot entrypoint runs app.js, which implements
        // the authenticated owner-scoped contract. Reject instead of dropping or
        // accidentally exposing sensitive request data here.
        const carriesUserSub = Boolean(req.body
          && Object.prototype.hasOwnProperty.call(req.body, 'userSub'));
        const carriesCreds = req.body?.creds && typeof req.body.creds === 'object'
          && Object.keys(req.body.creds).length > 0;
        if (carriesUserSub || carriesCreds) {
          return res.status(410).json({
            success: false,
            error: 'owner-scoped execution is unsupported by the legacy swarm-node runtime',
          });
        }
        const {
          text, taskId, workspaceFolderId, agentId, agenticMode = true,
          allowedTools, authorizedScopes,
        } = req.body;

        if (!text) {
          return res.status(400).json({ success: false, error: 'text is required' });
        }
        const dispatchAllowedTools = requireDispatchAuthorityList(
          allowedTools, 'allowedTools', 256,
        );
        const dispatchAuthorizedScopes = requireDispatchAuthorityList(
          authorizedScopes, 'authorizedScopes', 512,
        );

        logger.info(`[swarm-execute] taskId=${taskId}, agentId=${agentId}, textLen=${text.length}, workspace=${workspaceFolderId}`);
        assertUnattendedProviderSelection(this.currentLLMProvider);

        // Resolve or create task
        const logicalTaskId = workspaceFolderId !== undefined
          ? workspaceFolderId
          : taskId !== undefined ? taskId : `swarm-${Date.now()}`;
        const effectiveTaskId = canonicalWorkspaceId(logicalTaskId);
        let task;
        try {
          task = await taskController.getTask(effectiveTaskId);
          if (!task) {
            task = await taskController.createTask(`Swarm execution for ${agentId}`, 'act', { forceTaskId: effectiveTaskId });
            if (task.id !== effectiveTaskId) throw workspaceMismatchError();
          }
        } catch (error) {
          if (isWorkspaceBoundaryError(error)) throw error;
          task = await taskController.createTask(`Swarm execution for ${agentId}`, 'act');
        }

        // Execute
        const result = await taskController.processMessage(task.id, { text }, {
          agenticMode,
          autoApprove: {},
          source: 'swarm-dispatch',
          agentId,
          allowedTools: dispatchAllowedTools,
          authorizedScopes: dispatchAuthorizedScopes,
        });

        const durationMs = Date.now() - execStart;

        // Extract response
        let response = '';
        if (result.messages && result.messages.length > 0) {
          const completionMsg = result.messages.find(m => m.say === 'completion_result' && m.text && m.text.length > 20);
          if (completionMsg) {
            response = completionMsg.text;
          } else {
            const textMsgs = result.messages.filter(m => m.say === 'text' && m.text && m.text.length > 20).map(m => m.text);
            response = textMsgs.join('\n\n') || 'Execution completed.';
          }
        }

        // Resolve actual provider/model from runtime
        const actualProvider = this.currentLLMProvider || 'unknown';
        let actualModel = 'unknown';
        if (actualProvider === 'claude-code' && this.claudeCodeProvider) {
          const info = this.claudeCodeProvider.getModelInfo ? this.claudeCodeProvider.getModelInfo() : {};
          actualModel = info.model || process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6';
        } else if (this.clineProvider) {
          const info = this.clineProvider.getModelInfo ? this.clineProvider.getModelInfo() : {};
          actualModel = info.model || process.env.FORCE_LLM_MODEL || process.env.LLM_MODEL || 'unknown';
        }

        const apiMetrics = result.apiMetrics || {};
        const usage = {
          inputTokens: apiMetrics.totalTokens || 0,
          outputTokens: apiMetrics.outputTokens || 0,
          totalTokens: apiMetrics.totalTokens || 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };

        logger.info(`[swarm-execute] Done — ${durationMs}ms, responseLen=${response.length}, provider=${actualProvider}, model=${actualModel}, cost=${apiMetrics.totalCost || 0}`);

        res.json({
          success: true,
          response,
          usage,
          cost: apiMetrics.totalCost || 0,
          model: actualModel,
          provider: actualProvider,
          durationMs,
          taskId: task.id,
        });
      } catch (error) {
        const durationMs = Date.now() - execStart;
        logger.error(`[swarm-execute] Failed — ${error.message} (${durationMs}ms)`);
        const invalidAuthority = error?.code === 'INVALID_DISPATCH_AUTHORITY';
        res.status(invalidAuthority ? 400 : 500).json({
          success: false,
          error: invalidAuthority ? 'invalid_execution_scope' : error.message,
          durationMs,
        });
      }
    });

    // ── Task endpoints (for workspace/session management) ────────────
    const retiredUnscopedRoute = (_req, res) => res.status(410).json({
      error: 'unscoped legacy task APIs are retired; use authenticated /api/swarm-execute',
    });
    this.app.post('/api/tasks', retiredUnscopedRoute);
    this.app.post('/api/tasks/:taskId/messages', retiredUnscopedRoute);

    // ── Send message (legacy compat for incident pipeline) ───────────
    this.app.post('/api/send-message', retiredUnscopedRoute);
  }

  async registerWithRedis() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      logger.warn('No REDIS_URL — skipping agent heartbeat registration');
      return;
    }

    try {
      const Redis = require('ioredis');
      const redis = new Redis(redisUrl);
      const agentId = process.env.AGENT_ID || process.env.BOT_NAME || 'unknown';
      const botName = process.env.BOT_NAME || 'unknown';
      const capabilities = (process.env.AGENT_CAPABILITIES || '').split(',').filter(Boolean);

      const registration = JSON.stringify({
        agentId,
        name: botName,
        status: 'online',
        provider: this.currentLLMProvider,
        capabilities,
        runtime: 'swarm-node',
        registeredAt: new Date().toISOString(),
      });

      // Register using the same key pattern the swarm controller reads:
      // oshal:runtime-agent:{agentId} — this is what AgentRuntimeRegistryService.listAgentRegistrations() scans.
      const registryKey = `oshal:runtime-agent:${agentId}`;
      await redis.set(registryKey, registration, 'EX', 120);

      logger.info(`Registered with Redis — agentId=${agentId}, bot=${botName}`);

      // Heartbeat every 30s — refresh the oshal:runtime-agent key
      setInterval(async () => {
        try {
          const refreshed = JSON.stringify({
            agentId, name: botName, status: 'online',
            provider: this.currentLLMProvider, capabilities,
            runtime: 'swarm-node', registeredAt: new Date().toISOString(),
          });
          await redis.set(registryKey, refreshed, 'EX', 120);
        } catch (err) {
          logger.warn(`Heartbeat failed: ${err.message}`);
        }
      }, 30_000);

      this.redis = redis;
    } catch (err) {
      logger.warn(`Redis registration failed: ${err.message}`);
    }
  }

  async start() {
    await this.initialize();
    this.setupRoutes();

    const port = parseInt(process.env.PORT || '5000', 10);
    this.app.listen(port, '0.0.0.0', async () => {
      logger.info(`🚀 Swarm node server running on port ${port}`);
      logger.info(`   Bot: ${process.env.BOT_NAME || 'unknown'}`);
      logger.info(`   Agent ID: ${process.env.AGENT_ID || 'unknown'}`);
      logger.info(`   Provider: ${this.currentLLMProvider}`);
      logger.info(`   Workspace: ${process.env.WORKSPACE_DIR || '/app/workspace'}`);

      // Register with Redis for swarm discovery
      await this.registerWithRedis();
    });
  }
}

const server = new SwarmNodeServer();
server.start().catch((err) => {
  console.error('Failed to start swarm node server:', err);
  process.exit(1);
});
