/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): database stores, LLM providers, controllers, MCP services, Plane registration, built-in tools, Plane monitor (initialize() core section)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: construct one authorization-enforcing MCP proxy with the canonical ToolRegistry and reuse it across every consumer.
 */

const TaskStore = require('../stores/TaskStore');
const MessageStore = require('../stores/MessageStore');
const CheckpointStore = require('../stores/CheckpointStore');
const SettingsStore = require('../stores/SettingsStore');
const TaskController = require('../controllers/TaskController');
const MessageController = require('../controllers/MessageController');
const StreamController = require('../controllers/StreamController');
const { registerFileTools } = require('../services/tools/fileTools');
const { registerCLITools } = require('../services/tools/cliTools');
const ScheduleTools = require('../tools/ScheduleTools');
const AnthropicProvider = require('../services/llm/AnthropicProvider');
const BedrockProvider = require('../services/llm/BedrockProvider');
const MCPService = require('../services/MCPService');
const MCPServiceV2 = require('../services/MCPServiceV2');
const PlaneMonitorService = require('../services/PlaneMonitorService');
const PlaneRegistrationService = require('../services/PlaneRegistrationService');
const { UnifiedMCPProxy } = require('./unified-mcp-proxy');
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * @description Initialize database stores, LLM providers (Bedrock/Cline/ClaudeCode/legacy Anthropic), controllers, both MCP services, Plane auto-registration, built-in tools, and the Plane monitor. Mutates the Application instance exactly as the original initialize() body did; throws on fatal errors (caller keeps the original try/catch).
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {Promise<void>}
 */
async function initializeCoreServices(application) {
      // Initialize database
      logger.info('Initializing database...');
      application.taskStore = new TaskStore();
      await application.taskStore.init();

      application.messageStore = new MessageStore(application.taskStore.db);
      await application.messageStore.init();

      application.checkpointStore = new CheckpointStore(application.taskStore.db);
      await application.checkpointStore.init();

      application.settingsStore = new SettingsStore(application.taskStore.db);
      await application.settingsStore.init();

      logger.info('✓ Database initialized');

      // Initialize controllers
      logger.info('Initializing controllers...');
      
      // ═══════════════════════════════════════════════════════════════════
      // PHASE_42: Initialize BOTH LLM providers (Bedrock + Cline CLI)
      // AgenticController will select which one to use based on toggle
      // ═══════════════════════════════════════════════════════════════════
      
      // Initialize Bedrock Provider
      let bedrockProvider = null;
      if (process.env.AWS_ACCESS_KEY_ID) {
        try {
          bedrockProvider = new BedrockProvider({
            region: process.env.AWS_REGION,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            model: config.llm.defaultModel,
            maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '4096'),
            temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.7'),
            useCrossRegionInference: process.env.LLM_USE_CROSS_REGION !== 'false',
          });
          logger.info('✓ BedrockProvider initialized');
        } catch (err) {
          logger.warn(`Failed to initialize BedrockProvider: ${err.message}`);
        }
      }
      
      // Initialize Cline CLI Provider
      // ⭐ PHASE_54: Pass SlashCommandGenerator for in-memory prompt assembly
      const ClineProvider = require('../services/llm/ClineProvider');
      let clineProvider = null;
      try {
        logger.info(`[DEBUG] SlashCommandGenerator available for ClineProvider: ${!!application.slashCommandGenerator}`);
        clineProvider = new ClineProvider({
          timeout: (config.clineAgent && config.clineAgent.timeout) || 300,
          inactivityTimeout: 180,
          model: config.llm.defaultModel,
          clineCommand: process.env.HOME + '/.local/bin/cline',
          slashCommandGenerator: application.slashCommandGenerator, // PHASE_54: Enable layered prompts
        });
        logger.info(`✓ ClineProvider initialized with layered prompt support (layered: ${!!application.slashCommandGenerator})`);
      } catch (err) {
        logger.warn(`Failed to initialize ClineProvider: ${err.message}`);
      }
      
      // ⭐ PHASE_48 Issue #049 FIX: Store clineProvider as instance variable
      // so route handlers can access it via application.clineProvider
      application.clineProvider = clineProvider;

      // ═══════════════════════════════════════════════════════════════════
      // PHASE_10: Initialize Claude Code CLI Provider (default when available)
      // Uses `claude` binary directly — auth via ~/.claude/ or ANTHROPIC_API_KEY
      // ═══════════════════════════════════════════════════════════════════
      const ClaudeCodeProvider = require('../services/llm/ClaudeCodeProvider');
      let claudeCodeProvider = null;
      try {
        claudeCodeProvider = new ClaudeCodeProvider({
          model: process.env.CLAUDE_CODE_MODEL || 'sonnet',
          claudeCommand: process.env.CLAUDE_CLI_PATH || '/usr/local/bin/claude',
        });
        // Test if claude binary is actually available
        const claudeAvailable = await claudeCodeProvider.testConnection();
        if (claudeAvailable) {
          logger.info('✓ ClaudeCodeProvider initialized and authenticated');
        } else {
          logger.warn('ClaudeCodeProvider: claude CLI not available or not authenticated — falling back');
          claudeCodeProvider = null;
        }
      } catch (err) {
        logger.warn(`Failed to initialize ClaudeCodeProvider: ${err.message}`);
        claudeCodeProvider = null;
      }
      application.claudeCodeProvider = claudeCodeProvider;

      // Legacy support: if neither provider available, try Anthropic
      let legacyProvider = null;
      if (!bedrockProvider && !clineProvider && process.env.ANTHROPIC_API_KEY) {
        try {
          legacyProvider = new AnthropicProvider({
            apiKey: process.env.ANTHROPIC_API_KEY,
            model: process.env.LLM_MODEL || 'claude-3-5-sonnet-20241022',
            maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '4096'),
            temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.7'),
          });
          logger.info('✓ AnthropicProvider initialized (legacy fallback)');
        } catch (err) {
          logger.warn(`Failed to initialize AnthropicProvider: ${err.message}`);
        }
      }
      
      if (!bedrockProvider && !clineProvider && !claudeCodeProvider && !legacyProvider) {
        logger.warn('No LLM providers available - LLM responses disabled');
      }
      
      application.streamController = new StreamController();
      application.streamController.initializeSocketIO(application.io);

      // Store provider toggle state
      // PHASE_10: Claude Code CLI is the preferred default when available.
      // Falls back to cline-cli, then bedrock.
      // MANDATORY: Default agent provider is ALWAYS cline-cli (per oshal-agent-provider-rules.md)
      // Bedrock agent path remains intact for rollback but is NEVER the default
      application.currentLLMProvider = clineProvider ? 'cline-cli' : (claudeCodeProvider ? 'claude-code' : 'cline-cli');
      logger.info(`[PHASE_10] Default LLM provider: ${application.currentLLMProvider} (claude-code: ${!!claudeCodeProvider}, cline: ${!!clineProvider}, bedrock: ${!!bedrockProvider})`);
      
      // ⭐ PHASE_48 Issue #049 FIX: Store bedrockProvider as instance variable too
      application.bedrockProvider = bedrockProvider || legacyProvider;
      
      application.taskController = new TaskController(
        application.taskStore,
        application.messageStore,
        application.checkpointStore,
        bedrockProvider || legacyProvider, // Legacy llmService for backward compatibility
        null,  // MCP service (Phase 5)
        application.streamController,  // Stream controller for real-time updates
        application.toolRegistry  // Tool registry for agentic mode
      );
      
      // ═══════════════════════════════════════════════════════════════════
      // PHASE_42: Wire both providers to AgenticController
      // PHASE_54: Always create AgenticController if we have ANY provider
      // Don't check if it already exists - TaskController may not have created it
      // ═══════════════════════════════════════════════════════════════════
      if (bedrockProvider || clineProvider || claudeCodeProvider) {
        // Always create AgenticController when we have a provider
        const AgenticController = require('../controllers/AgenticController');
        application.taskController.agenticController = new AgenticController(
          {
            bedrockProvider: bedrockProvider || legacyProvider,
            clineProvider: clineProvider,
            claudeCodeProvider: claudeCodeProvider,
            getCurrentProvider: () => application.currentLLMProvider,
          },
          application.toolRegistry,
          application.streamController,
          application.taskController
        );
        logger.info(`✓ AgenticController initialized with providers (claude-code: ${!!claudeCodeProvider}, cline: ${!!clineProvider}, bedrock: ${!!bedrockProvider})`);
        logger.info(`[DEBUG] AgenticController exists: ${!!application.taskController.agenticController}`);
      }

      application.messageController = new MessageController(application.messageStore);

      logger.info('✓ Controllers initialized');

      // Initialize MCP service for HTTP-based servers (Google search)
      logger.info('Initializing HTTP-based MCP service...');
      application.mcpServiceHTTP = new MCPService(config, application.toolRegistry);
      try {
        await application.mcpServiceHTTP.initialize();
        logger.info('✓ HTTP MCP service initialized');
      } catch (err) {
        logger.warn(`HTTP MCP service initialization failed: ${err.message}`);
      }

      // Initialize MCP Service V2 for stdio-based servers (context7, filesystem, etc.)
      // Skip on provisioned bots where npx/stdio binaries are not available
      if (process.env.ENABLE_STDIO_MCP_SERVERS === 'false') {
        logger.info('ℹ️  Stdio MCP servers SKIPPED (ENABLE_STDIO_MCP_SERVERS=false — provisioned bot)');
        application.mcpService = null;
      } else {
        logger.info('Initializing stdio-based MCP Service V2...');
        application.mcpService = new MCPServiceV2(config, application.toolRegistry);
        
        // Initialize with timeout protection (won't block if servers fail)
        try {
          await Promise.race([
            application.mcpService.initialize(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('MCP Service V2 initialization timeout')), 30000)
            )
          ]);
          logger.info('✓ MCP Service V2 initialized (stdio-based servers)');
        } catch (err) {
          logger.warn(`MCP Service V2 initialization timeout/error: ${err.message}`);
          logger.warn('Continuing with limited MCP functionality...');
        }
      }
      
      // One proxy owns the authorization seam for both transports. No consumer receives a
      // transport-level execute method.
      application.mcpProxy = new UnifiedMCPProxy(
        application.mcpService,
        application.mcpServiceHTTP,
        application.toolRegistry,
      );
      application.taskController.mcp = application.mcpProxy;

      // Initialize Plane Registration (if enabled)
      if (config.plane?.enabled) {
        logger.info('Initializing Plane Auto-Registration...');
        application.planeRegistrationService = new PlaneRegistrationService(application.mcpProxy, config);
        const planeResult = await application.planeRegistrationService.initialize();
        
        if (planeResult.success) {
          logger.info('✅ Plane Auto-Registration complete');
        } else if (planeResult.enabled) {
          logger.warn('⚠️  Plane Auto-Registration failed - continuing with reduced functionality');
        } else {
          logger.info('ℹ️  Plane integration disabled');
        }
      } else {
        logger.info('ℹ️  Plane integration disabled (USE_PLANE not set)');
      }

      // Register built-in tools
      logger.info('Registering built-in tools...');
      registerFileTools(application.toolRegistry);
      registerCLITools(application.toolRegistry);
      
      // Register schedule tools
      const scheduleTools = new ScheduleTools(application.toolRegistry);
      scheduleTools.registerAll();
      
      // Link tool registry to task controller
      application.toolRegistry.getAll().forEach((tool) => {
        application.taskController.registerTool(tool.name, tool.handler, {
          description: tool.description,
          requiresApproval: tool.requiresApproval,
          inputSchema: tool.inputSchema,
        });
      });

      logger.info('✓ Tools registered (built-in + MCP)');

      // Initialize Plane Monitor Service (Sprint 0) - INDEPENDENT OF MCP
      if (config.planeMonitor.enabled) {
        logger.info('Initializing Plane Monitor Service...');
        
        // Start PlaneMonitorService independently, don't wait for MCP
        setTimeout(async () => {
          try {
            const independentMCP = application.mcpService || {
              executeTool: async (server, tool, args) => {
                logger.info(`PlaneMonitor: Would execute ${server}/${tool}`);
                return { results: [] };
              },
              getServerTools: () => ['list_work_items', 'add_comment']
            };
            
            application.planeMonitorService = new PlaneMonitorService(
              application.taskController, 
              process.env
            );
            
            await application.planeMonitorService.start();
            logger.info('✓ Plane Monitor Service started INDEPENDENTLY');
          } catch (err) {
            logger.warn(`Plane Monitor Service independent start failed: ${err.message}`);
          }
        }, 5000); // Start after 5 seconds, don't block app initialization
        
        logger.info('✓ Plane Monitor Service scheduled for independent startup');
      } else {
        logger.info('Plane Monitor Service disabled (ENABLE_PLANE_MONITORING != true)');
      }
}

module.exports = { initializeCoreServices };
