/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): ADR-034 config-change broadcast, PHASE_42/61/62 LLM provider API, settings, SSE streams, MCP server/tool status
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: reject credential fields before provider mutation, stop writing secrets to Cline files, and persist provider/model/timeout metadata only.
 */

const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * @description Broadcast a locally-originated bot config change up to the OSHAL controller
 * on the swarm.config-change mesh channel (ADR-034). OSHAL subscribes and reconciles the
 * change into the authoritative per-agent record, so OSHAL stays the system-of-record even
 * when a change originates at the bot (its own UI) or at a sub-swarm this bot owns.
 *
 * Best-effort and non-fatal: a broadcast failure is logged at ERROR but never blocks the
 * config change itself (the bot still works standalone). The wire format matches
 * RedisMeshTransport.publish so the TS controller consumes it without coupling.
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
      payload: { agentId, params, source },
      messageType: 'broadcast',
    };
    await redisClient.xadd(
      'oshal:mesh:swarm.config-change', 'MAXLEN', '~', '10000', '*',
      'data', JSON.stringify(envelope),
    );
    logger.info(`[ADR-034] Broadcast config change up for ${agentId} (${params.providerId || '-'}/${params.modelId || '-'}) source=${source}`);
  } catch (err) {
    logger.error(`[ADR-034] Failed to broadcast config change for ${agentId}: ${err.message}`);
  }
}

/**
 * @description LLM provider registry/get/put/test routes (PHASE_42/61/62 incl. Redis persistence + ADR-034 broadcast-up), settings get/put, task SSE + session streaming endpoints, and MCP server/tool status routes.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerLlmSettingsAndStreamRoutes(application) {
    // Get settings
    // ═══════════════════════════════════════════════════════════════════
    // PHASE_42: LLM Provider Toggle (Bedrock vs Cline CLI)
    // Updates Application.currentLLMProvider which AgenticController reads
    // ═══════════════════════════════════════════════════════════════════
    // ⭐ PHASE_61: LLM Provider Registry — returns all providers + models for UI dropdowns
    application.app.get('/api/llm-provider/registry', (req, res) => {
      try {
        const registry = require('../services/llm/LLMProviderRegistry');
        res.json({
          providers: registry.PROVIDERS,
          count: Object.keys(registry.PROVIDERS).length,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ⭐ PHASE_61/62: Enhanced LLM Provider API — model, timeout, test connection, persist to Redis
    application.app.get('/api/llm-provider', async (req, res) => {
      // Load persisted config from Redis if available (per-bot key)
      let persistedConfig = {};
      if (application.redisClient) {
        try {
          const agentId = process.env.AGENT_ID || 'any-bot';
          const raw = await application.redisClient.get(`config:llm-provider:${agentId}`);
          if (raw) persistedConfig = JSON.parse(raw);
        } catch (e) { /* ignore */ }
      }
      // ⭐ PHASE_62: Fall back to in-memory last-saved provider (works without Redis)
      // Returns the raw LLM provider (e.g. 'gemini'), NOT the agenticProvider mapping ('cline-cli')
      const effectiveProvider = persistedConfig.provider || application._lastSavedProvider || application.currentLLMProvider;
      const effectiveModel = persistedConfig.model || application._lastSavedModel || process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929';
      res.json({ 
        provider: effectiveProvider,
        model: effectiveModel,
        timeout: persistedConfig.timeout || (application.clineProvider?.config?.timeout) || 300,
        available: {
          bedrock: !!application.taskController.agenticController?.bedrockProvider,
          'cline-cli': !!application.taskController.agenticController?.clineProvider,
        },
        availableModels: {
          govcloud: [
            'claude-sonnet-4-5-20250929',
            'anthropic.claude-3-7-sonnet-20250219-v1:0',
            'anthropic.claude-3-5-haiku-20241022-v1:0',
          ],
          standard: [
            'claude-sonnet-4-5-20250929',
            'anthropic.claude-3-7-sonnet-20250219-v1:0',
            'anthropic.claude-3-5-haiku-20241022-v1:0',
          ],
        },
      });
    });

    application.app.put('/api/llm-provider', async (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Request body must be an object' });
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'credentials')) {
        return res.status(400).json({
          error: 'credential fields are not accepted on runtime configuration mutations',
        });
      }
      const { provider, model, timeout } = req.body;
      
      // ⭐ PHASE_62: Accept all 22 providers from the registry
      const validProviders = [
        'bedrock', 'anthropic', 'openrouter', 'openai', 'openai-native', 'ollama', 'lmstudio',
        'gemini', 'vertex', 'azure', 'mistral', 'deepseek', 'xai', 'groq',
        'together', 'fireworks', 'cerebras', 'sambanova', 'nebius', 'asksage', 'litellm', 'requesty',
        'cline-cli',
      ];
      if (!provider || !validProviders.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider. Use one of: ${validProviders.join(', ')}` });
      }
      
      // Update application-level provider state
      // Map non-bedrock providers to 'cline-cli' for AgenticController routing
      // (Cline CLI handles all providers via its own config)
      let agenticProvider = 'cline-cli';
      if (provider === 'bedrock') agenticProvider = 'bedrock';
      if (provider === 'claude-code') agenticProvider = 'claude-code';
      
      application.currentLLMProvider = agenticProvider;
      
      // Also update TaskController's legacy toggle for backward compatibility
      application.taskController.setLLMProvider(agenticProvider);
      
      // Apply model to ClineProvider if provided
      if (model && application.clineProvider && agenticProvider === 'cline-cli') {
        application.clineProvider.config.model = model;
        if (application.clineProvider.wrapper) {
          application.clineProvider.wrapper._lastModel = model;
        }
        logger.info(`[PHASE_61] ClineProvider model updated to: ${model}`);
      }
      
      // Apply timeout to ClineProvider if provided
      if (timeout && application.clineProvider && agenticProvider === 'cline-cli') {
        const timeoutNum = parseInt(timeout);
        if (timeoutNum >= 30 && timeoutNum <= 300) {
          application.clineProvider.config.timeout = timeoutNum;
          application.clineProvider.wrapper.defaultTimeout = timeoutNum;
          logger.info(`[PHASE_61] ClineProvider timeout updated to: ${timeoutNum}s`);
        }
      }

      // Apply model to ClaudeCodeProvider if provided
      if (model && application.claudeCodeProvider && agenticProvider === 'claude-code') {
        application.claudeCodeProvider.config.model = model;
        if (application.claudeCodeProvider.wrapper) {
          application.claudeCodeProvider.wrapper.defaultModel = model;
        }
        logger.info(`[PHASE_10] ClaudeCodeProvider model updated to: ${model}`);
      }

      // Apply timeout to ClaudeCodeProvider if provided
      if (timeout && application.claudeCodeProvider && agenticProvider === 'claude-code') {
        const timeoutNum = parseInt(timeout);
        if (timeoutNum >= 30 && timeoutNum <= 300) {
          application.claudeCodeProvider.config.timeout = timeoutNum;
          application.claudeCodeProvider.wrapper.defaultTimeout = timeoutNum;
          logger.info(`[PHASE_10] ClaudeCodeProvider timeout updated to: ${timeoutNum}s`);
        }
      }
      
      // ⭐ PHASE_61: Write ~/.cline/config.json using LLMProviderRegistry
      // This makes Cline CLI use the selected provider for all subsequent invocations
      try {
        const registry = require('../services/llm/LLMProviderRegistry');
        const clineConfig = registry.buildClineConfig(provider, model);
        const globalState = registry.buildGlobalState(provider, model);
        
        if (clineConfig) {
          const fs = require('fs');
          const homeDir = process.env.HOME || '/home/node';
          const clineDir = `${homeDir}/.cline`;
          const dataDir = `${clineDir}/data`;
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(`${clineDir}/config.json`, JSON.stringify(clineConfig, null, 2));
          fs.writeFileSync(`${dataDir}/globalState.json`, JSON.stringify(globalState, null, 2));
          logger.info(`[PHASE_61] ✅ Cline CLI config updated for provider: ${provider} / ${model}`);
        }
      } catch (configErr) {
        logger.warn(`[PHASE_61] Failed to write Cline CLI config: ${configErr.message}`);
      }
      
      // ⭐ PHASE_62: Persist full config to Redis (per-bot key, survives container restarts)
      if (application.redisClient) {
        try {
          const agentId = process.env.AGENT_ID || 'any-bot';
          const configToSave = {
            provider,
            model: model || application.clineProvider?.config?.model || process.env.LLM_MODEL,
            timeout: timeout ? parseInt(timeout) : (application.clineProvider?.config?.timeout || 300),
            updatedAt: new Date().toISOString(),
          };
          await application.redisClient.set(`config:llm-provider:${agentId}`, JSON.stringify(configToSave));
          logger.info(`[PHASE_62] LLM provider config persisted to Redis for ${agentId}`);
        } catch (redisErr) {
          logger.warn(`[PHASE_62] Failed to persist provider config: ${redisErr.message}`);
        }
      }
      // ⭐ PHASE_62: Store last-saved provider in memory (fallback when Redis unavailable)
      application._lastSavedProvider = provider;
      application._lastSavedModel = model || application.clineProvider?.config?.model || process.env.LLM_MODEL;

      // ADR-034: broadcast this change up to the OSHAL controller so it reconciles into the
      // authoritative record — UNLESS this change originated from an OSHAL push-down
      // (X-Config-Source: oshal-push). That guard prevents an echo loop where OSHAL's push
      // would bounce straight back as a broadcast-up.
      if (req.get('X-Config-Source') !== 'oshal-push') {
        const broadcastAgentId = process.env.AGENT_ID || 'any-bot';
        await broadcastConfigChange(
          application.redisClient,
          broadcastAgentId,
          { providerId: provider, modelId: model || application._lastSavedModel },
          'bot-local',
        );
      }

      logger.info(`[PHASE_62] LLM provider switched to: ${provider} / ${model || 'default'} (agenticProvider: ${agenticProvider}, timeout: ${timeout || 'unchanged'})`);
      
      res.json({ 
        provider,
        agenticProvider,
        model: model || application.clineProvider?.config?.model,
        timeout: timeout ? parseInt(timeout) : application.clineProvider?.config?.timeout,
        active: true,
        message: `Provider switched to ${provider} (${model || 'default model'}). Cline CLI config updated.`
      });
    });

    // ⭐ PHASE_61: Test Cline CLI connection
    application.app.post('/api/llm-provider/test', async (req, res) => {
      const startTime = Date.now();
      try {
        if (!application.clineProvider) {
          return res.status(503).json({ success: false, error: 'ClineProvider not initialized' });
        }
        const available = await application.clineProvider.testConnection();
        const latency = Date.now() - startTime;
        res.json({
          success: available,
          latency,
          message: available ? `Cline CLI responding (${latency}ms)` : 'Cline CLI not available',
          model: application.clineProvider.config.model,
          timeout: application.clineProvider.config.timeout,
        });
      } catch (err) {
        res.json({ success: false, error: err.message, latency: Date.now() - startTime });
      }
    });

    application.app.get('/api/settings', async (req, res) => {
      try {
        const settings = await application.settingsStore.getAll();
        res.json({
          success: true,
          settings,
        });
      } catch (err) {
        logger.error(`Get settings failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Update settings
    application.app.put('/api/settings', async (req, res) => {
      try {
        await application.settingsStore.setMultiple(req.body);
        res.json({
          success: true,
        });
      } catch (err) {
        logger.error(`Update settings failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // SSE endpoint (task-specific)
    application.app.get('/api/stream', (req, res) => {
      const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const taskId = req.query.taskId;

      if (!taskId) {
        return res.status(400).json({ error: 'taskId query parameter required' });
      }

      application.streamController.registerSSEClient(clientId, taskId, res);
    });

    // General streaming endpoint (session-based)
    application.app.get('/streaming', (req, res) => {
      const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const sessionId = req.query.sessionId;

      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId query parameter required' });
      }

      // Register SSE client with 'all' to receive all task events
      // Frontend will filter by taskId if needed
      application.streamController.registerSSEClient(clientId, 'all', res);

      logger.info(`SSE client connected: ${clientId} (session: ${sessionId}, receiving all tasks)`);

      // Handle client disconnect
      req.on('close', () => {
        logger.info(`SSE client disconnected: ${clientId}`);
        application.streamController.unregisterSSEClient(clientId);
      });
    });

    // MCP server status
    application.app.get('/api/mcp/servers', async (req, res) => {
      try {
        if (!application.mcpService && !application.mcpServiceHTTP) {
          return res.status(503).json({ error: 'MCP service not available' });
        }

        // Get stdio servers from MCPServiceV2
        const stdioServers = application.mcpService.getAllServerStatuses();
        
        // Get HTTP servers from MCPService (if available)
        const httpServers = application.mcpServiceHTTP ? application.mcpServiceHTTP.getAllServerStatuses() : [];
        
        // Merge both lists
        const servers = [...stdioServers, ...httpServers];
        
        res.json({
          success: true,
          servers,
          count: servers.length,
        });
      } catch (err) {
        logger.error(`Get MCP servers failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Get specific MCP server status
    application.app.get('/api/mcp/servers/:serverId', async (req, res) => {
      try {
        if (!application.mcpService) {
          return res.status(503).json({ error: 'MCP service not available' });
        }

        const { serverId } = req.params;
        const server = application.mcpService.getServerStatus(serverId);

        if (!server) {
          return res.status(404).json({ error: 'MCP server not found' });
        }

        res.json({
          success: true,
          server,
        });
      } catch (err) {
        logger.error(`Get MCP server status failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });

    // Get MCP tools
    application.app.get('/api/mcp/tools', async (req, res) => {
      try {
        if (!application.mcpService && !application.mcpServiceHTTP) {
          return res.status(503).json({ error: 'MCP service not available' });
        }

        // ⭐ PHASE_70: Merge tools from BOTH stdio and HTTP MCP services
        const stdioTools = application.mcpService ? application.mcpService.getAvailableTools() : [];
        const httpTools = application.mcpServiceHTTP ? application.mcpServiceHTTP.getAvailableTools() : [];
        const tools = [...stdioTools, ...httpTools];
        
        res.json({
          success: true,
          tools,
          count: tools.length,
          sources: { stdio: stdioTools.length, http: httpTools.length },
        });
      } catch (err) {
        logger.error(`Get MCP tools failed: ${err.message}`);
        res.status(500).json({
          error: err.message,
        });
      }
    });
}

module.exports = { registerLlmSettingsAndStreamRoutes };
