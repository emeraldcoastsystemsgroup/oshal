/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * MCP Service V2 - Wrapper for stdio-based MCP servers
 * Integrates MCPServerManager with ToolRegistry
 */

const logger = require('../utils/logger');
const MCPServerManager = require('./MCPServerManager');
const MCPStore = require('../stores/MCPStore');

/**
 * @description Service that manages stdio-based MCP (Model Context Protocol)
 * servers and bridges their advertised tools/resources into the application's
 * ToolRegistry and MCPStore. It exists so that externally-launched MCP servers
 * can be started, tracked, and have their tools exposed for execution and
 * approval through a single, uniform interface, while remaining compatible with
 * the legacy HTTP-based MCPService surface.
 */
class MCPServiceV2 {
  /**
   * @description Wires the service to its dependencies and subscribes to the
   * server manager's lifecycle events so tool registration and status updates
   * happen automatically as servers come and go. No servers are started here;
   * see initialize().
   * @param {Object} config - Application configuration, including the `mcp`
   *   section that controls whether MCP is enabled and which servers to launch.
   * @param {Object} toolRegistry - Registry used to register/unregister tools
   *   so they become callable by the rest of the system.
   * @param {Object} [mcpStore=null] - Persistence layer for server/tool metadata
   *   and execution stats; a default MCPStore is created when omitted.
   */
  constructor(config, toolRegistry, mcpStore = null) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.mcpStore = mcpStore || new MCPStore();
    this.serverManager = new MCPServerManager();
    this.initialized = false;

    // Listen to server manager events
    this.serverManager.on('server-started', (data) => {
      this.handleServerStarted(data);
    });

    this.serverManager.on('server-stopped', (data) => {
      this.handleServerStopped(data);
    });

    this.serverManager.on('server-error', (data) => {
      this.handleServerError(data);
    });
  }

  /**
   * Initialize MCP service
   */
  async initialize() {
    if (this.initialized) {
      logger.warn('MCPServiceV2 already initialized');
      return;
    }

    logger.info('Initializing MCP Service V2 (stdio-based)...');

    const mcpConfig = this.config.mcp;
    if (!mcpConfig || !mcpConfig.enabled) {
      logger.info('MCP is disabled in config');
      this.initialized = true;
      return;
    }

    // Start all enabled servers
    const servers = mcpConfig.servers || {};
    const startPromises = [];

    for (const [serverId, serverConfig] of Object.entries(servers)) {
      if (serverConfig.enabled) {
        // Skip HTTP-based servers (handled by old MCPService)
        if (serverConfig.port && !serverConfig.command) {
          logger.info(`Skipping HTTP-based MCP server: ${serverId} (port ${serverConfig.port})`);
          continue;
        }
        
        // Only start stdio-based servers
        if (!serverConfig.command) {
          logger.warn(`Server ${serverId} has no command, skipping`);
          continue;
        }
        
        logger.info(`Starting stdio MCP server: ${serverId}`);
        
        // Store server in MCPStore
        this.mcpStore.upsertServer({
          id: serverId,
          name: serverId,
          host: 'stdio',
          port: 0,
          enabled: true
        });

        // Start server with individual timeout
        startPromises.push(
          Promise.race([
            this.serverManager.startServer(serverId, serverConfig),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Server ${serverId} startup timeout`)), 60000)
            )
          ])
          .catch(error => {
            logger.error(`Failed to start MCP server ${serverId}:`, error.message);
            this.mcpStore.updateServerStatus(serverId, 'offline');
            return null;
          })
        );
      }
    }

    // Wait for all servers with individual timeouts (don't hang on any single failure)
    const results = await Promise.allSettled(startPromises);
    const successfulServers = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
    const totalServers = startPromises.length;

    logger.info(`MCP Service V2 initialized: ${successfulServers}/${totalServers} servers started`);
    
    // Always mark as initialized, even if some servers failed
    this.initialized = true;
    
    if (successfulServers === 0 && totalServers > 0) {
      logger.warn('No MCP servers started successfully, continuing with limited functionality');
    }
  }

  /**
   * Handle server started event
   */
  handleServerStarted(data) {
    const { serverId, tools, resources } = data;
    
    logger.info(`MCP server ${serverId} started with ${tools.length} tools, ${resources.length} resources`);

    // Update server status in store
    this.mcpStore.updateServerStatus(serverId, 'connected');
    this.mcpStore.updateServerToolsCount(serverId, tools.length);

    // Register tools with ToolRegistry
    for (const tool of tools) {
      this.registerTool(serverId, tool);
    }
  }

  /**
   * Handle server stopped event
   */
  handleServerStopped(data) {
    const { serverId } = data;
    logger.warn(`MCP server ${serverId} stopped`);
    this.mcpStore.updateServerStatus(serverId, 'offline');
  }

  /**
   * Handle server error event
   */
  handleServerError(data) {
    const { serverId, error } = data;
    logger.error(`MCP server ${serverId} error:`, error);
    this.mcpStore.updateServerStatus(serverId, 'error');
  }

  /**
   * Register a tool in ToolRegistry and MCPStore
   */
  registerTool(serverId, tool) {
    const toolId = `mcp_${serverId}_${tool.name}`;
    
    // Store in MCPStore
    this.mcpStore.upsertTool({
      id: toolId,
      server_id: serverId,
      name: tool.name,
      description: tool.description || '',
      category: 'mcp',
      input_schema: tool.inputSchema || {},
      requires_approval: true // MCP tools require approval by default
    });

    // Register in ToolRegistry
    this.toolRegistry.register({
      name: toolId,
      description: tool.description || `${serverId} - ${tool.name}`,
      category: 'mcp',
      inputSchema: tool.inputSchema || {},
      requiresApproval: true,
      handler: async (input) => {
        return await this.executeTool(serverId, tool.name, input);
      },
      timeout: this.config.mcp?.timeout || 60000
    });

    logger.debug(`Tool registered: ${toolId}`);
  }

  /**
   * Register a dynamic tool at runtime (public API for DynamicToolManager)
   * @param {Object} toolDef - { name, description, inputSchema, handler }
   * @returns {boolean}
   */
  registerDynamicTool(toolDef) {
    if (!toolDef || !toolDef.name) {
      logger.warn('[MCPServiceV2] registerDynamicTool: missing name');
      return false;
    }
    if (typeof toolDef.handler !== 'function') {
      logger.warn(`[MCPServiceV2] registerDynamicTool: handler must be a function for ${toolDef.name}`);
      return false;
    }

    const toolId = `dynamic_${toolDef.name}`;
    this.mcpStore.upsertTool({
      id: toolId,
      server_id: 'dynamic',
      name: toolDef.name,
      description: toolDef.description || '',
      category: 'dynamic',
      input_schema: toolDef.inputSchema || {},
      requires_approval: false,
    });

    this.toolRegistry.register({
      name: toolId,
      description: toolDef.description || `Dynamic tool: ${toolDef.name}`,
      category: 'dynamic',
      inputSchema: toolDef.inputSchema || {},
      requiresApproval: false,
      handler: toolDef.handler,
      timeout: 30000,
    });

    logger.info(`[MCPServiceV2] Dynamic tool registered: ${toolId}`);
    return true;
  }

  /**
   * Unregister a tool by name
   * @param {string} toolName
   * @returns {boolean}
   */
  unregisterTool(toolName) {
    // Try both prefixed and unprefixed names
    const candidates = [toolName, `dynamic_${toolName}`, `mcp_${toolName}`];
    for (const name of candidates) {
      if (this.toolRegistry.has && this.toolRegistry.has(name)) {
        this.toolRegistry.unregister(name);
        logger.info(`[MCPServiceV2] Tool unregistered: ${name}`);
        return true;
      }
    }
    logger.debug(`[MCPServiceV2] Tool not found for unregister: ${toolName}`);
    return false;
  }

  /**
   * Execute a tool on an MCP server
   */
  async executeTool(serverId, toolName, parameters) {
    if (!this.serverManager.isServerRunning(serverId)) {
      throw new Error(`Server ${serverId} is not running`);
    }

    try {
      logger.info(`Executing MCP tool: ${serverId}/${toolName}`);

      const result = await this.serverManager.callTool(serverId, toolName, parameters);

      // Record execution in store
      const toolId = `mcp_${serverId}_${toolName}`;
      this.mcpStore.recordToolExecution(toolId);

      // Format result for consistency
      return {
        success: true,
        server: serverId,
        tool: toolName,
        result: result,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`MCP tool execution failed: ${serverId}/${toolName}`, error);
      throw error;
    }
  }

  /**
   * Access a resource on an MCP server
   */
  async accessResource(serverId, uri) {
    if (!this.serverManager.isServerRunning(serverId)) {
      throw new Error(`Server ${serverId} is not running`);
    }

    try {
      logger.info(`Accessing MCP resource: ${serverId}/${uri}`);

      const result = await this.serverManager.readResource(serverId, uri);

      return {
        success: true,
        server: serverId,
        uri: uri,
        result: result,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`MCP resource access failed: ${serverId}/${uri}`, error);
      throw error;
    }
  }

  /**
   * Get server status
   */
  getServerStatus(serverId) {
    const serverInfo = this.serverManager.getServerInfo(serverId);
    if (!serverInfo) {
      return null;
    }

    const stats = this.mcpStore.getServerStats(serverId);

    return {
      id: serverInfo.id,
      name: serverInfo.id,
      host: 'stdio',
      port: 0,
      status: serverInfo.status,
      lastHealthCheck: Date.now(),
      toolCount: serverInfo.tools.length,
      resourceCount: serverInfo.resources.length,
      promptCount: serverInfo.prompts.length,
      ...stats
    };
  }

  /**
   * Get all server statuses
   */
  getAllServerStatuses() {
    const serversInfo = this.serverManager.getAllServersInfo();
    return serversInfo.map(serverInfo => {
      const stats = this.mcpStore.getServerStats(serverInfo.id);
      return {
        id: serverInfo.id,
        name: serverInfo.id,
        host: 'stdio',
        port: 0,
        status: serverInfo.status,
        lastHealthCheck: Date.now(),
        toolCount: serverInfo.tools.length,
        resourceCount: serverInfo.resources.length,
        promptCount: serverInfo.prompts.length,
        ...stats
      };
    });
  }

  /**
   * Get available tools from all servers
   */
  getAvailableTools() {
    const tools = [];
    const serversInfo = this.serverManager.getAllServersInfo();

    for (const serverInfo of serversInfo) {
      if (serverInfo.status === 'connected') {
        for (const tool of serverInfo.tools) {
          tools.push({
            id: `mcp_${serverInfo.id}_${tool.name}`,
            serverId: serverInfo.id,
            server: serverInfo.id,
            name: tool.name,
            description: tool.description,
            category: 'mcp',
            inputSchema: tool.inputSchema,
            requires_approval: true,
            requiresApproval: true
          });
        }
      }
    }

    return tools;
  }

  /**
   * Get tools for a specific server
   */
  getServerTools(serverId) {
    const serverInfo = this.serverManager.getServerInfo(serverId);
    if (!serverInfo) {
      return null;
    }

    return serverInfo.tools || [];
  }

  /**
   * Get resources for a specific server
   */
  getServerResources(serverId) {
    const serverInfo = this.serverManager.getServerInfo(serverId);
    if (!serverInfo) {
      return null;
    }

    return serverInfo.resources || [];
  }

  /**
   * Check server health (for compatibility with old MCPService)
   */
  async checkServerHealth(serverId) {
    const serverInfo = this.serverManager.getServerInfo(serverId);
    if (!serverInfo) {
      return false;
    }

    return serverInfo.status === 'connected';
  }

  /**
   * Discover tools from all servers (for compatibility)
   */
  async discoverAllTools() {
    // Tools are automatically discovered on server startup
    // This is just for compatibility
    const serversInfo = this.serverManager.getAllServersInfo();
    const results = serversInfo.map(info => ({
      serverId: info.id,
      toolCount: info.tools.length,
      success: info.status === 'connected'
    }));

    return results;
  }

  /**
   * Discover tools from a server (for compatibility)
   */
  async discoverServerTools(serverId) {
    const serverInfo = this.serverManager.getServerInfo(serverId);
    if (!serverInfo) {
      throw new Error(`Server ${serverId} not found`);
    }

    return serverInfo.tools;
  }

  /**
   * Shutdown MCP service
   */
  async shutdown() {
    logger.info('Shutting down MCP Service V2...');

    await this.serverManager.stopAllServers();
    
    this.initialized = false;
    logger.info('MCP Service V2 shut down');
  }

  /**
   * Start health checks (for compatibility, not needed for stdio)
   */
  startHealthChecks() {
    logger.debug('Health checks not needed for stdio-based MCP servers');
  }

  /**
   * Stop health checks (for compatibility)
   */
  stopHealthChecks() {
    logger.debug('Health checks not needed for stdio-based MCP servers');
  }
}

module.exports = MCPServiceV2;
