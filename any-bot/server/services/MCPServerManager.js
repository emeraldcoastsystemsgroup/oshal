/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: rebranded legacy "Kevin" agent identity/namespace to neutral OSHAL
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: stdio MCP children receive an explicit runtime environment plus only their reviewed server-specific settings, never the controller's database, session, connector, or provider credentials.
 */

/**
 * MCP Server Manager - Manages stdio-based MCP servers
 * Handles spawning, communication, and lifecycle of MCP servers
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const readline = require('readline');

const MCP_RUNTIME_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
];

/**
 * Build a stdio MCP environment without carrying the controller process's credentials.
 * A server receives only OS/runtime values and the exact settings declared on its own config.
 */
function buildMcpServerProcessEnv(serverEnv = {}, parent = process.env) {
  const childEnv = {};
  for (const key of MCP_RUNTIME_ENV_KEYS) {
    if (parent[key] !== undefined) childEnv[key] = String(parent[key]);
  }
  for (const [key, value] of Object.entries(serverEnv || {})) {
    if (value !== undefined && value !== null) childEnv[key] = String(value);
  }
  return childEnv;
}

/**
 * @description Central coordinator for the lifecycle of stdio-based Model Context
 * Protocol (MCP) servers. Exists so the agent can treat external tool/resource/prompt
 * providers as long-lived child processes that are spawned on demand, spoken to over
 * JSON-RPC on stdin/stdout, kept alive through crash-recovery with exponential backoff,
 * and cleanly torn down. Extends EventEmitter so callers can react to lifecycle events
 * (server-started, server-stopped, server-error, server-notification) rather than poll.
 */
class MCPServerManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map(); // serverId -> { config, process, status, tools, resources }
    this.messageId = 0;
    this.pendingRequests = new Map(); // messageId -> { resolve, reject, timeout }
    this.restartAttempts = new Map(); // serverId -> attempt count
    this.maxRestartAttempts = 10; // Maximum restart attempts
    this.restartDelay = 5000; // Base delay in ms (exponential backoff)
  }

  /**
   * Start an MCP server
   */
  async startServer(serverId, serverConfig) {
    if (this.servers.has(serverId)) {
      logger.warn(`Server ${serverId} already started`);
      return;
    }

    const { command, args, env, cwd } = serverConfig;

    try {
      logger.info(`Starting MCP server: ${serverId}`, { command, args });

      // Spawn the MCP server process
      const serverProcess = spawn(command, args, {
        env: buildMcpServerProcessEnv(env),
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Create readline interface for line-by-line input
      const rl = readline.createInterface({
        input: serverProcess.stdout,
        crlfDelay: Infinity
      });

      // Store server info
      const serverInfo = {
        id: serverId,
        config: serverConfig,
        process: serverProcess,
        status: 'starting',
        tools: [],
        resources: [],
        prompts: [],
        rl: rl,
        buffer: ''
      };

      this.servers.set(serverId, serverInfo);

      // Handle stdout messages (MCP protocol)
      rl.on('line', (line) => {
        this.handleServerMessage(serverId, line);
      });

      // Handle stderr for logging
      serverProcess.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          logger.debug(`MCP server ${serverId} stderr:`, message);
        }
      });

      // Handle process exit with auto-restart
      serverProcess.on('exit', (code, signal) => {
        logger.warn(`MCP server ${serverId} exited`, { code, signal });
        serverInfo.status = 'stopped';
        this.emit('server-stopped', { serverId, code, signal });
        
        // Auto-restart the server
        this.handleServerCrash(serverId, serverConfig);
      });

      serverProcess.on('error', (error) => {
        logger.error(`MCP server ${serverId} error:`, error);
        serverInfo.status = 'error';
        this.emit('server-error', { serverId, error });
      });

      // Initialize the server
      await this.initializeServer(serverId);

      // List capabilities
      await this.discoverServerCapabilities(serverId);

      serverInfo.status = 'connected';
      logger.info(`MCP server ${serverId} started successfully`, {
        tools: serverInfo.tools.length,
        resources: serverInfo.resources.length
      });

      this.emit('server-started', { serverId, tools: serverInfo.tools, resources: serverInfo.resources });

      return serverInfo;
    } catch (error) {
      logger.error(`Failed to start MCP server ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Handle messages from MCP server
   */
  handleServerMessage(serverId, line) {
    try {
      if (!line || line.trim() === '') {
        return;
      }

      const message = JSON.parse(line);
      
      // Handle responses to our requests
      if (message.id !== undefined && this.pendingRequests.has(message.id)) {
        const { resolve, reject, timeout } = this.pendingRequests.get(message.id);
        clearTimeout(timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          reject(new Error(message.error.message || 'MCP server error'));
        } else {
          resolve(message.result);
        }
        return;
      }

      // Handle server notifications
      if (message.method) {
        this.handleServerNotification(serverId, message);
      }
    } catch (error) {
      logger.error(`Failed to parse MCP message from ${serverId}:`, { line, error: error.message });
    }
  }

  /**
   * Handle notifications from server
   */
  handleServerNotification(serverId, message) {
    logger.debug(`MCP server ${serverId} notification:`, message.method);
    this.emit('server-notification', { serverId, method: message.method, params: message.params });
  }

  /**
   * Send request to MCP server
   */
  async sendRequest(serverId, method, params = {}, timeoutMs = 30000) {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) {
      throw new Error(`Server ${serverId} not found`);
    }

    if (serverInfo.status !== 'connected' && serverInfo.status !== 'starting') {
      throw new Error(`Server ${serverId} is not connected (status: ${serverInfo.status})`);
    }

    const id = ++this.messageId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request to ${serverId} timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      // Send request
      try {
        serverInfo.process.stdin.write(JSON.stringify(request) + '\n');
        logger.debug(`Sent MCP request to ${serverId}:`, { method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Initialize MCP server
   */
  async initializeServer(serverId) {
    const result = await this.sendRequest(serverId, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: {
          listChanged: false
        },
        sampling: {}
      },
      clientInfo: {
        name: 'oshal-agent',
        version: '1.0.0'
      }
    });

    logger.info(`MCP server ${serverId} initialized`, {
      serverInfo: result.serverInfo,
      capabilities: result.capabilities
    });

    // Send initialized notification
    const serverInfo = this.servers.get(serverId);
    serverInfo.process.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    }) + '\n');

    return result;
  }

  /**
   * Discover server capabilities (tools, resources, prompts)
   */
  async discoverServerCapabilities(serverId) {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) {
      throw new Error(`Server ${serverId} not found`);
    }

    try {
      // List tools
      const toolsResult = await this.sendRequest(serverId, 'tools/list', {});
      serverInfo.tools = toolsResult.tools || [];
      logger.info(`Discovered ${serverInfo.tools.length} tools from ${serverId}`);

      // List resources
      try {
        const resourcesResult = await this.sendRequest(serverId, 'resources/list', {});
        serverInfo.resources = resourcesResult.resources || [];
        logger.info(`Discovered ${serverInfo.resources.length} resources from ${serverId}`);
      } catch (error) {
        // Resources might not be supported
        logger.debug(`Server ${serverId} does not support resources`);
        serverInfo.resources = [];
      }

      // List prompts
      try {
        const promptsResult = await this.sendRequest(serverId, 'prompts/list', {});
        serverInfo.prompts = promptsResult.prompts || [];
        logger.info(`Discovered ${serverInfo.prompts.length} prompts from ${serverId}`);
      } catch (error) {
        // Prompts might not be supported
        logger.debug(`Server ${serverId} does not support prompts`);
        serverInfo.prompts = [];
      }

      return {
        tools: serverInfo.tools,
        resources: serverInfo.resources,
        prompts: serverInfo.prompts
      };
    } catch (error) {
      logger.error(`Failed to discover capabilities from ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Call an MCP tool
   */
  async callTool(serverId, toolName, arguments_) {
    logger.info(`Calling MCP tool: ${serverId}/${toolName}`);

    try {
      const result = await this.sendRequest(serverId, 'tools/call', {
        name: toolName,
        arguments: arguments_ || {}
      });

      logger.info(`MCP tool executed successfully: ${serverId}/${toolName}`);
      return result;
    } catch (error) {
      logger.error(`MCP tool execution failed: ${serverId}/${toolName}`, error);
      throw error;
    }
  }

  /**
   * Read an MCP resource
   */
  async readResource(serverId, uri) {
    logger.info(`Reading MCP resource: ${serverId}/${uri}`);

    try {
      const result = await this.sendRequest(serverId, 'resources/read', {
        uri: uri
      });

      logger.info(`MCP resource read successfully: ${serverId}/${uri}`);
      return result;
    } catch (error) {
      logger.error(`MCP resource read failed: ${serverId}/${uri}`, error);
      throw error;
    }
  }

  /**
   * Get prompt from server
   */
  async getPrompt(serverId, promptName, arguments_) {
    logger.info(`Getting MCP prompt: ${serverId}/${promptName}`);

    try {
      const result = await this.sendRequest(serverId, 'prompts/get', {
        name: promptName,
        arguments: arguments_ || {}
      });

      logger.info(`MCP prompt retrieved successfully: ${serverId}/${promptName}`);
      return result;
    } catch (error) {
      logger.error(`MCP prompt retrieval failed: ${serverId}/${promptName}`, error);
      throw error;
    }
  }

  /**
   * Get server info
   */
  getServerInfo(serverId) {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) {
      return null;
    }

    return {
      id: serverInfo.id,
      status: serverInfo.status,
      tools: serverInfo.tools,
      resources: serverInfo.resources,
      prompts: serverInfo.prompts,
      config: {
        command: serverInfo.config.command,
        args: serverInfo.config.args
      }
    };
  }

  /**
   * Get all servers info
   */
  getAllServersInfo() {
    const serversInfo = [];
    for (const serverId of this.servers.keys()) {
      serversInfo.push(this.getServerInfo(serverId));
    }
    return serversInfo;
  }

  /**
   * Stop an MCP server
   */
  async stopServer(serverId) {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) {
      logger.warn(`Server ${serverId} not found for stopping`);
      return;
    }

    logger.info(`Stopping MCP server: ${serverId}`);

    try {
      // Send shutdown notification
      if (serverInfo.process && !serverInfo.process.killed) {
        serverInfo.process.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/shutdown'
        }) + '\n');
      }
    } catch (error) {
      logger.debug(`Error sending shutdown to ${serverId}:`, error.message);
    }

    // Kill the process
    if (serverInfo.process && !serverInfo.process.killed) {
      serverInfo.process.kill();
    }

    // Close readline interface
    if (serverInfo.rl) {
      serverInfo.rl.close();
    }

    // Clear pending requests for this server
    for (const [id, request] of this.pendingRequests.entries()) {
      request.reject(new Error(`Server ${serverId} stopped`));
      clearTimeout(request.timeout);
      this.pendingRequests.delete(id);
    }

    this.servers.delete(serverId);
    logger.info(`MCP server ${serverId} stopped`);
  }

  /**
   * Stop all servers
   */
  async stopAllServers() {
    logger.info('Stopping all MCP servers...');
    
    const serverIds = Array.from(this.servers.keys());
    for (const serverId of serverIds) {
      await this.stopServer(serverId);
    }

    logger.info('All MCP servers stopped');
  }

  /**
   * Get server count
   */
  getServerCount() {
    return this.servers.size;
  }

  /**
   * Check if server is running
   */
  isServerRunning(serverId) {
    const serverInfo = this.servers.get(serverId);
    return serverInfo && serverInfo.status === 'connected';
  }

  /**
   * Handle server crash and auto-restart
   */
  async handleServerCrash(serverId, serverConfig) {
    const attempts = this.restartAttempts.get(serverId) || 0;
    
    if (attempts >= this.maxRestartAttempts) {
      logger.error(`MCP server ${serverId} exceeded max restart attempts (${this.maxRestartAttempts}), giving up`);
      this.restartAttempts.delete(serverId);
      return;
    }
    
    // Calculate exponential backoff delay
    const delay = this.restartDelay * Math.pow(2, attempts);
    
    logger.warn(`MCP server ${serverId} will restart in ${delay}ms (attempt ${attempts + 1}/${this.maxRestartAttempts})`);
    this.restartAttempts.set(serverId, attempts + 1);
    
    // Wait before restarting
    setTimeout(async () => {
      try {
        // Clean up old server entry
        this.servers.delete(serverId);
        
        logger.info(`Auto-restarting MCP server: ${serverId}`);
        await this.startServer(serverId, serverConfig);
        
        // Reset restart counter on successful start
        this.restartAttempts.delete(serverId);
        logger.info(`MCP server ${serverId} successfully restarted`);
      } catch (error) {
        logger.error(`Failed to restart MCP server ${serverId}:`, error);
        // Will retry on next crash if within limits
      }
    }, delay);
  }

  /**
   * Reset restart counter for a server (call after successful operation)
   */
  resetRestartCounter(serverId) {
    this.restartAttempts.delete(serverId);
  }
}

module.exports = MCPServerManager;
module.exports.buildMcpServerProcessEnv = buildMcpServerProcessEnv;
