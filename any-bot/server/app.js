/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: rebranded legacy "Kevin" agent identity/namespace to neutral OSHAL
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Leak fix: /api/redis-visibility and /api/qm/activity disconnect their per-request ioredis clients in finally — error paths previously abandoned clients that reconnected forever (2026-07-05 leak audit)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed for the 1000-code-line cap: startup sequences + route registrations extracted to app-modules/* with identical behavior and registration order; /api/swarm-execute kept inline (tests/unit/live-weather-email-wiring.spec.ts asserts on this file's source)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-119 P4 (A2): registered routes-self-heal (POST /api/self-heal/apply — the deterministic, fail-closed remediation endpoint the controller's auto-apply engine calls; role-gated to the self-healing node, appended after the existing registrations so the order contract is untouched)
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact bot owners and canonicalize untrusted HTTP workspace IDs before owner lookup or TaskController creation; invalid identity/path assertions now fail closed.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: require service authentication before every non-health HTTP/static request and Socket.IO upgrade, fail startup closed when unconfigured, and require exact dispatch tool/scope grants.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 credential containment: reject generic credential carriers on the legacy execute route and propagate only the exact caller identity. Deterministic provider intents remain exclusive to the canonical bot-node runtime.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: carry the controller-authenticated agent identity into request-scoped MCP capability enforcement.
 */

/**
 * Main Application Server
 * Integrates all Phase 1 components with Express + Socket.IO
 *
 * Decomposition note (2026-07-11): the startup sequence and route registrations
 * live in ./app-modules/*. This file remains the runtime entrypoint
 * (`node any-bot/server/app.js`) and composes the modules in the exact original
 * order — Express route registration ORDER is part of the API contract.
 */

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const { createServer } = require('http');
const { Server: SocketIOServer } = require('socket.io');
const path = require('path');
const selfHealTestEndpoint = require('./services/SelfHealTestEndpoint');
const {
  assertServiceSecretConfigured,
  authorizeAnyBotRequest,
  authorizeSwarmExecute,
  validServiceSecret,
} = require('./services/codebase/swarm-execute-auth');
const { optionalExactUserSubject } = require('./services/codebase/exact-user-subject');
const { canonicalWorkspaceId } = require('./services/codebase/task-workspace-scope');
const { requireDispatchAuthorityList } = require('./utils/dispatch-capabilities');
const { assertUnattendedProviderSelection } = require('./services/llm/assert-cli-tool-boundary');

// Utils
const logger = require('./utils/logger');
const config = require('./utils/config');

// Services constructed directly by the Application shell
const ToolRegistry = require('./services/ToolRegistry');

/** True for identity, ownership, or containment errors that must never trigger fallback work. */
function isTaskBoundaryError(error) {
  return Boolean(error && ['TASK_OWNER_MISMATCH', 'UNSAFE_TASK_WORKSPACE', 'INVALID_USER_SUBJECT',
    'INVALID_DISPATCH_AUTHORITY']
    .includes(String(error.code || '')));
}

/** Build a stable containment error when TaskController violates the canonical ID contract. */
function unsafeTaskBoundaryError() {
  const error = new Error('TaskController returned a non-canonical workspace id');
  error.code = 'UNSAFE_TASK_WORKSPACE';
  return error;
}

/** Map boundary errors without exposing stack or subject/path content. */
function taskBoundaryResponse(error) {
  if (!isTaskBoundaryError(error)) return null;
  if (error.code === 'TASK_OWNER_MISMATCH') return { status: 403, code: 'task_owner_mismatch' };
  return { status: 400, code: 'invalid_execution_scope' };
}

// Startup-sequence modules (extracted from initialize(); call order preserved)
const {
  logProviderStartupConfig,
  ensureWorkspaceSymlink,
  setupClineCli,
  initSlashCommandGenerator,
} = require('./app-modules/startup-environment');
const { initializeCoreServices } = require('./app-modules/startup-core-services');
const { initializeSwarmRuntime } = require('./app-modules/startup-swarm-runtime');

// Route-registration modules (extracted from setupRoutes(); the call order in
// setupRoutes() below preserves the original Express registration order exactly)
const { registerWorkspaceAndStaticRoutes } = require('./app-modules/routes-workspace-static');
const { registerProcessTicketRoute } = require('./app-modules/routes-process-ticket');
const { registerTaskAndCheckpointRoutes } = require('./app-modules/routes-tasks-checkpoints');
const { registerLlmSettingsAndStreamRoutes } = require('./app-modules/routes-llm-settings-stream');
const { registerAgentAndProvisioningRoutes } = require('./app-modules/routes-agents-provisioning');
const { registerMeshChannelRoutes, registerMeshUiRoutes } = require('./app-modules/routes-mesh');
const { registerMcpVoiceAndQueueRoutes } = require('./app-modules/routes-mcp-voice-queue');
const {
  registerUiAndPlaneConfigRoutes,
  registerConfigAndTaskExplorerRoutes,
} = require('./app-modules/routes-pages-config-explorer');
const { registerOpsObservabilityRoutes } = require('./app-modules/routes-ops-observability');
const { registerTicketChatRoutes } = require('./app-modules/routes-ticket-chat');
const { registerSelfHealApplyRoutes } = require('./app-modules/routes-self-heal');

class Application {
  constructor() {
    this.app = express();
    // Register the blanket gate before any route or static middleware can be mounted.
    this.app.use(authorizeAnyBotRequest);
    this.server = createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      // Socket.IO upgrades bypass Express middleware. Require the same service credential
      // at the transport boundary and do not advertise wildcard cross-origin access.
      allowRequest: (req, callback) => callback(null, validServiceSecret(req)),
    });

    // Initialize stores
    this.taskStore = null;
    this.messageStore = null;
    this.checkpointStore = null;
    this.settingsStore = null;

    // Initialize controllers
    this.taskController = null;
    this.messageController = null;
    this.streamController = null;

    // Initialize services
    this.toolRegistry = new ToolRegistry();
    this.mcpService = null;
    this.mcpServiceHTTP = null; // For HTTP-based MCP servers like Google search

    this.initialized = false;
  }

  /**
   * Initialize database and all components
   */
  async initialize() {
    assertServiceSecretConfigured();
    logger.info('========================================');
    logger.info('  Initializing Application');
    logger.info('========================================');

    // PHASE_54: LLM provider/model startup log (app-modules/startup-environment)
    logProviderStartupConfig();

    // PHASE_54 SESSION_10: /app/workspace → /home/node/workspace symlink fix
    ensureWorkspaceSymlink();

    // PHASE_15: Cline CLI symlink + GovCloud patch + auth config
    await setupClineCli(this);

    // PHASE_54: Initialize SlashCommandGenerator FIRST (before database init)
    await initSlashCommandGenerator(this);

    try {
      // Database stores, LLM providers, controllers, MCP services, tools, Plane monitor
      await initializeCoreServices(this);

      // Queue Manager / agent-swarm registration / heartbeats / SelfHealingScheduler
      await initializeSwarmRuntime(this);

      // Setup routes
      this.setupRoutes();

      // ═══════════════════════════════════════════════════════════
      // PHASE_17: SelfHealable Contract — every bot gets /api/selfheal/test
      // The self-healing code deploy bot calls this to verify fixes work.
      // Default tests: health, tool registry, no crashes, memory, event loop.
      // Bots can register custom tests via selfHealTestEndpoint.registerTest().
      // ═══════════════════════════════════════════════════════════
      try {
        selfHealTestEndpoint.initialize(this.app, this.toolRegistry);
        logger.info('✓ SelfHealable test endpoint registered');
      } catch (healErr) {
        logger.warn(`SelfHealable endpoint setup failed: ${healErr.message}`);
      }

      logger.info('✓ All routes configured');

      this.initialized = true;

      logger.info('========================================');
      logger.info('  Application Initialized Successfully');
      logger.info('========================================');
      logger.info(JSON.stringify(config.getSummary(), null, 2));
      logger.info('========================================');

    } catch (err) {
      logger.error(`Application initialization failed: ${err.message}`);
      logger.error(err.stack);
      throw err;
    }
  }

  /**
   * Setup Express routes
   *
   * Route registration ORDER is part of the API contract. The register* calls
   * below replay the original inline registrations in their exact order;
   * /api/swarm-execute stays inline in this file (its source is asserted by
   * tests/unit/live-weather-email-wiring.spec.ts).
   */
  setupRoutes() {
    registerWorkspaceAndStaticRoutes(this);

    registerProcessTicketRoute(this);

    // ═══════════════════════════════════════════════════════════════════
    // OSHAL SWARM EXECUTE — called by the swarm controller to dispatch
    // work to this bot node. The swarm assembles the full prompt (persona
    // layers, handovers, awareness, phase prompts). The any-bot handles
    // provider resolution, CLI spawning, credential management, and cost
    // capture. This is the correct architecture boundary per
    // any-bot-swarm-separation-design.md.
    // ═══════════════════════════════════════════════════════════════════
    this.app.post('/api/swarm-execute', authorizeSwarmExecute, async (req, res) => {
      const execStart = Date.now();
      try {
        const {
          text,               // Full assembled prompt from swarm execution handler
          taskId,             // Per-bot task ID (e.g. "ticketId::agentId")
          workspaceFolderId,  // Shared workspace folder (e.g. ticket external ID)
          agentId,            // Bot identity UUID
          agenticMode = true, // Whether to use multi-turn agentic loop
          direct = false,     // Interactive answer: require a real final response
          providerId,         // Optional: override provider for this execution
          model,              // Optional: override model for this execution
          userSub,            // Authenticated caller identity for workspace/tool scoping
          byoLlmConnection,   // Per-request OpenAI-compatible endpoint/key/model
          providerIntent,     // TS bot-node only: legacy runtime must fail closed
          allowedTools,       // Controller-issued exact runtime tool names
          authorizedScopes,   // Controller-issued exact operation scopes
        } = req.body;

        if (!text) {
          return res.status(400).json({ success: false, error: 'text is required' });
        }
        if (providerIntent !== undefined) {
          return res.status(409).json({
            success: false,
            error: 'trusted provider intents require the canonical bot-node runtime',
          });
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'creds')) {
          return res.status(400).json({
            success: false,
            error: 'connector credentials require a canonical deterministic provider intent',
          });
        }
        const dispatchAllowedTools = requireDispatchAuthorityList(allowedTools, 'allowedTools', 256);
        const dispatchAuthorizedScopes = requireDispatchAuthorityList(
          authorizedScopes, 'authorizedScopes', 512,
        );

        const taskController = this.taskController;
        if (!taskController) {
          return res.status(503).json({ success: false, error: 'TaskController not initialized' });
        }

        const scopedUserSub = optionalExactUserSubject(userSub, 'swarm-execute userSub');
        const hasByoRequest = byoLlmConnection !== undefined && byoLlmConnection !== null;
        const requestedByo = byoLlmConnection && typeof byoLlmConnection === 'object'
          && typeof byoLlmConnection.baseUrl === 'string'
          && /^https?:\/\//i.test(byoLlmConnection.baseUrl)
          && typeof byoLlmConnection.apiKey === 'string'
          && byoLlmConnection.apiKey.length > 0
          && typeof byoLlmConnection.model === 'string'
          && byoLlmConnection.model.trim().length > 0
          ? {
              baseUrl: byoLlmConnection.baseUrl,
              apiKey: byoLlmConnection.apiKey,
              model: byoLlmConnection.model,
            }
          : undefined;
        if (hasByoRequest && !requestedByo) {
          return res.status(400).json({ success: false, error: 'invalid byoLlmConnection' });
        }
        // The model/tool runtime receives identity only. Connector material belongs to a
        // schema-bounded server-side provider handler, which this legacy runtime does not host.
        const extraEnv = scopedUserSub === undefined ? undefined : { OSHAL_USER_SUB: scopedUserSub };

        const logicalWorkspaceId = workspaceFolderId !== undefined
          ? workspaceFolderId
          : taskId !== undefined ? taskId : `swarm-${crypto.randomUUID()}`;
        const effectiveTaskId = canonicalWorkspaceId(logicalWorkspaceId);
        logger.info(`[swarm-execute] Received task from swarm — taskId=${effectiveTaskId}, agentId=${agentId}, textLen=${text.length}`);

        // If provider/model override requested, switch before executing
        if (providerId) {
          try {
            const LLMProviderRegistry = require('./services/llm/LLMProviderRegistry');
            const providerInfo = LLMProviderRegistry.getProvider(providerId);
            if (providerInfo) {
              logger.info(`[swarm-execute] Switching provider to ${providerId}${model ? '/' + model : ''} for this execution`);
              // The provider switch is handled internally by the any-bot
              // For now we set env hints that the agentic controller reads
              if (model) process.env.CLAUDE_CODE_MODEL = model;
            }
          } catch (provErr) {
            logger.warn(`[swarm-execute] Provider switch failed (non-fatal): ${provErr.message}`);
          }
        }

        assertUnattendedProviderSelection(
          this.currentLLMProvider || process.env.LLM_PROVIDER,
          { byoHostedInference: Boolean(requestedByo) },
        );

        // Resolve or create task for workspace isolation
        let task;
        try {
          task = await taskController.getTask(effectiveTaskId);
          if (task) {
            taskController.assertTaskOwner(task, scopedUserSub);
          } else {
            task = await taskController.createTask(
              `Swarm execution for ${agentId}`, 'act',
              { forceTaskId: effectiveTaskId, userSub: scopedUserSub }
            );
            if (task.id !== effectiveTaskId) throw unsafeTaskBoundaryError();
          }
        } catch (taskErr) {
          if (isTaskBoundaryError(taskErr)) throw taskErr;
          task = await taskController.createTask(
            `Swarm execution for ${agentId}`, 'act', { userSub: scopedUserSub }
          );
        }

        // Execute via TaskController — this routes through the any-bot's
        // own provider stack (ClineProvider, ClaudeCodeProvider, BedrockProvider)
        // which handles credential management, CLI spawning, and token capture.
        const result = await taskController.processMessage(task.id, {
          text,
        }, {
          agenticMode,
          autoApprove: {},
          source: 'swarm-dispatch',
          agentId,
          allowedTools: dispatchAllowedTools,
          authorizedScopes: dispatchAuthorizedScopes,
          byoLlmConnection: requestedByo,
          extraEnv,
        });

        const durationMs = Date.now() - execStart;

        // Extract response text — same extraction pattern as /api/process-ticket
        let response = '';
        if (result.messages && result.messages.length > 0) {
          const completionMsgs = result.messages.filter(msg =>
            msg.say === 'completion_result' && msg.text && msg.text.trim().length > 0
          );
          if (completionMsgs.length > 0) {
            response = completionMsgs[completionMsgs.length - 1].text;
          } else {
            const textMsgs = result.messages
              .filter(m => m.say === 'text' && m.text && m.text.trim().length > 0)
              .map(m => m.text);
            response = textMsgs.length > 0 ? textMsgs[textMsgs.length - 1] : '';
          }
        }
        if (!response && direct) throw new Error('Bot execution returned no final answer');
        if (!response) response = 'Execution completed.';

        // Extract usage/cost metrics from the result
        const apiMetrics = result.apiMetrics || {};
        const usage = {
          inputTokens: apiMetrics.inputTokens || apiMetrics.totalTokens || 0,
          outputTokens: apiMetrics.outputTokens || 0,
          totalTokens: apiMetrics.totalTokens || 0,
          cacheReadTokens: apiMetrics.cacheReads || 0,
          cacheWriteTokens: apiMetrics.cacheCreationTokens || 0,
        };

        // Resolve the ACTUAL provider and model from the any-bot's runtime state.
        // apiMetrics does NOT contain provider/model — those live in the runtime.
        const configuredProvider = this.currentLLMProvider || process.env.LLM_PROVIDER || 'unknown';
        const actualProvider = requestedByo ? 'byo-llm' : configuredProvider;
        let actualModel = requestedByo?.model || 'unknown';
        if (!requestedByo && actualProvider === 'claude-code' && this.claudeCodeProvider) {
          const info = this.claudeCodeProvider.getModelInfo ? this.claudeCodeProvider.getModelInfo() : {};
          actualModel = info.model || process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6';
        } else if (!requestedByo && this.clineProvider) {
          const info = this.clineProvider.getModelInfo ? this.clineProvider.getModelInfo() : {};
          actualModel = info.model || process.env.FORCE_LLM_MODEL || process.env.LLM_MODEL || 'unknown';
        }

        logger.info(`[swarm-execute] Completed — taskId=${taskId}, durationMs=${durationMs}, responseLen=${response.length}, cost=${apiMetrics.totalCost || 0}, provider=${actualProvider}, model=${actualModel}`);

        res.json({
          success: true,
          response,
          usage,
          cost: apiMetrics.totalCost || 0,
          model: actualModel,
          provider: actualProvider,
          durationMs,
          taskId: task.id,
          providerRecords: Array.isArray(result.providerRecords) ? result.providerRecords : [],
        });
      } catch (error) {
        const durationMs = Date.now() - execStart;
        logger.error(`[swarm-execute] Failed — ${error.message} (${durationMs}ms)`);
        const boundary = taskBoundaryResponse(error);
        res.status(boundary?.status || 500).json({
          success: false,
          error: boundary?.code || error.message,
          durationMs,
        });
      }
    });

    registerTaskAndCheckpointRoutes(this);

    registerLlmSettingsAndStreamRoutes(this);

    registerAgentAndProvisioningRoutes(this);

    registerMeshChannelRoutes(this);

    registerMcpVoiceAndQueueRoutes(this);

    registerUiAndPlaneConfigRoutes(this);

    registerMeshUiRoutes(this);

    registerConfigAndTaskExplorerRoutes(this);

    registerOpsObservabilityRoutes(this);

    registerTicketChatRoutes(this);

    // ADR-119 P4 (A2): deterministic self-heal apply endpoint (fail-closed, role-gated).
    registerSelfHealApplyRoutes(this);
  }

  /**
   * Start the server
   */
  async start(port = null) {
    if (!this.initialized) {
      await this.initialize();
    }

    const serverPort = port || config.server.port;

    return new Promise((resolve) => {
      this.server.listen(serverPort, config.server.host, () => {
        logger.info('========================================');
        logger.info(`🚀 Server started on port ${serverPort}`);
        logger.info(`🌐 Dashboard: http://localhost:${serverPort}/dashboard`);
        logger.info(`📡 API Health: http://localhost:${serverPort}/api/health`);
        logger.info(`🔌 WebSocket: ws://localhost:${serverPort}`);
        logger.info(`📊 SSE: http://localhost:${serverPort}/api/stream?taskId=<id>`);
        logger.info('========================================');
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  async stop() {
    logger.info('Stopping server...');

    // Deregister agent if in swarm mode
    if (this.agentBootstrap) {
      await this.agentBootstrap.shutdown();
    }

    // Shutdown MCP services
    if (this.mcpServiceHTTP) {
      await this.mcpServiceHTTP.shutdown();
    }
    if (this.mcpService) {
      await this.mcpService.shutdown();
    }

    // Close database
    if (this.taskStore) {
      await this.taskStore.close();
    }

    // Close server
    return new Promise((resolve) => {
      this.server.close(() => {
        logger.info('Server stopped');
        resolve();
      });
    });
  }
}

module.exports = Application;

// Run server if executed directly
if (require.main === module) {
  const app = new Application();
  
  app.start().catch((err) => {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await app.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await app.stop();
    process.exit(0);
  });
}
