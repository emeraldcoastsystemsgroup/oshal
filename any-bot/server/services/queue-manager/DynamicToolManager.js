/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * DynamicToolManager - Runtime MCP tool registration manager
 * 
 * Allows agents to register new tools at runtime via HTTP endpoints.
 * Validates tool definitions, persists to Redis for recovery after restart,
 * and registers with MCPServiceV2.
 */

const logger = require('../../utils/logger');

/**
 * @description Manages the lifecycle of MCP tools that agents register at
 * runtime, so the swarm can extend its own capabilities without a redeploy.
 * Acts as the source of truth for dynamic tools: it validates incoming
 * registrations, mirrors them into Redis so they survive a process restart,
 * enforces per-tool TTLs to keep the registry from growing unbounded, and
 * bridges each tool to MCPServiceV2 with an HTTP-backed handler.
 */

class DynamicToolManager {
  constructor(mcpService, toolRegistry, redisClient) {
    this.mcpService = mcpService;
    this.toolRegistry = toolRegistry;
    this.redis = redisClient;
    this._tools = new Map();
    this._redisKey = 'dynamic-tools';
  }

  /**
   * Initialize — restore tools from Redis
   */
  async initialize() {
    try {
      if (!this.redis) return;
      const stored = await this.redis.hgetall(this._redisKey);
      if (stored) {
        for (const [name, json] of Object.entries(stored)) {
          try {
            const reg = JSON.parse(json);
            // Check TTL
            if (reg.ttlMs > 0 && Date.now() > reg.registeredAt + reg.ttlMs) {
              await this.redis.hdel(this._redisKey, name);
              continue; // Expired
            }
            this._tools.set(name, reg);
            this._registerWithMcp(reg);
          } catch (e) {
            logger.warn(`[DynamicToolManager] Failed to restore tool ${name}: ${e.message}`);
          }
        }
        logger.info(`[DynamicToolManager] Restored ${this._tools.size} dynamic tool(s) from Redis`);
      }
    } catch (error) {
      logger.warn(`[DynamicToolManager] Failed to restore from Redis: ${error.message}`);
    }
  }

  /**
   * Register a new tool at runtime
   * @param {Object} registration - Tool registration
   * @param {string} registration.toolName - Unique tool name
   * @param {string} registration.serverUrl - HTTP endpoint for the tool
   * @param {string} registration.description - What the tool does
   * @param {Object} [registration.inputSchema] - JSON Schema for parameters
   * @param {boolean} [registration.requiresApproval=false] - Requires human approval
   * @param {string} registration.registeredBy - Agent ID
   * @param {number} [registration.ttlMs=86400000] - Time-to-live (0 = permanent)
   * @returns {Promise<{success: boolean, toolId?: string, error?: string, expiresAt?: string}>}
   */
  async registerTool(registration) {
    // Validate
    const validation = this._validateRegistration(registration);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; ') };
    }

    const { toolName, serverUrl, description, inputSchema, requiresApproval, registeredBy, ttlMs } = registration;

    // Check for duplicates
    if (this._tools.has(toolName)) {
      return { success: false, error: `Tool "${toolName}" already registered. Unregister first.` };
    }

    const record = {
      toolName,
      serverUrl,
      description: description || '',
      inputSchema: inputSchema || { type: 'object', properties: {} },
      requiresApproval: requiresApproval || false,
      registeredBy: registeredBy || 'unknown',
      registeredAt: Date.now(),
      ttlMs: ttlMs !== undefined ? ttlMs : 86400000, // Default 24h
    };

    // Store in memory
    this._tools.set(toolName, record);

    // Persist to Redis
    try {
      if (this.redis) {
        await this.redis.hset(this._redisKey, toolName, JSON.stringify(record));
      }
    } catch (err) {
      logger.warn(`[DynamicToolManager] Redis persist failed for ${toolName}: ${err.message}`);
    }

    // Register with MCP service
    this._registerWithMcp(record);

    const expiresAt = record.ttlMs > 0 
      ? new Date(record.registeredAt + record.ttlMs).toISOString()
      : 'never';

    logger.info(`[DynamicToolManager] ✓ Tool registered: ${toolName} (by ${registeredBy}, expires: ${expiresAt})`);

    return {
      success: true,
      toolId: toolName,
      expiresAt,
    };
  }

  /**
   * Unregister a dynamically registered tool
   * @param {string} toolName - Tool name to remove
   * @returns {Promise<boolean>}
   */
  async unregisterTool(toolName) {
    const existed = this._tools.delete(toolName);
    
    if (existed) {
      // Remove from Redis
      try {
        if (this.redis) {
          await this.redis.hdel(this._redisKey, toolName);
        }
      } catch (err) {
        logger.warn(`[DynamicToolManager] Redis delete failed for ${toolName}: ${err.message}`);
      }

      // Unregister from MCP
      if (this.mcpService && typeof this.mcpService.unregisterTool === 'function') {
        this.mcpService.unregisterTool(toolName);
      }

      logger.info(`[DynamicToolManager] Tool unregistered: ${toolName}`);
    }
    
    return existed;
  }

  /**
   * List all dynamically registered tools
   * @returns {Object[]}
   */
  listTools() {
    return Array.from(this._tools.values()).map(t => ({
      ...t,
      expired: t.ttlMs > 0 && Date.now() > t.registeredAt + t.ttlMs,
      remainingMs: t.ttlMs > 0 ? Math.max(0, (t.registeredAt + t.ttlMs) - Date.now()) : null,
    }));
  }

  /**
   * Get info about a specific tool
   * @param {string} toolName
   * @returns {Object|null}
   */
  getToolInfo(toolName) {
    return this._tools.get(toolName) || null;
  }

  /**
   * Clean up expired tools
   * @returns {Promise<number>} - Number of tools cleaned
   */
  async cleanExpired() {
    let cleaned = 0;
    const now = Date.now();

    for (const [name, reg] of this._tools) {
      if (reg.ttlMs > 0 && now > reg.registeredAt + reg.ttlMs) {
        await this.unregisterTool(name);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`[DynamicToolManager] Cleaned ${cleaned} expired tool(s)`);
    }

    return cleaned;
  }

  // === Private Helpers ===

  /**
   * Validate a tool registration
   * @private
   */
  _validateRegistration(reg) {
    const errors = [];

    if (!reg.toolName || typeof reg.toolName !== 'string') {
      errors.push('toolName is required and must be a string');
    } else if (!/^[a-zA-Z0-9_-]+$/.test(reg.toolName)) {
      errors.push('toolName must be alphanumeric with hyphens/underscores only');
    } else if (reg.toolName.length > 64) {
      errors.push('toolName must be 64 characters or less');
    }

    if (!reg.serverUrl || typeof reg.serverUrl !== 'string') {
      errors.push('serverUrl is required and must be a string');
    } else {
      try {
        new URL(reg.serverUrl);
      } catch {
        errors.push('serverUrl must be a valid URL');
      }
    }

    if (!reg.registeredBy || typeof reg.registeredBy !== 'string') {
      errors.push('registeredBy is required (agent ID)');
    }

    if (reg.inputSchema && typeof reg.inputSchema !== 'object') {
      errors.push('inputSchema must be a JSON object if provided');
    }

    if (reg.ttlMs !== undefined && (typeof reg.ttlMs !== 'number' || reg.ttlMs < 0)) {
      errors.push('ttlMs must be a non-negative number');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Register tool with MCP service
   * @private
   */
  _registerWithMcp(record) {
    try {
      if (this.mcpService && typeof this.mcpService.registerTool === 'function') {
        const handler = this._createHttpHandler(record.serverUrl);
        this.mcpService.registerTool({
          name: record.toolName,
          description: record.description,
          inputSchema: record.inputSchema,
          handler,
        });
      }
    } catch (err) {
      logger.warn(`[DynamicToolManager] MCP registration failed for ${record.toolName}: ${err.message}`);
    }
  }

  /**
   * Create an HTTP handler function for a tool endpoint
   * @private
   */
  _createHttpHandler(serverUrl) {
    return async (params) => {
      const http = require('http');
      const https = require('https');
      const url = new URL(serverUrl);
      const client = url.protocol === 'https:' ? https : http;

      return new Promise((resolve, reject) => {
        const postData = JSON.stringify(params);
        const req = client.request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 30000,
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ result: data });
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Tool HTTP timeout')); });
        req.write(postData);
        req.end();
      });
    };
  }
}

module.exports = DynamicToolManager;