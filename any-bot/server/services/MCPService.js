/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * MCP Service - Manages MCP server connections and tool execution
 * Handles health checks, tool discovery, and communication with MCP servers
 */

const axios = require('axios');
const logger = require('../utils/logger');
const MCPStore = require('../stores/MCPStore');

/**
 * @description Service responsible for the lifecycle of HTTP-based MCP (Model
 * Context Protocol) server integrations: it registers configured servers,
 * monitors their health on an interval, discovers and registers the tools they
 * expose, and brokers tool execution and resource access between the rest of
 * the application and those remote servers. Centralizing this here keeps MCP
 * connectivity, retry/backoff behavior, and tool-registry wiring in one place
 * so callers can treat remote MCP tools like any other tool.
 */
class MCPService {
  /**
   * @description Construct the service and capture its dependencies and tunable
   * settings without performing any I/O; actual server registration and tool
   * discovery are deferred to initialize() so the instance can be wired up
   * cheaply and started explicitly.
   * @param {object} config - Application configuration; the `mcp` section drives
   *   whether MCP is enabled, which servers to register, and the retry/timeout
   *   behavior.
   * @param {object} toolRegistry - Shared registry that discovered MCP tools are
   *   registered into so they become callable by the wider system.
   * @param {object} [mcpStore=null] - Persistence/state store for servers and
   *   tools; a new MCPStore is created when one is not supplied.
   */
  constructor(config, toolRegistry, mcpStore = null) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.mcpStore = mcpStore || new MCPStore();
    this.servers = new Map(); // serverId -> server connection info
    this.healthCheckInterval = null;
    this.healthCheckIntervalMs = 30000; // 30 seconds
    this.retryAttempts = config.mcp?.retryAttempts || 3;
    this.timeout = config.mcp?.timeout || 60000;
    this.initialized = false;
  }

  /**
   * Initialize MCP service - register servers and discover tools
   */
  async initialize() {
    if (this.initialized) {
      logger.warn('MCPService already initialized');
      return;
    }

    logger.info('Initializing MCP Service...');

    // Register configured servers
    await this.registerConfiguredServers();

    // Start health check interval
    this.startHealthChecks();

    // Discover tools from all servers
    await this.discoverAllTools();

    this.initialized = true;
    logger.info('MCP Service initialized successfully', {
      serverCount: this.servers.size,
      toolCount: this.toolRegistry.count()
    });
  }

  /**
   * Register servers from config
   */
  async registerConfiguredServers() {
    const mcpConfig = this.config.mcp;
    
    if (!mcpConfig || !mcpConfig.enabled) {
      logger.info('MCP is disabled in config');
      return;
    }

    const servers = mcpConfig.servers || {};
    
    for (const [id, serverConfig] of Object.entries(servers)) {
      // Only register HTTP-based servers (ones with port but no command)
      if (serverConfig.enabled && serverConfig.port && !serverConfig.command) {
        await this.registerServer({
          id,
          name: id,
          host: serverConfig.host || 'localhost',
          port: serverConfig.port,
          enabled: true
        });
      }
    }

    logger.info(`Registered ${this.servers.size} HTTP-based MCP servers from config`);
  }

  /**
   * Register an MCP server
   */
  async registerServer(serverConfig) {
    const { id, name, host, port, enabled } = serverConfig;
    
    // Store in MCPStore
    this.mcpStore.upsertServer({
      id,
      name,
      port,
      host,
      enabled
    });

    // Store in memory
    this.servers.set(id, {
      id,
      name,
      host,
      port,
      enabled,
      baseUrl: `http://${host}:${port}`,
      status: 'unknown',
      lastHealthCheck: null,
      tools: []
    });

    logger.info(`MCP server registered: ${id} at ${host}:${port}`);
  }

  /**
   * Check health of a server
   */
  async checkServerHealth(serverId) {
    const server = this.servers.get(serverId);
    if (!server) {
      logger.warn(`Server not found: ${serverId}`);
      return false;
    }

    try {
      const response = await axios.get(`${server.baseUrl}/health`, {
        timeout: 5000
      });

      const isHealthy = response.status === 200 && (response.data.status === 'UP' || response.data.status === 'healthy');
      const status = isHealthy ? 'connected' : 'unhealthy';

      // Update in memory
      server.status = status;
      server.lastHealthCheck = Date.now();

      // Update in store
      this.mcpStore.updateServerStatus(serverId, status);

      logger.debug(`Health check for ${serverId}: ${status}`);
      return isHealthy;
    } catch (error) {
      const status = 'offline';
      
      // Update in memory
      server.status = status;
      server.lastHealthCheck = Date.now();

      // Update in store
      this.mcpStore.updateServerStatus(serverId, status);

      logger.debug(`Health check for ${serverId}: ${status} - ${error.message}`);
      return false;
    }
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      for (const serverId of this.servers.keys()) {
        await this.checkServerHealth(serverId);
      }
    }, this.healthCheckIntervalMs);

    logger.info('MCP health checks started');
  }

  /**
   * Stop health checks
   */
  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.info('MCP health checks stopped');
    }
  }

  /**
   * Discover tools from a server
   */
  async discoverServerTools(serverId) {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server not found: ${serverId}`);
    }

    // First check health
    const isHealthy = await this.checkServerHealth(serverId);
    if (!isHealthy) {
      logger.warn(`Cannot discover tools from unhealthy server: ${serverId}`);
      return [];
    }

    try {
      // Try to get tools from /tools endpoint (common pattern)
      const response = await axios.get(`${server.baseUrl}/tools`, {
        timeout: 5000
      });

      const tools = response.data.tools || [];
      server.tools = tools;

      // Register each tool
      for (const tool of tools) {
        await this.registerTool(serverId, tool);
      }

      // Update tools count in store
      this.mcpStore.updateServerToolsCount(serverId, tools.length);

      logger.info(`Discovered ${tools.length} tools from ${serverId}`);
      return tools;
    } catch (error) {
      // If /tools endpoint doesn't exist, try status endpoint for capabilities
      try {
        const statusResponse = await axios.get(`${server.baseUrl}/status`, {
          timeout: 5000
        });

        const capabilities = statusResponse.data.tools || [];
        const tools = capabilities.map(cap => this.parseToolFromCapability(cap, serverId));
        
        server.tools = tools;

        // Register each tool
        for (const tool of tools) {
          await this.registerTool(serverId, tool);
        }

        // Update tools count in store
        this.mcpStore.updateServerToolsCount(serverId, tools.length);

        logger.info(`Discovered ${tools.length} tools from ${serverId} status`);
        return tools;
      } catch (statusError) {
        logger.error(`Failed to discover tools from ${serverId}`, {
          error: error.message,
          statusError: statusError.message
        });
        return [];
      }
    }
  }

  /**
   * Parse tool info from capability string
   */
  parseToolFromCapability(capability, serverId) {
    // If capability is already an object, return it
    if (typeof capability === 'object' && capability.name) {
      return capability;
    }

    // Parse from string like "POST /tools/read_file"
    const match = String(capability).match(/POST \/tools\/(\w+)/);
    const toolName = match ? match[1] : String(capability).replace(/\W+/g, '_');

    return {
      name: toolName,
      description: `${serverId} - ${toolName}`,
      category: 'mcp',
      input_schema: {},
      requires_approval: true
    };
  }

  /**
   * Register a tool in ToolRegistry and MCPStore
   */
  async registerTool(serverId, tool) {
    const toolId = `mcp_${serverId}_${tool.name}`;
    
    // Convert Google's "parameters" format to JSON Schema if needed
    let inputSchema = tool.input_schema || tool.inputSchema;
    if (!inputSchema && tool.parameters) {
      inputSchema = this.convertParametersToSchema(tool.parameters);
    }
    inputSchema = inputSchema || {};
    
    // Store in MCPStore - MCP tools default to auto-approve (requiresApproval: false)
    this.mcpStore.upsertTool({
      id: toolId,
      server_id: serverId,
      name: tool.name,
      description: tool.description || '',
      category: 'mcp',
      input_schema: inputSchema,
      requires_approval: false // Auto-approve all MCP tools
    });

    // Register in ToolRegistry - MCP tools default to auto-approve (requiresApproval: false)
    this.toolRegistry.register({
      name: toolId,
      description: tool.description || `${serverId} - ${tool.name}`,
      category: 'mcp',
      inputSchema: inputSchema,
      requiresApproval: false, // Auto-approve all MCP tools
      handler: async (input) => {
        return await this.executeTool(serverId, tool.name, input);
      },
      timeout: this.timeout
    });

    logger.debug(`Tool registered: ${toolId} (auto-approve enabled)`);
  }
  
  /**
   * Convert Google Search's parameter format to JSON Schema
   */
  convertParametersToSchema(parameters) {
    const schema = {
      type: 'object',
      properties: {},
      required: []
    };
    
    for (const [paramName, paramDesc] of Object.entries(parameters)) {
      const desc = String(paramDesc);
      const isRequired = desc.includes('required');
      const isString = desc.includes('string');
      const isInteger = desc.includes('integer');
      
      schema.properties[paramName] = {
        type: isInteger ? 'integer' : 'string',
        description: desc
      };
      
      if (isRequired) {
        schema.required.push(paramName);
      }
    }
    
    return schema;
  }

  /**
   * Discover tools from all servers
   */
  async discoverAllTools() {
    logger.info('Discovering tools from all MCP servers...');
    
    const results = [];
    for (const serverId of this.servers.keys()) {
      try {
        const tools = await this.discoverServerTools(serverId);
        results.push({ serverId, toolCount: tools.length, success: true });
      } catch (error) {
        logger.error(`Tool discovery failed for ${serverId}`, { error: error.message });
        results.push({ serverId, toolCount: 0, success: false, error: error.message });
      }
    }

    const totalTools = results.reduce((sum, r) => sum + r.toolCount, 0);
    logger.info(`Tool discovery complete: ${totalTools} total tools from ${results.length} servers`);
    
    return results;
  }

  /**
   * Execute a tool on an MCP server
   */
  async executeTool(serverId, toolName, parameters, attempt = 1) {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server not found: ${serverId}`);
    }

    // Check server health first
    if (server.status === 'offline') {
      const isHealthy = await this.checkServerHealth(serverId);
      if (!isHealthy) {
        throw new Error(`Server ${serverId} is offline`);
      }
    }

    try {
      logger.info(`Executing MCP tool: ${serverId}/${toolName}`, { parameters });

      // Try standard /tools/{toolName} endpoint
      const response = await axios.post(
        `${server.baseUrl}/tools/${toolName}`,
        parameters,
        {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      // Record execution in store
      const toolId = `mcp_${serverId}_${toolName}`;
      this.mcpStore.recordToolExecution(toolId);

      logger.info(`MCP tool executed successfully: ${serverId}/${toolName}`);
      
      return {
        success: true,
        server: serverId,
        tool: toolName,
        result: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`MCP tool execution failed: ${serverId}/${toolName}`, {
        attempt,
        error: error.message
      });

      // Retry logic
      if (attempt < this.retryAttempts) {
        logger.info(`Retrying MCP tool execution (${attempt + 1}/${this.retryAttempts})...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
        return await this.executeTool(serverId, toolName, parameters, attempt + 1);
      }

      throw new Error(`MCP tool execution failed after ${attempt} attempts: ${error.message}`);
    }
  }

  /**
   * Get all available tools
   */
  getAvailableTools() {
    const tools = [];
    
    for (const [serverId, server] of this.servers.entries()) {
      if (server.status === 'connected' || server.status === 'healthy') {
        for (const tool of server.tools) {
          tools.push({
            id: `mcp_${serverId}_${tool.name}`,
            serverId: serverId,
            server: serverId,
            name: tool.name,
            description: tool.description,
            category: tool.category || 'mcp',
            inputSchema: tool.inputSchema,
            requires_approval: tool.requires_approval !== false,
            requiresApproval: tool.requires_approval !== false
          });
        }
      }
    }
    
    return tools;
  }

  /**
   * Get server status
   */
  getServerStatus(serverId) {
    const server = this.servers.get(serverId);
    if (!server) {
      return null;
    }

    const stats = this.mcpStore.getServerStats(serverId);

    return {
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      status: server.status,
      lastHealthCheck: server.lastHealthCheck,
      tools: server.tools || [],
      resources: server.resources || [],
      toolCount: server.tools.length,
      ...stats
    };
  }

  /**
   * Get all server statuses
   */
  getAllServerStatuses() {
    const statuses = [];
    
    for (const serverId of this.servers.keys()) {
      statuses.push(this.getServerStatus(serverId));
    }
    
    return statuses;
  }

  /**
   * Get tools for a specific server
   */
  getServerTools(serverName) {
    const server = this.servers.get(serverName);
    if (!server) {
      logger.warn(`Server not found: ${serverName}`);
      return null;
    }

    return server.tools || [];
  }

  /**
   * Get resources for a specific server
   */
  getServerResources(serverName) {
    const server = this.servers.get(serverName);
    if (!server) {
      logger.warn(`Server not found: ${serverName}`);
      return null;
    }

    // Resources not yet implemented in server object
    // For now return empty array
    return server.resources || [];
  }

  /**
   * Access a resource on an MCP server
   */
  async accessResource(serverName, uri) {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server not found: ${serverName}`);
    }

    // Check server health first
    if (server.status === 'offline') {
      const isHealthy = await this.checkServerHealth(serverName);
      if (!isHealthy) {
        throw new Error(`Server ${serverName} is offline`);
      }
    }

    try {
      logger.info(`Accessing MCP resource: ${serverName}/${uri}`);

      // Try to access resource endpoint
      const response = await axios.get(
        `${server.baseUrl}/resources/${encodeURIComponent(uri)}`,
        {
          timeout: this.timeout,
          headers: {
            'Accept': 'application/json'
          }
        }
      );

      logger.info(`MCP resource accessed successfully: ${serverName}/${uri}`);
      
      return {
        success: true,
        server: serverName,
        uri: uri,
        result: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error(`MCP resource access failed: ${serverName}/${uri}`, {
        error: error.message
      });

      throw new Error(`Failed to access resource: ${error.message}`);
    }
  }

  /**
   * Shutdown MCP service
   */
  async shutdown() {
    logger.info('Shutting down MCP Service...');
    
    this.stopHealthChecks();
    this.servers.clear();
    this.initialized = false;
    
    logger.info('MCP Service shut down');
  }
}

module.exports = MCPService;
